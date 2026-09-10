import { LucideIcon } from "lucide-react";
/** `import type` is erased at compile time: `launchFailure.ts` stays in the card's late chunk only. */
import type { ExecutionErrorDetails } from "./launchFailure";

export type SubscriptionTier = "free" | "plus" | "pro";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  isPremium: boolean;
  /** Paid tier when billing supports Plus vs Pro; optional until checkout is wired. */
  planTier?: SubscriptionTier;
  isAdmin?: boolean;
  /** How many devices the licence covers; comes from the server on activation. */
  deviceLimit?: number;
  trialEndsAt?: string; // ISO Date string
  avatarUrl?: string;
  /** Local profile only (billing / account sync can come later). */
  address?: string;
}

export interface AppItem {
  id: string;
  type?: "app" | "folder";
  label: string;
  iconName: string;
  iconSource?: "lucide" | "native"; // New property: 'lucide' for vector, 'native' for custom/extracted image
  /** `rovyl-icon://` reference to a file in userData, an `https:` favicon, or a legacy `data:` URL. */
  customIconUrl?: string; // Supports base64 images or URLs
  direction?: string;
  command: string;
  commandType?: "app" | "url" | "folder"; // New: distinguishes if command is an app path, a web URL, or a folder
  description: string;
  shortcut?: string;
  children?: AppItem[];
  hasRecents?: boolean; // New: indicates if the app should show recent folders
  /** When true, MRU sub-items also spawn a terminal in the selected project folder. */
  openTerminalForRecents?: boolean;
  openTerminal?: boolean; // New: indicates if opening this item should also open a terminal
  terminalCommands?: string[]; // New: list of commands to run automatically in the terminal
  /** Explicit directory for terminal/commands; avoids inferring cwd from the IDE's launch line. */
  workingDirectory?: string;
  /** Open strategy: normal, reuse the existing process, or warm files in the Windows cache. */
  launchMode?: "normal" | "reuse" | "prewarm";
}

export interface CenterButtonConfig {
  /** `widget` kept only to read old configs — the built-in widgets were removed. */
  type: "app" | "widget" | "command" | "none" | "cancel";
  target: string;
  label: string;
  iconName: string;
  commandType?: "app" | "url"; // Add commandType for 'command' type
}

export interface Coordinates {
  x: number;
  y: number;
}

export interface GameModeConfig {
  enabled: boolean;
  mode: "all" | "list"; // 'all' = any fullscreen app; 'list' = only apps from the list in fullscreen
  blockedApps: string;
  /** Auto-detects fullscreen games by folder, launcher and engine markers. */
  autoDetectGames: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  apps: AppItem[];
  /** Number key used while the radial is open. Zero means picker/mouse-wheel only. */
  hotkey: number; // 0 or 1-9
  enabled: boolean;
  color?: string; // Optional project/workspace color
  /** Lucide icon on the first wheel when `workspaceSwitchMode === 'picker'`. Omitted → Layers. */
  pickerIconName?: string;
}

export const CLOCK_HUD_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type ClockHudPosition = (typeof CLOCK_HUD_POSITIONS)[number];

export interface UIConfig {
  accentColor: string;
  /** Color applied to the item pointed at in the radial menu. Optional for compatibility with old configs. */
  radialHoverColor?: string;
  menuRadius: number;
  iconSize: number;
  /**
   * @deprecated No longer configurable — the wheel is always born at the center. Kept only to read
   * old configs (normalized to `true` on hydration). Do not expose it in settings again.
   */
  fixedPosition: boolean;
  backdropOpacity: number;
  menuBackgroundStyle: "circle" | "fullscreen";
  appSpacing: number; // New: spacing between apps in radial menu
  activationThreshold: number;
  centerButton: CenterButtonConfig;
  showLabels: boolean;
  /** When true, app names stay visible for all items; when false, only the hovered/selected item shows its label. */
  alwaysShowAppLabels: boolean;
  showBattery: boolean; // New
  showWeather: boolean; // New
  weatherLocation?: string; // New: CEP or city name for weather
  clockPosition: ClockHudPosition;
  gameMode: GameModeConfig;
  globalShortcut: string; // New: Global keyboard shortcut (e.g. 'Alt+Space')
  /**
   * Whether the first-run card has been dismissed. Absent means "not yet" — and any config that
   * came off disk is marked true on load, so it can only ever be false on a genuinely new profile.
   */
  hasSeenOnboarding?: boolean;
  /**
   * Whether the direction-mode hint ("push toward a target") has had its one showing. It used to
   * come back on every open until the hand moved — right for someone meeting the mode, furniture
   * for everyone else. It is now spent the first time it has been on screen long enough to have
   * been read, and does not come back.
   */
  hasSeenDirectionHint?: boolean;
  workspaces: Workspace[]; // New: Workspace configurations
  activeWorkspaceIndex: number; // New: Currently active workspace (0-indexed)
  /**
   * hotkeys: keys 1–9 (and the mouse wheel) switch workspace while the menu is open.
   * picker: opening the radial shows the workspace wheel first; picking one shows that space's apps; the center goes back (like folders).
   */
  workspaceSwitchMode?: 'hotkeys' | 'picker';
  /**
   * Theme for the opaque surfaces (titlebar + Settings). The radial always stays
   * dark: it is an overlay on the desktop, not a surface of the product.
   */
  appearanceTheme?: 'black' | 'white';
  /**
   * How the wheel decides the target.
   * 'angle'  — direction from the center; the slice lights up even with the cursor far away (default).
   * 'cursor' — only lights up when the pointer is right over the icon.
   */
  radialSelectionMode?: 'angle' | 'cursor';
  /**
   * Launch without a click: holding the aim on a target for `radialInstantDwellMs` launches it.
   *
   * Turning this on also changes HOW you aim. The pointer is hidden and parked at the center of the
   * wheel (the main handles that), and the slice now comes from the direction the hand went since
   * then — not from the position the cursor already sat at. Without that, opening the wheel with
   * the mouse low lit the bottom item on the first tremor and the dwell launched it by itself.
   *
   * 'swipe' is RESERVED and is read as 'off' everywhere — it is the same gesture without the wait,
   * and it is declared so a future implementation does not have to migrate configs.
   */
  radialInstantActivate?: 'off' | 'swipe' | 'dwell';
  /**
   * Milliseconds of continuous aim at the same target before it runs. Clamped to [0, 2000], and
   * zero is a choice and not a floor: the wait is optional, and at that mark the direction runs
   * as soon as it commits.
   */
  radialInstantDwellMs?: number;
  /**
   * How much travel a direction needs to light the slice on that side, with click-free launching
   * on. It only counts in that mode: that is the one that hides the pointer and parks it at the
   * center, and with no visible pointer the gesture is a direction — not a position that already
   * meant something before the hand moved.
   */
  radialInstantSensitivity?: 'low' | 'medium' | 'high';
  openAtLogin?: boolean; // New: Start app at login
  enableMouseTrigger: boolean;
  /** click: an MMB click opens and leaves the radial open; hold: holding opens, releasing runs the selection. */
  mouseTriggerMode?: 'click' | 'hold';
  /**
   * Physical button that opens the wheel. Left and right are off the table: watching them
   * globally would collide with the primary click and the system context menu.
   */
  mouseTriggerButton?: 'middle' | 'x1' | 'x2';
  language: "pt" | "en" | "es" | "fr" | "de" | "it" | "ja" | "zh" | "ko" | "ru";
  performanceMode: boolean; // New: Strict performance mode for zero-lag
  /**
   * Start Menu discovery already ran or Main was saved with custom apps — do not import shortcuts again at startup.
   * Persisted in config-v2.json (localStorage can be cleared after a reboot).
   */
  mainStartMenuDiscoveryDone?: boolean;
  persistenceMeta?: {
    isFirstRunCompleted?: boolean;
    lastSuccessfulLoad?: string;
    version?: number;
  };
}

export interface RadialState {
  isOpen: boolean;
  position: Coordinates;
  activeItemIndex: number | null;
}

/**
 * What `execute-command` returns. Never rejects: a failure is an `ok: false`, because the caller
 * wants to know IF it started, and a `throw` would force every launch site to carry its own `try`.
 */
export type LaunchResult =
  | { ok: true; method: string | null }
  | { ok: false; error: string; details?: ExecutionErrorDetails };


/** Where the app fetches updates from — and whether it does at all. */
export type UpdateChannel = 'store' | 'direct' | 'unsupported';

/**
 * Where the update is. One UI row, one state: the panel never shows "Check for updates"
 * next to an update that is already downloaded.
 */
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error' | 'unsupported';

export interface UpdateState {
  state: UpdatePhase;
  version?: string | null;
  /** Download percentage, when the server announces a size. */
  percent?: number;
  /** When the last completed check happened. */
  checkedAt?: number;
  error?: string;
}

export interface ElectronAPI {
  executeCommand: (
    command: string,
    commandType: "app" | "url" | "folder",
    options?: { openTerminal?: boolean; terminalCommands?: string[]; workingDirectory?: string; launchMode?: "normal" | "reuse" | "prewarm" },
  ) => Promise<LaunchResult>;
  hideWindow: () => void;
  showWindow: () => void;
  requestKeyboardFocus?: () => void;
  getAppVersion?: () => Promise<string>;
  /**
   * Distribution channel, from the updater's point of view: 'store' (MSIX) and 'unsupported'
   * (unpackaged build) have no update of their own — the row leaves the panel.
   */
  getBuildChannel?: () => Promise<UpdateChannel>;
  onUpdateState?: (callback: (payload: UpdateState) => void) => () => void;
  getUpdateState?: () => Promise<UpdateState & { channel?: UpdateChannel }>;
  checkForUpdates?: () => Promise<{
    ok: boolean;
    state?: UpdatePhase;
    version?: string;
    percent?: number;
    code?: string;
    error?: string;
  }>;
  installUpdateNow?: () => void;
  wasOpenedAtLogin?: () => Promise<boolean>;
  /** The main confirms the app really has an IDE profile with an MRU (do not guess by name). */
  appSupportsRecents?: (appName: string, appCommand: string) => Promise<boolean>;
  onOpenMenu: (
    callback: (data: {
      x: number;
      y: number;
      source?: "mmb" | "mmb-click" | "shortcut";
      /** True when the main already applied fullscreen — avoids a second `applyWindowSize` in the renderer. */
      preSizedByMain?: boolean;
      /** The panel stays on screen under the radial — the renderer cannot close it. */
      keepPanel?: boolean;
      /** Screen rect of the panel; only when the window was widened and it needs repositioning. */
      panelRect?: { x: number; y: number; width: number; height: number } | null;
      /** Center already converted to the new HWND's coordinates; avoids stale metrics after Settings. */
      clientPosition?: { x: number; y: number } | null;
      /** Native origin matching the clientPosition/panelRect during the handshake. */
      windowOrigin?: { x: number; y: number } | null;
      /** Authoritative viewport after the resize; the renderer may still report the Settings size. */
      clientSize?: { width: number; height: number } | null;
      /** First-frame handshake: the main only reveals a hidden window once this token is acknowledged. */
      paintToken?: number;
    }) => void,
  ) => () => void;
  /** Before opening the radial from the main — cover the old frame (e.g. the dashboard on restore). */
  onPrepareRadialShow?: (callback: () => void) => () => void;
  notifyRadialPrepPaintDone?: () => void;
  notifyRadialOpenPaintDone?: (paintToken: number) => void;
  /** The native window is already visible; releases the animation of the radial prepped at zero alpha. */
  onRadialNativeRevealed?: (callback: (paintToken: number) => void) => () => void;
  onOpenDashboard: (callback: () => void) => () => void;
  onMouseUp: (callback: () => void) => () => void;
  onMmbRelease: (callback: () => void) => () => void;
  /** Cursor polled by the main while the middle button is held down (screen coordinates). */
  onMmbCursor?: (
    callback: (point: { x: number; y: number }) => void,
  ) => (() => void) | void;
  onOpenSettings: (callback: () => void) => () => void;
  /** Fired when the OS hid the window to tray (not a real quit). */
  onWindowHidToTray: (callback: () => void) => () => void;
  /** Main window minimize/restore — the panel can stay in React state but the island must come back on minimize. */
  onMainWindowMinimized?: (
    callback: (payload: { minimized: boolean }) => void,
  ) => () => void;
  onWindowNativeDisplayRestored: (
    callback: (payload: {
      mode: "small" | "fullscreen" | "windowed";
    }) => void,
  ) => () => void;
  setWindowSize: (
    mode: "small" | "fullscreen" | "windowed",
    /** Screen coordinates (e.g. cursor) — which monitor should receive the fullscreen/small overlay */
    anchorScreenPoint?: { x: number; y: number },
  ) => void;
  /** Awaitable resize — use before showing the radial so the first paint is not still windowed bounds. */
  applyWindowSize?: (
    mode: "small" | "fullscreen" | "windowed",
    anchorScreenPoint?: { x: number; y: number },
  ) => Promise<boolean>;
  /** Pre-warms small↔fullscreen once after startup (island HWND shrunk). */
  warmRadialTransition?: () => Promise<boolean>;
  /** Re-applies desktop passthrough overlay after closing a fullscreen widget (fixes flaky clicks on Windows). */
  reapplySmallOverlay?: () => Promise<boolean>;
  /** Idle: shrinks the HWND into the corner (no fullscreen transparent layer). */
  collapseIdleOverlay?: () => Promise<boolean>;
  /** Side of the radial's box (px) + whether the position is fixed — the main sizes the menu window with this. */
  setRadialViewport?: (payload: { size: number; fixed: boolean }) => void;
  /**
   * Click-free launching on: when the radial opens, the main stores where the cursor was, puts it
   * at the center of the wheel and returns it on close. This is what makes the pointer hideable (it
   * is only invisible over our own window) and the gesture neutral at startup.
   */
  setRadialCursorCapture?: (enabled: boolean) => void;
  /** Pulls the cursor back to the center without ending the gesture — used when it drifts off the window. */
  parkRadialCursor?: () => void;
  /** Panel (Settings/Welcome) actually in view — decides whether the radial opens on top of it. */
  setPanelSurfaceVisible?: (visible: boolean) => void;
  /** Clears island passthrough / hit-shape so widgets and panels receive clicks immediately. */
  ensureWindowInteractive?: () => Promise<boolean>;
  /** Windows/Linux: island — `coordinateSpace: "screen"` shrinks the HWND; without it, client coords + setShape. */
  setWindowHitShape?: (
    rects: Array<{ x: number; y: number; width: number; height: number }>,
    opts?: { coordinateSpace?: "screen" | "client" },
  ) => Promise<boolean>;
  /** 0–1; used to hide the window during fullscreen resize to avoid DWM stretching the old settings frame (flash). */
  setWindowOpacity: (opacity: number) => void;
  /** Schedules a full Chromium repaint — helps transparent frameless windows on Windows after show/resize. */
  invalidatePaint?: () => Promise<boolean>;
  /** Webview area on screen — prefer it over `screenX`/`screenY` when computing hit-shape after a resize. */
  getMainWindowContentBounds?: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  setGameMode: (config: GameModeConfig) => void;
  prewarmApps?: (commands: string[]) => void;
  getVolume: () => Promise<number>;
  setVolume: (value: number) => void;
  getBrightness: () => Promise<number>;
  setBrightness: (value: number) => void;
  getHardwareCapabilities: () => Promise<{ hasWifi: boolean; hasBluetooth: boolean }>;
  toggleWifi: (enabled: boolean) => Promise<boolean>;
  toggleBluetooth: (enabled: boolean) => Promise<boolean>;
  getFileIcon: (path: string) => Promise<string | null>;
  /** Favicon fetched in the main (data URL) — the renderer usually fails with <img https://…>. */
  getWebsiteFaviconDataUrl?: (pageUrl: string) => Promise<string | null>;
  /** The page's own <title>, so a web shortcut is named the way its browser tab is. */
  getWebsitePageTitle?: (pageUrl: string) => Promise<string | null>;
  minimizeWindow: () => void;
  toggleMaximize: () => void;
  quitApp: () => void;
  onWindowState: (
    callback: (state: "maximized" | "windowed") => void,
  ) => () => void;
  onSwitchWorkspace: (callback: (index: number) => void) => () => void;
  selectFile: () => Promise<string | null>;
  selectFolder: () => Promise<string | null>;
  selectImage: () => Promise<string | null>;
  /** Removes a file only if it lives under userData/custom-icons (safe no-op otherwise). */
  removeManagedCustomIcon: (urlOrPath?: string) => Promise<void>;
  getInstalledApps: (forceRefresh?: boolean) => Promise<any[]>;
  getOnboardingApps: () => Promise<any[]>;
  getStartupApps: () => Promise<any[]>;
  relaunchApp: () => void;
  getSettings: () => Promise<any>;
  setSettings: (settings: any) => void;
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
  openSettingsWindow: () => void;
  resetConfig: () => void;
  toggleSettings: () => void;
  setBackgroundMaterial: (
    material: "none" | "acrylic" | "mica" | "tabbed",
  ) => void;
  pauseGlobalShortcut: () => void;
  resumeGlobalShortcut: () => void;
  /**
   * Whether Windows would give Rovyl this combination.
   * `rovyl` means Rovyl already holds it — which, for the shortcut in use, is what healthy is.
   */
  probeShortcut?: (
    accelerator: string,
  ) => Promise<{
    available: boolean;
    reason?: 'taken' | 'invalid' | 'rovyl';
    /** Present when main can name who took it — today only the Alt+Z overlay. */
    hint?: string;
  }>;
  startShortcutRecording: () => void;
  stopShortcutRecording: () => void;
  onShortcutRecorded: (callback: (shortcut: string) => void) => () => void;
  saveFullConfig: (config: any) => Promise<{ ok: boolean; error?: string }>;
  /** Synchronous save to disk (Electron); returns false if main rejected or IPC failed. */
  saveFullConfigSync?: (config: any) => boolean;
  getFullConfig: () => Promise<any>;
  /** Sizes of config-v2.json (+ .bak + quarantined .broken-*) — used to avoid overwriting real data when load fails. */
  getConfigPersistenceMeta?: () => Promise<{
    primaryBytes: number;
    backupBytes: number;
    quarantineBytes?: number;
  }>;
  /** Main is quitting — flush then call ackQuitFlush (callback may be async). */
  onBeforeQuitFlush?: (callback: () => void | Promise<void>) => () => void;
  ackQuitFlush?: () => void;
  getAppRecents: (appName: string, appCommand?: string) => Promise<AppItem[]>;
  setWorkspaceShortcutsState: (
    isOpen: boolean,
    workspaceSwitchMode?: 'hotkeys' | 'picker',
  ) => void;
  exportConfig: () => Promise<{ success: boolean; error?: string }>;
  importConfig: () => Promise<{ success: boolean; error?: string }>;
  startGoogleAuth: () => void;
  onGoogleAuthSuccess: (callback: (user: any) => void) => () => void;
  onGoogleAuthError?: (callback: (payload: { code?: string; message?: string; userDataPath?: string }) => void) => () => void;
  savePersistenceLog: (message: string) => void;
  /** Open URL in the OS default browser (shell.openExternal). */
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** OS-native uninstall flow (Windows uninstaller / Apps settings; macOS Finder). */
  openSystemUninstall?: () => Promise<{
    ok: boolean;
    mode?: "uninstaller" | "settings" | "finder";
    dev?: boolean;
    error?: string;
  }>;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
