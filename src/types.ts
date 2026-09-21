import { LucideIcon } from "lucide-react";
/** `import type` is erased at compile time: `launchFailure.ts` stays in the card's late chunk only. */
import type { ExecutionErrorDetails } from "./launchFailure";
/** Erased at compile time: the drop classifier is only ever loaded by the settings chunk. */
import type { InspectedDropPath } from "./utils/droppedShortcut";

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
  /**
   * Where the icon comes from.
   * 'lucide' — the `iconName` glyph.
   * 'native' — a bitmap Rovyl found by itself (the program's icon, the site's favicon), kept up to
   *   date by the healing pass and re-extracted when the pipeline changes.
   * 'custom' — the user chose it: the picture in `customIconUrl`, or, with none, the `iconName`
   *   glyph in place of the program's own icon. Nothing automatic ever replaces it.
   */
  iconSource?: "lucide" | "native" | "custom";
  /** `rovyl-icon://` reference to a file in userData, an `https:` favicon, or a legacy `data:` URL. */
  customIconUrl?: string;
  /**
   * The file a custom picture was taken from, as Windows writes an icon location:
   * `C:\Icons\app.png`, or `C:\Windows\System32\shell32.dll,4` for the fifth icon in a library.
   * Only there so the workspace file can name it; the picture itself is `customIconUrl`. Absent
   * for a picture that was pasted.
   */
  customIconFile?: string;
  direction?: string;
  command: string;
  /**
   * What `command` is, so the main process does not have to guess.
   *
   * `file` is a document and not a program: it is handed to `shell.openPath`, which opens it in
   * whatever Windows has registered for that extension. It is deliberately not `app` — the app
   * ladder builds `<terminal> /c <line>`, and a `.pdf` down that route opens a console window or
   * nothing at all.
   */
  commandType?: "app" | "url" | "folder" | "file" | "command";
  /**
   * `command` only: which shell reads the line, and whether a console window shows it. Unset means
   * PowerShell in a window that stays open, so the output of a typo can still be read.
   */
  commandShell?: "powershell" | "cmd";
  commandWindow?: "open" | "hidden";
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

/**
 * The two corner docks drawn beside the open wheel. Shape, defaults and every rule about them live
 * in `src/utils/screenDocks.ts`, because the wheel, the settings panel and the window sizing all
 * need the same answers and a second copy of them is how the three drift.
 */
export type {
  DockPosition,
  ShortcutDockConfig,
  StatusDockConfig,
} from "./utils/screenDocks";

/**
 * One reading of the things the status dock displays, as the main process reports it.
 *
 * Every number carries its own "not available": `-1` for a machine with no battery and for a
 * network with no signal quality to give (a cable has none), `null` for a whole reading that has
 * not arrived yet. A readout that cannot distinguish "0%" from "unknown" shows a flat battery to
 * somebody sitting at a desktop PC.
 */
export interface SystemStatus {
  /** 0-100, or -1 when there is no audio endpoint to ask. */
  volume: number;
  muted: boolean;
  network: "none" | "ethernet" | "wifi" | "other";
  /** Wi-Fi signal quality, 0-100. -1 on anything that is not Wi-Fi. */
  signal: number;
  /** 0-100, or -1 on a machine with no battery. */
  battery: number;
  charging: boolean;
}

/** The Windows panels a status readout may open. Named, never spelled as a URI by the renderer. */
export type SystemPanel = "volume" | "network" | "battery" | "clock";

export interface Workspace {
  id: string;
  name: string;
  apps: AppItem[];
  /**
   * The POSITIONAL number key: 1–9 by place in the list, zero past the ninth. Renumbered on every
   * reorder and every delete, so it always describes the position and never the workspace.
   *
   * It is the default, not the binding — read `workspaceKeyAt`, which prefers `hotkeyKey`.
   */
  hotkey: number; // 0 or 1-9
  /**
   * A key recorded for THIS workspace, which outranks the positional digit above.
   *
   * Three states, and the difference between two of them is the whole point:
   *   absent — never edited, so the workspace follows its position and keeps doing so after a
   *            reorder. This is what every existing config has.
   *   ''     — deliberately no key, which is what is left behind when the key is given to
   *            something else. It survives a reorder; a missing field would not.
   *   'K'    — that key, stored as the single upper-case character the layout prints.
   *
   * Read it through `workspaceKeyAt`; a config can be hand-edited and this one is a free string.
   */
  hotkeyKey?: string;
  enabled: boolean;
  color?: string; // Optional project/workspace color
  /** Lucide icon on the home launcher — the wheel's first level. Omitted → Layers. */
  pickerIconName?: string;
  /**
   * A picture chosen for the workspace, drawn instead of `pickerIconName` — a `rovyl-icon://`
   * reference, like `AppItem.customIconUrl`. The glyph stays as the fallback if the file is gone.
   */
  pickerIconUrl?: string;
  /** Where that picture came from — see `AppItem.customIconFile`. */
  pickerIconFile?: string;
}

/**
 * What a file offers as a custom icon, as main reads it (`readCustomIconSource`).
 * `image` is raw bytes still to be normalized; `library` is every icon a program or icon library
 * holds, with the requested one at full size; `shell` is the icon Windows draws for anything else,
 * already stored.
 */
export type CustomIconSource =
  | { ok: true; kind: "image"; path: string; dataUrl: string }
  | {
      ok: true;
      kind: "library";
      path: string;
      index: number;
      count: number;
      /** One per icon, in the file's order; an empty string where one could not be drawn. */
      thumbnails: string[];
      dataUrl: string | null;
    }
  | { ok: true; kind: "shell"; path: string; ref: string }
  | { ok: false; error: string };

export const CLOCK_HUD_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type ClockHudPosition = (typeof CLOCK_HUD_POSITIONS)[number];

/**
 * Where the settings gear may sit while the wheel is open.
 *
 * Corners only, unlike the HUD's regions: the middle of an edge is the one place a small target
 * must not be, because that is where a wedge aimed at the top or the bottom of the wheel ends up.
 */
export const SETTINGS_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type SettingsCorner = (typeof SETTINGS_CORNERS)[number];

export interface UIConfig {
  accentColor: string;
  /** Color applied to the item pointed at in the radial menu. Optional for compatibility with old configs. */
  radialHoverColor?: string;
  menuRadius: number;
  iconSize: number;
  /**
   * @deprecated No longer configurable — the wheel is always born at the center. Kept only to read
   * old configs (normalized to `true` on hydration). Do not expose it in settings again.
   *
   * Not to be confused with `radialMonitor`: that one is live, and it chooses a SCREEN. This one
   * chose a POINT, which is the part that is gone.
   */
  fixedPosition: boolean;
  /** Strict offline mode disables all external internet requests (weather, remote favicons, updates). */
  strictOfflineMode?: boolean;
  /**
   * Which monitor the wheel is born on.
   * 'primary' — always the main screen, wherever the hand is (default, and what shipped).
   * 'cursor'  — the screen the pointer is on, so what gets launched lands in front of the user.
   *
   * It picks a screen, not a position: the box is still centred on whichever monitor it names.
   */
  radialMonitor?: 'primary' | 'cursor';
  /**
   * WHERE on that monitor the wheel is born — the companion to `radialMonitor`, which chooses only
   * the screen.
   * 'center' — the middle of the screen (default, and what shipped).
   * 'cursor' — under the pointer, so the wheel appears where the hand already is and no item is
   *   further away than the gesture that opened it.
   *
   * This is NOT the old `fixedPosition`: that stored a point the user had dragged the wheel to and
   * pinned it there forever. This one stores no point at all — it is read live, at every open.
   *
   * Near a screen edge the centre is pulled back just far enough to keep the whole ring reachable
   * (main clamps it with the `ring` reach sent through `setRadialViewport`); a wheel half off the
   * screen is items that cannot be aimed at.
   */
  radialPlacement?: 'center' | 'cursor';
  /**
   * "Background dimming", 0..1. At 1 the desktop is gone: an opaque fill over the whole monitor.
   * Read it through `radialScrimAlphas` — the number is not an alpha, and how it maps to one
   * changed. `backdropDimScale` says which mapping the saved value belongs to.
   */
  backdropOpacity: number;
  /**
   * Which scale `backdropOpacity` is written on (`BACKDROP_DIM_SCALE`). ABSENT means the config
   * predates the scale that reaches a black screen, and hydration converts the value once so the
   * dimming looks exactly as it did before the upgrade.
   */
  backdropDimScale?: number;
  /**
   * The readouts — clock, battery, network, volume — in one corner of the open wheel.
   *
   * ABSENT means off, which is what every config written before this feature says. Read it through
   * `normalizeStatusDock`, never field by field: a blob from disk may be missing any of them, and
   * a missing `iconSize` read as 0 is a dock that is enabled, placed and invisible.
   */
  statusDock?: import("./utils/screenDocks").StatusDockConfig;
  /**
   * The user's own icons, in a corner of the open wheel. Same rule: `normalizeShortcutDock`.
   *
   * Its `items` are ordinary `AppItem`s so that one launch path serves both these and the wheel —
   * a second way to run a shortcut is a second place for launch failures to be reported wrongly.
   */
  shortcutDock?: import("./utils/screenDocks").ShortcutDockConfig;
  menuBackgroundStyle: "circle" | "fullscreen";
  appSpacing: number; // New: spacing between apps in radial menu
  activationThreshold: number;
  centerButton: CenterButtonConfig;
  showLabels: boolean;
  /** When true, app names stay visible for all items; when false, only the hovered/selected item shows its label. */
  alwaysShowAppLabels: boolean;
  /** The pill under the wheel naming where you are (workspace, then folders). Absent means on. */
  showWorkspacePill?: boolean;
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
   * Theme for the opaque surfaces (titlebar + Settings). The radial always stays
   * dark: it is an overlay on the desktop, not a surface of the product.
   */
  appearanceTheme?: 'black' | 'white';
  /**
   * How the wheel decides the target.
   * 'area'   — direction from the centre (default). The plane is cut into as many equal shares as
   *            there are items, and the one pointed at is the target with the cursor anywhere
   *            inside its share — including far outside the ring.
   * 'cursor' — only lights up when the pointer is right over the icon.
   *
   * 'angle' was a third value and is gone. It aimed exactly as 'area' does and differed only in
   * that the shares were not drawn — which is a question about what is painted, not about how the
   * wheel targets, and is `radialAreaWedges` now. Configs carrying it are rewritten on read; see
   * `normalizeStoredConfig`.
   */
  radialSelectionMode?: 'cursor' | 'area';
  /**
   * Whether area targeting DRAWS the division it aims by.
   *
   * On: the seams are there from the moment the wheel opens and the share being aimed at fills
   * with the hover colour, so where one target stops owning the pointer and the next begins stops
   * being something the hand can only learn by being wrong about it.
   *
   * Off (default): the same aim, nothing painted — only the icon lights up. Off is the default
   * because it is what the wheel has always looked like, and an update must not repaint the
   * screen of somebody who asked for nothing.
   */
  radialAreaWedges?: boolean;
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
  /**
   * Number keys pick AND run: while the wheel is up, 1-9 launch the shortcut sitting in that
   * position, with no Enter and no aiming. The digits count from the top and go clockwise, the
   * same order the wheel is laid out in, and they address the level on screen — inside a folder
   * they are that folder's items, on the home launcher they are the workspaces.
   *
   * It CLAIMS the digits. The workspace keys are registered as global shortcuts while the wheel is
   * open, and two features cannot own one key: with this on, the wheel asks main not to register
   * the DIGITS among them, so a workspace still on its positional default goes quiet while a
   * workspace whose key was recorded as a letter keeps working. That is said out loud in the
   * settings row rather than discovered by pressing 2 and watching an app open.
   *
   * Off by default: it turns a keystroke that filtered ("Photoshop 2024") into one that launches.
   */
  radialNumberLaunch?: boolean;
  /**
   * Whether each tile carries its digit while `radialNumberLaunch` is on. Read as `!== false`:
   * a number you cannot see is a number you have to count to, so the badges are what the feature
   * ships with and hiding them is the deliberate step — for someone who has learned the wheel and
   * wants the icons back unmarked.
   *
   * Means nothing on its own: with number launching off, no tile is numbered whatever this says.
   */
  radialNumberLabels?: boolean;
  /**
   * The single key that leaves a folder — the hub's keyboard equivalent, since the centre could
   * only ever be clicked. Stored upper case; an empty string means no key at all.
   *
   * It only fires where the hub actually says "Back": one level deep or more, with nothing typed.
   * At the root there is nothing to leave, so the key goes back to being a character the filter can
   * have — which is what keeps `qBittorrent` reachable with the default binding.
   *
   * Read it through `normalizeBackKey`; a config can be hand-edited and this one is a free string.
   *
   * Means nothing while `radialNumberLaunch` is off, exactly like `radialNumberLabels`: that switch
   * owns the keyboard-driven wheel and this key is part of it. The wheel checks the pair, not this
   * alone — a binding that acts with no visible setting behind it is indistinguishable from a bug.
   */
  radialBackKey?: string;
  /**
   * A gear in a corner of the open wheel, which opens Settings.
   *
   * Rovyl's other doors to Settings are all gestures you have to know about — the tray icon, a
   * double middle-click — and none of them is visible from the wheel itself. This one is, at the
   * cost of one more thing painted over the desktop, so it is opt-in.
   *
   * Turning it on makes the overlay cover the whole monitor (`radialScrimNeedsFullBleed` asks for
   * the same thing at high dimming): the window is normally only a box around the wheel, and a
   * "corner" of that box is not a corner of the screen — it is a gear floating beside the wheel.
   *
   * It is NOT offered while click-free launching aims by direction: that mode hides the pointer
   * and parks it at the centre, so there is no way to reach a corner, and a click anywhere
   * launches whatever the gesture is pointing at. The gear hides itself there rather than sit on
   * screen unclickable.
   */
  showSettingsCorner?: boolean;
  /** Which corner it sits in. Absent means `top-right`. */
  settingsCorner?: SettingsCorner;
  openAtLogin?: boolean; // New: Start app at login
  /**
   * Whether the global shortcut opens the wheel at all.
   *
   * Optional, and read as `!== false`: every config written before this key existed had a working
   * keyboard trigger, and absence has to keep meaning that rather than silently taking it away.
   */
  enableKeyboardTrigger?: boolean;
  enableMouseTrigger: boolean;
  /** click: an MMB click opens and leaves the radial open; hold: holding opens, releasing runs the selection. */
  mouseTriggerMode?: 'click' | 'hold';
  /** toggle: pressing shortcut opens/closes; hold: holding shortcut opens, releasing runs selection or closes. */
  shortcutTriggerMode?: 'toggle' | 'hold';
  /**
   * The button that opens the wheel, as a binding rather than a name: a button plus the modifiers
   * held with it — `middle`, `x1`, `Ctrl+left`, `Alt+Shift+x2`. The grammar, the spellings it
   * accepts and the one rule it enforces (left and right are only bindable with a modifier) live
   * in `src/constants/mouseTrigger.ts`, which main mirrors in `backend/mouse-trigger.cjs`.
   *
   * Left as a plain string: the set of buttons a mouse can report is not a list this type should
   * be pretending to close, and the three values this field used to hold are still valid.
   */
  mouseTriggerButton?: string;
  language: "en" | "ar" | "pt" | "es" | "fr" | "de" | "it" | "ja" | "zh" | "ko" | "ru";
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
    commandType: "app" | "url" | "folder" | "file" | "command",
    options?: {
      openTerminal?: boolean;
      terminalCommands?: string[];
      workingDirectory?: string;
      launchMode?: "normal" | "reuse" | "prewarm";
      commandShell?: "powershell" | "cmd";
      commandWindow?: "open" | "hidden";
    },
  ) => Promise<LaunchResult>;
  hideWindow: () => void;
  showWindow: () => void;
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
  /** Resolved in the preload, so the very first render already knows — a login start stays in the tray. */
  openedAtLogin?: boolean;
  /** The main confirms the app really has an IDE profile with an MRU (do not guess by name). */
  appSupportsRecents?: (appName: string, appCommand: string) => Promise<boolean>;
  onOpenMenu: (
    callback: (data: {
      source?: "mmb" | "mmb-click" | "shortcut";
      /** Main already knows the wheel is open: this event must never open nor confirm a selection. */
      closeOnly?: boolean;
      /** Centre of the overlay window, in its own coordinates — never read `window.screenX/Y` instead. */
      clientPosition?: { x: number; y: number } | null;
      /** The overlay's origin on screen, as main set it a moment ago. */
      windowOrigin?: { x: number; y: number } | null;
      /** Authoritative viewport after the resize; the renderer may still report the Settings size. */
      clientSize?: { width: number; height: number } | null;
      /** First-frame handshake: the main only reveals a hidden window once this token is acknowledged. */
      paintToken?: number;
    }) => void,
  ) => () => void;
  notifyRadialOpenPaintDone?: (paintToken: number) => void;
  /** The native window is already visible; releases the animation of the radial prepped at zero alpha. */
  onRadialNativeRevealed?: (callback: (paintToken: number) => void) => () => void;

  /* ---- The overlay window's own channels. Only `radial.html` ever calls these. ---- */

  /**
   * The wheel has finished: main puts the overlay back to an invisible, click-through idle box.
   *
   * Separate from `hideWindow`, which belongs to the settings window — two windows, two lifecycles,
   * and conflating them is exactly what made one HWND serve two jobs in the first place.
   */
  closeRadial?: () => void;
  /** Main took the overlay down without being asked (game mode, quit, a gesture that never landed). */
  onRadialHidden?: (callback: () => void) => () => void;
  /** The config file changed on disk; the payload is the whole blob, as `getFullConfig` returns it. */
  onConfigChanged?: (callback: (blob: any) => void) => () => void;
  /** The settings window owns the Start Menu scan and says how far along it is. */
  onDiscoveryPhase?: (
    callback: (phase: 'idle' | 'waiting' | 'scanning') => void,
  ) => () => void;
  /** Wheel → writer: the user switched workspace mid-gesture; persist it. */
  radialWorkspaceChanged?: (index: number) => void;
  /** Wheel → writer: the direction-mode hint has been read and does not come back. */
  radialDirectionHintSeen?: () => void;
  /** Wheel → writer: a launch failed, and the card that reports it lives in the settings window. */
  reportRadialLaunchFault?: (fault: {
    raw: string;
    details?: unknown;
    appLabel?: string;
    shortcut?: { workspaceIndex: number; appId: string; rootId: string };
  }) => void;

  /* ---- The same three, arriving in the settings window. Only `index.html` listens. ---- */

  /** Settings → wheel: how far the Start Menu scan has got, so an empty wheel can say why. */
  publishDiscoveryPhase?: (phase: 'idle' | 'waiting' | 'scanning') => void;
  onRadialWorkspaceChanged?: (callback: (index: number) => void) => () => void;
  onRadialDirectionHintSeen?: (callback: () => void) => () => void;
  onRadialLaunchFault?: (
    callback: (fault: {
      raw: string;
      details?: unknown;
      appLabel?: string;
      shortcut?: { workspaceIndex: number; appId: string; rootId: string };
    }) => void,
  ) => () => void;
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
  onCleanMemory?: (callback: () => void) => () => void;
  onShortcutRelease?: (callback: () => void) => () => void;
  /**
   * Side of the radial's box (px) + whether the position is fixed — the main sizes the menu window
   * with this. `fullBleed` overrides the box entirely: the dimming reaches the edge, so the window
   * takes the screen (see `radialScrimNeedsFullBleed`). The screen meaning the work area — main
   * stops the window at the taskbar, which it would otherwise cover with the scrim.
   */
  setRadialViewport?: (payload: {
    size: number;
    fixed: boolean;
    fullBleed?: boolean;
    /** Which monitor the wheel is born on — see `UIConfig.radialMonitor`. */
    monitor?: 'primary' | 'cursor';
    /** Where on it — see `UIConfig.radialPlacement`. */
    placement?: 'center' | 'cursor';
    /**
     * How far the drawn wheel reaches from its own centre (px). Only `placement: 'cursor'` uses it,
     * to keep the ring on the screen when the pointer is in a corner. Main cannot derive it: `size`
     * has the gesture margin baked in and is several hundred px wider than anything visible.
     */
    ring?: number;
  }) => void;
  /**
   * Click-free launching on: when the radial opens, the main stores where the cursor was, puts it
   * at the center of the wheel and returns it on close. This is what makes the pointer hideable (it
   * is only invisible over our own window) and the gesture neutral at startup.
   */
  setRadialCursorCapture?: (enabled: boolean) => void;
  /** Pulls the cursor back to the center without ending the gesture — used when it drifts off the window. */
  parkRadialCursor?: () => void;
  /**
   * The hub has been picked up and the wheel wants the whole screen to be carried across.
   *
   * Main grows the overlay to the display the wheel is on. The new geometry arrives separately, on
   * `onRadialDragGeometry`, and it arrives BEFORE the window actually moves — which is the point:
   * client coordinates are measured from a corner that is about to shift by several hundred pixels,
   * and a renderer told afterwards paints one frame with the new size and the old centre.
   */
  requestRadialDragSpace?: () => void;
  /**
   * Where this window's client area is about to start, and how big it is about to be. Applied on
   * the `resize` that follows, so the two halves of the change land in the same frame.
   */
  onRadialDragGeometry?: (
    callback: (geometry: {
      windowOrigin: Coordinates;
      clientSize: { width: number; height: number };
    }) => void,
  ) => () => void;
  setGameMode: (config: GameModeConfig) => void;
  /**
   * Whether the status dock needs live readings. Main owns the helper that produces them, so it is
   * told what the switches say and decides for itself whether a process is worth starting.
   */
  setStatusDockActive?: (active: boolean) => void;
  /** The last reading main has. Resolves immediately from its cache; never starts a helper to answer. */
  getSystemStatus?: () => Promise<SystemStatus>;
  /** Pushed whenever a reading changes while the wheel is up. */
  onSystemStatus?: (callback: (status: SystemStatus) => void) => () => void;
  /** 0-100. Applied to the default output device, the same one the reading comes from. */
  setSystemVolume?: (percent: number) => void;
  setSystemMuted?: (muted: boolean) => void;
  /**
   * Opens one of Windows' own panels. An ENUM and not a URI: the renderer naming the exact
   * `ms-settings:` string would be a renderer that can ask the shell to open anything.
   */
  openSystemPanel?: (panel: SystemPanel) => void;
  prewarmApps?: (commands: string[]) => void;
  getFileIcon: (path: string) => Promise<string | null>;
  /** Favicon fetched in the main (data URL) — the renderer usually fails with <img https://…>. */
  getWebsiteFaviconDataUrl?: (pageUrl: string) => Promise<string | null>;
  /** The page's own <title>, so a web shortcut is named the way its browser tab is. */
  getWebsitePageTitle?: (pageUrl: string) => Promise<string | null>;
  minimizeWindow: () => void;
  /** The colour the native window shows before the page paints (`#rrggbb`). */
  setWindowBackground?: (color: string) => void;
  toggleMaximize: () => void;
  quitApp: () => void;
  onWindowState: (
    callback: (state: "maximized" | "windowed") => void,
  ) => () => void;
  onSwitchWorkspace: (callback: (index: number) => void) => () => void;
  /**
   * Native open dialog. Defaults to the executable filter (`.exe`/`.lnk`/`.bat`/`.cmd`) that the
   * Application picker has always used; `{ mode: "any" }` opens it on every file, for shortcuts
   * that point at a document rather than a program.
   */
  selectFile: (options?: { mode?: "executable" | "any" }) => Promise<string | null>;
  selectFolder: () => Promise<string | null>;
  /**
   * What a set of dropped paths are — folder, program, document or internet shortcut — resolved
   * through `.lnk` and `.url` files. Only main can stat a path, and a drop carries nothing but the
   * string, so a dropped shortcut's `commandType` comes from here.
   */
  inspectDropPaths?: (paths: string[]) => Promise<(InspectedDropPath | null)[]>;
  /** The open dialog for a custom icon: pictures, icon files, programs, or any file's own icon. */
  chooseCustomIconFile?: () => Promise<string | null>;
  /** Accepts `path` or `path,index`, with `%VARIABLES%`. */
  readCustomIconSource?: (source: string) => Promise<CustomIconSource>;
  /** One icon from a program or icon library, full size, as a PNG data URL. */
  extractLibraryIcon?: (filePath: string, index: number) => Promise<string | null>;
  /** A normalized PNG data URL in, its `rovyl-icon://` reference out. */
  storeCustomIcon?: (pngDataUrl: string) => Promise<string | null>;
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
  /** Releases / re-arms the global mouse hook while Settings records a trigger button. */
  pauseMouseTrigger?: () => void;
  resumeMouseTrigger?: () => void;
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
    /**
     * The wheel is handling 1-9 itself (`radialNumberLaunch`), so main must NOT register them as
     * global shortcuts — registered, they never reach the renderer at all.
     */
    numberKeysClaimed?: boolean,
    /**
     * Which key belongs to which workspace, from `workspaceKeyBindings`. Main registers exactly
     * these while the wheel is open; it used to hardcode 1–9 against the position, which stopped
     * being true the moment a key could be recorded.
     */
    keys?: Array<{ key: string; index: number }>,
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
