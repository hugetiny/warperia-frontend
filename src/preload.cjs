try {
  const { contextBridge, ipcRenderer, webFrame } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const versionInfo = require('win-version-info');
  const extract = require('extract-zip');
  const { spawn, exec } = require('child_process');
  const processManager = new Map();
  const os = require('os');

  const readPortableVersionInfo = (filePath) => {
    try {
      const executable = fs.readFileSync(filePath);

      // Portable PE metadata fallback for non-Windows environments where
      // win-version-info may return incomplete data.
      if (executable.subarray(0, 2).toString('ascii') !== 'MZ') {
        return {};
      }

      const contents = executable.toString('utf16le');
      const getValue = (key) => {
        const match = contents.match(new RegExp(`${key}\\0+([^\\0]{1,100})`, 'i'));
        return match ? match[1].trim() : '';
      };

      return {
        ProductName: getValue('ProductName'),
        FileDescription: getValue('FileDescription'),
        ProductVersion: getValue('ProductVersion'),
        FileVersion: getValue('FileVersion'),
      };
    } catch (error) {
      console.warn(`[Warperia] Failed to read portable version info for ${filePath}:`, error);
      return {};
    }
  };

  const normalizeExecutableVersion = (version) => {
    if (!version || typeof version !== 'string') return null;
    return version.replace(/,\s*/g, '.').trim();
  };

  // --------------------------------
  // FILE OPERATION HELPERS
  // --------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const execSilent = (cmd) =>
    new Promise((resolve) => exec(cmd, (error) => resolve(!error)));

  // On Windows, fs.writeFile throws EPERM on hidden/system/read-only files
  // even when running as administrator. Clear those attributes first.
  const clearWindowsAttributes = async (targetPath, recursive = false) => {
    if (os.platform() !== 'win32') return;
    if (recursive) {
      await execSilent(`attrib -r -s -h "${targetPath}" /s /d`);
      await execSilent(`attrib -r -s -h "${targetPath}\\*.*" /s /d`);
    } else {
      await execSilent(`attrib -r -s -h "${targetPath}"`);
    }
  };

  const isTransientFsError = (err) =>
    err && ['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE'].includes(err.code);

  // Run Windows diagnostics to identify why a path is blocked.
  // Logs: attributes, ACL, owner, and any processes with open handles.
  const diagnoseFsBlocker = async (targetPath) => {
    if (os.platform() !== 'win32') return;
    const safePath = targetPath.replace(/"/g, '\\"');
    console.warn(`[Warperia DIAG] Investigating EPERM for: ${targetPath}`);

    // 1. Attributes
    exec(`attrib "${safePath}"`, (err, stdout) => {
      console.warn(`[Warperia DIAG] attrib: ${err ? err.message : stdout.trim()}`);
    });

    // 2. ACL / owner
    exec(`icacls "${safePath}"`, (err, stdout) => {
      console.warn(`[Warperia DIAG] icacls: ${err ? err.message : stdout.trim()}`);
    });

    // 3. Open handles (best-effort, may require sysinternals handle.exe)
    // Prefer handle.exe if it's on PATH
    exec(`handle.exe "${safePath}"`, (err, stdout) => {
      if (!err && stdout) {
        console.warn(`[Warperia DIAG] handle.exe output:\n${stdout}`);
      }
    });

    // 4. Built-in Windows handle query (often disabled; silent fail)
    exec(`openfiles /query /fo csv`, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.split('\n').filter((l) => l.includes(safePath));
        if (lines.length) {
          console.warn(`[Warperia DIAG] openfiles matches:\n${lines.join('\n')}`);
        }
      }
    });

    // 5. Detailed file info (owner, mode)
    exec(
      `powershell -NoProfile -Command "Get-ItemProperty -Path '${safePath.replace(/'/g, "''")}' | Select-Object FullName, IsReadOnly, Attributes, @{N='Owner';E={(Get-Acl $_.FullName).Owner}}, Length, LastWriteTime | Format-List"`,
      (err, stdout) => {
        console.warn(`[Warperia DIAG] file info: ${err ? err.message : stdout.trim()}`);
      }
    );
  };

  const TRASH_PREFIX = '.__warperia_trash__';

  // Check which files in a folder are truly locked by another process.
  // A file that is merely read-only is NOT considered locked; we clear the
  // read-only attribute and try to open it again. Only files that still fail
  // to open after clearing attributes are reported as locked.
  const detectLockedFiles = async (folderPath) => {
    const locked = [];
    let entries = [];
    try {
      entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    } catch {
      return locked;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const filePath = path.join(folderPath, entry.name);
        try {
          const handle = await fs.promises.open(filePath, 'r+');
          await handle.close();
        } catch (err) {
          if (!isTransientFsError(err)) return;

          // It might be read-only. Try clearing attributes and retry.
          await clearWindowsAttributes(filePath);
          await sleep(50);
          try {
            const handle = await fs.promises.open(filePath, 'r+');
            await handle.close();
            return;
          } catch (retryErr) {
            if (isTransientFsError(retryErr)) {
              locked.push(entry.name);
            }
          }
        }
      })
    );

    return locked;
  };

  // Best-effort sweep of leftover trash entries in a directory.
  const sweepTrashEntries = async (dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath);
      for (const entry of entries) {
        if (entry.startsWith(TRASH_PREFIX)) {
          const entryPath = path.join(dirPath, entry);
          fs.promises
            .rm(entryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
            .catch(() => {});
        }
      }
    } catch {
      // Directory unreadable - nothing to sweep
    }
  };

  // Build the trash path for a given target.
  const makeTrashPath = (targetPath) => {
    const parentDir = path.dirname(targetPath);
    return path.join(parentDir, `${TRASH_PREFIX}${path.basename(targetPath)}-${Date.now()}`);
  };

  // Delete a file or folder
  const forceRemoveNoStat = async (targetPath) => {
    try {
      const entries = await fs.promises.readdir(targetPath);
      // It's a directory
      await Promise.all(
        entries.map((entry) => forceRemoveNoStat(path.join(targetPath, entry)))
      );
      await fs.promises.rmdir(targetPath);
    } catch (err) {
      if (err.code === 'ENOTDIR') {
        // It's a file
        try {
          await fs.promises.unlink(targetPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
        }
      } else if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  };

  // Check whether the AddOns folder is writable and whether it has the Windows
  // read-only attribute set. Returns { writable: true } or { writable: false, error }.
  const checkAddonsFolderWritable = async (gameDir) => {
    const addonsDir = path.join(gameDir, 'Interface', 'AddOns');
    const testFile = path.join(addonsDir, `.__warperia_writetest_${Date.now()}`);

    // 1. Check Windows attributes for read-only flag
    if (os.platform() === 'win32') {
      try {
        const attr = await new Promise((resolve) => {
          exec(`attrib "${addonsDir}"`, (_, stdout) => resolve(stdout || ''));
        });
        const attributes = attr.split(/\s+/).filter(Boolean).slice(0, -1);
        if (attributes.includes('R')) {
          console.warn(`[Warperia] AddOns folder has read-only attribute: ${addonsDir}`);
          return { writable: false, error: new Error(`AddOns folder is read-only (${attributes.join('')})`) };
        }
      } catch (attrErr) {
        console.warn('[Warperia] Could not read AddOns folder attributes:', attrErr);
      }
    }

    // 2. Try to actually write and delete a test file
    try {
      await fs.promises.mkdir(addonsDir, { recursive: true });
      await fs.promises.writeFile(testFile, 'write-test');
      await fs.promises.unlink(testFile);
      return { writable: true };
    } catch (err) {
      console.warn(`[Warperia] AddOns folder write test failed: ${addonsDir}`, err);
      return { writable: false, error: err };
    }
  };

  // Windows command-level deletion fallback. The built-in fs.rm can fail on
  // some delete-pending or locked states because it uses lstat; rd/del use the
  // Windows API directly and sometimes succeed where Node.js fails.
  const windowsCommandDelete = async (targetPath) => {
    if (os.platform() !== 'win32') return false;
    const safePath = targetPath.replace(/"/g, '\\"');
    return new Promise((resolve) => {
      exec(`cmd /c rd /s /q "${safePath}" >nul 2>&1 || del /f /q "${safePath}" >nul 2>&1`, (error) => {
        resolve(!error);
      });
    });
  };

  // Try to determine whether an EPERM is due to a read-only attribute or
  // because another process holds an open handle. For directories we rely on
  // attributes; for files we also try opening for write.
  const classifyFsBlocker = async (targetPath) => {
    if (os.platform() !== 'win32') return { type: 'unknown', reason: 'unknown' };

    const result = { type: 'unknown', reason: 'unknown' };
    let isDirectory = false;

    try {
      const stat = await fs.promises.stat(targetPath);
      isDirectory = stat.isDirectory();
    } catch {
      // If we can't stat it, we'll try below as a file
    }

    try {
      const attr = await new Promise((resolve) => {
        exec(`attrib "${targetPath}"`, (_, stdout) => resolve(stdout || ''));
      });
      const attributes = attr.split(/\s+/).filter(Boolean).slice(0, -1);
      if (attributes.includes('R')) {
        result.type = 'read-only';
        result.reason = 'Read-only attribute is set';
      }
    } catch {
      // ignore
    }

    // Opening a directory with r+ is invalid and will return misleading errors,
    // so only do this for files.
    if (!isDirectory) {
      try {
        const handle = await fs.promises.open(targetPath, 'r+');
        await handle.close();
      } catch (openErr) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(openErr.code)) {
          result.type = 'locked';
          result.reason = 'File is open or locked by another process';
        }
      }
    }

    return result;
  };

  const robustDelete = async (targetPath, maxRetries = 2) => {
    // --- Strategy 1: rename-to-trash (atomic, no child-file access) ---
    const trashPath = makeTrashPath(targetPath);
    for (let renameAttempt = 0; renameAttempt <= 1; renameAttempt++) {
      try {
        await fs.promises.rename(targetPath, trashPath);
        console.log(`[Warperia] Moved to trash: ${trashPath}`);
        fs.promises
          .rm(trashPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
          .catch(() => {});
        sweepTrashEntries(path.dirname(targetPath));
        return;
      } catch (renameErr) {
        if (renameAttempt === 0) {
          // First rename failed. Common cause on Windows: read-only attribute.
          // Clear it and try ONE more time before running diagnostics.
          console.warn(`[Warperia] Rename-to-trash failed for ${targetPath} (${renameErr.code}), clearing attributes and retrying`);
          await clearWindowsAttributes(targetPath, true);
          await sleep(150);
        } else {
          console.warn(`[Warperia] Rename-to-trash failed for ${targetPath} (${renameErr.code}), falling back to direct deletion`);
          await diagnoseFsBlocker(targetPath);
        }
      }
    }

    // --- Strategy 2: direct rm with attribute clearing and retries ---
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fs.promises.rm(targetPath, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        });
      } catch (err) {
        lastError = err;
      }

      const stillExists = await fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (!stillExists) return;

      await clearWindowsAttributes(targetPath, true);
      await sleep(200 * (attempt + 1));
    }

    const stillExists = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (!stillExists) return;

    // --- Strategy 3: lstat-free recursive delete (handles delete-pending) ---
    try {
      await forceRemoveNoStat(targetPath);
      const stillExistsNoStat = await fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (!stillExistsNoStat) return;
    } catch (noStatErr) {
      lastError = noStatErr;
    }

    // --- Strategy 4: Windows command-level deletion (rd /s /q || del /f /q) ---
    try {
      if (await windowsCommandDelete(targetPath)) {
        const stillExistsCmd = await fs.promises
          .access(targetPath)
          .then(() => true)
          .catch(() => false);
        if (!stillExistsCmd) return;
      }
    } catch (cmdErr) {
      // ignore
    }

    const stillExistsFinal = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (!stillExistsFinal) return;

    // Determine the real cause so the UI can show an accurate message.
    const blocker = await classifyFsBlocker(targetPath);
    const message = blocker.type === 'read-only'
      ? `Cannot delete ${targetPath}: the folder or a file inside it is read-only. Remove the read-only attribute and retry.`
      : blocker.type === 'locked'
      ? `Cannot delete ${targetPath}: the file is open or locked by another process.`
      : `Failed to delete ${targetPath}: permission denied or protected.`;

    const error = lastError || new Error(message);
    error.message = message;
    error.code = blocker.type === 'locked' ? 'ELOCKED' : 'EPERM';
    error.path = targetPath;
    error.blockerType = blocker.type;
    error.blockerReason = blocker.reason;
    throw error;
  };

  // Write a file with automatic recovery from EPERM/EBUSY.
  //
  // When a .warperia file is in Windows delete-pending state (opened for
  // deletion by a previous failed rm) we cannot write to it with writeFile
  // and we cannot rename it away (rename fails on pending-delete files).
  // The trick: write new content to a temp file in the SAME directory, then
  // rename the temp file OVER the target. A rename that REPLACES a pending-
  // delete target succeeds on Windows because the kernel substitutes the new
  // inode; the old pending-delete inode is cleaned up independently.
  const robustWriteFile = async (filePath, fileData, opts = {}) => {
    const { maxRetries = 3, diagnose = true } = opts;
    let lastError = null;
    let diagnosed = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fs.promises.writeFile(filePath, fileData);
        return;
      } catch (err) {
        lastError = err;
        if (!isTransientFsError(err)) throw err;

        // Run diagnostics once on first EPERM to see what is blocking the file
        if (diagnose && !diagnosed) {
          diagnosed = true;
          await diagnoseFsBlocker(filePath);
        }

        // Attempt 0: clear hidden/system/read-only attributes
        await clearWindowsAttributes(filePath);
        await sleep(100);

        if (attempt >= 1) {
          // Attempt 1+: write to a temp file, then rename over the target.
          // This works even when the target is delete-pending because the
          // rename replaces (not reopens) the blocking inode.
          const dir = path.dirname(filePath);
          const tmpPath = path.join(
            dir,
            `${TRASH_PREFIX}tmp_${Date.now()}_${path.basename(filePath)}`
          );
          try {
            await fs.promises.writeFile(tmpPath, fileData);
            try {
              await fs.promises.rename(tmpPath, filePath);
              return; // success via atomic replace
            } catch (renameErr) {
              fs.promises.unlink(tmpPath).catch(() => {});
              // Only log on the last attempt to avoid spam during batch scans
              if (attempt === maxRetries && diagnose) {
                console.warn(`[Warperia] Could not write ${path.basename(filePath)} (${err.code}) - file may be locked by another process`);
              }
            }
          } catch (tmpErr) {
            fs.promises.unlink(tmpPath).catch(() => {});
          }
        }

        await sleep(150 * attempt);
      }
    }
    throw lastError;
  };

  contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    arch: process.arch,
    isMacSilicon: process.platform === 'darwin' && (process.arch === 'arm64' || os.arch() === 'arm64'),
    isMac: process.platform === 'darwin',

    // --------------------------------
    // KEY IPC RENDERER WRAPPERS
    // --------------------------------
    ipcRenderer: {
      send: (channel, data) => ipcRenderer.send(channel, data),
      invoke: (channel, data) => ipcRenderer.invoke(channel, data),
      on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
      removeListener: (channel, func) => ipcRenderer.removeListener(channel, func),
    },

    // --------------------------------
    // PATH HELPERS
    // --------------------------------
    pathJoin: (...args) => path.join(...args),
    pathResolve: (...args) => path.resolve(...args),
    pathNormalize: (p) => path.normalize(p),
    pathRelative: (from, to) => path.relative(from, to),
    pathIsAbsolute: (p) => path.isAbsolute(p),
    pathDirname: (p) => path.dirname(p),

    // --------------------------------
    // USER DATA PATH
    // --------------------------------
    getUserDataPath: () => {
      return ipcRenderer.sendSync('get-user-data-path');
    },
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    clearCache: () => ipcRenderer.invoke('clear-cache'),

    // --------------------------------
    // GITHUB FINGERPRINT
    // --------------------------------
    fetchGitHubFingerprint: (owner, repo) =>
      ipcRenderer.invoke('fetch-github-fingerprint', owner, repo),
    fetchGitHubDefaultBranch: (owner, repo) =>
      ipcRenderer.invoke('fetch-github-default-branch', owner, repo),

    // --------------------------------
    // DOWNLOAD FILES
    // --------------------------------
    downloadFile: async (url, savePath) => {
      return new Promise((resolve, reject) => {
        const fs = require('fs');
        const https = require('https');

        const file = fs.createWriteStream(savePath);
        https
          .get(url, (response) => {
            if (response.statusCode !== 200) {
              return reject(new Error(`Failed to download file: ${response.statusCode}`));
            }

            const totalBytes = parseInt(response.headers['content-length'], 10);
            let downloadedBytes = 0;

            // console.log(`Starting download. Total size: ${totalBytes} bytes`);

            response.on('data', (chunk) => {
              downloadedBytes += chunk.length;
              const progress = Math.round((downloadedBytes / totalBytes) * 100);
              ipcRenderer.send('download-progress', progress);
            });

            response.pipe(file);

            file.on('finish', () => {
              file.close(() => {
                console.log('Download complete');
                resolve(savePath);
              });
            });
          })
          .on('error', (err) => {
            fs.unlink(savePath, () => reject(err));
          });
      });
    },

    // --------------------------------
    // APP UPDATES
    // --------------------------------
    installUpdate: () => {
      ipcRenderer.invoke("install-update");
    },
    getAppVersion: () => ipcRenderer.invoke("get-app-version"),

    // Listen for auto-updater events
    onUpdateChecking: (callback) => {
      ipcRenderer.on('update-checking', () => callback());
    },
    onUpdateAvailable: (callback) => {
      ipcRenderer.on('update-available', (event, info) => callback(info));
    },
    onUpdateNotAvailable: (callback) => {
      ipcRenderer.on('update-not-available', (event, info) => callback(info));
    },
    onUpdateProgress: (callback) => {
      ipcRenderer.on('update-progress', (event, progress) => callback(progress));
    },
    onUpdateDownloaded: (callback) => {
      ipcRenderer.on('update-downloaded', (event, info) => callback(info));
    },
    onUpdateError: (callback) => {
      ipcRenderer.on('update-error', (event, error) => callback(error));
    },

    // --------------------------------
    // FILE DIALOG
    // --------------------------------
    showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
    onSetupExportProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('setup-manager-export-progress', listener);
      return () => {
        ipcRenderer.removeListener('setup-manager-export-progress', listener);
      };
    },
    exportSetupBackup: (payload) => ipcRenderer.invoke('setup-manager-export', payload),
    importSetupBackup: (payload) => ipcRenderer.invoke('setup-manager-import', payload),

    // --------------------------------
    // STORE / RETRIEVE TOKEN
    // --------------------------------
    storeToken: (token, backendUrl) => ipcRenderer.invoke('store-token', token, backendUrl),
    retrieveToken: () => ipcRenderer.invoke('retrieve-token'),
    clearToken: () => ipcRenderer.invoke('clear-token'),

    isSafeStorageAvailable: () => ipcRenderer.invoke('is-safe-storage-available'),

    // --------------------------------
    // STORE / RETRIEVE UUID
    // --------------------------------
    storeUuid: (uuid) => ipcRenderer.invoke('store-uuid', uuid),
    retrieveUuid: () => ipcRenderer.invoke('retrieve-uuid'),

    // --------------------------------
    // EXTERNAL URL
    // --------------------------------
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

    // --------------------------------
    // CONFIG
    // --------------------------------
    getConfig: () => ipcRenderer.invoke('get-config'),

    // --------------------------------
    // STORE / RETRIEVE USER
    // --------------------------------
    storeUser: (user) => ipcRenderer.invoke('store-user', user),
    retrieveUser: () => ipcRenderer.invoke('retrieve-user'),
    clearUser: () => ipcRenderer.invoke('clear-user'),

    // --------------------------------
    // GUEST SESSION MANAGEMENT
    // --------------------------------
    storeGuestSession: (guestData) => ipcRenderer.invoke('store-guest-session', guestData),
    retrieveGuestSession: () => ipcRenderer.invoke('retrieve-guest-session'),
    clearGuestSession: () => ipcRenderer.invoke('clear-guest-session'),
    checkGuestMode: () => ipcRenderer.invoke('check-guest-mode'),
    setGuestMode: (isGuest) => ipcRenderer.invoke('set-guest-mode', isGuest),

    // --------------------------------
    // DEV MODE
    // --------------------------------
    setDevMode: (enabled) => ipcRenderer.invoke('set-dev-mode', enabled),
    getDevMode: () => ipcRenderer.invoke('get-dev-mode'),
    getDevLogPath: () => ipcRenderer.invoke('get-dev-log-path'),
    sendDevLog: (level, message) => ipcRenderer.send('dev-log-message', level, message),

    // --------------------------------
    // LAUNCH / TERMINATE EXE
    // --------------------------------
    launchExe: async (exePath, serverData = null) => {
      const { spawn } = require('child_process');
      const { spawnSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      if (!fs.existsSync(exePath)) {
        throw new Error('Executable file not found.');
      }

      const launchDetachedProcess = (command, args = [], options = {}) =>
        new Promise((resolve, reject) => {
          try {
            const processInstance = spawn(command, args, {
              detached: true,
              stdio: 'ignore',
              ...options,
            });

            let settled = false;
            processInstance.once('error', (error) => {
              if (settled) return;
              settled = true;
              reject(error);
            });

            processInstance.once('spawn', () => {
              if (settled) return;
              settled = true;
              processInstance.unref();
              resolve();
            });
          } catch (error) {
            reject(error);
          }
        });

      const resolveWineBinary = () => {
        const platform = os.platform();
        if (platform === 'win32') return null;

        const candidates = platform === 'darwin'
          ? ['wine64', 'wine']
          : ['wine64', 'wine'];

        for (const candidate of candidates) {
          try {
            const check = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
            if (!check.error && check.status === 0) {
              return candidate;
            }
          } catch {
            // Keep trying other candidates
          }
        }

        return null;
      };

      // Helper function to update realmlist files
      const updateRealmlistFiles = async (serverData) => {
        if (!serverData.s_realmlist || !serverData.s_dir) {
          return;
        }

        const gameVersion = serverData.s_version;
        const isMop = gameVersion && gameVersion.toLowerCase().includes('mop');
        const isLegion = gameVersion && gameVersion.toLowerCase().includes('legion');
        const isClassic = gameVersion && gameVersion.includes('-classic');
        
        // Skip for classic clients
        if (isClassic) {
          return;
        }

        try {
          // For Legion, only update Config.wtf (no realmlist.wtf)
          if (isLegion) {
            const configPath = path.join(serverData.s_dir, 'WTF', 'Config.wtf');
            let configContent = '';
            
            if (fs.existsSync(configPath)) {
              configContent = fs.readFileSync(configPath, 'utf8');
            }
            
            // Remove existing portal line and add new one
            const lines = configContent.split('\n');
            const filteredLines = lines.filter(line => 
              !line.match(/^SET\s+portal\s+/i)
            );
            filteredLines.push(`SET portal "${serverData.s_realmlist}"`);
            
            const updatedConfigContent = filteredLines.join('\n');
            
            // Ensure WTF directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }
            
            fs.writeFileSync(configPath, updatedConfigContent, 'utf8');
            return;
          }

          // Find locale directory
          const dataDir = path.join(serverData.s_dir, 'Data');
          if (!fs.existsSync(dataDir)) {
            // Create Data/enUS directory structure as fallback
            const fallbackLocaleDir = path.join(dataDir, 'enUS');
            fs.mkdirSync(fallbackLocaleDir, { recursive: true });
          }

          const knownLocales = ['enUS', 'enGB', 'deDE', 'frFR', 'esES', 'esMX', 'ruRU', 'ptBR', 'itIT', 'zhCN', 'zhTW', 'koKR'];
          const directories = fs.readdirSync(dataDir);
          let locale = directories.find(d => knownLocales.includes(d));
          
          if (!locale) {
            // No known locale found - use enUS as fallback and create the directory
            locale = 'enUS';
            const fallbackDir = path.join(dataDir, locale);
            if (!fs.existsSync(fallbackDir)) {
              fs.mkdirSync(fallbackDir, { recursive: true });
            }
          }

          // Update realmlist.wtf
          const realmlistPath = path.join(dataDir, locale, 'realmlist.wtf');
          const realmlistContent = `set realmlist ${serverData.s_realmlist}\n`;
          
          // Ensure directory exists
          const realmlistDir = path.dirname(realmlistPath);
          if (!fs.existsSync(realmlistDir)) {
            fs.mkdirSync(realmlistDir, { recursive: true });
          }
          
          fs.writeFileSync(realmlistPath, realmlistContent, 'utf8');

          // Update Config.wtf for MoP - update SET portal line
          if (isMop) {
            const configPath = path.join(serverData.s_dir, 'WTF', 'Config.wtf');
            let configContent = '';
            
            if (fs.existsSync(configPath)) {
              configContent = fs.readFileSync(configPath, 'utf8');
            }
            
            // Remove existing portal and realmlist lines, then add updated portal
            const lines = configContent.split('\n');
            const filteredLines = lines.filter(line => 
              !line.match(/^SET\s+portal\s+/i) && !line.match(/^SET\s+realmlist\s+/i)
            );
            filteredLines.push(`SET portal "${serverData.s_realmlist}"`);
            
            const updatedConfigContent = filteredLines.join('\n');
            
            // Ensure WTF directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }
            
            fs.writeFileSync(configPath, updatedConfigContent, 'utf8');
          }
        } catch (error) {
          console.error('[REALMLIST] Error updating realmlist files:', error);
          throw error;
        }
      };

      // Update realmlist files before launching if server data is provided
      if (serverData && serverData.s_realmlist && serverData.s_dir) {
        try {
          await updateRealmlistFiles(serverData);
          console.log('[REALMLIST] Updated realmlist files before launch');
        } catch (error) {
          console.error('[REALMLIST] Failed to update realmlist files:', error);
          // Continue with launch even if realmlist update fails
        }
      }

      // Backup Config.wtf before launching the game
      const configPath = path.join(path.dirname(exePath), 'WTF', 'Config.wtf');
      const backupPath = path.join(path.dirname(exePath), 'WTF', 'Config.wtf.backup');

      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, backupPath);
        console.log('[MODIFICATIONS] Created backup of Config.wtf');
      }

      // Launch the game.
      // - Windows: direct executable launch.
      // - Linux/macOS: try direct first (for binfmt wrappers), then fallback to Wine.
      const isWindows = os.platform() === 'win32';
      const isExeFile = /\.exe$/i.test(exePath);

      try {
        await launchDetachedProcess(exePath);
      } catch (directLaunchError) {
        if (!isWindows && isExeFile) {
          const wineBinary = resolveWineBinary();
          if (!wineBinary) {
            throw new Error(
              `Failed to launch executable directly (${directLaunchError.message}). Wine is required on this platform to run Windows executables.`
            );
          }

          try {
            await launchDetachedProcess(wineBinary, [exePath], {
              cwd: path.dirname(exePath),
            });
            console.log(`[LAUNCH] Started executable via ${wineBinary}: ${exePath}`);
            return;
          } catch (wineLaunchError) {
            throw new Error(
              `Failed to launch executable directly (${directLaunchError.message}) and via ${wineBinary} (${wineLaunchError.message}).`
            );
          }
        }

        throw directLaunchError;
      }
    },

    // For truly restarting:
    restartExe: async (exePath) => {
      // We'll rely on main to do the fallback kill logic, 
      // then re-launch the original exe
      return ipcRenderer.invoke('restart-exe', exePath);
    },

    // --------------------------------
    // START/STOP PROCESS MONITORING
    // (This triggers repeated checks in main.cjs)
    // --------------------------------
    startProcessMonitoring: (exePath, serverId, intervalMs = 5000) => {
      ipcRenderer.send('start-process-monitoring', { exePath, serverId, intervalMs });
    },
    stopProcessMonitoring: (exePath) => {
      ipcRenderer.send('stop-process-monitoring', { exePath });
    },


    // --------------------------------
    // CHECK WOW VERSION
    // --------------------------------
    checkWowVersion: (filePath) => {
      try {
        const fileName = path.basename(filePath);
        const fileDir = path.dirname(filePath);

        // Read version info for the selected file with cross-platform fallback.
        let nativeVersionData = {};
        try {
          nativeVersionData = versionInfo(filePath) || {};
        } catch (versionError) {
          console.warn(`[Warperia] win-version-info failed for ${filePath}:`, versionError);
        }
        const versionData = nativeVersionData.ProductVersion
          ? nativeVersionData
          : readPortableVersionInfo(filePath);
        const productName = versionData.ProductName || '';
        const fileDescription = versionData.FileDescription || '';

        // Strict check for "World of Warcraft" in either field
        const isWowExecutable = /world of warcraft/i.test(productName) || /world of warcraft/i.test(fileDescription);

        if (isWowExecutable) {
          console.log(`Matched WoW executable: ${fileName}`);

          // Check for WoW-specific directories in the same directory as the .exe file
          const requiredDirs = ['Data', 'Interface', 'WTF'];
          const hasRequiredDirs = requiredDirs.some(dirName => fs.existsSync(path.join(fileDir, dirName)));

          if (hasRequiredDirs) {
            console.log('Valid WoW installation directory detected.');
            const detectedVersion = normalizeExecutableVersion(
              versionData.ProductVersion || versionData.FileVersion
            );
            return detectedVersion; // Return version if valid WoW executable
          } else {
            console.warn('WoW executable found, but required directories (Data, Interface, WTF) are missing.');
            return null; // Invalid if directories are missing
          }
        } else {
          console.warn('The selected file is not a valid World of Warcraft executable.');
          return null; // Explicitly return null for non-WoW executables
        }
      } catch (error) {
        console.error(`Error reading version info for ${filePath}:`, error);
        return null; // Explicitly return null on error
      }
    },

    checkInterfaceFolder: (directoryPath) => {
      try {
        const interfacePath = path.join(directoryPath, 'Interface');
        return fs.existsSync(interfacePath);
      } catch (error) {
        console.error('Error checking Interface folder:', error);
        return false;
      }
    },

    // --------------------------------
    // ZIP / FILE IO UTILS
    // --------------------------------
    saveZipFile: async (zipBlob, fileName) => {
      try {
        const userDataPath = ipcRenderer.sendSync('get-user-data-path');
        const filePath = path.join(userDataPath, fileName);

        const buffer = await zipBlob.arrayBuffer();
        await fs.promises.writeFile(filePath, Buffer.from(buffer));
        return filePath;
      } catch (err) {
        console.error('Error writing file:', err);
        throw err;
      }
    },

    extractZip: async (zipPath, extractPath) => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await extract(zipPath, { dir: extractPath });
          return;
        } catch (err) {
          lastError = err;
          if (!isTransientFsError(err)) {
            console.error("Error extracting ZIP file:", err);
            throw err;
          }
          // Existing hidden/read-only/locked files block overwriting during
          // extraction. Clear attributes on the destination and retry.
          console.warn(`Extraction attempt ${attempt + 1} failed (${err.code}), clearing attributes and retrying...`);
          await clearWindowsAttributes(extractPath, true);
          await sleep(200 * (attempt + 1));
        }
      }
      console.error("Error extracting ZIP file:", lastError);
      throw lastError;
    },

    writeFile: async (filePath, fileData) => {
      try {
        // Check if file already exists before writing
        const fileExists = await fs.promises.access(filePath).then(() => true).catch(() => false);
        if (fileExists) {
          return;  // Skip if the file already exists
        }

        // Proceed to write the file if it does not exist
        await robustWriteFile(filePath, fileData);
      } catch (err) {
        console.error(`Error writing file: ${filePath}`, err);
        throw err;
      }
    },

    overwriteFile: async (filePath, fileData, opts = {}) => {
      try {
        await robustWriteFile(filePath, fileData, opts);
      } catch (err) {
        if (opts.diagnose !== false) {
          console.error(`Error overwriting file: ${filePath}`, err);
        }
        throw err;
      }
    },

    detectLockedFiles: async (folderPath) => {
      return detectLockedFiles(folderPath);
    },

    createFolder: async (folderPath) => {
      try {
        await fs.promises.mkdir(folderPath, { recursive: true });
      } catch (err) {
        console.error("Error creating folder:", err);
        throw err;
      }
    },

    createHiddenFolder: async (folderPath) => {
      try {
        await fs.promises.mkdir(folderPath, { recursive: true });
        
        // On Windows, make the folder hidden using attrib command
        if (os.platform() === 'win32') {
          return new Promise((resolve, reject) => {
            exec(`attrib +h "${folderPath}"`, (error) => {
              if (error) {
                console.error('Error making folder hidden:', error);
                reject(error);
              } else {
                resolve({ success: true });
              }
            });
          });
        }
      } catch (err) {
        console.error("Error creating hidden folder:", err);
        throw err;
      }
    },

    readDir: async (dirPath) => {
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith(TRASH_PREFIX))
          .map(entry => entry.name);
      } catch (err) {
        console.error("Error reading directory:", err);
        throw err;
      }
    },

    readFile: async (filePath) => {
      try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        return data;
      } catch (err) {
        console.error('Error reading file:', err);
        throw err;
      }
    },

    readDirAndFiles: async (dirPath) => {
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const files = entries
          .filter(entry => entry.isFile() && !entry.name.startsWith(TRASH_PREFIX)) // Include all files regardless of extension
          .map(file => file.name);
        const directories = entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith(TRASH_PREFIX))
          .map(entry => entry.name);

        return { files, directories }; // Return both files and directories
      } catch (err) {
        console.error("Error reading directory and files:", err);
        throw err;
      }
    },

    readBinaryFile: async (filePath) => {
      try {
        const data = await fs.promises.readFile(filePath);
        return data;
      } catch (err) {
        console.error('Error reading binary file:', err);
        throw err;
      }
    },

    deleteFolder: async (folderPath) => {
      try {
        await robustDelete(folderPath);
      } catch (err) {
        console.error("Error deleting folder:", err);
        throw err;
      }
    },

    pathJoin: (...segments) => {
      return path.join(...segments);
    },

    deleteUnknownAddonFolder: async (folderPath) => {
      try {
        await robustDelete(folderPath);
      } catch (err) {
        console.error("Error deleting folder and its contents:", err);
        throw err;
      }
    },

    fileExists: async (filePath) => {
      try {
        await fs.promises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },

    readTitleFromToc: async (tocFilePath) => {
      try {
        const data = await fs.promises.readFile(tocFilePath, 'utf8');
        const titleLine = data.split('\n').find(line => line.startsWith('## Title:'));
        if (titleLine) {
          let title = titleLine.replace('## Title:', '').trim();

          // Strip WoW-specific color codes and special characters
          title = title.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '');
          title = title.replace(/(\|H.*?\|h|\|T.*?\|t|\|A.*?\|a)/g, '');

          return title.trim();
        }
        return null;
      } catch (error) {
        console.error('Error reading .toc file:', error);
        throw error;
      }
    },

    readVersionFromToc: async (tocFilePath) => {
      try {
        const content = await fs.promises.readFile(tocFilePath, 'utf-8');
        const versionLine = content.split('\n').find(line => line.startsWith('## Version:'));
        return versionLine ? versionLine.split(': ')[1].trim() : null;
      } catch (err) {
        console.error("Error reading version from TOC:", err);
        throw err;
      }
    },

    updateTocVersion: async (addonPath, version) => {
      try {
        const tocFilePath = path.join(addonPath, `${path.basename(addonPath)}.toc`);
        
        // Fix file permissions before attempting to read/write
        await clearWindowsAttributes(tocFilePath);

        let tocContent = await fs.promises.readFile(tocFilePath, 'utf-8');
        const versionLine = tocContent.split('\n').find(line => line.startsWith('## Version:'));

        if (versionLine) {
          tocContent = tocContent.replace(versionLine, `## Version: ${version}`);
        } else {
          tocContent += `\n## Version: ${version}`;
        }

        await robustWriteFile(tocFilePath, tocContent);
      } catch (err) {
        console.error('Error updating .toc file:', err);
        throw err;
      }
    },

    readDependenciesFromToc: async (tocFilePath) => {
      try {
        const data = await fs.promises.readFile(tocFilePath, 'utf8');
        const optionalDeps = data.split('\n').filter(line => line.startsWith('## OptionalDeps:')).map(line => line.replace('## OptionalDeps:', '').trim());
        const loadOnDemand = data.split('\n').filter(line => line.startsWith('## LoadOnDemand:')).map(line => line.replace('## LoadOnDemand:', '').trim());
        const dependencies = [...optionalDeps, ...loadOnDemand].flatMap(dep => dep.split(',').map(d => d.trim()));

        return dependencies;
      } catch (error) {
        console.error('Error reading dependencies from .toc file:', error);
        throw error;
      }
    },

    normalizePath: (filePath) => {
      const normalizedPath = path.normalize(filePath);
      return normalizedPath;
    },

    fixFilePermissions: (filePath) => {
      return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
          // On Windows, remove read-only/system/hidden attributes using "attrib" command
          exec(`attrib -r -s -h "${filePath}"`, (error) => {
            if (error) {
              console.error('Error removing file attributes:', error);
              reject(error);
            } else {
              resolve({ success: true });
            }
          });
        } else {
          // On Unix-like, try chmod 664 or similar
          fs.chmod(filePath, 0o664, (err) => {
            if (err) {
              console.error('Error changing file permissions:', err);
              reject(err);
            } else {
              resolve({ success: true });
            }
          });
        }
      });
    },

    forceFixPermissions: (folderPath) => {
      return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
          // More aggressive Windows permission fix
          const commands = [
            `takeown /f "${folderPath}" /r /d y`,
            `icacls "${folderPath}" /grant administrators:F /t`,
            `attrib -r -s -h "${folderPath}" /s /d`,
            `attrib -r -s -h "${folderPath}\\*.*" /s /d`
          ];

          let completed = 0;
          commands.forEach((cmd, index) => {
            exec(cmd, (error) => {
              if (error) {
                console.warn(`Command ${index + 1} failed:`, error.message);
              }
              completed++;
              if (completed === commands.length) {
                resolve({ success: true });
              }
            });
          });
        } else {
          // Unix-like fallback
          exec(`chmod -R 755 "${folderPath}"`, (error) => {
            if (error) {
              console.error('Error changing folder permissions:', error);
              reject(error);
            } else {
              resolve({ success: true });
            }
          });
        }
      });
    },

    checkAddonsFolderWritable: async (gameDir) => {
      return checkAddonsFolderWritable(gameDir);
    },

    fixAddonsFolderPermissions: async (gameDir) => {
      const addonsDir = path.join(gameDir, 'Interface', 'AddOns');
      try {
        await fs.promises.mkdir(addonsDir, { recursive: true });
      } catch {
        // ignore
      }

      // Run the same aggressive permission fix used for individual folders
      const runFix = () =>
        new Promise((resolve) => {
          if (os.platform() !== 'win32') {
            exec(`chmod -R 755 "${addonsDir}"`, () => resolve());
            return;
          }
          const commands = [
            `takeown /f "${addonsDir}" /r /d y`,
            `icacls "${addonsDir}" /grant administrators:F /t`,
            `icacls "${addonsDir}" /grant "%username%":F /t`,
            `attrib -r -s -h "${addonsDir}" /s /d`,
            `attrib -r -s -h "${addonsDir}\\*.*" /s /d`
          ];
          let completed = 0;
          commands.forEach((cmd) => {
            exec(cmd, () => {
              completed++;
              if (completed === commands.length) resolve();
            });
          });
        });

      await runFix();
      await sleep(500);
      return checkAddonsFolderWritable(gameDir);
    },

    deleteFile: async (filePath) => {
      try {
        await robustDelete(filePath);
      } catch (error) {
        console.error('Error deleting file:', error);
        throw error;
      }
    },

  });

  webFrame.executeJavaScript(`
    (function () {
      if (window.__warperiaConsolePatched) return;
      window.__warperiaConsolePatched = true;

      function serializeArg(a) {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (typeof a === 'object') {
          if (a instanceof Error) return a.toString();
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      }

      const originals = {};
      ['log', 'info', 'debug', 'warn', 'error'].forEach(function (level) {
        const orig = window.console[level];
        if (typeof orig !== 'function') return;
        originals[level] = orig;
        window.console[level] = function () {
          const args = Array.prototype.slice.call(arguments);
          orig.apply(window.console, args);
          if (window.electron && typeof window.electron.sendDevLog === 'function') {
            window.electron.sendDevLog(level, args.map(serializeArg).join(' '));
          }
        };
      });
    })();
  `).catch((err) => {
    console.error('Error patching console for dev logging:', err);
  });
} catch (error) {
  console.error('Error in preload script:', error);
}