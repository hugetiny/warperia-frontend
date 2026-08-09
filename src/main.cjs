const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    safeStorage,
    shell
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const http = require('http');
const url = require('url');
const mime = require('mime-types');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
// Configuration values - loaded from config.js
let CONFIG = null;

let Store, isDev;
let mainWindow;
let localServer;
let activePort;
let appStore = null;
let devModeEnabled = false;
const MAX_DEV_LOG_SIZE = 100 * 1024 * 1024;
const SECURITY_KEYWORDS = ['password', 'token', 'secret', 'apikey', 'api_key', 'credential', 'bearer'];
const DEV_LOG_NOISE = ['webpack-dev-server', '[hmr]', 'react devtools'];
const getDevLogPath = () => path.join(app.getPath('userData'), 'dev-mode.log');

function resolveSafePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null;
    try {
        return path.resolve(path.normalize(inputPath));
    } catch {
        return null;
    }
}

/** Compare backend URLs ignoring trailing slashes (login strips them; config may keep them). */
function normalizeBackendUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function formatTimestampForFile(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}_${hours}-${minutes}`;
}

async function pathExists(targetPath) {
    try {
        await fs.promises.access(targetPath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function copyDirectoryRecursive(sourceDir, destinationDir) {
    await fs.promises.mkdir(destinationDir, { recursive: true });
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        const src = path.join(sourceDir, entry.name);
        const dest = path.join(destinationDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirectoryRecursive(src, dest);
        } else if (entry.isFile()) {
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.copyFile(src, dest);
        }
    }
}

async function collectFilesRecursive(sourcePath, relativeBase = '') {
    const files = [];
    const stats = await fs.promises.stat(sourcePath);

    if (stats.isFile()) {
        files.push({
            source: sourcePath,
            relative: relativeBase.replace(/\\/g, '/'),
            size: stats.size,
        });
        return files;
    }

    const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
        const childSource = path.join(sourcePath, entry.name);
        const childRelative = path.join(relativeBase, entry.name);
        if (entry.isDirectory()) {
            const nested = await collectFilesRecursive(childSource, childRelative);
            files.push(...nested);
        } else if (entry.isFile()) {
            const childStats = await fs.promises.stat(childSource);
            files.push({
                source: childSource,
                relative: childRelative.replace(/\\/g, '/'),
                size: childStats.size,
            });
        }
    }

    return files;
}

async function writeTestFile(targetDir) {
    const testFile = path.join(targetDir, `.__warperia_setup_test_${Date.now()}.tmp`);
    await fs.promises.writeFile(testFile, 'warperia-setup-test', 'utf8');
    await fs.promises.unlink(testFile);
}

async function createSetupBackupZip({
    sourceWowDir,
    backupType,
    destinationZipPath,
    appVersion,
    onProgress,
}) {
    const normalizedSourceDir = resolveSafePath(sourceWowDir);
    const normalizedDestination = resolveSafePath(destinationZipPath);
    if (!normalizedSourceDir || !normalizedDestination) {
        throw new Error('Invalid source or destination path.');
    }

    const wtfDir = path.join(normalizedSourceDir, 'WTF');
    const interfaceDir = path.join(normalizedSourceDir, 'Interface');
    const configFile = path.join(wtfDir, 'Config.wtf');
    const accountDir = path.join(wtfDir, 'Account');

    const includedEntries = [];
    if (backupType === 'simple') {
        if (await pathExists(configFile)) {
            includedEntries.push({ type: 'file', source: configFile, relative: path.join('WTF', 'Config.wtf') });
        }
        if (await pathExists(accountDir)) {
            includedEntries.push({ type: 'directory', source: accountDir, relative: path.join('WTF', 'Account') });
        }
    } else {
        if (await pathExists(wtfDir)) {
            includedEntries.push({ type: 'directory', source: wtfDir, relative: 'WTF' });
        }
        if (await pathExists(interfaceDir)) {
            includedEntries.push({ type: 'directory', source: interfaceDir, relative: 'Interface' });
        }
    }

    if (!includedEntries.length) {
        throw new Error(
            backupType === 'simple'
                ? 'No eligible settings were found. Expected at least "WTF/Config.wtf" or "WTF/Account".'
                : 'No eligible settings were found. Expected "WTF" and/or "Interface" folders.'
        );
    }

    await fs.promises.mkdir(path.dirname(normalizedDestination), { recursive: true });

    const createdAt = new Date().toISOString();
    const manifest = {
        schema: 'warperia.setup.backup.v1',
        app: 'Warperia',
        appVersion: appVersion || 'unknown',
        backupType,
        createdAt,
        sourceWowDir: normalizedSourceDir,
        includedPaths: includedEntries.map((entry) => entry.relative.replace(/\\/g, '/')),
    };
    const manifestContent = JSON.stringify(manifest, null, 2);
    const manifestSize = Buffer.byteLength(manifestContent, 'utf8');

    // Build a concrete file list so progress reflects real bytes read.
    const filesToArchive = [];
    for (const entry of includedEntries) {
        const collected = await collectFilesRecursive(entry.source, entry.relative);
        filesToArchive.push(...collected);
    }
    const totalInputBytes = filesToArchive.reduce((sum, file) => sum + (file.size || 0), 0) + manifestSize;
    let processedInputBytes = 0;
    let lastPercent = -1;
    let maxPercentReported = 0;

    const emitInputProgress = () => {
        if (typeof onProgress !== 'function' || totalInputBytes <= 0) return;
        const rawPercent = Math.floor((processedInputBytes / totalInputBytes) * 100);
        const bounded = Math.max(0, Math.min(99, rawPercent));
        maxPercentReported = Math.max(maxPercentReported, bounded);
        if (maxPercentReported !== lastPercent) {
            lastPercent = maxPercentReported;
            onProgress(maxPercentReported);
        }
    };

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(normalizedDestination);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            if (typeof onProgress === 'function') {
                onProgress(100);
            }
            resolve();
        });
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.on('entry', (entry) => {
            const entrySize = Number(entry?.stats?.size || 0);
            if (entrySize > 0) {
                processedInputBytes += entrySize;
                emitInputProgress();
            }
        });

        for (const file of filesToArchive) {
            archive.file(file.source, { name: file.relative });
        }

        archive.append(manifestContent, { name: 'setup.warperia' });
        processedInputBytes += manifestSize;
        emitInputProgress();
        archive.finalize();
    });

    const stats = await fs.promises.stat(normalizedDestination);
    return {
        outputPath: normalizedDestination,
        bytes: stats.size,
        backupType,
        includedPaths: manifest.includedPaths,
    };
}

async function importSetupBackupZip({ zipPath, targetWowDir }) {
    const normalizedZipPath = resolveSafePath(zipPath);
    const normalizedTargetDir = resolveSafePath(targetWowDir);
    if (!normalizedZipPath || !normalizedTargetDir) {
        throw new Error('Invalid backup file path or target path.');
    }

    if (!(await pathExists(normalizedZipPath))) {
        throw new Error('Backup file does not exist.');
    }
    if (!(await pathExists(normalizedTargetDir))) {
        throw new Error('Target World of Warcraft directory does not exist.');
    }

    await writeTestFile(normalizedTargetDir);

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warperia-setup-import-'));
    const extractDir = path.join(tempRoot, 'extracted');
    await fs.promises.mkdir(extractDir, { recursive: true });

    try {
        const zip = await unzipper.Open.file(normalizedZipPath);
        await zip.extract({ path: extractDir, concurrency: 5 });

        const manifestPath = path.join(extractDir, 'setup.warperia');
        if (!(await pathExists(manifestPath))) {
            throw new Error('Invalid backup: "setup.warperia" file was not found.');
        }

        const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
        let manifest;
        try {
            manifest = JSON.parse(manifestRaw);
        } catch {
            throw new Error('Invalid backup: could not parse "setup.warperia" metadata.');
        }

        if (manifest?.schema !== 'warperia.setup.backup.v1' || !Array.isArray(manifest?.includedPaths)) {
            throw new Error('Invalid backup metadata schema.');
        }

        const restoredPaths = [];
        const skippedPaths = [];

        for (const relPath of manifest.includedPaths) {
            if (typeof relPath !== 'string' || !relPath.trim()) {
                continue;
            }

            const normalizedRel = relPath.replace(/\//g, path.sep);
            const sourcePath = path.join(extractDir, normalizedRel);
            const destinationPath = path.join(normalizedTargetDir, normalizedRel);

            if (!(await pathExists(sourcePath))) {
                skippedPaths.push(relPath);
                continue;
            }

            const srcStat = await fs.promises.stat(sourcePath);
            if (srcStat.isDirectory()) {
                await copyDirectoryRecursive(sourcePath, destinationPath);
            } else {
                await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
                await fs.promises.copyFile(sourcePath, destinationPath);
            }
            restoredPaths.push(relPath);
        }

        return {
            restoredPaths,
            skippedPaths,
            backupType: manifest.backupType || 'unknown',
            createdAt: manifest.createdAt || null,
            sourceWowDir: manifest.sourceWowDir || null,
        };
    } finally {
        fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
}

function isRunningAsAdmin() {
    try {
        if (process.platform === 'win32') {
            const result = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
            return result.status === 0;
        }
        return typeof process.getuid === 'function' && process.getuid() === 0;
    } catch {
        return false;
    }
}
const PRODUCTION_PORT = 9001; // Default port
const PORT_RANGE = [9001, 9002, 9003, 9004, 9005]; // Fallback ports to try

// Keep intervals for monitoring
const monitoringIntervals = new Map();

/** 
 * Session states:
 * {
 *   [exePath]: {
 *      currentlyRunning: boolean,
 *      sessionStart: Date | null
 *   }
 * }
 */
const sessionState = {};

/** 
 * If the user triggers a restart, we set pendingRestarts[exePath] = true
 * Then we skip the session-end event if the game closes while in that state.
 * Once we see the game running again, we clear that flag. 
 */
const pendingRestarts = {};

/** For production, skip sessions < 5 min. For dev, skip 0 min. */
const SKIP_MINUTES = app.isPackaged ? 5 : 0;

const FALLBACK_ALGO = 'aes-256-gcm';
const getFallbackKey = () => crypto.createHash('sha256').update(app.getPath('userData')).digest();

const encryptApiKeyFallback = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(FALLBACK_ALGO, getFallbackKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
};

const decryptApiKeyFallback = (payload) => {
    const buffer = Buffer.from(payload, 'base64');
    const iv = buffer.slice(0, 12);
    const tag = buffer.slice(12, 28);
    const data = buffer.slice(28);
    const decipher = crypto.createDecipheriv(FALLBACK_ALGO, getFallbackKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
};

function clearDevLogSync() {
    try {
        const logPath = getDevLogPath();
        if (fs.existsSync(logPath)) {
            fs.unlinkSync(logPath);
        }
    } catch {}
}

async function writeDevLog(level, message) {
    if (!devModeEnabled || !message || typeof message !== 'string') {
        return;
    }

    const levelStr = typeof level === 'number'
        ? (['verbose', 'info', 'warning', 'error'][level] || `level-${level}`)
        : String(level || 'log');
    if (levelStr.toLowerCase().includes('warn')) {
        return;
    }

    const lowerMessage = message.toLowerCase();
    if (SECURITY_KEYWORDS.some((k) => lowerMessage.includes(k))) {
        return;
    }
    if (DEV_LOG_NOISE.some((k) => lowerMessage.includes(k))) {
        return;
    }

    const sanitizedMessage = message.replace(/webpack:\/\/[^\s),]+/g, '[source]');

    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const entry = `[${timestamp}] [${levelStr.toUpperCase()}] - ${sanitizedMessage}\n`;

    try {
        const logPath = getDevLogPath();
        const entryLength = Buffer.byteLength(entry, 'utf8');
        const stats = await fs.promises.stat(logPath).catch(() => null);
        if (stats && stats.size + entryLength > MAX_DEV_LOG_SIZE) {
            await fs.promises.writeFile(logPath, entry, 'utf8');
        } else {
            await fs.promises.appendFile(logPath, entry, 'utf8');
        }
    } catch {
        // Ignore logging errors to avoid infinite loops
    }
}

/**
 * Fix cache permission issues on Windows by setting app paths early
 */
if (process.platform === 'win32') {
    const userDataPath = app.getPath('userData');
    const cachePath = path.join(userDataPath, 'WarperiaCache');
    
    try {
        if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(cachePath, { recursive: true });
        }
        app.setPath('sessionData', cachePath);
    } catch (err) {
        console.error('Error setting cache path:', err);
    }
}

/**
 * Cleanup leftover addon/mod zip downloads in userData from interrupted installs.
 */
async function cleanupStaleDownloads() {
    try {
        const userDataPath = app.getPath('userData');
        const entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
        const staleZips = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
            .map((entry) => path.join(userDataPath, entry.name));

        await Promise.all(
            staleZips.map(async (zipPath) => {
                try {
                    await fs.promises.rm(zipPath, { force: true });
                } catch (err) {
                    if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') {
                        console.error('Error deleting stale download:', zipPath, err);
                        return;
                    }
                    // File is locked or in delete-pending state - rename it out of the way
                    // so it doesn't block the next launch.
                    const trashPath = zipPath + '.__warperia_trash__' + Date.now();
                    try {
                        await fs.promises.rename(zipPath, trashPath);
                        fs.promises.rm(trashPath, { force: true }).catch(() => {});
                    } catch {
                        // Nothing more we can do; file will clear after reboot
                    }
                }
            })
        );
    } catch (err) {
        console.error('Error cleaning stale downloads:', err);
    }
}


async function initializeApp() {
    const importedStore = await import('electron-store');
    Store = importedStore.default;

    const importedIsDev = await import('electron-is-dev');
    isDev = importedIsDev.default;

    // Load configuration from config.js
    try {
        const configPath = path.join(__dirname, 'utils', 'config.js');
        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf8');
            const configMatch = configContent.match(/export const CONFIG = \{([^}]+)\};/s);
            if (configMatch) {
                const configStr = configMatch[1];
                const githubKeyMatch = configStr.match(/GITHUB_API_KEY:\s*['"]([^'"]+)['"]/);
                const backendUrlMatch = configStr.match(/BACKEND_URL:\s*['"]([^'"]+)['"]/);
                
                CONFIG = {
                    GITHUB_API_KEY: githubKeyMatch ? githubKeyMatch[1] : '',
                    BACKEND_URL: backendUrlMatch ? backendUrlMatch[1] : 'https://warperia.com/',
                };
            } else {
                throw new Error('Failed to parse config.js');
            }
        } else {
            throw new Error('config.js not found');
        }
    } catch (configErr) {
        console.error('[Config] Failed to load configuration:', configErr.message);
        CONFIG = {
            GITHUB_API_KEY: '',
            BACKEND_URL: 'https://warperia.com/',
        };
    }

    if (isDev) {
        require('electron-reload')(__dirname, {
            electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron')
        });
    }

    appStore = new Store();
    const store = appStore;
    devModeEnabled = store.get('devModeEnabled') === true;

    if (devModeEnabled) {
        const isAdmin = isRunningAsAdmin();
        await writeDevLog('info', `[Warperia] Running as administrator: ${isAdmin}`);
    }

    // ================
    // CONFIG INITIALIZATION (BACKEND_URL, GITHUB_API_KEY)
    // ================
    const initializeConfig = () => {
        try {
            const backendUrl = CONFIG.BACKEND_URL;
            const githubApiKey = CONFIG.GITHUB_API_KEY;
            
            // Initialize BACKEND_URL
            if (backendUrl && typeof backendUrl === 'string' && backendUrl.trim()) {
                const stored = store.get('config_backend_url');
                if (stored !== backendUrl.trim()) {
                    store.set('config_backend_url', backendUrl.trim());
                }
            } else {
                // Fallback to default if not set
                const stored = store.get('config_backend_url');
                if (!stored) {
                    store.set('config_backend_url', 'https://warperia.com/');
                }
            }
            
            // Initialize GITHUB_API_KEY
            if (githubApiKey && typeof githubApiKey === 'string' && githubApiKey.trim()) {
                const apiKey = githubApiKey.trim();
                const stored = store.get('config_github_token');
                
                // Decrypt stored key to compare (if it exists)
                let storedApiKey = null;
                if (stored && stored.value) {
                    try {
                        if (stored.method === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
                            storedApiKey = safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
                        } else if (stored.method === 'fallback') {
                            storedApiKey = decryptApiKeyFallback(stored.value);
                        }
                    } catch (err) {
                        // Failed to decrypt stored key, will update with new one
                    }
                }
                
                // Only update if the key has changed
                if (storedApiKey !== apiKey) {
                    let storedValue;
                    if (safeStorage.isEncryptionAvailable()) {
                        const encrypted = safeStorage.encryptString(apiKey);
                        storedValue = { method: 'safeStorage', value: encrypted.toString('base64') };
                    } else {
                        const encrypted = encryptApiKeyFallback(apiKey);
                        storedValue = { method: 'fallback', value: encrypted };
                    }
                    store.set('config_github_token', storedValue);
                }
            }
        } catch (err) {
            console.error('[Config] Error initializing config:', err);
        }
    };

    initializeConfig();

    // Clear addon cache on startup
    setTimeout(() => {
        if (mainWindow) {
            mainWindow.webContents.send('clear-addon-cache-on-startup');
        }
    }, 2000);

    // Proactively remove leftover addon/mod zip files from previous interrupted installs
    cleanupStaleDownloads();

    // ================
    // TOKEN/USER IPC
    // ================
    ipcMain.handle('store-token', async (event, token, backendUrl) => {
        if (!safeStorage.isEncryptionAvailable()) {
            return { success: false, error: 'Encryption not available' };
        }
        const encrypted = safeStorage.encryptString(token);
        store.set('auth_token', encrypted.toString('base64'));
        if (backendUrl) {
            store.set('auth_backend_url', normalizeBackendUrl(backendUrl));
        }
        return { success: true };
    });

    ipcMain.handle('retrieve-token', async () => {
        const encB64 = store.get('auth_token');
        if (encB64 && safeStorage.isEncryptionAvailable()) {
            try {
                const storedBackendUrl = normalizeBackendUrl(store.get('auth_backend_url'));
                const currentBackendUrl = normalizeBackendUrl(store.get('config_backend_url'));
                
                if (storedBackendUrl && currentBackendUrl && storedBackendUrl !== currentBackendUrl) {
                    store.delete('auth_token');
                    store.delete('auth_backend_url');
                    store.delete('user');
                    return { success: false, error: 'Backend URL changed' };
                }
                
                const enc = Buffer.from(encB64, 'base64');
                const dec = safeStorage.decryptString(enc);
                return { success: true, token: dec };
            } catch (err) {
                return { success: false, error: 'Decrypt token failed.' };
            }
        }
        return { success: false, error: 'No token' };
    });

    ipcMain.handle('clear-token', () => {
        store.delete('auth_token');
        store.delete('auth_backend_url');
        return { success: true };
    });

    // ================
    // UUID IPC
    // ================
    ipcMain.handle('store-uuid', (event, uuid) => {
        if (!uuid || typeof uuid !== 'string') {
            return { success: false, error: 'UUID is required.' };
        }

        try {
            let storedValue;
            if (safeStorage.isEncryptionAvailable()) {
                const encrypted = safeStorage.encryptString(uuid);
                storedValue = { method: 'safeStorage', value: encrypted.toString('base64') };
            } else {
                const encrypted = encryptApiKeyFallback(uuid);
                storedValue = { method: 'fallback', value: encrypted };
            }
            store.set('app_uuid_secure', storedValue);
            return { success: true, method: storedValue.method };
        } catch (err) {
            return { success: false, error: 'Unable to store UUID securely.' };
        }
    });

    ipcMain.handle('retrieve-uuid', () => {
        const stored = store.get('app_uuid_secure');
        if (!stored || !stored.value) {
            return { success: false, error: 'No UUID' };
        }

        try {
            let uuid = null;
            if (stored.method === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
                uuid = safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
            } else if (stored.method === 'fallback') {
                uuid = decryptApiKeyFallback(stored.value);
            } else if (safeStorage.isEncryptionAvailable()) {
                uuid = safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
            }

            if (uuid) {
                return { success: true, uuid };
            }
            return { success: false, error: 'UUID unavailable' };
        } catch (err) {
            return { success: false, error: 'Failed to read UUID.' };
        }
    });

    // ================
    // CONFIG IPC
    // ================
    ipcMain.handle('get-config', () => {
        try {
            const backendUrl = store.get('config_backend_url') || 'https://warperia.com/';
            const stored = store.get('config_github_token');
            
            let githubToken = '';
            if (stored && stored.value) {
                try {
                    if (stored.method === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
                        githubToken = safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
                    } else if (stored.method === 'fallback') {
                        githubToken = decryptApiKeyFallback(stored.value);
                    }
                } catch (err) {
                }
            }
            
            return {
                success: true,
                BACKEND_URL: backendUrl,
                GITHUB_TOKEN: githubToken,
                GITHUB_API_KEY: githubToken
            };
        } catch (err) {
            return {
                success: false,
                error: 'Failed to retrieve config',
                BACKEND_URL: 'https://warperia.com/',
                GITHUB_TOKEN: '',
                GITHUB_API_KEY: ''
            };
        }
    });

    ipcMain.handle('is-safe-storage-available', () => ({
        available: safeStorage.isEncryptionAvailable()
    }));

    ipcMain.handle('store-user', (event, user) => {
        store.set('user', user);
        return { success: true };
    });

    ipcMain.handle('retrieve-user', () => {
        const user = store.get('user');
        return user ? { success: true, user } : { success: false, error: 'Not found' };
    });

    ipcMain.handle('clear-user', () => {
        store.delete('user');
        return { success: true };
    });

    // ================
    // GUEST SESSION IPC
    // ================
    ipcMain.handle('store-guest-session', (event, guestData) => {
        try {
            const guestSessionPath = path.join(app.getPath('userData'), 'guest_session.json');
            fs.writeFileSync(guestSessionPath, JSON.stringify(guestData, null, 2), 'utf8');
            return { success: true };
        } catch (err) {
            console.error('Error storing guest session:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('retrieve-guest-session', () => {
        try {
            const guestSessionPath = path.join(app.getPath('userData'), 'guest_session.json');
            if (fs.existsSync(guestSessionPath)) {
                const data = fs.readFileSync(guestSessionPath, 'utf8');
                const guestData = JSON.parse(data);
                return { success: true, guestData };
            }
            return { success: false, error: 'No guest session found' };
        } catch (err) {
            console.error('Error retrieving guest session:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('clear-guest-session', () => {
        try {
            const guestSessionPath = path.join(app.getPath('userData'), 'guest_session.json');
            if (fs.existsSync(guestSessionPath)) {
                fs.unlinkSync(guestSessionPath);
            }
            return { success: true };
        } catch (err) {
            console.error('Error clearing guest session:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('check-guest-mode', () => {
        const isGuest = store.get('is_guest_mode') === true;
        return { success: true, isGuest };
    });

    ipcMain.handle('set-guest-mode', (event, isGuest) => {
        store.set('is_guest_mode', isGuest);
        return { success: true };
    });

    // ================
    // DEV MODE IPC
    // ================
    ipcMain.handle('set-dev-mode', async (event, enabled) => {
        devModeEnabled = !!enabled;
        store.set('devModeEnabled', devModeEnabled);
        if (!devModeEnabled) {
            clearDevLogSync();
        }
        return { success: true };
    });

    ipcMain.handle('get-dev-mode', () => ({ enabled: devModeEnabled }));
    ipcMain.handle('get-dev-log-path', () => getDevLogPath());

    ipcMain.on('dev-log-message', (event, level, message) => {
        writeDevLog(level, message);
    });

    ipcMain.on('download-progress', (event, progress) => {
        if (mainWindow) {
            mainWindow.webContents.send('download-progress', progress);
        }
    });

    ipcMain.handle('install-update', () => {
        app.quit();
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('get-cache-info', async () => {
        try {
            if (!mainWindow || !mainWindow.webContents.session) {
                return { totalBytes: 0, entries: [], userDataPath: app.getPath('userData') };
            }

            const session = mainWindow.webContents.session;
            const userDataPath = app.getPath('userData');

            const electronCacheSize = await session.getCacheSize();

            let tempZipSize = 0;
            try {
                const entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
                const zipFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'));
                
                for (const zipFile of zipFiles) {
                    const zipPath = path.join(userDataPath, zipFile.name);
                    const stats = await fs.promises.stat(zipPath);
                    tempZipSize += stats.size;
                }
            } catch (err) {
                console.error('Error reading temp zip files:', err);
            }

            const entries = [];
            
            if (electronCacheSize > 0) {
                entries.push({
                    name: 'Application Cache',
                    size: electronCacheSize,
                    type: 'Electron Session Cache'
                });
            }

            if (tempZipSize > 0) {
                entries.push({
                    name: 'Temporary Addon Files',
                    size: tempZipSize,
                    type: 'Download Cache'
                });
            }

            const totalBytes = electronCacheSize + tempZipSize;

            return { 
                totalBytes, 
                entries, 
                userDataPath 
            };
        } catch (err) {
            console.error('Error getting cache info:', err);
            return { totalBytes: 0, entries: [], userDataPath: app.getPath('userData') };
        }
    });

    ipcMain.handle('clear-cache', async () => {
        try {
            if (!mainWindow || !mainWindow.webContents.session) {
                return { freedBytes: 0, remainingBytes: 0, failed: [] };
            }

            const session = mainWindow.webContents.session;
            const userDataPath = app.getPath('userData');
            let totalFreedBytes = 0;
            const failed = [];

            const initialSize = await session.getCacheSize();

            await session.clearCache();
            await session.clearStorageData({
                storages: ['appcache', 'cachestorage', 'serviceworkers', 'cookies']
            });

            const finalSize = await session.getCacheSize();
            const sessionFreed = Math.max(0, initialSize - finalSize);
            totalFreedBytes += sessionFreed;

            try {
                const entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
                const zipFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'));
                
                for (const zipFile of zipFiles) {
                    try {
                        const zipPath = path.join(userDataPath, zipFile.name);
                        const stats = await fs.promises.stat(zipPath);
                        await fs.promises.unlink(zipPath);
                        totalFreedBytes += stats.size;
                    } catch (err) {
                        console.error('Failed to delete temp file:', zipFile.name, err);
                        failed.push(zipFile.name);
                    }
                }
            } catch (err) {
                console.error('Error cleaning temp zip files:', err);
            }

            return { 
                freedBytes: totalFreedBytes, 
                remainingBytes: finalSize, 
                failed 
            };
        } catch (err) {
            console.error('Error clearing cache:', err);
            return { freedBytes: 0, remainingBytes: 0, failed: ['Error clearing cache'] };
        }
    });

    // In production, start local HTTP server before creating window
    if (!isDev) {
        startLocalServer()
            .then((result) => {
                localServer = result.server;
                activePort = result.port;
                createMainWindow();
                setupAutoUpdater();
            })
            .catch((err) => {
                console.error('Failed to start local server:', err);
                dialog.showErrorBox(
                    'Server Error',
                    `Failed to start internal server. ${err.message || 'Please try again.'}`
                );
                app.quit();
            });
    } else {
        createMainWindow();
        setupAutoUpdater();
    }
}

/**
 * Try to start server on a specific port
 */
function tryPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} is in use, trying next port...`);
                reject(err);
            } else {
                console.error('Server error:', err);
                reject(err);
            }
        };

        server.once('error', onError);
        
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onError);
            console.log(`Local server started at http://localhost:${port}`);
            resolve(port);
        });
    });
}

/**
 * START LOCAL HTTP SERVER
 * Automatically tries alternative ports if default is in use
 */
async function startLocalServer() {
    const distPath = path.join(app.getAppPath(), 'dist');
    
    const server = http.createServer((req, res) => {
        // Parse URL
        const parsedUrl = url.parse(req.url);
        let pathname = parsedUrl.pathname;
        
        // Default to index.html
        if (pathname === '/') {
            pathname = '/index.html';
        }
        
        // Build file path
        let filePath = path.join(distPath, pathname);
        
        // Security: prevent directory traversal
        const normalizedPath = path.normalize(filePath);
        if (!normalizedPath.startsWith(distPath)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        
        // Read and serve file
        fs.readFile(filePath, (err, data) => {
            if (err) {
                // Try serving index.html for SPA routing
                if (err.code === 'ENOENT') {
                    filePath = path.join(distPath, 'index.html');
                    fs.readFile(filePath, (err2, data2) => {
                        if (err2) {
                            res.writeHead(404);
                            res.end('Not Found');
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(data2);
                    });
                    return;
                }
                res.writeHead(500);
                res.end('Internal Server Error');
                return;
            }
            
            // Determine content type
            const ext = path.extname(filePath);
            const contentType = mime.lookup(ext) || 'application/octet-stream';
            
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    });
    
    // Try ports in sequence until one succeeds
    for (const port of PORT_RANGE) {
        try {
            const boundPort = await tryPort(server, port);
            activePort = boundPort;
            return { server, port: boundPort };
        } catch (err) {
            // If this was the last port in the range, throw error
            if (port === PORT_RANGE[PORT_RANGE.length - 1]) {
                throw new Error(`Failed to start server. All ports (${PORT_RANGE.join(', ')}) are in use.`);
            }
            // Otherwise, continue to next port
        }
    }
}

/** 
 * CREATE MAIN WINDOW
 */
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        icon: path.join(__dirname, '../assets/icon.png'),
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#121212',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: true,
            nodeIntegrationInWorker: true,
            contextIsolation: true,
            devTools: false,
            webSecurity: false,
            partition: 'persist:warperia'
        }
    });

    mainWindow.setMinimumSize(1280, 720);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:9000').catch((error) => {
            console.error('Failed to load dev URL:', error);
            dialog.showErrorBox(
                'App Load Error',
                'Check dev server is running.'
            );
        });
    } else {
        // In production, load from local HTTP server
        // Uses activePort which is determined at runtime (tries 9001-9005)
        mainWindow.loadURL(`http://localhost:${activePort}`).catch((error) => {
            console.error('Failed to load from local server:', error);
            dialog.showErrorBox(
                'App Load Error',
                'Please contact support.'
            );
        });
    }

    ipcMain.handle('show-open-dialog', async (event, opts) => {
        const result = await dialog.showOpenDialog(mainWindow, opts);
        return result.filePaths;
    });

    ipcMain.handle('open-directory', async (event, directoryPath) => {
        try {
            const norm = path.normalize(directoryPath);
            const out = await shell.openPath(norm);
            if (out) {
                console.error('[open-directory] shell.openPath error:', out);
            }
        } catch (err) {
            console.error('[open-directory] error:', err);
        }
    });

    ipcMain.handle('show-item-in-folder', async (event, filePath) => {
        try {
            if (!filePath || typeof filePath !== 'string') {
                return { success: false, error: 'Invalid path' };
            }
            shell.showItemInFolder(path.normalize(filePath));
            return { success: true };
        } catch (err) {
            console.error('[show-item-in-folder] error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('open-external-url', async (event, url) => {
        try {
            if (!url || typeof url !== 'string') {
                return { success: false, error: 'Invalid URL' };
            }
            
            const parsedUrl = new URL(url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return { success: false, error: 'Invalid URL protocol' };
            }
            
            await shell.openExternal(url);
            return { success: true };
        } catch (err) {
            console.error('[open-external-url] error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('set-window-background', (event, color) => {
        try {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return { success: false, error: 'Window not available' };
            }
            if (typeof color !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
                return { success: false, error: 'Invalid color' };
            }
            mainWindow.setBackgroundColor(color);
            return { success: true };
        } catch (err) {
            console.error('[set-window-background] error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('setup-manager-export', async (event, payload = {}) => {
        try {
            const sourceWowDir = resolveSafePath(payload.sourceWowDir);
            const backupType = payload.backupType === 'simple' ? 'simple' : 'full';
            if (!sourceWowDir) {
                return { success: false, message: 'Invalid source directory.' };
            }

            if (!(await pathExists(sourceWowDir))) {
                return { success: false, message: 'Selected source directory does not exist.' };
            }

            const defaultName = `warperia-setup-${backupType}-${formatTimestampForFile()}.zip`;
            const saveResult = await dialog.showSaveDialog(mainWindow, {
                title: 'Save Warperia Setup Backup',
                defaultPath: path.join(sourceWowDir, defaultName),
                filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
                properties: ['createDirectory', 'showOverwriteConfirmation'],
            });

            if (saveResult.canceled || !saveResult.filePath) {
                return { success: false, canceled: true };
            }

            const backupInfo = await createSetupBackupZip({
                sourceWowDir,
                backupType,
                destinationZipPath: saveResult.filePath,
                appVersion: app.getVersion(),
                onProgress: (percent) => {
                    event.sender.send('setup-manager-export-progress', { percent });
                },
            });

            return { success: true, ...backupInfo };
        } catch (err) {
            console.error('[setup-manager-export] error:', err);
            return {
                success: false,
                message: err?.message || 'Failed to create setup backup.',
                errorCode: err?.code || null,
            };
        }
    });

    ipcMain.handle('setup-manager-import', async (_event, payload = {}) => {
        try {
            const zipPath = resolveSafePath(payload.zipPath);
            const targetWowDir = resolveSafePath(payload.targetWowDir);

            if (!zipPath || !targetWowDir) {
                return { success: false, message: 'Invalid backup file path or target directory.' };
            }

            const importInfo = await importSetupBackupZip({ zipPath, targetWowDir });
            return { success: true, ...importInfo };
        } catch (err) {
            console.error('[setup-manager-import] error:', err);
            return {
                success: false,
                message: err?.message || 'Failed to import setup backup.',
                errorCode: err?.code || null,
            };
        }
    });

    ipcMain.on('get-user-data-path', (event) => {
        event.returnValue = app.getPath('userData');
    });

    ipcMain.on('window-control', (event, action) => {
        const focused = BrowserWindow.getFocusedWindow();
        if (!focused) return;

        switch (action) {
            case 'refresh':
                mainWindow.reload();
                break;
            case 'minimize':
                focused.minimize();
                break;
            case 'maximize':
                if (focused.isMaximized()) {
                    focused.unmaximize();
                } else {
                    focused.maximize();
                }
                break;
            case 'close':
                focused.close();
                break;
            case 'back':
                if (focused.webContents.canGoBack()) {
                    focused.webContents.goBack();
                }
                break;
            case 'forward':
                if (focused.webContents.canGoForward()) {
                    focused.webContents.goForward();
                }
                break;
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (e, navUrl) => {
        // Allow localhost URLs (dev server on 9000, production server on activePort) and file://
        const allowedUrls = [
            'http://localhost:9000',
            'http://127.0.0.1:9000',
        ];
        
        // In production, add the active port to allowed URLs
        if (activePort) {
            allowedUrls.push(`http://localhost:${activePort}`);
            allowedUrls.push(`http://127.0.0.1:${activePort}`);
        }
        
        const isLocalhost = allowedUrls.some(url => navUrl.startsWith(url));
        const isFile = navUrl.startsWith('file://');
        
        if (!isLocalhost && !isFile) {
            e.preventDefault();
            shell.openExternal(navUrl);
        }
    });
}

ipcMain.on('process-status-update', (event, status) => {
    if (mainWindow) {
        mainWindow.webContents.send('process-status-update', status);
    }
});

/* =========================================
   LIST PROCESSES using Powershell
*/
function listProcessesWithPaths() {
    if (process.platform !== 'win32') {
        return Promise.resolve([]);
    }

    // PowerShell command that outputs JSON
    const script = `Get-WmiObject Win32_Process | Select ProcessId, ExecutablePath | ConvertTo-Json`;

    return new Promise((resolve) => {
        const ps = spawn('powershell', ['-command', script], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        ps.stdout.on('data', (chunk) => {
            stdout += chunk;
        });

        ps.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        ps.on('close', (code) => {
            if (stderr && stderr.trim()) {
                console.error('[listProcessesWithPaths] PowerShell error:', stderr);
            }
            if (!stdout) {
                console.warn('[listProcessesWithPaths] PowerShell returned empty stdout. Possibly no processes or missing PowerShell?');
                return resolve([]);
            }

            let parsed;
            try {
                parsed = JSON.parse(stdout);
            } catch (err) {
                console.error('[listProcessesWithPaths] invalid JSON output from PowerShell:', err);
                return resolve([]);
            }

            // Convert single object to array if needed
            if (!Array.isArray(parsed)) {
                parsed = [parsed];
            }

            const results = [];
            for (const item of parsed) {
                const exePath = item.ExecutablePath;
                const pid = item.ProcessId;
                if (exePath && pid) {
                    results.push({ pid, exePath });
                }
            }
            resolve(results);
        });
    });
}

/* 
   isGameRunning => same fallback approach
*/
async function isGameRunning(exePath) {
    const all = await listProcessesWithPaths();
    const serverDir = path.normalize(path.dirname(exePath)).toLowerCase();
    const serverExeName = path.basename(exePath).toLowerCase();
    const baseName = serverExeName.replace(/\.exe$/i, '');

    // exact
    const exact = all.find(proc => {
        const norm = path.normalize(proc.exePath || '').toLowerCase();
        if (!norm.startsWith(serverDir)) return false;
        return (path.basename(norm) === serverExeName);
    });
    if (exact) return true;

    // fallback
    const fallback = all.find(proc => {
        const norm = path.normalize(proc.exePath || '').toLowerCase();
        if (!norm.startsWith(serverDir)) return false;
        return path.basename(norm).startsWith(baseName);
    });
    if (fallback) return true;

    return false;
}

/*
   findMatchingPIDsForExe => KILL fallback logic
   so if user typed "Wow.exe" but real is "Wow-64.exe"
*/
async function findMatchingPIDsForExe(exePath) {
    const all = await listProcessesWithPaths();
    const serverDir = path.normalize(path.dirname(exePath)).toLowerCase();
    const serverExeName = path.basename(exePath).toLowerCase();
    const baseName = serverExeName.replace(/\.exe$/i, '');

    // 1) exact
    let matched = all.filter(proc => {
        const norm = path.normalize(proc.exePath || '').toLowerCase();
        if (!norm.startsWith(serverDir)) return false;
        return path.basename(norm) === serverExeName;
    });
    if (matched.length > 0) {
        return matched.map(m => m.pid);
    }

    // 2) startsWith fallback
    matched = all.filter(proc => {
        const norm = path.normalize(proc.exePath || '').toLowerCase();
        if (!norm.startsWith(serverDir)) return false;
        return path.basename(norm).startsWith(baseName);
    });
    if (matched.length > 0) {
        return matched.map(m => m.pid);
    }

    // 3) final includes fallback
    matched = all.filter(proc => {
        const norm = path.normalize(proc.exePath || '').toLowerCase();
        if (!norm.startsWith(serverDir)) return false;
        return path.basename(norm).includes(baseName);
    });
    return matched.map(m => m.pid);
}

// Handler for restarting the game exe
ipcMain.handle('restart-exe', async (event, exePath) => {
    try {
        // Mark pending restart
        pendingRestarts[exePath] = true;

        // Find all PIDs to kill in that folder
        const matchedPIDs = await findMatchingPIDsForExe(exePath);
        console.log('[restart-exe] matchedPIDs:', matchedPIDs);

        // If none found, we'll just spawn a new instance
        if (matchedPIDs.length === 0) {
            console.log('[restart-exe] No running process found, just launching new...');
            spawn(exePath, { detached: true, stdio: 'ignore' }).unref();
            return { success: true, message: 'Launched new instance.' };
        }

        // Kill them all
        for (const pid of matchedPIDs) {
            spawnSync('taskkill', ['/PID', String(pid), '/F']);
        }

        // After short delay, spawn the typed exe
        setTimeout(() => {
            console.log(`[restart-exe] Re-launching ${exePath} after kill...`);
            spawn(exePath, { detached: true, stdio: 'ignore' }).unref();
        }, 1000);

        return { success: true, message: `Restarted. Killed ${matchedPIDs.length} processes.` };
    } catch (err) {
        console.error('[restart-exe] Error:', err);
        return { success: false, error: err.message };
    }
});

/* ====================================
   SESSION FILES
*/
function getSessionsFilePath(exePath) {
    const serverDir = path.dirname(exePath);
    const sessionsDir = path.join(serverDir, 'GameSessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }
    return path.join(sessionsDir, 'sessions.json');
}
function loadSessionsFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Error loading sessions file:', err);
        return [];
    }
}
function saveSessionsFile(filePath, sessions) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (err) {
        console.error('Error saving sessions file:', err);
    }
}
function saveSessionToFile(exePath, sessionObj) {
    const filePath = getSessionsFilePath(exePath);
    const sessions = loadSessionsFile(filePath);
    sessions.push(sessionObj);
    saveSessionsFile(filePath, sessions);
}

// IPC to load / delete / clear sessions
ipcMain.handle('load-sessions', (event, exePath) => {
    const filePath = getSessionsFilePath(exePath);
    return loadSessionsFile(filePath);
});
ipcMain.handle('delete-session', (event, { exePath, index }) => {
    const filePath = getSessionsFilePath(exePath);
    const sessions = loadSessionsFile(filePath);
    if (index >= 0 && index < sessions.length) {
        sessions.splice(index, 1);
        saveSessionsFile(filePath, sessions);
    }
    return sessions;
});
ipcMain.handle('clear-sessions', (event, exePath) => {
    const filePath = getSessionsFilePath(exePath);
    saveSessionsFile(filePath, []);
    return [];
});
ipcMain.on('update-realmlist', (event, { exePath, realmlist }) => {
    // If we already have a sessionState for this exePath, store it
    // so that when the session ends, we can include that realmlist.
    if (!sessionState[exePath]) {
        sessionState[exePath] = {
            currentlyRunning: false,
            sessionStart: null,
            realmlist: ''
        };
    }
    sessionState[exePath].realmlist = realmlist || '';
});

/* ====================================
   START MONITORING => doCheck => 
   skip session end if pendingRestarts[exePath] is true
*/
ipcMain.on('start-process-monitoring', (event, { exePath, serverId, intervalMs = 5000 }) => {
    if (monitoringIntervals.has(exePath)) {
        clearInterval(monitoringIntervals.get(exePath));
        monitoringIntervals.delete(exePath);
    }

    if (!sessionState[exePath]) {
        sessionState[exePath] = {
            currentlyRunning: false,
            sessionStart: null
        };
    }

    // Make doCheck async so we can await isGameRunning
    const doCheck = async () => {
        const isRunning = await isGameRunning(exePath);
        const st = sessionState[exePath];

        if (!st.currentlyRunning && isRunning) {
            // game just launched (or re-launched)
            st.currentlyRunning = true;

            // If we previously set pendingRestarts[exePath], that means we just re-launched after a restart
            // => continue the session, do not create a new start time
            if (pendingRestarts[exePath] && st.sessionStart) {
                console.log('[SESSION] Resuming session after restart for', exePath);
                // Clear pending restart
                delete pendingRestarts[exePath];
            } else {
                // normal launch
                st.sessionStart = new Date();
                console.log('[SESSION] Game started at', st.sessionStart);
            }
        }
        else if (st.currentlyRunning && !isRunning) {
            // game just closed
            // check if we are skipping because user triggered a restart
            if (pendingRestarts[exePath]) {
                // skip ending session
                st.currentlyRunning = false;
                // do NOT reset sessionStart - so we keep counting
                return;
            }

            // normal closure => end session
            const sessionEnd = new Date();
            const sessionStart = st.sessionStart || new Date();
            st.currentlyRunning = false;
            st.sessionStart = null;

            // compute duration
            const ms = sessionEnd - sessionStart;
            const minutes = ms / 1000 / 60;

            if (minutes >= SKIP_MINUTES) {
                const realmlist = st.realmlist || '';

                const sessionObj = {
                    startTime: sessionStart.toISOString(),
                    endTime: sessionEnd.toISOString(),
                    durationMinutes: Math.round(minutes * 100) / 100,
                    realmlist
                };

                saveSessionToFile(exePath, sessionObj);

                if (mainWindow) {
                    mainWindow.webContents.send('session-ended', {
                        exePath,
                        serverId,
                        session: sessionObj
                    });
                }
            }

            // Restore the backup of Config.wtf after the game closes
            const configPath = path.join(path.dirname(exePath), 'WTF', 'Config.wtf');
            const backupPath = path.join(path.dirname(exePath), 'WTF', 'Config.wtf.backup');

            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, configPath);
                fs.unlinkSync(backupPath);
            }
        }

        // normal process-status
        if (mainWindow) {
            mainWindow.webContents.send('process-status-update', {
                exePath,
                serverId,
                running: isRunning
            });
        }
    };

    // Run it once right away
    doCheck();

    // Then run at the given interval
    const handle = setInterval(() => {
        doCheck();
    }, intervalMs);

    monitoringIntervals.set(exePath, handle);
});

ipcMain.on('stop-process-monitoring', (event, { exePath }) => {
    if (monitoringIntervals.has(exePath)) {
        clearInterval(monitoringIntervals.get(exePath));
        monitoringIntervals.delete(exePath);
    }
});

/**
 * SETUP AUTO UPDATER
 */
function setupAutoUpdater() {
    // Set logger
    autoUpdater.logger = require("electron-log");
    autoUpdater.logger.transports.file.level = "info";
    autoUpdater.logger.transports.console.level = "info";

    // Listen for update events
    autoUpdater.on('checking-for-update', () => {
        console.log('Checking for updates...');
        mainWindow.webContents.send('update-checking');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info);
        mainWindow.webContents.send('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('No updates available.');
        mainWindow.webContents.send('update-not-available', info);
    });

    autoUpdater.on('error', (err) => {
        console.error('Error in auto-updater:', err);
        mainWindow.webContents.send('update-error', err.message);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        let log_message = `Download speed: ${progressObj.bytesPerSecond}`;
        log_message += ` - Downloaded ${progressObj.percent}%`;
        log_message += ` (${progressObj.transferred}/${progressObj.total})`;
        console.log(log_message);
        mainWindow.webContents.send('update-progress', progressObj.percent);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('Update downloaded:', info);
        mainWindow.webContents.send('update-downloaded', info);
        // Attempt to automatically install the update
        autoUpdater.quitAndInstall(false, true);
    });

    // Check for updates after window is ready
    autoUpdater.checkForUpdatesAndNotify();
}

/* APP EVENTS */
app.on('ready', initializeApp);

ipcMain.handle('get-app-version', () => {
    return { version: app.getVersion() };
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // Clean up local server if running
    if (localServer) {
        localServer.close(() => {
            console.log('Local server stopped');
        });
    }
    // Wipe dev-mode log on shutdown
    clearDevLogSync();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        initializeApp();
    }
});
