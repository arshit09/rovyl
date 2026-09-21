import { AppItem, UIConfig, Workspace } from "./types";
import { BACKDROP_DIM_SCALE } from "./utils/radialScrim";
import { DEFAULT_SHORTCUT_DOCK, DEFAULT_STATUS_DOCK } from "./utils/screenDocks";
import { DEFAULT_BACK_KEY } from "./constants/radialBackKey";

export const DEFAULT_APPS: AppItem[] = [
  {
    id: "1a7a5818-4c99-4e4f-8a4d-3e28d4d7f5d7",
    type: "app",
    label: "Browser",
    direction: "N",
    iconName: "Globe",
    iconSource: "native",
    command: "msedge",
    description: "Web Browser",
  },
  {
    id: "2b8b6818-5d99-4e4f-8a4d-3e28d4d7f5d8",
    type: "folder",
    label: "Media Hub",
    direction: "NE",
    iconName: "Folder",
    iconSource: "lucide",
    command: "",
    description: "Entertainment",
    children: [
      {
        id: "3c9c7818-6e99-4e4f-8a4d-3e28d4d7f5d9",
        type: "app",
        label: "Spotify",
        iconName: "Music",
        iconSource: "native",
        command: "spotify",
        description: "Music Player",
      },
      {
        id: "4da08818-7f99-4e4f-8a4d-3e28d4d7f5da",
        type: "app",
        label: "YouTube",
        iconName: "Youtube",
        iconSource: "lucide",
        command: "https://www.youtube.com/",
        commandType: "url",
        description: "Web Video",
      },
      {
        id: "5eb19818-8099-4e4f-8a4d-3e28d4d7f5db",
        type: "app",
        label: "Netflix",
        iconName: "Clapperboard",
        iconSource: "lucide",
        command: "https://www.netflix.com/",
        commandType: "url",
        description: "Streaming",
      },
    ],
  },
  {
    id: "6fc2a818-9199-4e4f-8a4d-3e28d4d7f5dc",
    type: "app",
    label: "Games",
    direction: "SE",
    iconName: "Gamepad2",
    iconSource: "native",
    command: "steam",
    description: "Steam",
  },
  {
    id: "70d3b818-a299-4e4f-8a4d-3e28d4d7f5dd",
    type: "app",
    label: "Chat",
    direction: "S",
    iconName: "MessageSquare",
    iconSource: "native",
    command: "discord",
    description: "Discord",
  },
  {
    id: "81e4c818-b399-4e4f-8a4d-3e28d4d7f5de",
    type: "app",
    label: "Files",
    direction: "SW",
    iconName: "FolderOpen",
    iconSource: "native",
    command: "explorer",
    description: "File Manager",
  },
  {
    id: "a306e818-d599-4e4f-8a4d-3e28d4d7f5e0",
    type: "app",
    label: "Calculator",
    direction: "NW",
    iconName: "Calculator",
    iconSource: "native",
    command: "calc",
    description: "Calculator",
  },
  {
    id: "antigravity-default",
    type: "app",
    label: "Antigravity",
    iconName: "Binary",
    iconSource: "lucide",
    command: "antigravity",
    description: "Next-gen AI IDE",
    hasRecents: true,
  },
  {
    id: "cursor-default",
    type: "app",
    label: "Cursor",
    iconName: "Code2",
    iconSource: "lucide",
    command: "cursor",
    description: "AI Code Editor",
    hasRecents: true,
  },
];

/**
 * IDs from the bundled demo radial (Browser, Media Hub, Steam, etc.) — not real Start Menu picks.
 * If Main still contains any of these after a previous bug, we re-run Start Menu discovery to replace them.
 */
export const BUNDLED_DEMO_APP_IDS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  const walk = (items: AppItem[]) => {
    for (const a of items) {
      if (a.id) s.add(a.id);
      if (a.children?.length) walk(a.children);
    }
  };
  walk(DEFAULT_APPS);
  return s;
})();

export function workspaceContainsBundledDemoApp(workspace: Workspace): boolean {
  const scan = (items: AppItem[]): boolean => {
    for (const a of items) {
      if (a.id && BUNDLED_DEMO_APP_IDS.has(a.id)) return true;
      if (a.children?.length && scan(a.children)) return true;
    }
    return false;
  };
  return scan(workspace.apps);
}

/**
 * Main workspace before Start Menu discovery: empty — never the full demo wheel
 * (keeps the wrong apps out of the first paint / off disk). The internal widgets used to live here.
 */
export const MINIMAL_MAIN_WORKSPACE_APPS: AppItem[] = [];

// Default Workspaces
export const DEFAULT_WORKSPACES: Workspace[] = [
  {
    id: "workspace-1",
    name: "Main",
    hotkey: 1,
    enabled: true,
    apps: MINIMAL_MAIN_WORKSPACE_APPS,
    color: "#3B82F6", // Blue
    /** Without this every workspace lands in the wheel with the same `Layers` and is told apart only by name. */
    pickerIconName: "Home",
  },
  {
    id: "workspace-2",
    name: "Streaming",
    hotkey: 2,
    enabled: true,
    pickerIconName: "MonitorPlay",
    apps: [
      {
        id: "stream-1",
        type: "app",
        label: "YouTube",
        iconName: "Youtube",
        iconSource: "lucide",
        command: "https://www.youtube.com/",
        commandType: "url",
        description: "Watch videos",
      },
      {
        id: "stream-2",
        type: "app",
        label: "Twitch",
        iconName: "Tv",
        iconSource: "lucide",
        command: "https://www.twitch.tv/",
        commandType: "url",
        description: "Live streaming",
      },
      {
        id: "stream-4",
        type: "app",
        label: "Netflix",
        iconName: "Clapperboard",
        iconSource: "lucide",
        command: "https://www.netflix.com/br/",
        commandType: "url",
        description: "Netflix Brasil",
      },
    ],
    color: "#EF4444", // Red
  },
  /**
   * The wheel Rovyl is shown with: AI tools, editors and design, on 3.
   * Every command here is a Start Menu AppID rather than a path, because that is what Windows
   * hands back for these installers and what `normalizeAumidIdeCommands` already knows how to
   * turn into an executable. An entry whose app is not installed simply fails to launch — the
   * user deletes it, the same as any other item on the wheel.
   */
  {
    id: "workspace-3",
    name: "Build",
    hotkey: 3,
    enabled: true,
    pickerIconName: "Stars",
    apps: [
      {
        id: "build-1",
        type: "app",
        label: "Claude",
        iconName: "Bot",
        iconSource: "native",
        command: "Claude_pzs8sxrjxfjjc!Claude",
        commandType: "app",
        description: "AI assistant",
      },
      {
        id: "build-2",
        type: "app",
        label: "ChatGPT",
        iconName: "MessageCircle",
        iconSource: "lucide",
        command: "https://chatgpt.com/",
        commandType: "url",
        description: "AI chat",
      },
      {
        id: "build-3",
        type: "app",
        label: "Gemini",
        iconName: "Sparkles",
        iconSource: "lucide",
        command: "https://gemini.google.com/app",
        commandType: "url",
        description: "AI chat",
      },
      {
        id: "build-4",
        type: "app",
        label: "Cursor",
        iconName: "Code2",
        iconSource: "native",
        command: "Anysphere.Cursor",
        commandType: "app",
        description: "AI code editor",
      },
      {
        id: "build-5",
        type: "app",
        label: "Antigravity",
        iconName: "Binary",
        iconSource: "native",
        command: "electron.app.Antigravity",
        commandType: "app",
        description: "AI IDE",
      },
      {
        id: "build-6",
        type: "app",
        label: "Visual Studio Code",
        iconName: "FileCode",
        iconSource: "native",
        command: "Microsoft.VisualStudioCode",
        commandType: "app",
        description: "Code editor",
      },
      {
        id: "build-7",
        type: "app",
        label: "Comet",
        iconName: "Compass",
        iconSource: "native",
        command: "Comet.XC3C7ZDCXKJMBTAJSSDCPHARG4",
        commandType: "app",
        description: "AI browser",
      },
      {
        id: "build-8",
        type: "app",
        label: "Figma",
        iconName: "Figma",
        iconSource: "native",
        command: "com.squirrel.Figma.Figma",
        commandType: "app",
        description: "Design",
      },
    ],
    color: "#FFFFFF",
  },
];

export const DEFAULT_UI_CONFIG: UIConfig = {
  accentColor: "#FFFFFF",
  radialHoverColor: "#FFFFFF",
  menuRadius: 140,
  iconSize: 64,
  fixedPosition: true,
  strictOfflineMode: false,
  /**
   * The main screen, which is where every wheel has opened until now. Following the pointer is a
   * better default for two monitors and a worse one for the person who put the wheel somewhere on
   * purpose — so it is offered, not imposed.
   */
  radialMonitor: 'primary',
  /**
   * The centre of the screen, which is where every wheel has opened until now. Under the pointer is
   * the shorter gesture, but it also moves the wheel somewhere different on every open — so it is
   * offered rather than imposed, exactly like the monitor above.
   */
  radialPlacement: 'center',
  /**
   * Deliberately deep: at 0.9 the desktop is a dark suggestion behind the wheel (~0.85 alpha under
   * it, still falling off at the edge rather than a flat sheet), so the wheel is the only thing on
   * screen worth looking at. Note this is past `SCRIM_FLATTEN_FROM`, so the radial opens monitor-
   * wide by default instead of as a box around the wheel. See `radialScrimAlphas`.
   */
  backdropOpacity: 0.9,
  backdropDimScale: BACKDROP_DIM_SCALE,
  /**
   * Both off. They paint things beside the wheel that were never there, and the shortcut dock is
   * empty until somebody fills it — a strip of nothing appearing in the corner because a person
   * updated is not a feature arriving, it is a fault report.
   */
  statusDock: DEFAULT_STATUS_DOCK,
  shortcutDock: DEFAULT_SHORTCUT_DOCK,
  menuBackgroundStyle: "circle",
  appSpacing: 10, // Default spacing between apps
  activationThreshold: 60,
  centerButton: {
    type: "none",
    target: "",
    label: "",
    iconName: "Circle",
  },
  showLabels: true,
  alwaysShowAppLabels: false,
  showWorkspacePill: true,
  showBattery: false,
  showWeather: false,
  clockPosition: "top-center",
  /**
   * Off: it paints something over the desktop that was never there, and it costs the overlay its
   * cheap box (see `showSettingsCorner`). Whoever wants a visible way into Settings turns it on.
   */
  showSettingsCorner: false,
  settingsCorner: "top-right",
  gameMode: {
    enabled: false,
    mode: "list",
    blockedApps: "",
    autoDetectGames: false,
  },
  globalShortcut: "Alt+Z",
  hasSeenOnboarding: false,
  hasSeenDirectionHint: false,
  workspaces: DEFAULT_WORKSPACES,
  activeWorkspaceIndex: 0,
  appearanceTheme: 'black',
  radialSelectionMode: 'area',
  /**
   * The shares are aimed by but not drawn, which is the wheel every existing profile already has.
   * Turning the wedges on is a deliberate choice in Appearance.
   */
  radialAreaWedges: false,
  /**
   * Off by default: with this on, resting the mouse over an icon LAUNCHES IT. Changing the
   * behaviour under someone already using the wheel would turn a neutral gesture (aiming) into a
   * destructive one. Whoever wants it turns it on in settings.
   */
  radialInstantActivate: 'off',
  radialInstantDwellMs: 400,
  radialInstantSensitivity: 'medium',
  /**
   * Off, like every other setting here that changes what an existing gesture DOES. Typing on an
   * open wheel filters it; turning this on makes nine of those keys launch instead, and nobody
   * should meet that by updating.
   */
  radialNumberLaunch: false,
  /** On, so that turning the feature on is enough to see where the numbers are. */
  radialNumberLabels: true,
  /**
   * A key is named up front so that turning `radialNumberLaunch` on is enough to have one — the
   * same reason `radialNumberLabels` ships true. It stays inert until then, and even once live it
   * only answers inside a folder with the filter empty, so the single thing it costs is starting a
   * search with this letter while already one level down.
   */
  radialBackKey: DEFAULT_BACK_KEY,
  enableKeyboardTrigger: true,
  enableMouseTrigger: true,
  mouseTriggerMode: 'click',
  mouseTriggerButton: 'middle',
  shortcutTriggerMode: 'toggle',
  /**
   * On: a launcher that has to be started by hand is not there when the wheel is reached for, so a
   * new install signs in ready — into the tray, not into Settings. Existing profiles keep what they
   * have; `normalizeStoredConfig` holds a config saved before this key at `false`.
   */
  openAtLogin: true,
  language: "en",
  performanceMode: false,
  mainStartMenuDiscoveryDone: false,
};

/**
 * Old configs saved `internal:*` shortcuts (Notes / Alarm / Stopwatch / Pomodoro).
 * Those widgets are gone: without this cleanup on hydration the radial would show dead icons.
 */
export function stripInternalWidgetApps(items: AppItem[]): AppItem[] {
  const out: AppItem[] = [];
  for (const a of items) {
    if (typeof a.command === "string" && a.command.startsWith("internal:")) continue;
    out.push(a.children?.length ? { ...a, children: stripInternalWidgetApps(a.children) } : a);
  }
  return out;
}

/** Applies `stripInternalWidgetApps` to every workspace and to the center button. */
export function stripInternalWidgetsFromConfig(config: UIConfig): UIConfig {
  const workspaces = config.workspaces?.map((ws) => ({
    ...ws,
    apps: stripInternalWidgetApps(ws.apps ?? []),
  }));
  const center = config.centerButton;
  const centerIsInternal =
    typeof center?.target === "string" && center.target.startsWith("internal:");
  return {
    ...config,
    workspaces: workspaces ?? config.workspaces,
    centerButton: centerIsInternal
      ? { type: "none", target: "", label: "", iconName: "Circle" }
      : center,
  };
}
