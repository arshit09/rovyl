const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  /**
   * Resolves with `{ ok: true, method }` or `{ ok: false, error, details }` — never rejects.
   *
   * It used to be a `send` with no reply, and the failure came back on `execution-error`, a broadcast
   * channel that did not say WHICH shortcut failed. The renderer paired it with the last dispatch by
   * matching commands within 15 s; coming back this way, the item is the call's own.
   */
  executeCommand: (command, commandType, options) =>
    ipcRenderer.invoke("execute-command", command, commandType, options),
  hideWindow: () => ipcRenderer.send("hide-window"),
  showWindow: () => ipcRenderer.send("show-window"),
  /** Surfaces with a text field (the license gate) need the HWND in the foreground to receive keys. */
  requestKeyboardFocus: () => ipcRenderer.send("request-keyboard-focus"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  /** Who updates: "store" (MSIX) and "unsupported" (not yet packaged) have no updater of their own. */
  getBuildChannel: () => ipcRenderer.invoke("get-build-channel"),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  installUpdateNow: () => ipcRenderer.send("install-update-now"),
  /** Auto-update state — feeds the badge on the radial's hub. */
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.removeListener("update-state", listener);
  },
  /** Tells a Windows startup apart from a manual open — see the scan deferral. */
  wasOpenedAtLogin: () => ipcRenderer.invoke("was-opened-at-login"),
  appSupportsRecents: (appName, appCommand) => ipcRenderer.invoke("app-supports-recents", appName, appCommand),
  onOpenMenu: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on("open-menu", listener);
    return () => ipcRenderer.removeListener("open-menu", listener);
  },
  /**
   * zenith-verify:radial-handshake-preload — Main is about to show the radial — paint a neutral
   * cover and confirm before `open-menu` (avoids a flash after minimize).
   *
   * The payload carries `vacatePanel` when the panel has to leave the surface rather than just be
   * covered: main is about to MOVE the window out from under it (see `panelVacatingForRadial`).
   */
  onPrepareRadialShow: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("prepare-radial-show", listener);
    return () => ipcRenderer.removeListener("prepare-radial-show", listener);
  },
  notifyRadialPrepPaintDone: () =>
    ipcRenderer.send("radial-prep-paint-done"),
  /** Confirms the radial's DOM has already been through a paint before main reveals the HWND. */
  notifyRadialOpenPaintDone: (paintToken) =>
    ipcRenderer.send("radial-open-paint-done", paintToken),
  /** Main revealed the HWND already painted; only now may the visual animation leave the transparent frame. */
  onRadialNativeRevealed: (callback) => {
    const listener = (_event, paintToken) => callback(paintToken);
    ipcRenderer.on("radial-native-revealed", listener);
    return () => ipcRenderer.removeListener("radial-native-revealed", listener);
  },
  onOpenDashboard: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on("open-dashboard", listener);
    return () => ipcRenderer.removeListener("open-dashboard", listener);
  },
  onMouseUp: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on("mouse-up", listener);
    return () => ipcRenderer.removeListener("mouse-up", listener);
  },
  /** Cursor position polled by main while the middle button is held (Windows keeps the capture in another window). */
  onMmbCursor: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on("mmb-cursor", listener);
    return () => ipcRenderer.removeListener("mmb-cursor", listener);
  },
  onMmbRelease: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on("mmb-release", listener);
    return () => ipcRenderer.removeListener("mmb-release", listener);
  },
  onOpenSettings: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on("open-settings", listener);
    return () => ipcRenderer.removeListener("open-settings", listener);
  },
  /** Main process hid the window to tray (Alt+F4 / system close) — React must drop "interactive" state. */
  onWindowHidToTray: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("window-hid-to-tray", listener);
    return () => ipcRenderer.removeListener("window-hid-to-tray", listener);
  },
  onMainWindowMinimized: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("main-window-minimized", listener);
    return () =>
      ipcRenderer.removeListener("main-window-minimized", listener);
  },
  /** After minimize→restore (Windows transparent window): main process reapplies bounds + hit-testing. */
  onWindowNativeDisplayRestored: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("window-native-display-restored", listener);
    return () =>
      ipcRenderer.removeListener("window-native-display-restored", listener);
  },
  setWindowSize: (mode, anchorScreenPoint) =>
    ipcRenderer.send("set-window-size", mode, anchorScreenPoint),
  applyWindowSize: (mode, anchorScreenPoint) =>
    ipcRenderer.invoke("apply-window-size", mode, anchorScreenPoint),
  ensureWindowInteractive: () => ipcRenderer.invoke("ensure-window-interactive"),
  warmRadialTransition: () => ipcRenderer.invoke("warm-radial-transition"),
  reapplySmallOverlay: () => ipcRenderer.invoke("reapply-small-overlay"),
  collapseIdleOverlay: () => ipcRenderer.invoke("collapse-idle-overlay"),
  setRadialViewport: (payload) =>
    ipcRenderer.send("set-radial-viewport", payload),
  /** Clickless execution: main parks the pointer at the wheel's centre and gives it back on close. */
  setRadialCursorCapture: (enabled) =>
    ipcRenderer.send("set-radial-cursor-capture", !!enabled),
  /** Pulls the pointer back to the centre mid-gesture — does not end it, does not touch the return point. */
  parkRadialCursor: () => ipcRenderer.send("park-radial-cursor"),
  /** Critical geometry state: the next shortcut can land on the same tick as the Settings close. */
  setPanelSurfaceVisible: (visible) => {
    try {
      return !!ipcRenderer.sendSync("set-panel-surface-visible", !!visible);
    } catch (_) {
      return false;
    }
  },
  setWindowHitShape: (rects, opts) =>
    ipcRenderer.invoke("set-window-hit-shape", rects, opts || {}),
  setWindowOpacity: (opacity) => ipcRenderer.send("set-window-opacity", opacity),
  invalidatePaint: () => ipcRenderer.invoke("invalidate-paint"),
  getMainWindowContentBounds: () =>
    ipcRenderer.invoke("get-main-window-content-bounds"),
  setGameMode: (config) => ipcRenderer.send("set-game-mode", config),
  /** Main owns the taskbar helper; the renderer only ever states what the switches say. */
  setTaskbarOverlay: (config) => ipcRenderer.send("set-taskbar-overlay", config),
  /** 'classic' | 'mixed' | 'xaml' | 'none' — what this machine's taskbar lets anyone touch. */
  getTaskbarCapability: () => ipcRenderer.invoke("get-taskbar-capability"),
  prewarmApps: (commands) => ipcRenderer.send("prewarm-apps", commands),
  setLoginItemSettings: (settings) =>
    ipcRenderer.send("set-login-item-settings", settings),
  getFileIcon: (path) => ipcRenderer.invoke("get-file-icon", path),
  getWebsiteFaviconDataUrl: (pageUrl) =>
    ipcRenderer.invoke("get-website-favicon-data-url", pageUrl),
  getWebsitePageTitle: (pageUrl) =>
    ipcRenderer.invoke("get-website-page-title", pageUrl),
  onWindowState: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  onSwitchWorkspace: (callback) => {
    const listener = (event, index) => callback(index);
    ipcRenderer.on("switch-workspace", listener);
    return () => ipcRenderer.removeListener("switch-workspace", listener);
  },
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  toggleMaximize: () => ipcRenderer.send("toggle-maximize"),
  quitApp: () => ipcRenderer.send("quit-app"),
  selectFile: () => ipcRenderer.invoke("select-file"),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectImage: () => ipcRenderer.invoke("select-image"),
  removeManagedCustomIcon: (urlOrPath) =>
    ipcRenderer.invoke("remove-managed-custom-icon", urlOrPath),
  getInstalledApps: (forceRefresh = false) =>
    ipcRenderer.invoke("get-installed-apps", forceRefresh),
  getOnboardingApps: () => ipcRenderer.invoke("get-onboarding-apps"),
  getStartupApps: () => ipcRenderer.invoke("get-startup-apps"),
  relaunchApp: () => ipcRenderer.send("relaunch-app"),
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (settings) => ipcRenderer.send("set-settings", settings),
  openSettingsWindow: () => ipcRenderer.send("open-settings-window"),
  resetConfig: () => ipcRenderer.send("reset-config"),
  toggleSettings: () => ipcRenderer.send("toggle-settings"),
  setBackgroundMaterial: (material) =>
    ipcRenderer.send("set-background-material", material),
  pauseGlobalShortcut: () => ipcRenderer.send("pause-global-shortcut"),
  resumeGlobalShortcut: () => ipcRenderer.send("resume-global-shortcut"),
  /** Asks Windows whether a combination is free, by trying to take it and giving it straight back. */
  probeShortcut: (accelerator) => ipcRenderer.invoke("probe-shortcut", accelerator),
  startShortcutRecording: () => ipcRenderer.send("start-shortcut-recording"),
  stopShortcutRecording: () => ipcRenderer.send("stop-shortcut-recording"),
  onShortcutRecorded: (callback) => {
    const subscription = (event, shortcut) => callback(shortcut);
    ipcRenderer.on("shortcut-recorded", subscription);
    return () => ipcRenderer.removeListener("shortcut-recorded", subscription);
  },
  saveFullConfig: (config) => ipcRenderer.invoke("save-full-config", config),
  /** Blocks until written — use on shutdown / visibility hidden so notes are not lost. */
  saveFullConfigSync: (config) => {
    try {
      return !!ipcRenderer.sendSync("save-full-config-sync", config);
    } catch (e) {
      console.error("saveFullConfigSync failed:", e);
      return false;
    }
  },
  getFullConfig: () => ipcRenderer.invoke("get-full-config"),
  getConfigPersistenceMeta: () =>
    ipcRenderer.invoke("get-config-persistence-meta"),
  onBeforeQuitFlush: (callback) => {
    const listener = () => {
      try {
        const out = callback();
        if (out != null && typeof out.then === "function") {
          void out.catch((err) =>
            console.error("onBeforeQuitFlush async error:", err),
          );
        }
      } catch (e) {
        console.error("onBeforeQuitFlush error:", e);
      }
    };
    ipcRenderer.on("zenith-before-quit-flush", listener);
    return () =>
      ipcRenderer.removeListener("zenith-before-quit-flush", listener);
  },
  ackQuitFlush: () => ipcRenderer.send("zenith-quit-flush-ack"),
  exportConfig: () => ipcRenderer.invoke("export-config"),
  importConfig: () => ipcRenderer.invoke("import-config"),
  getAppRecents: (appName, appCommand) =>
    ipcRenderer.invoke("get-app-recents", appName, appCommand),
  setWorkspaceShortcutsState: (isOpen, workspaceSwitchMode) =>
    ipcRenderer.send("set-workspace-shortcuts", isOpen, workspaceSwitchMode),
  startGoogleAuth: () => ipcRenderer.send("start-google-auth"),
  onGoogleAuthSuccess: (callback) => {
    const listener = (event, user) => callback(user);
    ipcRenderer.on("google-auth-success", listener);
    return () => ipcRenderer.removeListener("google-auth-success", listener);
  },
  onGoogleAuthError: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("google-auth-error", listener);
    return () => ipcRenderer.removeListener("google-auth-error", listener);
  },
  savePersistenceLog: (message) => ipcRenderer.send("save-persistence-log", message),
  /** Opens http(s) URLs in the system default browser (not an Electron window). */
  openExternalUrl: (url) => ipcRenderer.invoke("open-external-url", url),
  openSystemUninstall: () => ipcRenderer.invoke("open-system-uninstall"),
});

// Intercept console messages from the renderer process and send them to the main process
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

console.log = (...args) => {
  ipcRenderer.send("renderer-log", "log", ...args);
  originalConsole.log(...args);
};

console.warn = (...args) => {
  ipcRenderer.send("renderer-log", "warn", ...args);
  originalConsole.warn(...args);
};

console.error = (...args) => {
  ipcRenderer.send("renderer-log", "error", ...args);
  originalConsole.error(...args);
};
