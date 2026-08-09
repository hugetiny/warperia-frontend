import React, { useState, useEffect } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import { WEB_URL } from "./config.js";

const Settings = ({ user, showToast, onLogout, initialTab = "general" }) => {
  const [activeTab, setActiveTab] = useState(initialTab);

  // User details state
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isGuest, setIsGuest] = useState(false);

  // General settings state
  const [defaultStartupPage, setDefaultStartupPage] = useState("servers");
  const [silentUpdates, setSilentUpdates] = useState(false);
  const [silentUpdatesInterval, setSilentUpdatesInterval] = useState("6");
  const [devMode, setDevMode] = useState(false);
  const [devLogPath, setDevLogPath] = useState("");
  const [cacheSize, setCacheSize] = useState("Calculating...");
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [appVersion, setAppVersion] = useState("1.7.5");

  // Setup Manager state
  const [servers, setServers] = useState([]);
  const [sourceServerId, setSourceServerId] = useState("");
  const [targetServerId, setTargetServerId] = useState("");
  const [backupType, setBackupType] = useState("simple"); // "simple" | "full"
  const [backupZipPath, setBackupZipPath] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Load configured servers from localStorage / electron
  useEffect(() => {
    try {
      const savedServers = JSON.parse(localStorage.getItem("servers") || "[]");
      if (Array.isArray(savedServers) && savedServers.length > 0) {
        setServers(savedServers);
        setSourceServerId(savedServers[0].id || "");
        setTargetServerId(savedServers[0].id || "");
      }
    } catch (e) {
      console.error("Error reading saved servers:", e);
    }
  }, []);

  // Fetch user details & guest mode
  useEffect(() => {
    const fetchUserDetails = async () => {
      try {
        if (window.electron && typeof window.electron.checkGuestMode === "function") {
          const guestResult = await window.electron.checkGuestMode();
          if (guestResult && guestResult.isGuest) {
            setIsGuest(true);
          }
        }

        if (user && user.id) {
          const tokenResult = await window.electron.retrieveToken();
          if (tokenResult.success && tokenResult.token) {
            const response = await axios.get(
              `${WEB_URL}/wp-json/wp/v2/users/${user.id}`,
              {
                headers: {
                  Authorization: `Bearer ${tokenResult.token}`,
                },
              }
            );

            if (response.data) {
              setDisplayName(response.data.display_name || "");
              setUsername(response.data.username || "");
              setEmail(response.data.email || "");
            }
          }
        }
      } catch (error) {
        console.error("Error fetching user details:", error);
      }
    };

    fetchUserDetails();
  }, [user]);

  // Load General Settings (Cache, DevMode, StartupPage, CompactMode, AppVersion)
  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Startup Page
        const savedStartup = localStorage.getItem("defaultStartupPage");
        if (savedStartup) setDefaultStartupPage(savedStartup);

        // Silent Updates
        const savedSilent = localStorage.getItem("silentUpdates");
        if (savedSilent !== null) setSilentUpdates(savedSilent === "true");
        const savedInterval = localStorage.getItem("silentUpdatesInterval");
        if (savedInterval) setSilentUpdatesInterval(savedInterval);

        // Compact Mode
        const savedCompact = localStorage.getItem("compactMode");
        if (savedCompact !== null) setCompactMode(savedCompact === "true");

        // Dev Mode & Log Path
        if (window.electron && typeof window.electron.getDevMode === "function") {
          const devResult = await window.electron.getDevMode();
          if (devResult) setDevMode(Boolean(devResult.enabled));
        }
        if (window.electron && typeof window.electron.getDevLogPath === "function") {
          const pathResult = await window.electron.getDevLogPath();
          if (pathResult && pathResult.path) setDevLogPath(pathResult.path);
        }

        // App Version
        if (window.electron && typeof window.electron.getAppVersion === "function") {
          const verResult = await window.electron.getAppVersion();
          if (verResult && verResult.version) setAppVersion(verResult.version);
        }

        // Cache Size
        await fetchCacheInfo();
      } catch (err) {
        console.error("Error loading settings:", err);
      }
    };

    loadSettings();
  }, []);

  const fetchCacheInfo = async () => {
    try {
      if (window.electron && typeof window.electron.getCacheInfo === "function") {
        const info = await window.electron.getCacheInfo();
        if (info && typeof info.totalBytes === "number") {
          const mb = (info.totalBytes / (1024 * 1024)).toFixed(2);
          setCacheSize(`${mb} MB`);
        } else {
          setCacheSize("0 MB");
        }
      }
    } catch (e) {
      console.error("Error getting cache info:", e);
      setCacheSize("Unknown");
    }
  };

  const handleClearCache = async () => {
    try {
      setIsClearingCache(true);
      if (window.electron && typeof window.electron.clearCache === "function") {
        const res = await window.electron.clearCache();
        if (res && res.success) {
          if (showToast) showToast(`Cache cleared! Freed ${res.clearedMb || "0"} MB space.`, "success");
        } else {
          if (showToast) showToast("Cache cleared.", "success");
        }
        await fetchCacheInfo();
      }
    } catch (e) {
      console.error("Error clearing cache:", e);
      if (showToast) showToast("Failed to clear cache.", "danger");
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleToggleDevMode = async (enabled) => {
    try {
      setDevMode(enabled);
      if (window.electron && typeof window.electron.setDevMode === "function") {
        await window.electron.setDevMode(enabled);
        if (showToast) {
          showToast(enabled ? "Developer mode enabled." : "Developer mode disabled.", "info");
        }
      }
    } catch (e) {
      console.error("Error setting dev mode:", e);
    }
  };

  const handleOpenLogFolder = async () => {
    try {
      if (devLogPath && window.electron && typeof window.electron.showItemInFolder === "function") {
        await window.electron.showItemInFolder(devLogPath);
      } else if (showToast) {
        showToast("Log file path not available.", "warning");
      }
    } catch (e) {
      console.error("Error opening log file location:", e);
    }
  };

  const handleStartupPageChange = (val) => {
    setDefaultStartupPage(val);
    localStorage.setItem("defaultStartupPage", val);
    if (showToast) showToast("Startup page preference saved.", "success");
  };

  const handleSilentUpdatesChange = (enabled) => {
    setSilentUpdates(enabled);
    localStorage.setItem("silentUpdates", enabled ? "true" : "false");
    if (showToast) showToast("Background update preference updated.", "info");
  };

  const handleSilentIntervalChange = (val) => {
    setSilentUpdatesInterval(val);
    localStorage.setItem("silentUpdatesInterval", val);
    if (showToast) showToast("Update check interval saved.", "info");
  };

  const handleCompactModeChange = (enabled) => {
    setCompactMode(enabled);
    localStorage.setItem("compactMode", enabled ? "true" : "false");
    if (showToast) showToast("Compact mode preference updated.", "info");
  };

  // Setup Manager: Export Backup
  const handleExportBackup = async () => {
    const selectedServer = servers.find((s) => s.id === sourceServerId);
    if (!selectedServer || !selectedServer.gameDir) {
      if (showToast) showToast("Please select a valid WoW installation with a game directory configured.", "warning");
      return;
    }

    try {
      setIsExporting(true);
      setExportProgress(0);

      // Listen for progress if available
      let removeProgressListener = null;
      if (window.electron && typeof window.electron.onSetupExportProgress === "function") {
        removeProgressListener = window.electron.onSetupExportProgress((progress) => {
          setExportProgress(Math.round(progress * 100));
        });
      }

      const result = await window.electron.exportSetupBackup({
        sourceWowDir: selectedServer.gameDir,
        backupType: backupType, // "simple" | "full"
      });

      if (removeProgressListener) removeProgressListener();

      if (result && result.success) {
        if (showToast) showToast(`Backup created successfully at: ${result.zipPath}`, "success");
      } else {
        if (showToast) showToast(result?.error || "Backup export failed or was cancelled.", "danger");
      }
    } catch (e) {
      console.error("Error exporting backup:", e);
      if (showToast) showToast("Failed to create backup.", "danger");
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  // Setup Manager: Select zip and Import Backup
  const handleSelectBackupZip = async () => {
    try {
      if (window.electron && typeof window.electron.showOpenDialog === "function") {
        const dialogResult = await window.electron.showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "Zip Archives", extensions: ["zip"] }],
        });

        if (dialogResult && !dialogResult.canceled && dialogResult.filePaths && dialogResult.filePaths.length > 0) {
          setBackupZipPath(dialogResult.filePaths[0]);
        }
      }
    } catch (e) {
      console.error("Error choosing zip file:", e);
    }
  };

  const handleImportBackup = async () => {
    if (!backupZipPath) {
      if (showToast) showToast("Please select a backup .zip file to import.", "warning");
      return;
    }

    const selectedServer = servers.find((s) => s.id === targetServerId);
    if (!selectedServer || !selectedServer.gameDir) {
      if (showToast) showToast("Please select a valid target WoW installation.", "warning");
      return;
    }

    try {
      setIsImporting(true);
      const result = await window.electron.importSetupBackup({
        zipPath: backupZipPath,
        targetWowDir: selectedServer.gameDir,
      });

      if (result && result.success) {
        if (showToast) showToast("Backup imported successfully into target installation!", "success");
        setBackupZipPath("");
      } else {
        if (showToast) showToast(result?.error || "Backup import failed.", "danger");
      }
    } catch (e) {
      console.error("Error importing backup:", e);
      if (showToast) showToast("Failed to import backup.", "danger");
    } finally {
      setIsImporting(false);
    }
  };

  // Account: Update Display Name
  const handleDisplayNameChange = async () => {
    if (!displayName.trim()) {
      if (showToast) showToast("Display name cannot be empty.", "danger");
      return;
    }

    try {
      const tokenResult = await window.electron.retrieveToken();
      if (tokenResult.success && tokenResult.token) {
        const response = await axios.post(
          `${WEB_URL}/wp-json/wp/v2/users/update-display-name`,
          {
            display_name: displayName.trim(),
          },
          {
            headers: {
              Authorization: `Bearer ${tokenResult.token}`,
            },
          }
        );

        if (response.data && response.data.message) {
          if (showToast) showToast(response.data.message, "success");
        }
      } else {
        if (showToast) showToast("Failed to retrieve token.", "danger");
      }
    } catch (error) {
      if (showToast) showToast("Failed to update display name.", "danger");
      console.error("Error updating display name:", error);
    }
  };

  // Account: Change Password
  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      if (showToast) showToast("All password fields are required.", "danger");
      return;
    }

    if (newPassword !== confirmPassword) {
      if (showToast) showToast("New passwords do not match.", "danger");
      return;
    }

    if (newPassword.length < 6) {
      if (showToast) showToast("Password must be at least 6 characters long.", "danger");
      return;
    }

    try {
      const tokenResult = await window.electron.retrieveToken();
      if (tokenResult.success && tokenResult.token) {
        const response = await axios.post(
          `${WEB_URL}/wp-json/wp/v2/users/change-password`,
          {
            current_password: currentPassword,
            new_password: newPassword,
            confirm_password: confirmPassword,
          },
          {
            headers: {
              Authorization: `Bearer ${tokenResult.token}`,
            },
          }
        );

        if (response.data && response.data.message) {
          if (showToast) showToast(response.data.message, "success");
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        }
      } else {
        if (showToast) showToast("Failed to retrieve token.", "danger");
      }
    } catch (error) {
      if (showToast) showToast(
        "Failed to change password. Please double-check your information and try again.",
        "danger"
      );
      console.error("Error changing password:", error);
    }
  };

  return (
    <div className="settings py-4">
      <div className="container-fluid">
        {/* Settings Header Tabs */}
        <div className="d-flex justify-content-between align-items-center mb-4 pb-2 border-bottom border-secondary">
          <h4 className="mb-0 fw-bold">⚙️ Settings</h4>
          <ul className="nav nav-pills">
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "general" ? "active" : "text-white"}`}
                onClick={() => setActiveTab("general")}
              >
                <i className="bi bi-sliders me-1"></i> General
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "setupManager" ? "active" : "text-white"}`}
                onClick={() => setActiveTab("setupManager")}
              >
                <i className="bi bi-box-seam me-1"></i> Set-up Manager
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "account" ? "active" : "text-white"}`}
                onClick={() => setActiveTab("account")}
              >
                <i className="bi bi-person me-1"></i> Account
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "appearance" ? "active" : "text-white"}`}
                onClick={() => setActiveTab("appearance")}
              >
                <i className="bi bi-palette me-1"></i> Appearance
              </button>
            </li>
          </ul>
        </div>

        {/* TAB 1: GENERAL */}
        {activeTab === "general" && (
          <div className="d-flex flex-column gap-4">
            {/* Startup Page Selection */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">🚀 Startup Page</h5>
              <p className="text-muted small mb-3">
                Select which page should load automatically when you start Warperia.
              </p>
              <div className="row g-3 align-items-center" style={{ maxWidth: "500px" }}>
                <div className="col-8">
                  <select
                    className="form-select bg-dark text-white border-secondary"
                    value={defaultStartupPage}
                    onChange={(e) => handleStartupPageChange(e.target.value)}
                  >
                    <option value="servers">Servers List</option>
                    {servers.map((s) => (
                      <option key={s.id} value={`server-${s.id}`}>
                        {s.name || `Server ${s.id}`} ({s.expansion || "3.3.5a"})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Silent Background Updates */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">🔄 Silent Background Updates</h5>
              <p className="text-muted small mb-3">
                Automatically check and download addon updates in the background without interrupting your game.
              </p>
              <div className="form-check form-switch mb-3">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="silentUpdatesToggle"
                  checked={silentUpdates}
                  onChange={(e) => handleSilentUpdatesChange(e.target.checked)}
                />
                <label className="form-check-label fw-medium" htmlFor="silentUpdatesToggle">
                  Enable background addon updates
                </label>
              </div>
              {silentUpdates && (
                <div className="row g-3 align-items-center" style={{ maxWidth: "500px" }}>
                  <div className="col-auto">
                    <label className="text-muted small">Check Interval:</label>
                  </div>
                  <div className="col-auto">
                    <select
                      className="form-select form-select-sm bg-dark text-white border-secondary"
                      value={silentUpdatesInterval}
                      onChange={(e) => handleSilentIntervalChange(e.target.value)}
                    >
                      <option value="1">Every 1 hour</option>
                      <option value="6">Every 6 hours</option>
                      <option value="12">Every 12 hours</option>
                      <option value="24">Every 24 hours</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Developer Mode & Support Logs */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">🛠️ Developer Mode & Support Logs</h5>
              <p className="text-muted small mb-3">
                Enables verbose logging to disk for troubleshooting and diagnosing addon installation or API issues.
              </p>
              <div className="form-check form-switch mb-3">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="devModeToggle"
                  checked={devMode}
                  onChange={(e) => handleToggleDevMode(e.target.checked)}
                />
                <label className="form-check-label fw-medium" htmlFor="devModeToggle">
                  Enable Developer Mode
                </label>
              </div>
              {devLogPath && (
                <div className="d-flex flex-column gap-2">
                  <div className="small text-muted font-monospace text-break bg-black p-2 rounded border border-secondary">
                    📄 {devLogPath}
                  </div>
                  <div>
                    <button
                      className="btn btn-outline-info btn-sm"
                      onClick={handleOpenLogFolder}
                    >
                      <i className="bi bi-folder2-open me-1"></i> Open Log File Location
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Cache Management */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">🧹 Cache Management</h5>
              <p className="text-muted small mb-3">
                Clean temporary downloaded addon archives and cache files to reclaim disk space.
              </p>
              <div className="d-flex align-items-center gap-3">
                <span className="badge bg-secondary p-2 fs-6">Cache Size: {cacheSize}</span>
                <button
                  className="btn btn-warning btn-sm fw-bold"
                  onClick={handleClearCache}
                  disabled={isClearingCache}
                >
                  {isClearingCache ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-1" role="status"></span>
                      Clearing...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-trash3 me-1"></i> Clear Cache
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SET-UP MANAGER (EXPORT & IMPORT) */}
        {activeTab === "setupManager" && (
          <div className="d-flex flex-column gap-4">
            <div className="alert alert-info bg-dark border-info text-info mb-0">
              <i className="bi bi-info-circle-fill me-2"></i>
              <strong>Set-up Manager</strong> allows you to create complete backups of your game settings, keybinds, and addons, and effortlessly transfer or import them into any other WoW installation.
            </div>

            {/* Export Section */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2 text-primary">📦 Export WoW Configuration Backup</h5>
              <p className="text-muted small mb-3">
                Package your WTF configurations and/or AddOns into a portable `.zip` backup archive.
              </p>

              <div className="row g-3 mb-3">
                <div className="col-md-6">
                  <label className="form-label text-muted small">Source WoW Installation</label>
                  <select
                    className="form-select bg-dark text-white border-secondary"
                    value={sourceServerId}
                    onChange={(e) => setSourceServerId(e.target.value)}
                  >
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || `Server ${s.id}`} ({s.gameDir || "No path"})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-md-6">
                  <label className="form-label text-muted small">Backup Scope</label>
                  <div className="d-flex gap-4 mt-2">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="backupType"
                        id="backupSimple"
                        value="simple"
                        checked={backupType === "simple"}
                        onChange={() => setBackupType("simple")}
                      />
                      <label className="form-check-label" htmlFor="backupSimple">
                        <strong>Simple</strong> (Settings & Keybinds only)
                      </label>
                    </div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="backupType"
                        id="backupFull"
                        value="full"
                        checked={backupType === "full"}
                        onChange={() => setBackupType("full")}
                      />
                      <label className="form-check-label" htmlFor="backupFull">
                        <strong>Full</strong> (Settings + Keybinds + All AddOns)
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {isExporting && exportProgress > 0 && (
                <div className="progress mb-3 bg-secondary" style={{ height: "10px" }}>
                  <div
                    className="progress-bar progress-bar-striped progress-bar-animated bg-primary"
                    role="progressbar"
                    style={{ width: `${exportProgress}%` }}
                  ></div>
                </div>
              )}

              <div>
                <button
                  className="btn btn-primary fw-bold"
                  onClick={handleExportBackup}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-1" role="status"></span>
                      Creating Backup ({exportProgress}%)...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-file-earmark-zip me-1"></i> Create Backup Zip
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Import Section */}
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2 text-success">📥 Import WoW Configuration Backup</h5>
              <p className="text-muted small mb-3">
                Restore settings, keybinds, and addons from a previous Warperia `.zip` backup into a target WoW directory.
              </p>

              <div className="row g-3 mb-3">
                <div className="col-md-6">
                  <label className="form-label text-muted small">Backup Zip File</label>
                  <div className="input-group">
                    <input
                      type="text"
                      className="form-control bg-dark text-white border-secondary"
                      placeholder="Select .zip backup file..."
                      value={backupZipPath}
                      readOnly
                    />
                    <button
                      className="btn btn-outline-secondary"
                      type="button"
                      onClick={handleSelectBackupZip}
                    >
                      Browse...
                    </button>
                  </div>
                </div>

                <div className="col-md-6">
                  <label className="form-label text-muted small">Target WoW Installation</label>
                  <select
                    className="form-select bg-dark text-white border-secondary"
                    value={targetServerId}
                    onChange={(e) => setTargetServerId(e.target.value)}
                  >
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || `Server ${s.id}`} ({s.gameDir || "No path"})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <button
                  className="btn btn-success fw-bold"
                  onClick={handleImportBackup}
                  disabled={isImporting || !backupZipPath}
                >
                  {isImporting ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-1" role="status"></span>
                      Importing Backup...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-box-arrow-in-down me-1"></i> Import Backup
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: ACCOUNT */}
        {activeTab === "account" && (
          <div className="d-flex flex-column gap-4">
            {isGuest && (
              <div className="alert alert-warning bg-dark border-warning text-warning mb-0">
                <i className="bi bi-exclamation-triangle-fill me-2"></i>
                You are currently using Warperia in <strong>Guest Mode</strong>. To save your server profiles across devices, please register or log in.
              </div>
            )}

            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-3">👤 Profile Information</h5>
              <div className="row row-cols-1 row-cols-md-3 g-3">
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">Display Name</label>
                  <input
                    type="text"
                    className="form-control bg-dark text-white border-secondary"
                    id="displayName"
                    value={displayName}
                    placeholder="Display Name"
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">Username</label>
                  <input
                    type="text"
                    className="form-control bg-dark text-white border-secondary"
                    id="username"
                    value={username}
                    placeholder="Username"
                    readOnly
                  />
                </div>
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">Email Address</label>
                  <input
                    type="text"
                    className="form-control bg-dark text-white border-secondary"
                    id="email"
                    value={email}
                    placeholder="Email Address"
                    readOnly
                  />
                </div>
              </div>
              <div className="mt-3">
                <button
                  className="btn btn-primary"
                  onClick={handleDisplayNameChange}
                >
                  Save Profile Changes
                </button>
              </div>
            </div>

            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-3">🔒 Change Password</h5>
              <div className="row row-cols-1 row-cols-md-3 g-3">
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">Current Password</label>
                  <input
                    type="password"
                    className="form-control bg-dark text-white border-secondary"
                    id="currentPassword"
                    value={currentPassword}
                    placeholder="Current Password"
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </div>
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">New Password</label>
                  <input
                    type="password"
                    className="form-control bg-dark text-white border-secondary"
                    id="newPassword"
                    value={newPassword}
                    placeholder="New Password"
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="col">
                  <label className="fw-medium text-muted small mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    className="form-control bg-dark text-white border-secondary"
                    id="confirmPassword"
                    value={confirmPassword}
                    placeholder="Confirm Password"
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-3">
                <button
                  className="btn btn-primary"
                  onClick={handleChangePassword}
                >
                  Change Password
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: APPEARANCE */}
        {activeTab === "appearance" && (
          <div className="d-flex flex-column gap-4">
            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">🎨 Theme & Layout</h5>
              <p className="text-muted small mb-3">
                Customize interface density and theme preferences.
              </p>
              <div className="form-check form-switch mb-3">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="compactModeToggle"
                  checked={compactMode}
                  onChange={(e) => handleCompactModeChange(e.target.checked)}
                />
                <label className="form-check-label fw-medium" htmlFor="compactModeToggle">
                  Compact Mode (Higher density list views)
                </label>
              </div>
            </div>

            <div className="card bg-dark border-secondary p-4 text-white">
              <h5 className="mb-2">ℹ️ Application Version</h5>
              <p className="text-muted small mb-2">
                Warperia Desktop Client — Synchronized with Upstream v{appVersion}
              </p>
              <div className="text-secondary small">
                Architecture: {window.electron?.platform === "darwin" ? "macOS (Silicon/Intel)" : "Windows x64"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Settings;