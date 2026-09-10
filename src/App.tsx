import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { RadialMenu } from './components/RadialMenu';
import { Coordinates, AppItem, UIConfig, UserProfile, Workspace } from './types';
import {
  DEFAULT_UI_CONFIG,
  MINIMAL_MAIN_WORKSPACE_APPS,
  stripInternalWidgetApps,
  stripInternalWidgetsFromConfig,
  workspaceContainsBundledDemoApp,
} from './defaults';
import { Minus, X, Maximize, Square, ArrowLeft, ArrowRight, PanelLeftClose } from 'lucide-react';
import { preloadIconsByName } from './iconMap';
import { isRemoteIconUrl, isStoredIconRef, isWebShortcutItem } from './iconRef';
import { useIconHealing } from './hooks/useIconHealing';
import { mirrorPersistenceToLocalStorage } from './persistenceMirror';
import { startMenuAppIdToLaunchCommand } from './utils/windowsLaunchCommand';
import {
  BACKDROP_DIM_SCALE,
  legacyBackdropOpacityToDim,
  radialScrimNeedsFullBleed,
} from './utils/radialScrim';
/** `import type` is erased at compile time: `launchFailure.ts` stays only in the late card chunk. */
import type { ExecutionErrorDetails, FaultShortcutRef, SurfacedFault } from './launchFailure';
/** Erased too — a value import here would put the whole settings module in the wheel's chunk. */
import type { SettingsNav } from './components/PrecisionSettings';

/** Settings is the largest UI surface; radial-only sessions never need to parse or retain it. */
const PrecisionSettings = React.lazy(() =>
  import('./components/PrecisionSettings').then((module) => ({
    default: module.PrecisionSettings,
  })),
);

/**
 * The only two things in this file that animated with `framer-motion`, both behind their own chunks.
 *
 * The wheel does not use the library at all — `RadialMenu` has zero `motion.` usages — yet 111 kB of
 * it was statically imported here for a settings transition, an error banner and a toast, and so sat
 * in the chunk the wheel waits on before it can paint. None of the three is ever on screen in a
 * session where the user opens the wheel and nothing fails.
 */
const PanelTransition = React.lazy(() =>
  import('./components/PanelTransition').then((module) => ({ default: module.PanelTransition })),
);
const ErrorOverlays = React.lazy(() =>
  import('./components/ErrorOverlays').then((module) => ({ default: module.ErrorOverlays })),
);
/** Shown once, on a profile that has never run before, and after that never fetched again. */
const FirstRun = React.lazy(() =>
  import('./components/FirstRun').then((module) => ({ default: module.FirstRun })),
);

const LS_MAIN_DISCOVERY_DONE = 'zenith_main_discovery_done';

/**
 * Where the Start Menu scan has got to, for the two surfaces that would otherwise just look broken.
 *
 * At login the scan is deliberately deferred twenty seconds so it cannot compete with Windows for
 * the disk — and for those twenty seconds the Main workspace is genuinely empty. A wheel with
 * nothing in it and no explanation is indistinguishable from one that has lost its shortcuts, and
 * the empty state in Settings said "Add an application", which is advice to undo work that is
 * already on its way.
 */
export type DiscoveryPhase = 'idle' | 'waiting' | 'scanning';

/** Every Lucide glyph name a config can put on screen: shortcuts, folders, workspaces, centre button. */
function* iterateItemIconNames(items: AppItem[]): Generator<string | undefined> {
  for (const item of items) {
    yield item.iconName;
    if (item.children?.length) yield* iterateItemIconNames(item.children);
  }
}

function* iterateConfigIconNames(config: UIConfig, apps: AppItem[]): Generator<string | undefined> {
  yield config.centerButton?.iconName;
  yield* iterateItemIconNames(apps);
  for (const workspace of config.workspaces ?? []) {
    yield workspace.pickerIconName;
    yield* iterateItemIconNames(workspace.apps ?? []);
  }
}

/** Legacy first-run flag — used only to avoid double-running in odd edge cases; repair no longer skips on this alone. */
const LS_ZENITH_INITIALIZED_LEGACY = 'zenith_initialized';

/**
 * Start Menu scan deferral.
 *
 * Started with Windows: 20 s. Competing with login saturates disk and CPU, and a PowerShell
 * probe at that moment leaves the whole system sluggish.
 *
 * Opened by hand: almost immediate. The same deferral applied to both cases, and the result
 * was the user installing, opening, and finding an empty wheel for twenty seconds — with nothing
 * happening and nothing to explain it. Opened by hand, the machine is idle and there is nothing
 * to avoid.
 */
const START_MENU_DISCOVERY_DEFER_LOGIN_MS = 20_000;
const START_MENU_DISCOVERY_DEFER_MANUAL_MS = 600;

type StartMenuDiscoveryRow = { Name?: string; Path?: string; Command?: string };

/** Box in screen coordinates (or client, once remapped) — used by the panel under the radial. */
type ScreenRect = { x: number; y: number; width: number; height: number };

/** Builds Main workspace apps from `get-startup-apps` and appends internal Zenith shortcuts from defaults. */
async function buildMainAppsFromStartMenuDiscovery(
  raw: StartMenuDiscoveryRow[],
): Promise<AppItem[]> {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  const built: AppItem[] = [];
  const DISCOVERY_ICON_BATCH = 4;
  for (let offset = 0; offset < raw.length; offset += DISCOVERY_ICON_BATCH) {
    const chunk = raw.slice(offset, offset + DISCOVERY_ICON_BATCH);
    const chunkBuilt = await Promise.all(
      chunk.map(async (app, chunkIndex) => {
        const idx = offset + chunkIndex;
        /**
         * Discovery reports Start menu AppIDs, same as the picker, so it stores launch lines the
         * same way — otherwise the apps offered on first run are exactly the ones that cannot be
         * launched. A row that already carries a real path (the `.lnk` sweep) stays a path.
         */
        const appId = String(app.Command || app.Path || '').trim();
        const cmd = startMenuAppIdToLaunchCommand(appId);
        let iconUrl = '';
        try {
          if (window.electron?.getFileIcon && cmd) {
            iconUrl = (await window.electron.getFileIcon(cmd)) || '';
          }
        } catch {
          /* ignore */
        }
        return {
          id: crypto.randomUUID(),
          type: 'app' as const,
          label: app.Name?.trim() || 'App',
          iconName: '',
          iconSource: 'native' as const,
          customIconUrl: iconUrl,
          command: cmd,
          commandType: 'app' as const,
          /** The id, not the moniker: the prefix is plumbing and says nothing to whoever reads this. */
          description: appId ? `Start Menu: ${appId}` : '',
          direction: directions[idx % 8],
        };
      }),
    );
    built.push(...chunkBuilt);
  }
  return [...built, ...MINIMAL_MAIN_WORKSPACE_APPS];
}

/** Main already has real shortcuts or apps outside the minimal widget set — do not re-import the Start Menu after a reboot. */
function mainWorkspaceAlreadyCustomized(mainWs: Workspace | undefined): boolean {
  if (!mainWs?.apps?.length) return false;
  const minimalIds = new Set(
    MINIMAL_MAIN_WORKSPACE_APPS.map((a) => a.id).filter((id): id is string => !!id),
  );
  if (mainWs.apps.length > MINIMAL_MAIN_WORKSPACE_APPS.length) return true;
  for (const a of mainWs.apps) {
    if (a.id && !minimalIds.has(a.id)) return true;
    if (typeof a.command === 'string' && !a.command.startsWith('internal:')) return true;
  }
  return false;
}

// Helper function to find an app by ID anywhere in the nested structure
const findAppRecursive = (items: AppItem[], id: string): AppItem | undefined => {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children && item.children.length > 0) {
      const found = findAppRecursive(item.children, id);
      if (found) return found;
    }
  }
  return undefined;
};

/**
 * The top-level item an id belongs to. Settings lists a workspace one row deep — a shortcut inside
 * a group has no row of its own — so "open the shortcut that failed" can only mean its group.
 */
const findRootAncestorId = (items: AppItem[], id: string): string | undefined => {
  for (const item of items) {
    if (item.id === id) return item.id;
    if (item.children?.length && findAppRecursive(item.children, id)) return item.id;
  }
  return undefined;
};

/**
 * Preferred over the cursor as the anchor in `setWindowSize('fullscreen'|'small')`: the main process
 * uses `getDisplayNearestPoint` — with several monitors the cursor can be on another screen while the
 * HWND (radial / island) already covers the right one.
 */
function windowCenterScreenPoint(): { x: number; y: number } {
  const w = window.outerWidth || window.innerWidth || 1;
  const h = window.outerHeight || window.innerHeight || 1;
  return {
    x: window.screenX + Math.round(w / 2),
    y: window.screenY + Math.round(h / 2),
  };
}

/** JSON-clone + guarantees `config.workspaces` is not empty — the file has to pass `normalizeFullPersistenceBlob` on the next startup. */
function sanitizeFullPersistenceForDisk(d: {
  user: UserProfile | null;
  apps: AppItem[];
  config: UIConfig;
}): {
  user: UserProfile | null;
  apps: AppItem[];
  config: UIConfig;
  /** Mirror at the JSON root — `normalizeFullPersistenceBlob` merges this in if `config.workspaces` comes back empty from disk. */
  workspaces: Workspace[];
} | null {
  try {
    const raw = JSON.parse(JSON.stringify(d)) as typeof d;
    if (!raw.config || typeof raw.config !== 'object') {
      return null;
    }
    if (!Array.isArray(raw.config.workspaces) || raw.config.workspaces.length === 0) {
      return null;
    }
    const mainWs = raw.config.workspaces.find(
      (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
    );
    if (mainWs && Array.isArray(mainWs.apps) && mainWs.apps.length > 0) {
      raw.apps = JSON.parse(JSON.stringify(mainWs.apps)) as AppItem[];
    }
    const workspacesMirror = JSON.parse(
      JSON.stringify(raw.config.workspaces),
    ) as Workspace[];
    return {
      ...raw,
      workspaces: workspacesMirror,
    };
  } catch {
    return null;
  }
}

export default function App() {
  /* zenith-verify:radial-handshake-renderer — radial overlays/handshake; see scripts/verify-radial-windowing.mjs */
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /** Update downloaded and waiting for a restart — flagged with a badge on the radial hub. */
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    /**
     * Ask, do not just wait for the event: `update-downloaded` fires once, and a renderer that
     * reloaded after it never saw the badge again — the update was still there, ready, with
     * nothing on the hub to say so.
     */
    void window.electron?.getUpdateState?.().then((state) => {
      if (!cancelled) setUpdateReady(state?.state === 'ready');
    }).catch(() => undefined);
    const off = window.electron?.onUpdateState?.((payload) => {
      setUpdateReady(payload?.state === 'ready');
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  /** Hides dashboard/settings before `await applyWindowSize('fullscreen')` — without it, restoring from the tray shows a frame of the last UI. */
  const [radialOpenAwaitingFullscreen, setRadialOpenAwaitingFullscreen] = useState(false);
  /**
   * The waiting cover can only be opaque if there was an opaque panel on screen to mask.
   * Coming from the tray/island there is no old texture, and the black painted the window's
   * old bounds — a black rectangle flashing where the radial should be.
   */
  const [radialAwaitCoverOpaque, setRadialAwaitCoverOpaque] = useState(false);
  /**
   * Panel (Settings/Welcome) that stays on screen under the radial.
   * `…ScreenRect` is the truth (screen coordinates, immune to the window resize);
   * `…ClientRect` is the same box in the coordinates of the already widened window, recomputed
   * whenever the geometry changes — just like the radial's anchor.
   */
  const [panelOverlayScreenRect, setPanelOverlayScreenRect] = useState<ScreenRect | null>(null);
  /** The panel stays on screen under the radial (with or without repositioning). */
  const [panelKeptUnderRadial, setPanelKeptUnderRadial] = useState(false);
  const [panelOverlayClientRect, setPanelOverlayClientRect] = useState<ScreenRect | null>(null);
  const panelOverlayScreenRectRef = useRef<ScreenRect | null>(null);
  panelOverlayScreenRectRef.current = panelOverlayScreenRect;
  /** One solid frame before minimizing — stops Windows caching a dashboard bitmap and flashing when the radial reopens. */
  const [minimizeNeutralCoverActive, setMinimizeNeutralCoverActive] = useState(false);
  /** Main: `prepare-radial-show` — paint before `show()` so no old texture is exposed (minimized/dashboard). */
  const [radialPreShowSolidCover, setRadialPreShowSolidCover] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  /**
   * Where Settings was open. Up here because the panel does not survive using the app.
   *
   * The surface is unmounted by three independent paths — the wheel over it (the commit in which
   * `panelOverlayClientRect` does not exist yet), the collapse into the island, and the shortcut
   * with the panel already put away — and React takes the component state with it. While the open
   * section lived in there, any of these gestures returned the user to General in the middle of
   * what they were doing. Kept here, it crosses the unmount and touches nothing that decides what
   * gets painted.
   */
  const [settingsNav, setSettingsNav] = useState<SettingsNav>({
    sectionId: 'general',
    isSidebarCollapsed: false,
  });
  /** Two-paint transparent close phase so DWM never caches Settings as the idle HWND texture. */
  const [panelNeutralizingClose, setPanelNeutralizingClose] = useState(false);
  const isDashboardOpenRef = useRef(false);
  const isSettingsOpenRef = useRef(false);

  // Standalone Settings Window Mode - REMOVED
  // const isSettingsWindow = window.location.hash === '#settings' || window.location.search.includes('window=settings');

  // Dashboard/Welcome Screen State
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  /**
   * After minimizing with Welcome/settings, the OS restores the HWND when `small` is applied and the `restore` event
   * would make the panel look “open” again in a loop. This flag keeps the panel chrome collapsed until the panel is
   * reopened / closed.
   */
  const [panelChromeDismissedForIsland, setPanelChromeDismissedForIsland] = useState(false);
  const panelSurfaceOpen = useMemo(
    () => (isDashboardOpen || isSettingsOpen || panelNeutralizingClose) && !panelChromeDismissedForIsland,
    [isDashboardOpen, isSettingsOpen, panelNeutralizingClose, panelChromeDismissedForIsland],
  );

  useEffect(() => {
    isDashboardOpenRef.current = isDashboardOpen;
    isSettingsOpenRef.current = isSettingsOpen;
  }, [isDashboardOpen, isSettingsOpen]);

  useEffect(() => {
    if (!isDashboardOpen && !isSettingsOpen) {
      setPanelChromeDismissedForIsland(false);
    }
  }, [isDashboardOpen, isSettingsOpen]);

  const [windowState, setWindowState] = useState<'maximized' | 'windowed'>('windowed');
  const [isLoaded, setIsLoaded] = useState(false);
  /** Only ever non-idle on a profile whose Main workspace has not been filled yet. */
  const [discoveryPhase, setDiscoveryPhase] = useState<DiscoveryPhase>('idle');
  /** True when we hydrated from config-v2.json / migration — localStorage can be empty after a reboot. */
  const hydratedFromPersistenceRef = useRef(false);
  /** Desktop welcome / first session: runs only after `isLoaded` (IPC cannot run before hydration). */
  const welcomeBootstrapDoneRef = useRef(false);
  /**
   * The Start Menu scan runs silently.
   *
   * There used to be a waiting screen here filling the whole window on the first open. An app
   * that lives in the tray and is summoned by a gesture should not start by trapping the user
   * in a progress notice — least of all one they did not ask for and cannot leave. The shortcuts
   * appear when they appear; the wheel already shows its own per-icon indicator.
   */
  /**
   * After the Start Menu discovery in a session with no previous data (reset / first startup),
   * open the dashboard automatically so the user sees their apps.
   */
  const openDashboardAfterDiscoveryRef = useRef(false);

  // User / Auth State (Defaults to null)
  const [user, setUser] = useState<UserProfile | null>(null);
  const userRef = useRef<UserProfile | null>(null);
  userRef.current = user;

  /**
   * Store channel. Microsoft charges before letting the package install and only hands the MSIX to
   * whoever bought it, so asking for a licence key afterwards would be charging twice.
   *
   * This is deliberately a DERIVED flag and not a synthetic `user`: the `user` goes to disk in
   * `sanitizeFullPersistenceForDisk`, and writing `isPremium: true` in there would mean copying the
   * persistence file to a direct-channel install unlocked it.
   */
  const [isStoreChannel, setIsStoreChannel] = useState(false);
  const isStoreChannelRef = useRef(false);
  isStoreChannelRef.current = isStoreChannel;

  useEffect(() => {
    let cancelled = false;
    void window.electron?.getBuildChannel?.().then((channel) => {
      if (!cancelled) setIsStoreChannel(channel === 'store');
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const [menuPosition, setMenuPosition] = useState<Coordinates>({ x: 0, y: 0 });
  /** Remounts the visual tree on every open; no geometry/transition from the previous session survives. */
  const [radialMountKey, setRadialMountKey] = useState(0);
  /** Token prepared while still hidden, and token whose native window has already been revealed. */
  const [radialPendingPaintToken, setRadialPendingPaintToken] = useState<number | null>(null);
  const [radialNativeRevealToken, setRadialNativeRevealToken] = useState<number | null>(null);
  const [radialClientSize, setRadialClientSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  /** Absolute centre chosen by main; it is the monitor's centre, never the cursor position. */
  const radialCenterScreenRef = useRef<Coordinates | null>(null);
  /** Bounds sent by main are authoritative while window.screenX/Y still reflect Settings. */
  const radialClientPositionHintRef = useRef<Coordinates | null>(null);
  const radialWindowOriginHintRef = useRef<Coordinates | null>(null);
  const [triggerSource, setTriggerSource] = useState<'mmb' | 'mmb-click' | 'shortcut'>('shortcut');
  const radialTransitionWarmedRef = useRef(false);
  /** One failure, one card. `seq` rises with each so animation and timer restart. */
  const [launchFault, setLaunchFault] = useState<SurfacedFault | null>(null);
  /**
   * Kept apart from `launchFault` on purpose: this one reports data loss and outlives every launch
   * failure. Sharing one slot meant the next app that failed to open silently threw it away.
   */
  const [configNotice, setConfigNotice] = useState<SurfacedFault | null>(null);
  const faultSeqRef = useRef(0);
  /** Latches on the first failure so the overlay chunk is fetched then, and never before. */
  const [errorOverlaysNeeded, setErrorOverlaysNeeded] = useState(false);
  useEffect(() => {
    if (launchFault || configNotice) setErrorOverlaysNeeded(true);
  }, [launchFault, configNotice]);
  const [isDesktopMode, setIsDesktopMode] = useState(false);
  /** Only mount the island after `setWindowSize('small')` with monitor bounds — otherwise the hit-shape uses coords with the window still at 1280×800 (dev). */
  const [electronSmallOverlayReady, setElectronSmallOverlayReady] = useState(false);
  const isDesktopModeRef = useRef(false);
  isDesktopModeRef.current = isDesktopMode;

  /** After minimizing the panel, the first `setWindowHitShape` can still use `screenX/screenY` from windowed mode — the HWND shrinks to the wrong place. Reapplies the `small` overlay on the next tick. (Must stay below `isDesktopMode` — otherwise a ReferenceError breaks the render.) */
  const prevPanelChromeDismissedRef = useRef(false);
  useEffect(() => {
    const edge =
      panelChromeDismissedForIsland && !prevPanelChromeDismissedRef.current;
    prevPanelChromeDismissedRef.current = panelChromeDismissedForIsland;
    if (!edge || !isDesktopMode) return;
    const t = window.setTimeout(() => {
      void window.electron?.reapplySmallOverlay?.();
      void window.electron?.invalidatePaint?.();
    }, 100);
    return () => clearTimeout(t);
  }, [isDesktopMode, panelChromeDismissedForIsland]);

  /** Declared before handlers that resize the window — keeps IPC + React in sync. */
  const lastWindowState = useRef<'fullscreen' | 'windowed' | 'small' | null>(null);
  /**
   * Opaque cover during small→windowed: masks DWM artefacts if main paints before `applyWindowSize`.
   * Turns on in the same commit the panel becomes visible; turns off in the microtask after resize + invalidate.
   */
  const [panelResizeSolidCover, setPanelResizeSolidCover] = useState(false);

  /** On the `panelSurfaceOpen` false→true edge, cover before `setWindowSize('windowed')` (wrong DWM frame). */
  const prevPanelSurfaceOpenRef = useRef(panelSurfaceOpen);
  useLayoutEffect(() => {
    const prev = prevPanelSurfaceOpenRef.current;
    prevPanelSurfaceOpenRef.current = panelSurfaceOpen;
    if (!prev && panelSurfaceOpen && isDesktopMode) {
      setPanelResizeSolidCover(true);
    }
  }, [panelSurfaceOpen, isDesktopMode]);

  /** Guarantees the HWND is `windowed` while the panel/settings are visible (not minimized). */
  useLayoutEffect(() => {
    if (!isDesktopMode) return;
    if (!window.electron?.setWindowSize && !window.electron?.applyWindowSize) return;
    if (!panelSurfaceOpen) return;
    if (radialOpenAwaitingFullscreen) return;
    /** Radial open over the panel: the window is the overlay — restoring `windowed` now would collapse it. */
    if (isMenuOpen) return;

    let cancelled = false;

    /** The microtask runs after the React commit and before the paint — `invoke` expands the HWND once the island is already in the DOM. */
    queueMicrotask(async () => {
      if (cancelled) return;
      try {
        if (window.electron?.applyWindowSize) {
          await window.electron.applyWindowSize('windowed');
        } else {
          window.electron?.setWindowSize?.('windowed');
        }
        if (cancelled) return;
        window.electron?.showWindow();
        lastWindowState.current = 'windowed';
        void window.electron?.invalidatePaint?.();
      } catch {
        /* ignore */
      } finally {
        if (cancelled) return;
        /** Two rAF — the DWM usually finishes the resize before the island is shown again when the panel closes. */
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!cancelled) {
              setPanelResizeSolidCover(false);
            }
          });
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isDesktopMode, panelSurfaceOpen, radialOpenAwaitingFullscreen, isSettingsOpen, isMenuOpen]);

  useEffect(() => {
    if (!panelSurfaceOpen) {
      setPanelResizeSolidCover(false);
    }
  }, [panelSurfaceOpen]);

  useLayoutEffect(() => {
    if (!isDesktopMode || !window.electron?.setWindowSize) {
      setElectronSmallOverlayReady(false);
      return;
    }
    /**
     * With the radial open, `panelSurfaceOpen` is false (dashboard closed in the same commit).
     * Without this guard we applied `small` here and cancelled `openMenu`'s `fullscreen` — the menu stayed in the windowed rect.
     */
    if (isMenuOpen || radialOpenAwaitingFullscreen) {
      setElectronSmallOverlayReady(true);
      return;
    }
    /** Panel / settings visible in `windowed` — do not force `small` here (avoids overwriting the first startup). */
    if (panelSurfaceOpen) {
      setElectronSmallOverlayReady(true);
      return;
    }

    let cancelled = false;
    setElectronSmallOverlayReady(false);
    const { x: ax, y: ay } = windowCenterScreenPoint();

    void (async () => {
      try {
        if (window.electron?.applyWindowSize) {
          await window.electron.applyWindowSize('small', { x: ax, y: ay });
        } else {
          window.electron!.setWindowSize!('small', { x: ax, y: ay });
          await new Promise<void>((r) => window.setTimeout(r, 48));
        }
        if (cancelled) return;
        lastWindowState.current = 'small';
        await window.electron?.reapplySmallOverlay?.();
        if (cancelled) return;
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (!cancelled) setElectronSmallOverlayReady(true);
      } catch {
        if (!cancelled) setElectronSmallOverlayReady(true);
      }
    })();

    return () => {
      cancelled = true;
      setElectronSmallOverlayReady(false);
    };
  }, [isDesktopMode, panelSurfaceOpen, isMenuOpen, radialOpenAwaitingFullscreen]);

  const [isAppReady, setIsAppReady] = useState(true); // Defaults to true so initial loading works normally

  // State for Apps and Config (Defaults to initial constants)
  const [apps, setApps] = useState<AppItem[]>(MINIMAL_MAIN_WORKSPACE_APPS);

  const [config, setConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG);
  const configRef = useRef(config);
  configRef.current = config;
  const targetWorkspaceIndexRef = useRef(config.activeWorkspaceIndex);
  targetWorkspaceIndexRef.current = config.activeWorkspaceIndex;
  const switchDebounceTimer = useRef<NodeJS.Timeout | null>(null);

  /**
   * One failed launch → one card, with the item that failed attached.
   *
   * Behind a ref because `executeAction` is re-created on every render and the promise it starts
   * outlives several of them: reading the current function at settle time is the only way the
   * failure is filed against the config as it is now, rather than as it was when the wheel opened.
   */
  const reportLaunchFailure = useCallback(
    (result: { ok: false; error: string; details?: ExecutionErrorDetails }, item?: AppItem) => {
      console.error('Execution failed:', result.error);
      const cfg = configRef.current;
      const workspaceIndex = cfg.activeWorkspaceIndex;
      const workspaceApps = cfg.workspaces[workspaceIndex]?.apps || [];
      const rootId = item ? findRootAncestorId(workspaceApps, item.id) : undefined;
      faultSeqRef.current += 1;
      setLaunchFault({
        kind: 'launch',
        seq: faultSeqRef.current,
        raw: result.error,
        details: result.details,
        /** Main knows the command; only this side knows the name that was on the wheel. */
        appLabel: item?.label || undefined,
        /**
         * No `rootId`, no offer to fix: the item is not in the workspace Settings would open —
         * a centre button bound to a raw command, or a shortcut deleted between wheel and card.
         */
        shortcut: item && rootId ? { workspaceIndex, appId: item.id, rootId } : undefined,
      });
    },
    [],
  );
  const reportLaunchFailureRef = useRef(reportLaunchFailure);
  reportLaunchFailureRef.current = reportLaunchFailure;

  /**
   * A config that only names curated glyphs never pays for the full Lucide chunk; one that does
   * — because the user picked something else in the icon picker — fetches it here, well before the
   * wheel opens, so the right glyph is already on screen at the first paint.
   */
  useEffect(() => {
    preloadIconsByName(iterateConfigIconNames(config, apps));
  }, [config, apps]);

  /**
   * With no radial and no panel there is nothing to draw: the HWND is shrunk into the corner. Leaving it
   * `small` at full screen kept a topmost layered window composed by the DWM taking all the mouse
   * hit-testing — cursor and system went slow. `updateWindowSize` re-expands when the radial / panel opens.
   */
  const overlayIdle =
    isDesktopMode &&
    !panelSurfaceOpen &&
    !isMenuOpen &&
    !radialOpenAwaitingFullscreen;

  /**
   * Size of the radial window. Labels sit outside the icons; the gesture margin is what guarantees that
   * dragging to pick the direction (and the click that confirms it) stays inside the window — mouse events
   * come from the window, outside it the angle freezes and the selection never confirms. Raise it if short.
   */
  useEffect(() => {
    if (!window.electron?.setRadialViewport) return;
    const RADIAL_LABEL_ALLOWANCE = 90;
    const RADIAL_GESTURE_MARGIN = 200;
    const radius = Number(config.menuRadius) || 140;
    const icon = Number(config.iconSize) || 64;
    const size = Math.round(
      2 * (radius + icon + RADIAL_LABEL_ALLOWANCE + RADIAL_GESTURE_MARGIN),
    );
    window.electron.setRadialViewport({
      size,
      fixed: true,
      /**
       * Past a certain dimming the scrim no longer fades out inside that box, and a box that shows
       * its own edge has to stop being a box: main opens the radial over the whole monitor instead.
       * It is the setting that decides, so the decision travels with the size, well before an open.
       */
      fullBleed: radialScrimNeedsFullBleed(config.backdropOpacity),
    });
  }, [config.menuRadius, config.iconSize, config.backdropOpacity]);

  /**
   * Click-free execution: the renderer is the one that knows it is on, but the one that has to park
   * the pointer at the centre of the wheel is main — the warp happens before `open-menu`, and so
   * before the radial exists here. Only the yes/no crosses, and only when the setting changes.
   */
  useEffect(() => {
    window.electron?.setRadialCursorCapture?.(config.radialInstantActivate === 'dwell');
  }, [config.radialInstantActivate]);

  /**
   * Main cannot infer this: `hide-window` hides the window without changing mode, so `windowed`
   * survives it and the next radial opened "over a panel" that was not on screen — dragging the
   * settings back with it. The renderer is the one that knows, so it says.
   */
  useLayoutEffect(() => {
    window.electron?.setPanelSurfaceVisible?.(
      isDesktopMode && panelSurfaceOpen && !panelNeutralizingClose,
    );
  }, [isDesktopMode, panelSurfaceOpen, panelNeutralizingClose]);

  useLayoutEffect(() => {
    if (!overlayIdle || !window.electron?.collapseIdleOverlay) return;
    /** A tick later: main may be applying `small`/`windowed` in the same cycle (avoids a bounds race). */
    const t = window.setTimeout(() => {
      void window.electron?.collapseIdleOverlay?.();
    }, 60);
    return () => window.clearTimeout(t);
  }, [overlayIdle]);

  /**
   * Warms small↔fullscreen while the window is idle — the 1st radial open (with the HWND
   * shrunk) stops paying the DWM's cold cost.
   */
  useEffect(() => {
    if (!isDesktopMode || !electronSmallOverlayReady || !window.electron?.warmRadialTransition) {
      return;
    }
    if (radialTransitionWarmedRef.current || isMenuOpen || radialOpenAwaitingFullscreen) return;
    if (panelSurfaceOpen) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          await window.electron!.warmRadialTransition!();
          if (cancelled) return;
          radialTransitionWarmedRef.current = true;
          await window.electron?.reapplySmallOverlay?.();
        } catch {
          /* ignore */
        }
      })();
    }, 100);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    isDesktopMode,
    electronSmallOverlayReady,
    panelSurfaceOpen,
    isMenuOpen,
    radialOpenAwaitingFullscreen,
  ]);

  /** Latest snapshot for flush on pagehide / sync disk write (survives reboot). */
  const persistenceRef = useRef({
    user: null as UserProfile | null,
    apps: MINIMAL_MAIN_WORKSPACE_APPS,
    config: DEFAULT_UI_CONFIG,
  });
  /** When load failed but disk still has a non-trivial config file — never overwrite with empty defaults. */
  const persistenceSaveBlockedRef = useRef(false);
  /**
   * The Start Menu scan was scheduled (long defer) after stripping Main — blocks the 150ms auto-save that
   * wrote an empty Main to disk before the scan finished (a restart then showed an empty Main).
   */
  const startMenuScanPersistenceHoldRef = useRef(false);
  /**
   * `hide-window` in main only lowers the opacity — the document can stay "visible", so `visibilitychange`/`pagehide`
   * never save. We keep the synchronous flush here and always call it before `hideWindow()`.
   */
  const flushPersistenceToDiskRef = useRef<(() => void) | null>(null);
  /** Layout: keep the ref aligned with state before the `useEffect`s that write to disk (avoids a flush with a stale snapshot). */
  useLayoutEffect(() => {
    persistenceRef.current = { user, apps, config };
  });

  /** Used by post-launch setTimeout — must never read stale React state or opening the dashboard after launching an app wrongly calls setWindowSize('small') (ignoreMouseEvents → "frozen" UI). */
  const electronShrinkGateRef = useRef({ panelSurfaceOpen: false });
  useEffect(() => {
    electronShrinkGateRef.current = { panelSurfaceOpen };
  }, [panelSurfaceOpen]);

  // ICON NORMALIZATION CACHE-BUST:
  // When the extract-icon.ps1 normalization algorithm changes, bump this version
  // so all stored base64 icons get cleared and re-fetched with the new format.
  const ICON_NORMALIZATION_VERSION = 'v4-shell-dib-orientation';
  useEffect(() => {
    if (!isLoaded) return;
    if (!window.electron?.getFileIcon) return;
    const storedVersion = localStorage.getItem('zenith_icon_normalization_version');
    if (storedVersion === ICON_NORMALIZATION_VERSION) return; // Already using new format

    // Version mismatch: clear stored exe icons so healing re-fetches them (skip URL favicons).
    setConfig(prev => {
      const clearIcons = (items: AppItem[]): AppItem[] =>
        items.map(item => ({
          ...item,
          customIconUrl:
            item.iconSource === 'native' &&
            !isWebShortcutItem(item) &&
            !isRemoteIconUrl(item.customIconUrl)
              ? undefined
              : item.customIconUrl,
          children: item.children ? clearIcons(item.children) : undefined,
        }));
      return {
        ...prev,
        workspaces: prev.workspaces.map(ws => ({
          ...ws,
          apps: clearIcons(ws.apps),
        })),
      };
    });

    localStorage.setItem('zenith_icon_normalization_version', ICON_NORMALIZATION_VERSION);
    // console.log('[Icons] Cache-busted: re-fetching icons with new normalization.');
  }, [isLoaded]);

  /** 241 lines of re-fetch and retry bookkeeping, and none of it is anyone else's business. */
  useIconHealing({ isLoaded, config, setConfig });


  // 1. PRIMARY PERSISTENCE: Load from Electron Main or Migrate from LocalStorage
  useEffect(() => {
    let discoveryDeferTimer: number | undefined;
    let cancelled = false;

    const loadPersistence = async () => {
      let finalData: any = null;
      let loadedFromLocalStorageMigration = false;

      if (window.electron?.getFullConfig) {
        try {
          finalData = await window.electron.getFullConfig();
        } catch (e) {
          console.warn('[Zenith] getFullConfig failed:', e);
          window.electron?.savePersistenceLog?.(
            `getFullConfig: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (cancelled) return;

      let persistenceMeta = { primaryBytes: 0, backupBytes: 0, quarantineBytes: 0 };
      if (window.electron?.getConfigPersistenceMeta) {
        try {
          const m = await window.electron.getConfigPersistenceMeta();
          persistenceMeta = {
            primaryBytes: m.primaryBytes,
            backupBytes: m.backupBytes,
            quarantineBytes: m.quarantineBytes ?? 0,
          };
        } catch (e) {
          console.warn('[Zenith] getConfigPersistenceMeta failed:', e);
        }
      }
      if (cancelled) return;

      // Migration Fallback
      if (!finalData) {
        const userStr = localStorage.getItem('zenith_user');
        const appsStr = localStorage.getItem('zenith_apps');
        const configStr = localStorage.getItem('zenith_config');

        if (userStr || appsStr || configStr) {
          finalData = {
            user: userStr ? JSON.parse(userStr) : null,
            apps: appsStr ? JSON.parse(appsStr) : MINIMAL_MAIN_WORKSPACE_APPS,
            config: configStr ? JSON.parse(configStr) : DEFAULT_UI_CONFIG,
          };
          loadedFromLocalStorageMigration = true;
          // Save to main process immediately
          void window.electron?.saveFullConfig?.(finalData);
        }
      }
      if (cancelled) return;

      const quarantineBytes = persistenceMeta.quarantineBytes ?? 0;
      const diskLooksSubstantial =
        persistenceMeta.primaryBytes > 50 ||
        persistenceMeta.backupBytes > 50 ||
        quarantineBytes > 0;
      if (!finalData && diskLooksSubstantial && !loadedFromLocalStorageMigration) {
        persistenceSaveBlockedRef.current = true;
        window.electron?.savePersistenceLog?.(
          `Hydration: no payload but disk has data (primary=${persistenceMeta.primaryBytes} bak=${persistenceMeta.backupBytes} quarantine=${quarantineBytes}) — blocking saves`,
        );
        faultSeqRef.current += 1;
        setConfigNotice({
          kind: 'notice',
          seq: faultSeqRef.current,
          title: 'Rovyl could not read your saved configuration',
          message:
            'Saving is blocked so nothing already on disk gets overwritten. Your shortcuts are still in AppData.',
          hint:
            'Check rovyl-persistence.log in the app data folder, look for config-v2.json.broken-* files, or restore config-v2.json / .bak.',
        });
      } else {
        persistenceSaveBlockedRef.current = false;
      }

      let nextApps: AppItem[] = MINIMAL_MAIN_WORKSPACE_APPS;
      let nextConfig: UIConfig = DEFAULT_UI_CONFIG;

      if (finalData) {
        if (finalData.config) {
          /** Old configs carry `internal:*` shortcuts from the removed widgets — discard them on read. */
          nextConfig = stripInternalWidgetsFromConfig({
            /**
             * The defaults as the base, BEFORE whatever came off disk.
             *
             * Without this base, every setting added in a version later than the saved file
             * reached the renderer as `undefined` instead of its default value. The symptom
             * misleads: it looks like the backup did not keep the settings, when in truth they
             * were never in the file and nobody restored them on read.
             */
            ...DEFAULT_UI_CONFIG,
            ...finalData.config,
            /**
             * The opening point is no longer configurable: the wheel is always born at the centre.
             * Old configs can carry `false` — normalize on read, otherwise a state the interface
             * can no longer show or undo would survive.
             */
            fixedPosition: true,
            gameMode: {
              ...DEFAULT_UI_CONFIG.gameMode,
              ...(finalData.config.gameMode || {}),
              /** Drops the old demo list: the selection is visual now, per application. */
              blockedApps:
                (finalData.config.gameMode?.blockedApps || '').trim().toLowerCase() ===
                'csgo.exe, valorant.exe, dota2.exe, overwatch.exe'
                  ? ''
                  : (finalData.config.gameMode?.blockedApps || ''),
            },
          });
          /**
           * Contiguous hotkeys by position, on read too.
           *
           * Renumbering only on mutations would leave out the files already saved with gaps
           * — the "1, 2, 4" left over from a workspace deleted in the middle on an earlier version.
           * The operation is idempotent: whatever is already right is not touched.
           */
          nextConfig = {
            ...nextConfig,
            workspaces: nextConfig.workspaces?.map((workspace, index) => {
              const hotkey = index < 9 ? index + 1 : 0;
              return workspace.hotkey === hotkey ? workspace : { ...workspace, hotkey };
            }) ?? nextConfig.workspaces,
          };

          const mainWs = nextConfig.workspaces?.find(
            (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
          );
          if (mainWs?.apps && mainWs.apps.length > 0) {
            nextApps = mainWs.apps;
          } else if (finalData.apps) {
            nextApps = finalData.apps;
          }
        } else if (finalData.apps) {
          nextApps = finalData.apps;
        }
      }

      if (finalData && window.electron) {
        nextConfig = {
          ...nextConfig,
          persistenceMeta: {
            ...nextConfig.persistenceMeta,
            version: Math.max(2, Number(nextConfig.persistenceMeta?.version) || 0),
            lastSuccessfulLoad: new Date().toISOString(),
          },
        };
      }

      /** Profile from disk / LS migration — do not force `mainStartMenuDiscoveryDone=true` just because a blob exists (that broke the Start Menu scan and mixed stale LS with the disk). */
      const loadedPersistedBlob = !!(finalData || loadedFromLocalStorageMigration);

      /**
       * A config written before this flag existed belongs to someone already using Rovyl, and the
       * welcome card is for people who are not. `...DEFAULT_UI_CONFIG` above fills the missing key
       * with `false`, so without this every existing user would be welcomed to an app they have had
       * for months.
       *
       * The test is that the key is ABSENT, not that a config exists at all. A first run saves one
       * within seconds — before anybody has read the card, let alone dismissed it — and treating
       * that as "already onboarded" meant closing the window once was enough to never be told what
       * the trigger key is.
       */
      const loadedConfig = finalData?.config;
      if (loadedConfig && !('hasSeenOnboarding' in loadedConfig)) {
        nextConfig = { ...nextConfig, hasSeenOnboarding: true };
      }

      /**
       * "Background dimming" used to top out at half a pool; it now reaches an opaque screen. The
       * saved number therefore means something darker than it did, and the default was the top of
       * the old scale — so left alone, every existing profile would have blacked the screen out on
       * the first open after updating, having changed nothing.
       *
       * Converted once, to the value that paints exactly the pixels the person already had. The
       * test is the missing marker, not the value: 1 was both the default and a deliberate choice,
       * and the two are indistinguishable here — which does not matter, because they looked the
       * same on screen and so they still do.
       */
      if (loadedConfig && Number(loadedConfig.backdropDimScale) !== BACKDROP_DIM_SCALE) {
        nextConfig = {
          ...nextConfig,
          backdropDimScale: BACKDROP_DIM_SCALE,
          backdropOpacity: legacyBackdropOpacityToDim(
            'backdropOpacity' in loadedConfig
              ? Number(loadedConfig.backdropOpacity)
              : 1,
          ),
        };
      }

      window.electron?.savePersistenceLog?.(
        `load | source=${finalData ? 'disk' : loadedFromLocalStorageMigration ? 'localStorage' : 'none'} ws=${nextConfig.workspaces?.length ?? 0} discoveryDone=${nextConfig.mainStartMenuDiscoveryDone}`,
      );

      const mainWs = nextConfig.workspaces?.find(
        (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
      );
      const lsDiscoveryDone = localStorage.getItem(LS_MAIN_DISCOVERY_DONE) === 'true';
      const legacyOnboardingDone = localStorage.getItem(LS_ZENITH_INITIALIZED_LEGACY);
      const hasDemoFingerprint = mainWs ? workspaceContainsBundledDemoApp(mainWs) : false;
      const mainIsEmpty = !!(mainWs && mainWs.apps.length === 0);
      const canDiscover = !!window.electron?.getStartupApps;
      const mainCustom = mainWorkspaceAlreadyCustomized(mainWs);

      if (loadedPersistedBlob) {
        if (mainCustom && nextConfig.mainStartMenuDiscoveryDone !== true) {
          nextConfig = { ...nextConfig, mainStartMenuDiscoveryDone: true };
        }
        /**
         * Inconsistent state: `mainStartMenuDiscoveryDone: true` was saved but the Main workspace
         * ended up empty. That happens when the Start
         * Menu discovery marks itself done before writing the apps to disk (race condition or a
         * restart during the 20 s window), or when the legacy data migration restores an
         * obsolete configuration file.
         * Fix: reset the flag so discovery runs again.
         *
         * Extra safety condition: only reset if the config does NOT have custom workspaces
         * (no workspace beyond the default Main+Streaming). If the user has a custom
         * workspace but left Main empty, discovery must NOT overwrite it.
         */
        const hasCustomWorkspaces =
          nextConfig.workspaces.length > DEFAULT_UI_CONFIG.workspaces.length;
        if (!mainCustom && !hasCustomWorkspaces && nextConfig.mainStartMenuDiscoveryDone === true) {
          nextConfig = { ...nextConfig, mainStartMenuDiscoveryDone: false };
          try {
            localStorage.removeItem(LS_MAIN_DISCOVERY_DONE);
          } catch {
            /* ignore */
          }
        } else if (nextConfig.mainStartMenuDiscoveryDone === true) {
          try {
            localStorage.setItem(LS_MAIN_DISCOVERY_DONE, 'true');
          } catch {
            /* ignore */
          }
        }
      }

      /** With the disk hydrated, LS `zenith_main_discovery_done` no longer decides on its own — avoids blocking the scan when the file says it is still pending. */
      let discoveryDoneEffective =
        mainCustom || nextConfig.mainStartMenuDiscoveryDone === true;
      if (!loadedPersistedBlob) {
        discoveryDoneEffective = discoveryDoneEffective || lsDiscoveryDone;
      }

      /** Main has not been through the Start Menu scan yet — it does not use bundled demo IDs. */
      const mainAwaitingStartMenuBootstrap =
        !mainCustom &&
        nextConfig.mainStartMenuDiscoveryDone !== true;

      const shouldTryStartMenuIpc =
        canDiscover &&
        !discoveryDoneEffective &&
        !legacyOnboardingDone &&
        (!loadedPersistedBlob ||
          (!mainCustom && nextConfig.mainStartMenuDiscoveryDone !== true)) &&
        (hasDemoFingerprint || mainIsEmpty || mainAwaitingStartMenuBootstrap);

      const stripMainToZenithOnly = () => {
        const mi = nextConfig.workspaces.findIndex(
          (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
        );
        if (mi === -1) return;
        const workspaces = [...nextConfig.workspaces];
        workspaces[mi] = { ...workspaces[mi], apps: MINIMAL_MAIN_WORKSPACE_APPS };
        nextConfig = { ...nextConfig, workspaces };
      };

      if (shouldTryStartMenuIpc) {
        startMenuScanPersistenceHoldRef.current = true;
        if (hasDemoFingerprint) {
          stripMainToZenithOnly();
        } else if (mainIsEmpty) {
          const miEmpty = nextConfig.workspaces.findIndex(
            (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
          );
          if (miEmpty !== -1) {
            const workspaces = [...nextConfig.workspaces];
            workspaces[miEmpty] = { ...workspaces[miEmpty], apps: MINIMAL_MAIN_WORKSPACE_APPS };
            nextConfig = { ...nextConfig, workspaces };
          }
        }

        const discoverHasDemoFingerprint = hasDemoFingerprint;
        nextConfig = { ...nextConfig, language: 'en' };

        /**
         * Startup with no previous data (reset / first install): show the overlay immediately
         * — the 20 s timer still waits before the PowerShell IPC, but visually
         * the user sees the waiting screen from the start.
         */
        /**
         * A real first install, and not a failed read.
         *
         * Without the third condition, a `getFullConfig` that returned null for an instant made the
         * app conclude it was a clean start: it ran the Start Menu discovery again and opened
         * Settings on its own. That was the "sometimes it opens in settings". The disk had already
         * been inspected above to block writes in that same case — the result just went unused.
         */
        const isFreshStart =
          !finalData && !loadedFromLocalStorageMigration && !diskLooksSubstantial;
        if (isFreshStart) {
          openDashboardAfterDiscoveryRef.current = true;
        }

        /** Only a start with Windows waits; whoever opened the app wants the shortcuts now. */
        let openedAtLogin = false;
        try {
          openedAtLogin = (await window.electron?.wasOpenedAtLogin?.()) === true;
        } catch (e) {
          openedAtLogin = false;
        }
        const discoveryDeferMs = openedAtLogin
          ? START_MENU_DISCOVERY_DEFER_LOGIN_MS
          : START_MENU_DISCOVERY_DEFER_MANUAL_MS;
        window.electron?.savePersistenceLog?.(
          `[StartMenu] scan scheduled in ${discoveryDeferMs}ms (started with Windows: ${openedAtLogin})`,
        );
        /** From here until the merge lands, an empty Main is a wait rather than a loss. */
        setDiscoveryPhase('waiting');

        discoveryDeferTimer = window.setTimeout(() => {
          void (async () => {
            if (cancelled) {
              setDiscoveryPhase('idle');
              startMenuScanPersistenceHoldRef.current = false;
              return;
            }
            const mainIdx = configRef.current.workspaces.findIndex(
              (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
            );
            /** Tracks whether discovery actually added apps — it is only marked done when it did. */
            let discoveryAddedApps = false;
            setDiscoveryPhase('scanning');
            try {
              const discovered = (await window.electron!.getStartupApps()) as StartMenuDiscoveryRow[];
              if (discovered?.length > 0 && mainIdx !== -1) {
                const mergedApps = await buildMainAppsFromStartMenuDiscovery(discovered);
                setConfig((prev) => {
                  const workspaces = [...prev.workspaces];
                  workspaces[mainIdx] = { ...workspaces[mainIdx], apps: mergedApps };
                  return { ...prev, workspaces, mainStartMenuDiscoveryDone: true };
                });
                discoveryAddedApps = true;
              } else if (discoverHasDemoFingerprint) {
                setConfig((prev) => {
                  const mi = prev.workspaces.findIndex(
                    (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
                  );
                  if (mi === -1) return prev;
                  const workspaces = [...prev.workspaces];
                  workspaces[mi] = { ...workspaces[mi], apps: MINIMAL_MAIN_WORKSPACE_APPS };
                  return { ...prev, workspaces, mainStartMenuDiscoveryDone: true };
                });
                discoveryAddedApps = true;
              }
            } catch (e) {
              console.warn('[Zenith] Start Menu discovery failed:', e);
              if (discoverHasDemoFingerprint) {
                setConfig((prev) => {
                  const mi = prev.workspaces.findIndex(
                    (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
                  );
                  if (mi === -1) return prev;
                  const workspaces = [...prev.workspaces];
                  workspaces[mi] = { ...workspaces[mi], apps: MINIMAL_MAIN_WORKSPACE_APPS };
                  return { ...prev, workspaces, mainStartMenuDiscoveryDone: true };
                });
                discoveryAddedApps = true;
              }
            } finally {
              /**
               * Only mark it done and write to LS when apps were actually added.
               * If discovery failed or returned 0 apps, keep `mainStartMenuDiscoveryDone: false`
               * so the next startup tries again.
               */
              if (discoveryAddedApps) {
                localStorage.setItem(LS_MAIN_DISCOVERY_DONE, 'true');
                setConfig((prev) =>
                  prev.mainStartMenuDiscoveryDone === true
                    ? prev
                    : { ...prev, mainStartMenuDiscoveryDone: true },
                );
              }
              /**
               * Idle either way. A scan that found nothing is over too, and leaving the message up
               * would promise apps that are not coming — the empty state is then the honest one.
               */
              setDiscoveryPhase('idle');
              startMenuScanPersistenceHoldRef.current = false;
              queueMicrotask(() => {
                flushPersistenceToDiskRef.current?.();
              });
              /**
               * First startup / reset: open the dashboard automatically after discovery
               * so the user sees the imported apps without having to open it by hand.
               */
              if (discoveryAddedApps && openDashboardAfterDiscoveryRef.current) {
                openDashboardAfterDiscoveryRef.current = false;
                window.setTimeout(() => {
                  flushSync(() => {
                    setPanelChromeDismissedForIsland(false);
                    setIsDashboardOpen(false);
                    setIsSettingsOpen(true);
                  });
                }, 350);
              } else {
                openDashboardAfterDiscoveryRef.current = false;
              }
            }
          })();
        }, discoveryDeferMs);
      } else if (!lsDiscoveryDone && discoveryDoneEffective) {
        localStorage.setItem(LS_MAIN_DISCOVERY_DONE, 'true');
      }

      if (cancelled) return;

      /** Apply English to every profile, including previously persisted configurations. */
      nextConfig = { ...nextConfig, language: 'en' };

      hydratedFromPersistenceRef.current =
        !!(finalData || loadedFromLocalStorageMigration);

      if (finalData) {
        if (finalData.user) setUser(finalData.user);
        if (finalData.apps) setApps(stripInternalWidgetApps(finalData.apps));
        setConfig(nextConfig);
      } else {
        setApps(nextApps);
        setConfig(nextConfig);
      }
      if (!cancelled) {
        setIsLoaded(true);
      }
    };

    void loadPersistence();
    return () => {
      cancelled = true;
      if (discoveryDeferTimer !== undefined) {
        window.clearTimeout(discoveryDeferTimer);
        startMenuScanPersistenceHoldRef.current = false;
      }
    };
  }, []);

  /** Desktop + welcome: only after hydrating — avoids depending on localStorage alone (cleared in some Electron sessions). */
  useEffect(() => {
    if (!isLoaded || welcomeBootstrapDoneRef.current) return;
    welcomeBootstrapDoneRef.current = true;

    const fromLs = localStorage.getItem('zenith_first_run_complete') === 'true';
    const fromDisk = config.persistenceMeta?.isFirstRunCompleted === true;
    const discoveryDone = config.mainStartMenuDiscoveryDone === true;
    const hadDiskPayload = hydratedFromPersistenceRef.current;

    const hasRunBefore =
      fromLs || fromDisk || discoveryDone || hadDiskPayload;

    if (window.electron) {
      flushSync(() => setIsDesktopMode(true));
    }

    if (!hasRunBefore) {
      /**
       * First run: open Settings right away.
       *
       * This used to wait for the Start Menu discovery, because back then a waiting screen
       * covered everything. With the waiting screen removed, waiting stopped making sense:
       * the window was visible with no surface at all underneath, that is, an empty black
       * rectangle until the scan finished. Settings opens immediately and the shortcuts appear
       * inside it when the scan brings them.
       */
      flushSync(() => {
        setPanelResizeSolidCover(true);
        setIsDashboardOpen(false);
        setIsSettingsOpen(true);
      });
      localStorage.setItem('zenith_first_run_complete', 'true');
      if (window.electron) {
        setConfig((prev) => ({
          ...prev,
          persistenceMeta: {
            ...prev.persistenceMeta,
            isFirstRunCompleted: true,
          },
        }));
      }
    } else {
      if (!fromLs) {
        localStorage.setItem('zenith_first_run_complete', 'true');
      }
      if (window.electron && !fromDisk && hadDiskPayload) {
        setConfig((prev) => ({
          ...prev,
          persistenceMeta: {
            ...prev.persistenceMeta,
            isFirstRunCompleted: true,
          },
        }));
      }
    }
  }, [isLoaded]);

  /** Game mode lives in main (`shouldOpenMenu`); before, we only sent the IPC on mount — before the config loaded from disk. */
  useEffect(() => {
    if (!window.electron?.setGameMode || !isLoaded) return;
    window.electron.setGameMode(config.gameMode ?? DEFAULT_UI_CONFIG.gameMode);
  }, [
    isLoaded,
    config.gameMode?.enabled,
    config.gameMode?.mode,
    config.gameMode?.blockedApps,
    config.gameMode?.autoDetectGames,
  ]);

  /** Preloads only the flagged executables; it does not start apps or open hidden windows. */
  useEffect(() => {
    if (!isLoaded || !window.electron?.prewarmApps) return;
    const commands: string[] = [];
    const visit = (items: AppItem[]) => {
      for (const item of items) {
        if (item.launchMode === 'prewarm' && item.commandType === 'app' && item.command) {
          commands.push(item.command);
        }
        if (item.children?.length) visit(item.children);
      }
    };
    for (const workspace of config.workspaces) visit(workspace.apps);
    window.electron.prewarmApps(commands);
  }, [isLoaded, config.workspaces]);

  // 2. UNIFIED SAVE EFFECT: Sync to Main Process and LocalStorage (disk + LS mirror survives reboot)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(() => {
      if (startMenuScanPersistenceHoldRef.current) {
        /**
         * Hold active (waiting on the Start Menu discovery).
         * Allow the save if the user already has custom content beyond the default state:
         * - extra workspaces beyond the default Main and Streaming
         * - Main workspace with real apps (not just internal widgets)
         * This way, changes made by the user during the 20 s hold are not lost.
         */
        const mainWs = config.workspaces?.find(
          (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
        );
        const hasCustomContent =
          mainWorkspaceAlreadyCustomized(mainWs) ||
          config.workspaces.length > DEFAULT_UI_CONFIG.workspaces.length;
        if (!hasCustomContent) {
          return; // Still in the default state — wait for discovery
        }
        // custom content: save even with the hold active
      }
      const fullData = sanitizeFullPersistenceForDisk({ user, apps, config });
      if (!fullData) return;

      mirrorPersistenceToLocalStorage({ user, apps, config });

      if (!persistenceSaveBlockedRef.current && window.electron?.saveFullConfig) {
        const wsCount = fullData.config?.workspaces?.length ?? 0;
        const mainApps = (fullData.config?.workspaces?.[0]?.apps?.length ?? 0);
        void window.electron.saveFullConfig(fullData).then((r) => {
          if (r && !r.ok) {
            window.electron?.savePersistenceLog?.(
              `saveFullConfig failed: ${r.error || 'unknown'} | ws=${wsCount} mainApps=${mainApps}`,
            );
          }
        });
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [user, apps, config, isLoaded]);

  /** Flush before exit / background so the last edit is not lost (debounce skipped). */
  useEffect(() => {
    if (!isLoaded) return;

    const flushToDisk = () => {
      const d = persistenceRef.current;
      const fullData = sanitizeFullPersistenceForDisk({
        user: d.user,
        apps: d.apps,
        config: d.config,
      });
      if (!fullData) return;
      mirrorPersistenceToLocalStorage(d);
      if (persistenceSaveBlockedRef.current) {
        return;
      }
      if (window.electron?.saveFullConfigSync) {
        const ok = window.electron.saveFullConfigSync(fullData);
        if (!ok) {
          window.electron?.savePersistenceLog?.(
            'saveFullConfigSync: false or IPC error — scheduling invoke fallback',
          );
          void window.electron.saveFullConfig?.(fullData);
        }
      } else if (window.electron?.saveFullConfig) {
        void window.electron.saveFullConfig(fullData);
      }
    };

    flushPersistenceToDiskRef.current = flushToDisk;

    const onPageHide = () => flushToDisk();
    const onBeforeUnload = () => flushToDisk();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushToDisk();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    const quitUnsub = window.electron?.onBeforeQuitFlush?.(async () => {
      const d = persistenceRef.current;
      const fullData = sanitizeFullPersistenceForDisk({
        user: d.user,
        apps: d.apps,
        config: d.config,
      });
      try {
        if (!fullData) return;
        mirrorPersistenceToLocalStorage(d);
        if (persistenceSaveBlockedRef.current) return;
        if (window.electron?.saveFullConfig) {
          const r = await window.electron.saveFullConfig(fullData);
          if (!r?.ok) {
            window.electron?.savePersistenceLog?.(
              `quit flush saveFullConfig: ${r?.error || 'unknown'}`,
            );
            const syncOk = window.electron.saveFullConfigSync?.(fullData);
            if (syncOk === false) {
              window.electron?.savePersistenceLog?.('quit flush saveFullConfigSync also failed');
            }
          }
        } else if (window.electron?.saveFullConfigSync) {
          const ok = window.electron.saveFullConfigSync(fullData);
          if (!ok) {
            window.electron?.savePersistenceLog?.('quit flush saveFullConfigSync failed');
          }
        }
      } finally {
        window.electron?.ackQuitFlush?.();
      }
    });
    return () => {
      try {
        flushToDisk();
      } catch {
        /* ignore */
      }
      flushPersistenceToDiskRef.current = null;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      quitUnsub?.();
    };
  }, [isLoaded]);

  const lastMiddleClickTime = useRef<number>(0);
  const isHolding = useRef(false);

  // Listen for Google Auth Success
  useEffect(() => {
    if (window.electron?.onGoogleAuthSuccess) {
      return window.electron.onGoogleAuthSuccess((authData: any) => {
        const newUser: UserProfile = {
          id: authData.isAdmin ? 'admin-001' : crypto.randomUUID(),
          name: authData.name,
          email: authData.email,
          isPremium: authData.isPremium,
          isAdmin: authData.isAdmin,
          planTier: authData.planTier ?? (authData.isPremium ? 'pro' : 'free'),
          trialEndsAt: undefined,
          avatarUrl: authData.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(authData.name)}&background=0D8ABC&color=fff`,
        };
        flushSync(() => {
          setUser(newUser);
          setPanelChromeDismissedForIsland(false);
          setIsDashboardOpen(false);
          setIsSettingsOpen(true);
        });
      });
    }
  }, []);



  // Window State Management (Interactable vs Passive)
  // TRACK WINDOW STATE TO PREVENT REDUNDANT IPC CALLS (Reduces Lag/Flicker)
  const lastVisibility = useRef<boolean | null>(null);
  const hideTimeout = useRef<NodeJS.Timeout | null>(null);
  /** Used to ignore double-clicks right after the radial closes (otherwise dblclick sees isMenuOpen false and opens Settings). */
  const menuJustClosedAtRef = useRef(0);
  const prevIsMenuOpenForCloseRef = useRef(false);
  /** OS hid the window (Alt+F4 / close) while React still had dashboard "open" — sync refs before state so we don't schedule hideWindow twice. */
  const syncAfterMainWindowHidRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncAfterMainWindowHidRef.current = () => {
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
        hideTimeout.current = null;
      }
      lastVisibility.current = false;
      lastWindowState.current = 'small';
      setIsMenuOpen(false);
      setIsSettingsOpen(false);
      setIsDashboardOpen(false);
      setPanelChromeDismissedForIsland(false);
      setRadialOpenAwaitingFullscreen(false);
      setMinimizeNeutralCoverActive(false);
      setRadialPreShowSolidCover(false);
    };
  });

  useEffect(() => {
    if (prevIsMenuOpenForCloseRef.current && !isMenuOpen) {
      menuJustClosedAtRef.current = Date.now();
    }
    prevIsMenuOpenForCloseRef.current = isMenuOpen;
  }, [isMenuOpen]);

  useEffect(() => {
    if (window.electron && isDesktopMode) {
      /** Includes “logical” dashboard/settings even when minimized — stops `hideWindow` thinking there is no active UI. */
      const isAnyInteractive =
        isMenuOpen ||
        radialOpenAwaitingFullscreen ||
        isDashboardOpen ||
        isSettingsOpen ||
        panelNeutralizingClose;

      const visibilityChanged = lastVisibility.current !== isAnyInteractive;

      /**
       * With the radial open, do not apply `windowed`/`small` here (the ordering against the dashboard close left
       * `lastWindowState` or the HWND misaligned — the menu appeared at the panel's size).
       */
      if (isMenuOpen || radialOpenAwaitingFullscreen) {
        if (lastWindowState.current !== 'fullscreen') {
          window.electron.setWindowSize('fullscreen', windowCenterScreenPoint());
          lastWindowState.current = 'fullscreen';
        }
        if (visibilityChanged) {
          if (isAnyInteractive) {
            if (hideTimeout.current) {
              clearTimeout(hideTimeout.current);
              hideTimeout.current = null;
            }
            window.electron.showWindow();
          } else {
            hideTimeout.current = setTimeout(() => {
              flushPersistenceToDiskRef.current?.();
              window.electron.hideWindow();
            }, 300);
          }
          lastVisibility.current = isAnyInteractive;
        }
        return;
      }

      /** Passive `small` overlay (shrunken HWND); panel/settings use `windowed`. */
      const targetMode: 'fullscreen' | 'windowed' | 'small' = panelSurfaceOpen
        ? 'windowed'
        : 'small';

      const modeChanged = lastWindowState.current !== targetMode;

      let modeResizeHandled = false;

      // 1. Mode changes while visible (not switching to passive "small" overlay).
      //    Always resize directly — never use hideWindow() here. The old "dip" path hit transitions
      //    like small → windowed (after closing the radial menu) and null → windowed, caused
      //    intermittent fullscreen / no-click bugs on the next open-settings.
      const modeAnchor =
        targetMode === 'windowed' ? undefined : windowCenterScreenPoint();

      if (modeChanged && lastVisibility.current && isAnyInteractive && targetMode !== 'small') {
        window.electron.setWindowSize(targetMode, modeAnchor);
        lastWindowState.current = targetMode;
        modeResizeHandled = true;
      }

      // 2. Standard mode update (non-flicker-prone or hidden)
      if (modeChanged && !modeResizeHandled) {
        window.electron.setWindowSize(targetMode, modeAnchor);
        lastWindowState.current = targetMode;
      }

      // 3. Standard visibility update
      if (visibilityChanged) {
        if (isAnyInteractive) {
          if (hideTimeout.current) {
            clearTimeout(hideTimeout.current);
            hideTimeout.current = null;
          }
          window.electron.showWindow();
        } else {
          hideTimeout.current = setTimeout(() => {
            flushPersistenceToDiskRef.current?.();
            window.electron.hideWindow();
          }, 300); // allow exit animations to complete
        }
        lastVisibility.current = isAnyInteractive;
      }
    }
  }, [
    isMenuOpen,
    radialOpenAwaitingFullscreen,
    isDashboardOpen,
    isSettingsOpen,
    panelNeutralizingClose,
    isDesktopMode,
    panelSurfaceOpen,
  ]);

  const openMenu = async (
    x: number,
    y: number,
    source: 'mmb' | 'mmb-click' | 'shortcut' = 'shortcut',
    /** IPC sends screen coords from the main process; MMB uses client coords relative to the current window. */
    coordSpace: 'client' | 'screen' = 'client',
    opts?: {
      preSizedByMain?: boolean;
      keepPanel?: boolean;
      panelRect?: ScreenRect | null;
      clientPosition?: Coordinates | null;
      windowOrigin?: Coordinates | null;
      clientSize?: { width: number; height: number } | null;
      paintToken?: number;
    },
  ) => {
    const triggerGeneration = ++radialTriggerGenerationRef.current;
    /**
     * Radial over the panel: there is only one window, so opening the radial shrank it to the
     * wheel's box and the settings vanished in a flash. We keep the panel's SCREEN rect — main has
     * already widened the window to cover it — and keep drawing it in exactly the same place.
     * When it is the renderer that resizes, the rect has to be read BEFORE the resize.
     */
    const keepPanel =
      opts?.keepPanel ?? (panelSurfaceOpen && isDesktopModeRef.current);
    /**
     * With a fixed position main does not touch the bounds: the panel is still the whole window and
     * there is nothing to reposition — that is the flash-free path. Only when the window is widened
     * (free position) does the panel need pinning to the screen rect it occupied.
     */
    const panelWindowStays = keepPanel && !opts?.panelRect;
    const panelRect: ScreenRect | null =
      opts?.panelRect ??
      (keepPanel && !panelWindowStays
        ? {
            x: window.screenX,
            y: window.screenY,
            width: window.innerWidth,
            height: window.innerHeight,
          }
        : null);

    /** Free position was removed: the resize always uses a centre anchor. */
    const anchorForFullscreen: { x: number; y: number } =
      coordSpace === 'screen'
        ? { x, y }
        : {
            x: window.screenX + window.innerWidth / 2,
            y: window.screenY + window.innerHeight / 2,
          };

    const needsRendererFullscreenResize =
      isDesktopModeRef.current &&
      window.electron &&
      !opts?.preSizedByMain;

    if (needsRendererFullscreenResize) {
      flushSync(() => {
        /** Before the resize: from here on the panel is never hidden. */
        setPanelKeptUnderRadial(keepPanel);
        setPanelOverlayScreenRect(panelRect);
        /** With the panel staying visible there is no old texture to mask — the opaque cover would only flash over it. */
        setRadialAwaitCoverOpaque(
          !panelRect && electronShrinkGateRef.current.panelSurfaceOpen,
        );
        setRadialOpenAwaitingFullscreen(true);
        setMinimizeNeutralCoverActive(false);
      });
    } else {
      flushSync(() => {
        setMinimizeNeutralCoverActive(false);
      });
    }

    try {
    /**
     * A shortcut/MMB via main already called `updateWindowSize('fullscreen')` — repeating `applyWindowSize` here
     * doubled the IPC round-trip + setBounds and delayed the radial's first paint.
     */
    if (needsRendererFullscreenResize) {
      try {
        if (window.electron.applyWindowSize) {
          await window.electron.applyWindowSize('fullscreen', anchorForFullscreen);
        } else {
          window.electron.setWindowSize('fullscreen', anchorForFullscreen);
        }
      } catch {
        try {
          window.electron.setWindowSize('fullscreen', anchorForFullscreen);
        } catch {
          /* ignore */
        }
      }
      lastWindowState.current = 'fullscreen';
    } else if (opts?.preSizedByMain && isDesktopModeRef.current) {
      lastWindowState.current = 'fullscreen';
    }

    /**
     * A second MMB/shortcut can close the radial while the async resize above is still finishing.
     * In that case, do not let this stale open remount the menu after the close.
     */
    if (triggerGeneration !== radialTriggerGenerationRef.current) return;

    radialCenterScreenRef.current =
      coordSpace === 'screen'
        ? { x, y }
        : {
            x: window.screenX + window.innerWidth / 2,
            y: window.screenY + window.innerHeight / 2,
          };
    radialClientPositionHintRef.current = opts?.clientPosition ?? null;
    radialWindowOriginHintRef.current = opts?.windowOrigin ?? null;

    /**
     * Never consult `window.screenX/Y` for the first frame. Right after closing Settings those
     * metrics still describe the windowed rect (880×600), whose centre is exactly the wrong point
     * seen in the video: (440,300) client → roughly (906,345) on screen. Everything needed already
     * came in the same IPC from main and belongs to the current generation.
     */
    const authoritativeClientPosition =
      opts?.clientPosition ??
      (opts?.windowOrigin
        ? { x: x - opts.windowOrigin.x, y: y - opts.windowOrigin.y }
        : opts?.clientSize
          ? { x: opts.clientSize.width / 2, y: opts.clientSize.height / 2 }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 });

    flushSync(() => {
      setRadialOpenAwaitingFullscreen(false);
      setRadialAwaitCoverOpaque(false);
      setRadialPreShowSolidCover(false);
      setPanelKeptUnderRadial(keepPanel);
      setPanelOverlayScreenRect(panelRect);
      /** We only close the panel when it is not going to survive under the radial. */
      if (!keepPanel) {
        setIsSettingsOpen(false);
        setIsDashboardOpen(false);
      }
      setIsMenuOpen(true);
      setRadialMountKey((key) => key + 1);
      setRadialPendingPaintToken(
        typeof opts?.paintToken === 'number' ? opts.paintToken : null,
      );
      setTriggerSource(source);
      setMenuPosition(authoritativeClientPosition);
      setRadialClientSize(
        opts?.clientSize ?? { width: window.innerWidth, height: window.innerHeight },
      );
    });

    /**
     * The native window is still hidden. One rAF followed by a task confirms the paint of the
     * zero-alpha frame; two full rAFs made the open noticeably slow.
     */
    if (typeof opts?.paintToken === 'number') {
      const paintToken = opts.paintToken;
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          window.electron?.notifyRadialOpenPaintDone?.(paintToken);
        }, 0);
      });
    }

    // Always call show-window when running under Electron — do not gate on isDesktopMode (it is still false for
    // one frame after load; main already set native opacity 0 in showMenuAtCursor).
    if (window.electron) {
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
        hideTimeout.current = null;
      }
      /**
       * With the panel on screen and no resize the window is already visible and in place: an extra
       * `show()` only recomposes the HWND. For the same reason there is no `invalidatePaint` on
       * open — on Windows it usually causes a flash (old texture) right after the radial appears.
       */
      if (!panelWindowStays && typeof opts?.paintToken !== 'number') {
        window.electron.showWindow();
      }
      lastVisibility.current = true;
    }

    isHolding.current = true;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Do not dip window opacity to 0 here — show-window already sets opacity 1 in main. A 0 → rAF → 1
    // sequence left the BrowserWindow stuck invisible on some systems (clicks still hit; radial UI gone).
    } catch (e) {
      radialClientPositionHintRef.current = null;
      radialWindowOriginHintRef.current = null;
      flushSync(() => {
        setRadialOpenAwaitingFullscreen(false);
        setMinimizeNeutralCoverActive(false);
        setRadialPreShowSolidCover(false);
      });
      throw e;
    }
  };

  /** Paints a neutral frame before `minimize()` so the Windows snapshot is not the dashboard (a flash when the radial opens later). */
  const flushNeutralFrameThenMinimize = useCallback(() => {
    if (!window.electron?.minimizeWindow) return;
    flushSync(() => setMinimizeNeutralCoverActive(true));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.electron!.minimizeWindow();
      });
    });
  }, []);

  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  /**
   * Trigger toggle (MMB / global shortcut): main does not know whether the radial is open,
   * so the decision lives here — a second trigger with the radial on screen closes instead of reopening.
   */
  const isMenuOpenRef = useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;
  const radialOpenAwaitingFullscreenRef = useRef(radialOpenAwaitingFullscreen);
  radialOpenAwaitingFullscreenRef.current = radialOpenAwaitingFullscreen;
  /** Stops the `click` generated after the `mouseup` that closed the radial from reaching the panel. */
  const radialClickShieldUntilRef = useRef(0);
  /** Invalidates an async open when the same trigger is used to close. */
  const radialTriggerGenerationRef = useRef(0);
  const handleMenuCloseRef = useRef<
    ((selectedId: string | null, selectedApp?: AppItem | null) => void) | null
  >(null);
  /** True when a new trigger should close the radial instead of opening it. */
  const closeMenuFromTrigger = useCallback(() => {
    if (!isMenuOpenRef.current && !radialOpenAwaitingFullscreenRef.current) return false;
    radialTriggerGenerationRef.current += 1;
    /** RadialMenu swallows any pending mouseup from this gesture without confirming the active slice. */
    window.dispatchEvent(new CustomEvent('zenith-radial-toggle-close'));
    handleMenuCloseRef.current?.(null);
    return true;
  }, []);

  useEffect(() => {
    const blockClickThrough = (event: MouseEvent) => {
      const radialActive =
        isMenuOpenRef.current || radialOpenAwaitingFullscreenRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const belongsToRadial = !!target?.closest('[data-zenith-radial-modal="true"]');

      /** Icons and hub still receive the click that runs the chosen action. */
      if (radialActive && belongsToRadial) return;
      if (!radialActive && Date.now() > radialClickShieldUntilRef.current) return;

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    document.addEventListener('click', blockClickThrough, true);
    document.addEventListener('auxclick', blockClickThrough, true);
    return () => {
      document.removeEventListener('click', blockClickThrough, true);
      document.removeEventListener('auxclick', blockClickThrough, true);
    };
  }, []);

  // After setBounds(fullscreen), inner/outer window metrics update a frame late — re-map screen anchor → client so the radial is not clipped (multi-monitor / half-screen).
  const syncMenuPositionFromAnchor = useCallback(() => {
    const hintedOrigin = radialWindowOriginHintRef.current;
    const clientOriginX = hintedOrigin?.x ?? window.screenX;
    const clientOriginY = hintedOrigin?.y ?? window.screenY;
    /** The same anchor remapping, applied to the panel left under the radial. */
    const panelScreen = panelOverlayScreenRectRef.current;
    if (panelScreen) {
      const next = {
        x: Math.round(panelScreen.x - clientOriginX),
        y: Math.round(panelScreen.y - clientOriginY),
        width: panelScreen.width,
        height: panelScreen.height,
      };
      setPanelOverlayClientRect((prev) =>
        prev && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height
          ? prev
          : next,
      );
    } else {
      setPanelOverlayClientRect(null);
    }

    /**
     * The wheel's position is frozen at the `clientPosition` received in open-menu. Recomputing it
     * here with late `window.screenX/Y` metrics made the already visible tree jump to another origin.
     * This synchronizer stays responsible only for the panel preserved under the radial.
     */
  }, []);

  useLayoutEffect(() => {
    if ((!isMenuOpen && !radialOpenAwaitingFullscreen) || !isDesktopMode) return;
    syncMenuPositionFromAnchor();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        syncMenuPositionFromAnchor();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isMenuOpen, radialOpenAwaitingFullscreen, isDesktopMode, syncMenuPositionFromAnchor]);

  useEffect(() => {
    if ((!isMenuOpen && !radialOpenAwaitingFullscreen) || !isDesktopMode) return;

    const sync = () => {
      syncMenuPositionFromAnchor();
    };

    sync();
    let rafB = 0;
    const rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(sync);
    });
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      window.removeEventListener('resize', sync);
    };
  }, [isMenuOpen, radialOpenAwaitingFullscreen, isDesktopMode, syncMenuPositionFromAnchor]);

  /**
   * The radial closes through many paths (Escape, right button, double-MMB → settings, selection).
   * Instead of clearing the panel rect in each one, we clear it here: while there is no radial
   * and no pending resize, the panel is the window again.
   *
   * Do not clear the geometry hints here. This is a passive effect of the CLOSED session and can be
   * drained by the next open's `flushSync` after `openMenu` has already written the new hints. That
   * erased the authoritative origin and the first frame fell back to a `window.screenX/Y` still
   * belonging to Settings; the next rAF corrected it and the wheel seemed to jump to the centre.
   * Every open overwrites both refs before its own commit, so keeping them between sessions is safe
   * and removes the late write across generations.
   */
  useEffect(() => {
    if (isMenuOpen || radialOpenAwaitingFullscreen) return;
    setPanelKeptUnderRadial((prev) => (prev ? false : prev));
    setPanelOverlayScreenRect((prev) => (prev === null ? prev : null));
    setPanelOverlayClientRect((prev) => (prev === null ? prev : null));
  }, [isMenuOpen, radialOpenAwaitingFullscreen]);

  /** Repaint only when the radial closes — invalidating on open flashed the frame (dashboard→fullscreen) on Windows. */
  const prevIsMenuOpenForPaintRef = useRef(isMenuOpen);
  useEffect(() => {
    if (!window.electron?.invalidatePaint) return;
    const was = prevIsMenuOpenForPaintRef.current;
    prevIsMenuOpenForPaintRef.current = isMenuOpen;
    const closing = was && !isMenuOpen;
    if (!closing) return;
    const t = window.setTimeout(() => {
      void window.electron?.invalidatePaint?.();
    }, 220);
    return () => clearTimeout(t);
  }, [isMenuOpen]);

  // IPC: menu / dashboard / settings — must run after openMenu exists; use openMenuRef so handler always calls latest openMenu.
  useEffect(() => {
    const cleanupMenu = window.electron?.onOpenMenu((data: {
      x: number;
      y: number;
      source?: 'mmb' | 'mmb-click' | 'shortcut';
      /** Main already knows the radial is open: this event must never open nor confirm a selection. */
      closeOnly?: boolean;
      preSizedByMain?: boolean;
      keepPanel?: boolean;
      panelRect?: ScreenRect | null;
      clientPosition?: Coordinates | null;
      windowOrigin?: Coordinates | null;
      clientSize?: { width: number; height: number } | null;
      paintToken?: number;
    }) => {
      if (data.closeOnly) {
        closeMenuFromTrigger();
        return;
      }
      /** Second MMB / shortcut with the radial already open: toggle (close) instead of reopening. */
      if (closeMenuFromTrigger()) return;
      void openMenuRef.current(data.x, data.y, data.source ?? 'shortcut', 'screen', {
        preSizedByMain: data.preSizedByMain === true,
        keepPanel: data.keepPanel === true,
        panelRect: data.panelRect ?? null,
        clientPosition: data.clientPosition ?? null,
        windowOrigin: data.windowOrigin ?? null,
        clientSize: data.clientSize ?? null,
        paintToken: data.paintToken,
      });
    });

    const cleanupPrepareRadial = window.electron?.onPrepareRadialShow?.(() => {
      flushSync(() => setRadialPreShowSolidCover(true));
      requestAnimationFrame(() => {
        window.electron?.notifyRadialPrepPaintDone?.();
      });
    });

    const cleanupRadialNativeRevealed = window.electron?.onRadialNativeRevealed?.((paintToken) => {
      setRadialNativeRevealToken(paintToken);
    });

    const cleanupDashboard = window.electron?.onOpenDashboard(() => {
      flushSync(() => {
        // Do not turn panelResizeSolidCover on here if the panel is already open (e.g. Settings→Dashboard):
        // z-[96] got stuck because the layout that turns it off only runs on panelSurfaceOpen false→true.
        setPanelChromeDismissedForIsland(false);
        setMinimizeNeutralCoverActive(false);
        setRadialPreShowSolidCover(false);
        setIsDashboardOpen(false);
        setIsSettingsOpen(true);
      });
      /** Do not call `showWindow()` here: it runs before the `useLayoutEffect` + microtask with `applyWindowSize('windowed')`
       * and the DWM paints the big HWND with the island's texture (a “stretched” clock). The show stays in the microtask after the resize. */
    });

    const cleanupSettings = window.electron?.onOpenSettings(() => {
      flushSync(() => {
        setPanelChromeDismissedForIsland(false);
        // Same cover clearing as onOpenDashboard above: the tray can ask for Settings while a
        // pre-minimize neutral cover is still up, and only `main-window-minimized` clears it.
        setMinimizeNeutralCoverActive(false);
        setRadialPreShowSolidCover(false);
        setIsMenuOpen(false);
        setIsSettingsOpen(true);
        setIsDashboardOpen(false);
      });
      requestAnimationFrame(() => {
        void window.electron?.invalidatePaint?.();
        requestAnimationFrame(() => {
          void window.electron?.invalidatePaint?.();
        });
      });
    });

    const cleanupWindowState = window.electron?.onWindowState((state) => {
      setWindowState(state);
    });

    const cleanupMouseUp = window.electron?.onMouseUp(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 1 }));
    });

    const cleanupWindowHidToTray = window.electron?.onWindowHidToTray(() => {
      // Persist before resetting UI state so we never flush a stale ref or miss the write if the window hides quickly.
      flushPersistenceToDiskRef.current?.();
      syncAfterMainWindowHidRef.current();
    });

    const cleanupMainWindowMinimized = window.electron?.onMainWindowMinimized?.(({ minimized }) => {
      if (minimized) {
        setMinimizeNeutralCoverActive(false);
        setRadialPreShowSolidCover(false);
      }
      if (
        minimized &&
        (isDashboardOpenRef.current || isSettingsOpenRef.current)
      ) {
        setPanelChromeDismissedForIsland(true);
      }
    });

    const cleanupNativeDisplayRestored =
      window.electron?.onWindowNativeDisplayRestored?.((payload: {
        mode: 'small' | 'fullscreen' | 'windowed';
      }) => {
        const m = payload?.mode;
        if (m !== 'fullscreen' && m !== 'windowed' && m !== 'small') return;
        const anchor = m === 'windowed' ? undefined : windowCenterScreenPoint();
        window.electron?.setWindowSize(m, anchor);
        window.electron?.showWindow();
        lastWindowState.current = m;
      });

    return () => {
      cleanupMenu?.();
      cleanupPrepareRadial?.();
      cleanupRadialNativeRevealed?.();
      cleanupDashboard?.();
      cleanupSettings?.();
      cleanupWindowState?.();
      cleanupMouseUp?.();
      cleanupWindowHidToTray?.();
      cleanupMainWindowMinimized?.();
      cleanupNativeDisplayRestored?.();
    };
  }, []);

  // Workspace Switching Handler (Debounced)
  // Uses a debounce so that rapid presses collapse into a single switch
  // to the LAST pressed workspace after 80ms of inactivity — no flickering.
  const handleWorkspaceSwitch = React.useCallback((workspaceIndex: number) => {
    const configData = configRef.current;
    
    if (workspaceIndex < 0 || workspaceIndex >= configData.workspaces.length) {
      console.warn(`[App.tsx] Invalid workspace index requested: ${workspaceIndex}. Total workspaces: ${configData.workspaces.length}`);
      return;
    }

    const workspace = configData.workspaces[workspaceIndex];
    if (!workspace || !workspace.enabled) {
      console.warn(`[App.tsx] Cannot switch to disabled or non-existent workspace: ${workspaceIndex}`);
      return;
    }

    // Update the target ref synchronously so repeated presses to same workspace are a no-op
    if (workspaceIndex === targetWorkspaceIndexRef.current) return;
    
    console.warn(`[App.tsx] Proceeding with workspace switch to: ${workspace.name} (Index: ${workspaceIndex})`);
    targetWorkspaceIndexRef.current = workspaceIndex;

    // Cancel any pending switch and restart the debounce window
    if (switchDebounceTimer.current) {
      clearTimeout(switchDebounceTimer.current);
    }

    switchDebounceTimer.current = setTimeout(() => {
      setConfig(prev => ({
        ...prev,
        activeWorkspaceIndex: targetWorkspaceIndexRef.current
      }));
      switchDebounceTimer.current = null;
    }, 80); // 80ms: imperceptible for single presses, collapses rapid sequences into one switch
  }, []);

  // Workspace switch IPC listener — ISOLATED in its own stable effect
  // CRITICAL: NOT inside [isSettingsOpen, isDashboardOpen] effect — that effect re-runs on settings/dashboard
  // changes and would accumulate multiple IPC listeners, causing 2-3x fires per keypress (the flicker root cause).
  useEffect(() => {
    const cleanup = window.electron?.onSwitchWorkspace((index: number) => {
      console.warn(`[App.tsx] switch-workspace IPC received for index: ${index}`);
      handleWorkspaceSwitch(index);
    });
    return () => cleanup?.();
  }, [handleWorkspaceSwitch]);

  // STABLE KEYBOARD LISTENER - PARENT LEVEL (Robust Fallback for Production)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Only handle numeric keys if menu is open
      if (!isMenuOpen) return;

      if (configRef.current.workspaceSwitchMode === 'picker') return;

      // Log the event as warn so it shows in diagnostic.log in production
      console.warn(`[App.tsx] Local keyboard event: key=${e.key}, code=${e.code}`);

      let num = parseInt(e.key);
      
      // Fallback to e.code for different keyboard layouts (Digit1, Digit2, etc.)
      if (isNaN(num) && e.code && e.code.startsWith('Digit')) {
        num = parseInt(e.code.replace('Digit', ''));
      }

      if (!isNaN(num) && num >= 1 && num <= 9) {
        console.warn(`[App.tsx] Valid numeric key detected: ${num}. Switching...`);
        e.preventDefault();
        e.stopPropagation();
        handleWorkspaceSwitch(num - 1);
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [isMenuOpen, handleWorkspaceSwitch]);

  // Centralized function to open settings and handle dashboard logic
  const handleOpenSettings = () => {
    flushSync(() => {
      if (isMenuOpen) setIsMenuOpen(false);
      // z-[96] cover: only the useLayoutEffect (panelSurfaceOpen false→true) should turn it on when leaving the island.
      // If we are already in the dashboard, turning it on here leaves the cover up forever — the resize effect does not re-run.
      setPanelChromeDismissedForIsland(false);
      setIsSettingsOpen(true);
      setIsDashboardOpen(false);
    });
    requestAnimationFrame(() => {
      void window.electron?.invalidatePaint?.();
      requestAnimationFrame(() => {
        void window.electron?.invalidatePaint?.();
      });
    });
  };
  const handleOpenSettingsRef = useRef(handleOpenSettings);
  handleOpenSettingsRef.current = handleOpenSettings;

  /**
   * "Fix shortcut" on a launch failure: Settings, on the workspace, with that row already open.
   *
   * The wheel closed the moment the launch was dispatched, so this both re-opens the panel and
   * hands `PrecisionSettings` the destination — it is mounted lazily and remounted often, and
   * anything told to it after it appears would race its own first render.
   */
  const handleFixShortcut = useCallback((target: FaultShortcutRef) => {
    setLaunchFault(null);
    setSettingsNav((current) => ({
      ...current,
      sectionId: 'spaces',
      focusShortcut: { workspaceIndex: target.workspaceIndex, appId: target.rootId },
    }));
    handleOpenSettingsRef.current();
  }, []);

  /** Closes only the Settings surface; the process, tray and shortcuts stay active. */
  const handleClosePanelToBackground = useCallback(() => {
    /**
     * Main needs to know in the same gesture that there is no panel any more. Waiting for the
     * effect left a window between this click and the next shortcut in which the radial
     * preserved/rendered the settings' old texture.
     */
    window.electron?.setPanelSurfaceVisible?.(false);
    flushSync(() => {
      /** Keeps the HWND windowed for two paints, but without drawing the panel. */
      setPanelNeutralizingClose(true);
      setIsSettingsOpen(false);
      setIsDashboardOpen(false);
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        flushSync(() => setPanelNeutralizingClose(false));
      });
    });
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) { // Middle button
      e.preventDefault();
      /**
       * On Electron the same MMB also arrives through the global monitor in the main process. If
       * both paths toggle the state, React closes first and the global hook can read the same
       * gesture as a new open a few ms later. Main is the sole owner of MMB in the app.
       */
      if (isDesktopModeRef.current && window.electron) return;
      if (closeMenuFromTrigger()) return;
      void openMenu(e.clientX, e.clientY, 'mmb', 'client');
    }
  };

  // Double Click (Left) to Open Settings — does not fire with the radial open
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (Date.now() - menuJustClosedAtRef.current < 650) {
      return;
    }
    if (!isMenuOpen && !radialOpenAwaitingFullscreen && !isSettingsOpen) {
      handleOpenSettings();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    /* Removed hardcoded Alt+Z */
    if (e.key === 'Escape' && isMenuOpen) {
      setIsMenuOpen(false);
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    // Removed Space key logic as it's no longer used for opening/closing the menu
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    }
  }, []);

  const executeAction = (
    command: string,
    commandType: "app" | "url" | "folder",
    itemForFault?: AppItem,
    options?: { openTerminal?: boolean; terminalCommands?: string[]; workingDirectory?: string; launchMode?: 'normal' | 'reuse' | 'prewarm' }
  ) => {
    // console.log("🚀 Zenith executing:", command, "Type:", commandType);
    if (!command) {
      console.warn("Attempted to execute an empty command");
      return;
    }

    /** Internal widgets (Notes / Alarm / Stopwatch / Pomodoro) were removed — ignore leftovers from old configs. */
    if (command.startsWith('internal:')) {
      return;
    }

    if (isDesktopMode && window.electron) {
      // console.log("Calling electron.executeCommand...");
      /**
       * The launch answers for itself now. While this was a fire-and-forget send, a shortcut whose
       * target had been uninstalled did exactly what a working one did — the wheel closed and
       * nothing happened — and the failure that main knew about arrived on a broadcast channel
       * carrying only a command string, which this side matched back to an item by comparing
       * commands inside a 15-second window.
       */
      void Promise.resolve(window.electron.executeCommand(command, commandType, options))
        .then((result) => {
          if (!result || result.ok !== false) return;
          reportLaunchFailureRef.current(result, itemForFault);
        })
        .catch((error) => {
          /** A rejection means the IPC itself broke; the ladder answers with `ok: false` instead. */
          reportLaunchFailureRef.current(
            { ok: false, error: `Unexpected error while running command: ${error?.message || error}` },
            itemForFault,
          );
        });
      setTimeout(() => {
        const g = electronShrinkGateRef.current;
        if (!g.panelSurfaceOpen) {
          window.electron?.setWindowSize('small', windowCenterScreenPoint());
          // Unified visibility effect will handle hiding automatically based on state
        }
      }, 1000);
    }
  };

  const executeActionRef = useRef(executeAction);
  executeActionRef.current = executeAction;

  const handleMenuClose = useCallback((selectedId: string | null, selectedApp?: AppItem | null) => {
    const cfg = configRef.current;
    const currentWorkspaceApps = cfg.workspaces[cfg.activeWorkspaceIndex]?.apps || apps;

    radialClickShieldUntilRef.current = Date.now() + 400;
    setIsMenuOpen(false);
    setRadialOpenAwaitingFullscreen(false);
    setRadialPreShowSolidCover(false);
    setRadialPendingPaintToken(null);
    /** The panel becomes the window again: the mode effect restores `windowed` with the saved rect. */
    setPanelKeptUnderRadial(false);
    setPanelOverlayScreenRect(null);
    setPanelOverlayClientRect(null);
    isHolding.current = false;

    if (!selectedId && isDesktopMode && !panelSurfaceOpen) {
      window.electron?.setWindowSize('small', windowCenterScreenPoint());
      return;
    }

    if (selectedId) {
      setIsDashboardOpen(false);
    }

    if (selectedId === '__CENTER__') {
      const centerConfig = cfg.centerButton;

      if (centerConfig.type === 'cancel') {
        if (isDesktopMode && !panelSurfaceOpen) {
          window.electron?.setWindowSize('small', windowCenterScreenPoint());
        }
        return;
      }

      if (centerConfig.type === 'app' || centerConfig.type === 'widget') {
        const targetApp = findAppRecursive(currentWorkspaceApps, centerConfig.target);
        const command = targetApp ? targetApp.command : centerConfig.target;
        console.log("Center action, target command:", command);
        executeActionRef.current(command, targetApp?.commandType || 'app', targetApp, {
          openTerminal: targetApp?.openTerminal,
          terminalCommands: targetApp?.terminalCommands,
          workingDirectory: targetApp?.workingDirectory,
          launchMode: targetApp?.launchMode,
        });
        return;
      } else if (centerConfig.type === 'command') {
        executeActionRef.current(centerConfig.target, centerConfig.commandType || 'app');
        return;
      }
      return;
    }

    if (selectedId) {
      const app =
        selectedApp ?? findAppRecursive(currentWorkspaceApps, selectedId);
      console.log("Selected app found in active workspace:", app);
      if (app) {
        console.log("Attempting to execute app command:", app.command);
        executeActionRef.current(app.command, app.commandType || 'app', app, {
          openTerminal: app.openTerminal,
          terminalCommands: app.terminalCommands,
          workingDirectory: app.workingDirectory,
          launchMode: app.launchMode,
        });
      } else {
        console.warn("Could not find app with ID in active workspace:", selectedId);
      }
    }
  }, [apps, isDesktopMode, panelSurfaceOpen]);

  handleMenuCloseRef.current = handleMenuClose;




  {/* Auth Functions */ }
  const handleLogin = (provider: 'google' | 'email') => {
    /** Google: Electron opens zenithos.online/auth?client=desktop and bridges id_token from localhost:3892. */
    if (provider === 'google' && window.electron?.startGoogleAuth) {
      window.electron.startGoogleAuth();
      return;
    }

    window.electron?.openExternalUrl?.('https://zenithos.online/#download');
  };


  /**
   * on this machine takes the same slot again instead of spending a new device.
   */
  /**
   * The locked wheel does not ask for the key: it routes to the licence card in settings, which is
   * where the keyboard already works without relying on foreground stealing for the radial window.
   */


  /** Stable object: the memo for the settings sections depends on it. */


  const handleLogout = () => {
    flushSync(() => {
      setUser(null);
      setPanelChromeDismissedForIsland(false);
      setIsDashboardOpen(false);
      setIsSettingsOpen(true);
    });
  };

  const handleUserProfileUpdate = useCallback((patch: Partial<UserProfile>) => {
    setUser((u) => (u ? { ...u, ...patch } : null));
  }, []);

  /**
   * The direction-mode hint has had its showing and does not come back.
   *
   * One-way, and it returns the SAME object when the flag is already up: `config` is the wheel's
   * only prop identity and the trigger for the debounced disk write, so minting a new one for a
   * no-op change would re-render the whole wheel and save for nothing.
   *
   * Deliberately not back-filled for configs written before the flag existed, the way
   * `hasSeenOnboarding` is. Direction mode is off by default, so an absent flag mostly means
   * "never turned this on" — marking those seen would quietly take the hint away from the people
   * who have yet to meet the mode. The few who already had it on get it once more, then never.
   */
  const handleDirectionHintSeen = useCallback(() => {
    setConfig((current) =>
      current.hasSeenDirectionHint === true
        ? current
        : { ...current, hasSeenDirectionHint: true },
    );
  }, []);

  /** Menu-only slice of config: stable when unrelated settings (e.g. widget opacities) change — keeps RadialMenu from re-rendering the full wheel. */
  /**
   * The wheel gets the whole config; the memo exists only to stabilize the reference.
   *
   * The dependencies were a HAND-WRITTEN FIELD LIST. Since the callback returns `config`
   * exactly as it is, any setting outside that list changed in state and the wheel kept
   * receiving the PREVIOUS object — the change only got through when, by chance, one of the
   * listed fields changed too. That is what happened to aiming by cursor: toggling the option
   * had no effect at all. Every new field was a silent trap.
   *
   * Depending on the object solves the whole class of problems: `config` only changes identity
   * when `setConfig` runs, that is, when something really changed.
   */
  const radialMenuConfig = React.useMemo(() => config, [config]);

  const radialApps = React.useMemo(() => {
    const w = config.workspaces[config.activeWorkspaceIndex];
    return w?.apps?.length ? w.apps : apps;
  }, [config.workspaces, config.activeWorkspaceIndex, apps]);

  const radialCurrentWorkspace = React.useMemo(
    () => config.workspaces[config.activeWorkspaceIndex],
    [config.workspaces, config.activeWorkspaceIndex]
  );

  // Check if any modal is open
  const isAnyModalOpen =
    panelSurfaceOpen || isMenuOpen || radialOpenAwaitingFullscreen;

  /**
   * The panel survives the radial (see `panelOverlayScreenRect`). There are two phases:
   * `…Staying` already covers the wait for the resize — it is what stops `hidden` flashing the panel;
   * `…UnderRadial` is the phase in which it is positioned by the rect inside the widened window.
   */
  const panelStaysUnderRadial =
    (isMenuOpen || radialOpenAwaitingFullscreen) &&
    panelSurfaceOpen &&
    panelKeptUnderRadial;
  const panelUnderRadial = panelStaysUnderRadial && !!panelOverlayClientRect;
  const radialBlocksPanelInteraction = isMenuOpen || radialOpenAwaitingFullscreen;
  /**
   * The panel content draws itself: outside the radial as always, or under it in this mode.
   *
   * With one exception. When main WIDENS the window for the radial, it sends the panel rect so it
   * can be repositioned inside — and that rect only exists in client coordinates after a
   * `useLayoutEffect` converts it. In that gap the panel was drawn with no position at all, that
   * is, `inset-0` of a window now the size of the screen: Settings jumped to giant.
   *
   * With a screen rect, the panel only appears once it is positioned. Without one (the path where
   * the window is not widened), `inset-0` is the correct position and there is nothing to wait for.
   */
  const panelAwaitingOverlayPlacement =
    panelStaysUnderRadial && !!panelOverlayScreenRect && !panelOverlayClientRect;
  const panelContentVisible =
    (panelStaysUnderRadial && !panelAwaitingOverlayPlacement) ||
    (!isMenuOpen && !radialOpenAwaitingFullscreen);

  /** Theme for the opaque surfaces (titlebar + panels). The radial is never themed: it is a desktop overlay. */
  const panelTheme = config.appearanceTheme === 'white' ? 'white' : 'black';

  return (
    <div
      className={`
        fixed inset-0 w-full h-full overflow-hidden cursor-default select-none group
        ${isDesktopMode ? 'bg-transparent' : 'bg-[#0D0D0D]'}
        ${isDesktopMode && !isAnyModalOpen ? 'pointer-events-none' : ''}
      `}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        if (isMenuOpen) setIsMenuOpen(false);
      }}
    >
      {/* Before minimizing: an opaque frame on purpose, so Windows caches a neutral bitmap. */}
      {isDesktopMode && minimizeNeutralCoverActive && (
        <div
          className="fixed inset-0 z-[99999] bg-[#0A0A0A] pointer-events-none"
          aria-hidden
        />
      )}

      {/**
       * `prepare-radial-show`: main has already done `showInactive()` on the old bounds, so a black
       * frame here is visible as a flashing rectangle. All that is needed is forcing a fresh paint
       * so no stale texture is exposed — clearing to (almost) transparent does it, and is invisible.
       */}
      {isDesktopMode && radialPreShowSolidCover && (
        <div
          className="fixed inset-0 z-[99999] pointer-events-none"
          style={{ background: 'rgba(10,10,10,0.01)' }}
          aria-hidden
        />
      )}

      {/* Visibility Wrapper — ONLY for opaque content (Dashboard, Settings, Widgets) */}
      {/* RadialMenu renders OUTSIDE this wrapper to stay truly transparent */}
      {/* When radial opens: hide this layer instantly (no opacity transition) — otherwise the 300ms fade shows a flash of the last settings/dashboard frame */}
      {/*
        The window is ONE surface. There used to be `border` + `rounded-xl` + `shadow-[0_0_50px]`
        on this same `absolute inset-0` element: since the parent is `fixed inset-0 overflow-hidden`,
        the outer shadow was clipped and all that was left were the smudges in the corner notches —
        it read as a second layer behind a border drawn on top.
        `zenith-panel-surface` (index.css) replaces the three with a tokenized inner
        hairline + radius. `hasShadow:false` in main stays: the separation from the
        desktop comes from the radius and the surface contrast, not from an inner halo.
      */}
      {/**
       * Radial over the panel: the window was widened to cover both, so the panel can no longer
       * be `inset-0` — it would stretch to the overlay's size. It is drawn instead in the exact
       * box it occupied on screen, and only the radial takes the mouse: a stray click in the
       * settings during the gesture would be an action the user did not ask for.
       */}
      <div
        data-zn-theme={panelTheme}
        data-radial-background-inert={radialBlocksPanelInteraction ? 'true' : undefined}
        {...({ inert: radialBlocksPanelInteraction ? '' : undefined } as any)}
        aria-hidden={radialBlocksPanelInteraction ? true : undefined}
        style={panelStaysUnderRadial ? {
          /**
           * Explicit `z-index` for two reasons: it sits below the radial (z-70) and, above all,
           * it creates a stacking context — without it the `z-index: 100` of `.zs-shell` competed
           * in the root context and the settings drew ON TOP of the wheel.
           */
          zIndex: 5,
          /** Positioning only exists on the resize path; without it the panel is still the window. */
          ...(panelUnderRadial
            ? {
                position: 'absolute' as const,
                left: panelOverlayClientRect!.x,
                top: panelOverlayClientRect!.y,
                width: panelOverlayClientRect!.width,
                height: panelOverlayClientRect!.height,
              }
            : null),
        } : undefined}
        className={`
        overflow-hidden [--zenith-title-bar-h:38px]
        ${panelUnderRadial ? '' : 'absolute inset-0'}
        ${panelNeutralizingClose
          ? 'opacity-0 invisible !transition-none pointer-events-none'
          : panelStaysUnderRadial
          ? 'zenith-panel-surface pointer-events-none !transition-none'
          : (isMenuOpen || radialOpenAwaitingFullscreen)
            ? 'hidden !transition-none pointer-events-none'
            : panelSurfaceOpen
              ? 'zenith-panel-surface !transition-none opacity-100 visible'
              : 'hidden !transition-none pointer-events-none'
        }
      `}>
        {/* CUSTOM TITLE BAR OVERLAY (for drag region + app name) */}
        {panelSurfaceOpen && panelContentVisible && (
          <div
            /* `zenith-titlebar` — styled in index.css, alongside the radial panel. */
            className="zenith-titlebar absolute top-0 left-0 right-0 h-[var(--zenith-title-bar-h)] z-[999] flex items-center justify-between pl-3 rounded-t-[12px] overflow-hidden"
            /* Under the radial the drag region would move the whole overlay window, not the panel. */
            style={{ WebkitAppRegion: panelStaysUnderRadial ? 'no-drag' : 'drag' } as any}
          >
            {isSettingsOpen ? (
              <div
                className="flex items-center gap-1 pointer-events-auto"
                style={{ WebkitAppRegion: 'no-drag' } as any}
                aria-label="Settings navigation"
              >
                <button
                  className="zenith-titlebar-btn w-8 h-6 flex items-center justify-center rounded-md"
                  onClick={() => window.dispatchEvent(new CustomEvent('zenith-settings-toggle-sidebar'))}
                  aria-label="Hide or show sidebar"
                >
                  <PanelLeftClose size={14} strokeWidth={1.9} />
                </button>
                <button
                  className="zenith-titlebar-btn w-8 h-6 flex items-center justify-center rounded-md"
                  onClick={() => window.dispatchEvent(new CustomEvent('zenith-settings-navigation', { detail: 'back' }))}
                  aria-label="Back in settings"
                >
                  <ArrowLeft size={14} strokeWidth={1.9} />
                </button>
                <button
                  className="zenith-titlebar-btn w-8 h-6 flex items-center justify-center rounded-md"
                  onClick={() => window.dispatchEvent(new CustomEvent('zenith-settings-navigation', { detail: 'forward' }))}
                  aria-label="Forward in settings"
                >
                  <ArrowRight size={14} strokeWidth={1.9} />
                </button>
              </div>
            ) : (
              <div />
            )}

            {/* Custom Window Controls */}
            <div className="flex items-stretch h-full pointer-events-auto" style={{ WebkitAppRegion: 'no-drag' } as any}>
              {/*
                Window controls like the Windows ones: no `title` (the native tooltip appeared
                over the bar and exists on no system window) and no transitions — the background
                highlight is instant, as in Explorer. The `aria-label` stays, because it is for
                screen readers and draws nothing.
              */}
              <button
                className="zenith-titlebar-btn h-full w-[46px] flex items-center justify-center"
                onClick={() => flushNeutralFrameThenMinimize()}
                aria-label="Minimize"
              >
                <Minus size={13} strokeWidth={2} />
              </button>
              <button
                className="zenith-titlebar-btn h-full w-[46px] flex items-center justify-center"
                onClick={() => window.electron?.toggleMaximize()}
                aria-label={windowState === 'maximized' ? 'Restore' : 'Maximize'}
              >
                {windowState === 'maximized' ? <Square size={11} strokeWidth={2.5} /> : <Maximize size={11} strokeWidth={2.5} />}
              </button>
              <button
                className="zenith-titlebar-btn is-close h-full w-[46px] flex items-center justify-center"
                onClick={handleClosePanelToBackground}
                aria-label="Close"
              >
                <X size={13} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        )}

        {/* GLOBAL TITLE BAR (Native Software Controls) */}


        {/* BACKGROUND (Simulator Only OR First Run Dashboard) */}
        {/* DELETED: Removed redundant background to allow RadialMenu to handle it exclusively */}

        {/* WELCOME SCREEN / DASHBOARD — AnimatePresence sync avoids a background-only gap between dashboard and settings (DWM). */}
        {/**
         * Hide, do not unmount.
         *
         * `panelContentVisible` exists so the panel does not DRAW before it has a position (see
         * `panelAwaitingOverlayPlacement`), and it did that by pulling the subtree out of React.
         * Since main always sends `keepPanel` with a rect, and that rect only reaches client
         * coordinates in the next `useLayoutEffect`, EVERY wheel gesture over Settings went through
         * a commit with no tree — and on closing the wheel the panel mounted again, repeating the
         * 0.28 s entrance and the `.zs-shell` fade. The panel seemed to reload every time the app
         * was used, when it had never left.
         *
         * `display: none` suppresses exactly the same: Chromium generates no box at all, so the
         * frame handed to the DWM is the same as it was without the subtree. The BACKGROUND is
         * still painted by the container (`zenith-panel-surface`), which sits outside this `div` —
         * the positioning gap paints what it always painted. Only what survives the gesture changes.
         */}
        <div className={panelContentVisible ? undefined : 'hidden'}>
          <React.Suspense
            fallback={
              isSettingsOpen && panelSurfaceOpen ? (
                <div
                  className="absolute inset-x-0 bottom-0 top-[var(--zenith-title-bar-h)] z-20 bg-[#08090b]"
                  aria-hidden
                />
              ) : null
            }
          >
            <PanelTransition show={isSettingsOpen && panelSurfaceOpen}>
                <PrecisionSettings
                  isOpen={isSettingsOpen}
                  isPage={true}
                  nav={settingsNav}
                  setNav={setSettingsNav}
                  discoveryPhase={discoveryPhase}
                  onClose={handleClosePanelToBackground}
                  apps={apps} setApps={setApps} config={config} setConfig={setConfig} onReset={async () => {
                    try {
                      setIsDashboardOpen(false);
                      setIsSettingsOpen(false);
                      setIsAppReady(false);
                      setIsLoaded(false);
                      /** Resetting everything and reopening on Advanced, where the button was pressed, would be odd. */
                      setSettingsNav({ sectionId: 'general', isSidebarCollapsed: false, focusShortcut: null });
                    } catch(e) {}
                    setApps(MINIMAL_MAIN_WORKSPACE_APPS); 
                    setConfig(DEFAULT_UI_CONFIG); 
                    if (window.electron?.resetConfig) {
                        try {
                           await window.electron.resetConfig();
                        } catch(e) {}
                    } else {
                        localStorage.clear();
                        window.location.reload();
                    }
                  }}
                  onOpenDashboard={handleOpenSettings}
                />
            </PanelTransition>
          </React.Suspense>
        </div>

      </div>

      {/* The panel's last frame: almost transparent, but not empty, so Chromium submits it to the DWM. */}
      {isDesktopMode && panelNeutralizingClose && (
        <div
          className="fixed inset-0 z-[99999] pointer-events-none"
          style={{ background: 'rgba(10,10,10,0.01)' }}
          aria-hidden
        />
      )}

      {/* During `applyWindowSize` the panel is already hidden in React — a solid background avoids a flash of the compositor's last texture.
          With no opaque panel before it (tray/island) it stays transparent: there the black was itself the flash. */}
      {isDesktopMode && radialOpenAwaitingFullscreen && (
        <div
          className={`fixed inset-0 z-[65] pointer-events-auto ${radialAwaitCoverOpaque ? 'bg-[#0A0A0A]' : ''}`}
          aria-hidden
        />
      )}

      {/* Island small→windowed: covers a wrong DWM frame before the invalidate after `applyWindowSize`. */}
      {isDesktopMode && panelResizeSolidCover && (
        <div
          className="fixed inset-0 z-[96] bg-[#0A0A0A] pointer-events-none"
          aria-hidden
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* TRANSPARENT LAYER — no background, RadialMenu + toasts live here    */}
      {/* ------------------------------------------------------------------ */}

        {/* During `radialOpenAwaitingFullscreen` the menu cannot stay mounted with `isOpen={false}` — Framer animated “close” and then “open”, causing an exit/entry flash. */}
        {(!radialOpenAwaitingFullscreen || isMenuOpen) && (
          <RadialMenu
            key={radialMountKey}
            isOpen={isMenuOpen}
            position={menuPosition}
            viewportSize={radialClientSize}
            onClose={handleMenuClose}
            apps={radialApps}
            config={radialMenuConfig}
            triggerSource={triggerSource}
            updateReady={updateReady}
            discoveryPhase={discoveryPhase}
            onWorkspaceSwitch={handleWorkspaceSwitch}
            onDirectionHintSeen={handleDirectionHintSeen}
            currentWorkspace={radialCurrentWorkspace}
            animationReady={
              radialPendingPaintToken === null ||
              radialNativeRevealToken === radialPendingPaintToken
            }
          />
        )}

        {/*
          The welcome card, over whatever the panel is showing. Gated on the panel being on screen
          because in island mode the HWND ignores the mouse — a dialog drawn there could never be
          dismissed, and it is the one thing on screen that must be.
        */}
        {isLoaded && config.hasSeenOnboarding !== true && panelSurfaceOpen && (
          <React.Suspense fallback={null}>
            <FirstRun
              config={config}
              onDismiss={() => setConfig((current) => ({ ...current, hasSeenOnboarding: true }))}
            />
          </React.Suspense>
        )}

        {/**
          * Kept mounted once it has ever been needed: `AnimatePresence` can only animate a child
          * out while it still owns it, so unmounting the moment the error clears would cut the
          * exit animation short.
          */}
        {errorOverlaysNeeded && (
          <React.Suspense fallback={null}>
            <ErrorOverlays
              /**
                * The sticky notice waits for a surface it can actually be dismissed on. In island
                * mode the HWND ignores the mouse and the card renders without its close button, so
                * showing a card that never leaves would pin it over the desktop forever. It stays
                * in state and appears the moment Settings or the dashboard opens.
                */
              faults={
                [
                  !isDesktopMode || panelSurfaceOpen ? configNotice : null,
                  launchFault,
                ].filter(Boolean) as SurfacedFault[]
              }
              theme={panelTheme}
              interactive={!isDesktopMode || panelSurfaceOpen}
              onFixShortcut={handleFixShortcut}
              onDismiss={(seq) => {
                setLaunchFault((current) => (current?.seq === seq ? null : current));
                setConfigNotice((current) => (current?.seq === seq ? null : current));
              }}
            />
          </React.Suspense>
        )}


        {/* FLASH PREVENTION BLANKER */}
        {!isAppReady && (
          <div 
            className="fixed inset-0 z-[99999] bg-black flex items-center justify-center" 
            style={{ opacity: 1, pointerEvents: 'none' }}
          />
        )}

        <style>{`
          .group:active { cursor: ${isAnyModalOpen ? 'default' : 'crosshair'}; }
        `}</style>

    </div>
  );
}
