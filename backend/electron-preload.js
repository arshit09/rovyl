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
  /**
   * The same answer, already here when React first renders.
   *
   * A login start belongs in the tray, and that is decided in the first render or not at all — an
   * awaited answer would show the Settings window and then hide it again at every sign-in.
   */
  openedAtLogin: (() => {
    try {
      return ipcRenderer.sendSync("get-launch-flags")?.openedAtLogin === true;
    } catch (e) {
      return false;
    }
  })(),
  appSupportsRecents: (appName, appCommand) => ipcRenderer.invoke("app-supports-recents", appName, appCommand),
  onOpenMenu: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on("open-menu", listener);
    return () => ipcRenderer.removeListener("open-menu", listener);
  },
  /**
   * zenith-verify:radial-handshake-preload — confirms the wheel's DOM has been through a paint
   * before main reveals the overlay window.
   *
   * There used to be a `prepare-radial-show` / `radial-prep-paint-done` pass in front of this one,
   * whose whole job was to get Settings off the shared surface before main could move the window.
   * The wheel has its own window now and nothing else has ever been drawn on it, so there is
   * nothing to clear and the first handshake is gone.
   */
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
  onCleanMemory: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("zenith-clean-memory", listener);
    return () => ipcRenderer.removeListener("zenith-clean-memory", listener);
  },
  onShortcutRelease: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("shortcut-release", listener);
    return () => ipcRenderer.removeListener("shortcut-release", listener);
  },
  /* ---- The overlay window's own channels ---- */

  /** The wheel is finished: main returns the overlay to an invisible, click-through idle box. */
  closeRadial: () => ipcRenderer.send("close-radial"),
  /** Main took the wheel down without being asked (Settings opened over it, quit). */
  onRadialHidden: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("radial-hidden", listener);
    return () => ipcRenderer.removeListener("radial-hidden", listener);
  },
  /**
   * The config file changed. Only the settings window writes it, so the wheel follows this rather
   * than tracking its own copy — the payload is the whole blob, as `getFullConfig` returns it.
   */
  onConfigChanged: (callback) => {
    const listener = (_event, blob) => callback(blob);
    ipcRenderer.on("config-changed", listener);
    return () => ipcRenderer.removeListener("config-changed", listener);
  },
  onDiscoveryPhase: (callback) => {
    const listener = (_event, phase) => callback(phase);
    ipcRenderer.on("discovery-phase", listener);
    return () => ipcRenderer.removeListener("discovery-phase", listener);
  },
  /** Wheel → writer. Applied locally for the frame, saved by the settings window. */
  radialWorkspaceChanged: (index) =>
    ipcRenderer.send("radial-workspace-changed", index),
  radialDirectionHintSeen: () => ipcRenderer.send("radial-direction-hint-seen"),
  reportRadialLaunchFault: (fault) =>
    ipcRenderer.send("radial-launch-fault", fault),

  /* ---- The same three, arriving in the settings window ---- */

  onRadialWorkspaceChanged: (callback) => {
    const listener = (_event, index) => callback(index);
    ipcRenderer.on("radial-workspace-changed", listener);
    return () => ipcRenderer.removeListener("radial-workspace-changed", listener);
  },
  onRadialDirectionHintSeen: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("radial-direction-hint-seen", listener);
    return () => ipcRenderer.removeListener("radial-direction-hint-seen", listener);
  },
  onRadialLaunchFault: (callback) => {
    const listener = (_event, fault) => callback(fault);
    ipcRenderer.on("radial-launch-fault", listener);
    return () => ipcRenderer.removeListener("radial-launch-fault", listener);
  },
  /** Writer → wheel: how far the Start Menu scan has got. */
  publishDiscoveryPhase: (phase) =>
    ipcRenderer.send("publish-discovery-phase", phase),

  setRadialViewport: (payload) =>
    ipcRenderer.send("set-radial-viewport", payload),
  /** Clickless execution: main parks the pointer at the wheel's centre and gives it back on close. */
  setRadialCursorCapture: (enabled) =>
    ipcRenderer.send("set-radial-cursor-capture", !!enabled),
  /** Pulls the pointer back to the centre mid-gesture — does not end it, does not touch the return point. */
  parkRadialCursor: () => ipcRenderer.send("park-radial-cursor"),
  /**
   * The hub has been picked up: ask for the whole display to carry the wheel across. The answer
   * comes back on `onRadialDragGeometry` — deliberately not as an `invoke`, because main sends the
   * geometry BEFORE it moves the window and a promise would resolve after.
   */
  requestRadialDragSpace: () => ipcRenderer.send("radial-drag-space"),
  /** Where this window's client area is about to start, and how big it is about to be. */
  onRadialDragGeometry: (callback) => {
    const listener = (_event, geometry) => callback(geometry);
    ipcRenderer.on("radial-drag-geometry", listener);
    return () => ipcRenderer.removeListener("radial-drag-geometry", listener);
  },
  setGameMode: (config) => ipcRenderer.send("set-game-mode", config),

  /* ---- The system dock's readings ---- */

  /**
   * Whether the dock asks for anything a helper has to answer.
   *
   * Main owns the process; the renderer only ever states what the switches say. A clock-only dock
   * is drawn from `Date` and reports false, so it costs no process at all.
   */
  setStatusDockActive: (active) => ipcRenderer.send("set-status-dock-active", !!active),
  /** The last reading main has. Never starts a helper to answer — "unknown" is a valid reply. */
  getSystemStatus: () => ipcRenderer.invoke("get-system-status"),
  onSystemStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("system-status", listener);
    return () => ipcRenderer.removeListener("system-status", listener);
  },
  setSystemVolume: (percent) => ipcRenderer.send("set-system-volume", percent),
  setSystemMuted: (muted) => ipcRenderer.send("set-system-muted", !!muted),
  /** One of four names — never a URI, so the renderer cannot ask the shell to open anything. */
  openSystemPanel: (panel) => ipcRenderer.send("open-system-panel", panel),
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
  setWindowBackground: (color) => ipcRenderer.send("set-window-background", color),
  toggleMaximize: () => ipcRenderer.send("toggle-maximize"),
  quitApp: () => ipcRenderer.send("quit-app"),
  selectFile: (options) => ipcRenderer.invoke("select-file", options),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  /** Custom icons: see the block of the same name in electron-main. */
  chooseCustomIconFile: () => ipcRenderer.invoke("choose-custom-icon-file"),
  readCustomIconSource: (source) => ipcRenderer.invoke("read-custom-icon-source", source),
  extractLibraryIcon: (filePath, index) =>
    ipcRenderer.invoke("extract-library-icon", filePath, index),
  storeCustomIcon: (dataUrl) => ipcRenderer.invoke("store-custom-icon", dataUrl),
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
  setWorkspaceShortcutsState: (isOpen, workspaceSwitchMode, numberKeysClaimed) =>
    ipcRenderer.send(
      "set-workspace-shortcuts",
      isOpen,
      workspaceSwitchMode,
      numberKeysClaimed,
    ),
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
