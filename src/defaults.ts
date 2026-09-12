import { AppItem, UIConfig, Workspace } from "./types";
import { BACKDROP_DIM_SCALE } from "./utils/radialScrim";
import { DEFAULT_TASKBAR_OVERLAY } from "./utils/taskbarOverlay";

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
        id: "stream-3",
        type: "app",
        label: "Prime Video",
        iconName: "MonitorPlay",
        iconSource: "lucide",
        command: "https://www.primevideo.com/",
        commandType: "url",
        description: "Amazon Streaming",
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
];

export const DEFAULT_UI_CONFIG: UIConfig = {
  accentColor: "#FFFFFF",
  radialHoverColor: "#FFFFFF",
  menuRadius: 140,
  iconSize: 64,
  fixedPosition: true,
  /**
   * The main screen, which is where every wheel has opened until now. Following the pointer is a
   * better default for two monitors and a worse one for the person who put the wheel somewhere on
   * purpose — so it is offered, not imposed.
   */
  radialMonitor: 'primary',
  /**
   * Not 1 any more, and not a weaker default either: 0.6 on the scale that reaches a black screen
   * paints the same alpha (0.5) that 1 painted on the scale that topped out at half. The slider
   * simply has somewhere to go above the shipped look now. See `radialScrimAlphas`.
   */
  backdropOpacity: 0.6,
  backdropDimScale: BACKDROP_DIM_SCALE,
  /**
   * Off, and for the same reason `radialInstantActivate` is off: this one reaches outside the app.
   * Everything else here changes how Rovyl looks; this changes the user's desktop, and a taskbar
   * that started disappearing because someone updated is not a setting, it is a fault report.
   */
  taskbarOverlay: DEFAULT_TASKBAR_OVERLAY,
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
  showBattery: false,
  showWeather: false,
  clockPosition: "top-center",
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
  workspaceSwitchMode: 'picker',
  appearanceTheme: 'black',
  radialSelectionMode: 'angle',
  /**
   * Off by default: with this on, resting the mouse over an icon LAUNCHES IT. Changing the
   * behaviour under someone already using the wheel would turn a neutral gesture (aiming) into a
   * destructive one. Whoever wants it turns it on in settings.
   */
  radialInstantActivate: 'off',
  radialInstantDwellMs: 400,
  radialInstantSensitivity: 'medium',
  enableMouseTrigger: true,
  mouseTriggerMode: 'click',
  mouseTriggerButton: 'middle',
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
