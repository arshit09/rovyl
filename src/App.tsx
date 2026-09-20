import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { AppItem, UIConfig, UserProfile, Workspace } from './types';
import {
  DEFAULT_UI_CONFIG,
  MINIMAL_MAIN_WORKSPACE_APPS,
  stripInternalWidgetApps,
  workspaceContainsBundledDemoApp,
} from './defaults';
import { Minus, X, Maximize, Square, ArrowLeft, ArrowRight, PanelLeftClose } from 'lucide-react';
import { preloadIconsByName } from './iconMap';
import { isRemoteIconUrl, isStoredIconRef, isWebShortcutItem } from './iconRef';
import { useIconHealing } from './hooks/useIconHealing';
import { mirrorPersistenceToLocalStorage } from './persistenceMirror';
import { normalizeStoredConfig } from './configHydration';
import type { DiscoveryPhase } from './discovery';
import { startMenuAppIdToLaunchCommand } from './utils/windowsLaunchCommand';
/**
 * Codes and metadata only — never `./i18n/translations`, which would put all seven locale tables
 * in the chunk the wheel waits on. That distinction is the whole reason `languages.ts` is its own
 * file; `scripts/verify-renderer-budget.mjs` fails the build if it is ignored.
 */
import { normalizeLanguage } from './i18n/languages';
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
 * The only two things in this file that animate with `framer-motion`, both behind their own chunks.
 *
 * They are lazy for the same reason they always were — a settings transition, an error banner and a
 * toast should not be parsed before anything can paint. The wheel is now a separate document
 * entirely (`radial.html`), so it never sees this file, let alone the 111 kB behind it.
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
export type { DiscoveryPhase } from './discovery';

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
  /** Update downloaded and waiting for a restart — the wheel asks main for the same state. */
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

  /**
   * Open — unless Windows opened the app.
   *
   * Settings is what a manual launch is asking for, and the last thing a login start wants: with
   * "start with Windows" on, Rovyl signs in to the tray with the wheel warm behind it. The window
   * is created hidden and only `showWindow` puts it on screen, so leaving this closed is all it
   * takes to keep the sign-in silent — and the flag is read synchronously in the preload precisely
   * so the choice can be made here, in the first render, rather than as a flash.
   */
  const [isSettingsOpen, setIsSettingsOpen] = useState(
    () => window.electron?.openedAtLogin !== true,
  );
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
    sectionId: 'spaces',
    isSidebarCollapsed: false,
  });
  const isDashboardOpenRef = useRef(false);
  const isSettingsOpenRef = useRef(false);

  // Standalone Settings Window Mode - REMOVED
  // const isSettingsWindow = window.location.hash === '#settings' || window.location.search.includes('window=settings');

  // Dashboard/Welcome Screen State
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const panelSurfaceOpen = useMemo(
    () => isDashboardOpen || isSettingsOpen,
    [isDashboardOpen, isSettingsOpen],
  );

  useEffect(() => {
    isDashboardOpenRef.current = isDashboardOpen;
    isSettingsOpenRef.current = isSettingsOpen;
  }, [isDashboardOpen, isSettingsOpen]);

  useEffect(() => {
    if (!isDashboardOpen && !isSettingsOpen) {
      import('./components/installedApps').then((m) => m.clearInstalledAppsMemory?.()).catch(() => {});
      if (typeof (window as any).gc === 'function') {
        try {
          (window as any).gc();
        } catch (_) {}
      }
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
  const isDesktopModeRef = useRef(false);
  isDesktopModeRef.current = isDesktopMode;

  const [isAppReady, setIsAppReady] = useState(true); // Defaults to true so initial loading works normally

  // State for Apps and Config (Defaults to initial constants)
  const [apps, setApps] = useState<AppItem[]>(MINIMAL_MAIN_WORKSPACE_APPS);

  const [config, setConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG);
  const configRef = useRef(config);
  configRef.current = config;

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

  /**
   * A config that only names curated glyphs never pays for the full Lucide chunk; one that does
   * — because the user picked something else in the icon picker — fetches it here, well before the
   * wheel opens, so the right glyph is already on screen at the first paint.
   */
  useEffect(() => {
    preloadIconsByName(iterateConfigIconNames(config, apps));
  }, [config, apps]);

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
  /**
   * Serialization of the last payload disk accepted, so an unchanged one can skip the write.
   *
   * The synchronous flush runs on every wheel close, and main's sync writer is not cheap: a full
   * rewrite of ~26 kB, an `fsync`, a whole-file copy to `.bak`, a second `fsync`, plus a
   * `settings.json` write and a global-shortcut re-registration on the far side. Measured p50
   * 8.9 ms / p90 18.2 ms with both processes blocked. Nothing in the app records usage counts or
   * last-launched times, so on the ordinary open → launch → close the payload is byte-identical
   * and all of that is spent to rewrite the file it already has.
   *
   * Set only after a write is known to have been accepted, and cleared when one fails, so a
   * failure can never leave the flush believing disk is current.
   */
  const lastPersistedPayloadRef = useRef<string | null>(null);
  /** Layout: keep the ref aligned with state before the `useEffect`s that write to disk (avoids a flush with a stale snapshot). */
  useLayoutEffect(() => {
    persistenceRef.current = { user, apps, config };
  });

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
          /**
           * Every read-path normalization now lives in one module, because the wheel reads the same
           * file from its own renderer and has to arrive at the identical config.
           */
          nextConfig = normalizeStoredConfig(finalData.config);

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
        nextConfig = { ...nextConfig, language: normalizeLanguage(nextConfig.language) };

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
        window.electron?.publishDiscoveryPhase?.('waiting');

        discoveryDeferTimer = window.setTimeout(() => {
          void (async () => {
            if (cancelled) {
              setDiscoveryPhase('idle');
              window.electron?.publishDiscoveryPhase?.('idle');
              startMenuScanPersistenceHoldRef.current = false;
              return;
            }
            const mainIdx = configRef.current.workspaces.findIndex(
              (ws) => ws.id === 'workspace-1' || ws.name === 'Main',
            );
            /** Tracks whether discovery actually added apps — it is only marked done when it did. */
            let discoveryAddedApps = false;
            setDiscoveryPhase('scanning');
            window.electron?.publishDiscoveryPhase?.('scanning');
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
              window.electron?.publishDiscoveryPhase?.('idle');
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

      /**
       * Normalize, do not overwrite. This used to force `'en'` on every profile, because the ten
       * locales it could otherwise hydrate had no selector to reach them and no chunk worth
       * shipping. Settings has a real selector again, so a stored choice has to survive a reload —
       * but only for a language that actually has a table. `UIConfig['language']` still types four
       * that do not (`fr`, `it`, `ja`, `ko`), so a config carrying one still lands on English.
       */
      nextConfig = { ...nextConfig, language: normalizeLanguage(nextConfig.language) };

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
        /** Recorded here too, so the close-time flush does not redo a write this one just made. */
        const serialized = JSON.stringify(fullData);
        void window.electron.saveFullConfig(fullData).then((r) => {
          if (r && !r.ok) {
            lastPersistedPayloadRef.current = null;
            window.electron?.savePersistenceLog?.(
              `saveFullConfig failed: ${r.error || 'unknown'} | ws=${wsCount} mainApps=${mainApps}`,
            );
            return;
          }
          lastPersistedPayloadRef.current = serialized;
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
      /**
       * The dirty check. Serializing ~26 kB costs well under a millisecond against the 8.9 ms the
       * write costs, and on the common close there is nothing to write at all.
       */
      const serialized = JSON.stringify(fullData);
      if (serialized === lastPersistedPayloadRef.current) return;
      if (window.electron?.saveFullConfigSync) {
        const ok = window.electron.saveFullConfigSync(fullData);
        if (!ok) {
          lastPersistedPayloadRef.current = null;
          window.electron?.savePersistenceLog?.(
            'saveFullConfigSync: false or IPC error — scheduling invoke fallback',
          );
          void window.electron.saveFullConfig?.(fullData);
        } else {
          lastPersistedPayloadRef.current = serialized;
        }
      } else if (window.electron?.saveFullConfig) {
        lastPersistedPayloadRef.current = null;
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
  /** OS hid the window (Alt+F4 / close) while React still had the panel "open" — sync refs before state so we don't schedule hideWindow twice. */
  const syncAfterMainWindowHidRef = useRef<() => void>(() => {});
  /** The window is opaque: a strip exposed mid-resize shows this colour, so it follows the theme's `--zn-bg`. */
  useEffect(() => {
    window.electron?.setWindowBackground?.(config.appearanceTheme === 'white' ? '#e8e8ea' : '#151515');
  }, [config.appearanceTheme]);
  useEffect(() => {
    syncAfterMainWindowHidRef.current = () => {
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
        hideTimeout.current = null;
      }
      lastVisibility.current = false;
      setIsSettingsOpen(false);
      setIsDashboardOpen(false);
    };
  });

  /**
   * This window is now an ordinary one: it is either on screen or it is not.
   *
   * What used to be here decided between three native geometries — a monitor-sized overlay for the
   * wheel, the panel's own rect, and a collapsed click-through box for idle — and had to sequence
   * them against the radial's open so the two surfaces never fought over the same HWND. The wheel
   * has its own window now, so all three modes and the ordering between them are gone.
   */
  useEffect(() => {
    if (!window.electron || !isDesktopMode) return;
    const visible = panelSurfaceOpen;
    if (lastVisibility.current === visible) return;
    lastVisibility.current = visible;

    if (visible) {
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
        hideTimeout.current = null;
      }
      window.electron.showWindow();
      return;
    }
    /** Allow the exit animation to finish before the window leaves. */
    hideTimeout.current = setTimeout(() => {
      flushPersistenceToDiskRef.current?.();
      window.electron?.hideWindow();
    }, 300);
  }, [isDesktopMode, panelSurfaceOpen]);

  /**
   * Minimize.
   *
   * This used to paint a neutral frame and wait two rAFs before calling through, so that Windows
   * would not cache a picture of Settings as the thumbnail the DWM re-presented when the WHEEL next
   * opened in the same window. There is no same window any more: minimizing Settings now caches a
   * picture of Settings, which is what a thumbnail is for.
   */
  const flushNeutralFrameThenMinimize = useCallback(() => {
    window.electron?.minimizeWindow?.();
  }, []);

  // IPC: the settings surface — plus everything the wheel, in its own window, reports back here.
  useEffect(() => {
    const openPanel = () => {
      flushSync(() => {
        setIsSettingsOpen(true);
        setIsDashboardOpen(false);
      });
    };

    const cleanupDashboard = window.electron?.onOpenDashboard(openPanel);
    const cleanupSettings = window.electron?.onOpenSettings(openPanel);

    const cleanupWindowState = window.electron?.onWindowState((state) => {
      setWindowState(state);
    });

    const cleanupWindowHidToTray = window.electron?.onWindowHidToTray(() => {
      // Persist before resetting UI state so we never flush a stale ref or miss the write if the window hides quickly.
      flushPersistenceToDiskRef.current?.();
      syncAfterMainWindowHidRef.current();
    });

    /**
     * The wheel switched workspace. It has already redrawn itself — this is the write.
     *
     * Two renderers, one file: `App.tsx` is the only thing that saves, so every change the overlay
     * makes arrives here to be folded into the config that gets written. `config-changed` then goes
     * back out to the overlay, which finds the index it already set.
     */
    const cleanupRadialWorkspace = window.electron?.onRadialWorkspaceChanged?.((index) => {
      setConfig((prev) =>
        index < 0 || index >= prev.workspaces.length || prev.activeWorkspaceIndex === index
          ? prev
          : { ...prev, activeWorkspaceIndex: index },
      );
    });

    const cleanupRadialHint = window.electron?.onRadialDirectionHintSeen?.(() => {
      setConfig((prev) =>
        prev.hasSeenDirectionHint === true ? prev : { ...prev, hasSeenDirectionHint: true },
      );
    });

    /**
     * A launch started from the wheel failed. The card belongs here, where it can be read and
     * dismissed — the overlay is click-through whenever the wheel is closed.
     */
    const cleanupRadialFault = window.electron?.onRadialLaunchFault?.((fault) => {
      faultSeqRef.current += 1;
      setLaunchFault({
        kind: 'launch',
        seq: faultSeqRef.current,
        raw: fault.raw,
        details: fault.details as ExecutionErrorDetails | undefined,
        appLabel: fault.appLabel,
        shortcut: fault.shortcut,
      });
    });

    const cleanupCleanMemory = window.electron?.onCleanMemory?.(() => {
      import('./components/installedApps').then((m) => m.clearInstalledAppsMemory?.()).catch(() => {});
      if (typeof (window as any).gc === 'function') {
        try {
          (window as any).gc();
        } catch (_) {
          /* ignore */
        }
      }
    });

    return () => {
      cleanupDashboard?.();
      cleanupSettings?.();
      cleanupWindowState?.();
      cleanupWindowHidToTray?.();
      cleanupRadialWorkspace?.();
      cleanupRadialHint?.();
      cleanupRadialFault?.();
      cleanupCleanMemory?.();
    };
  }, []);

  /** Centralized function to open the settings surface. */
  const handleOpenSettings = useCallback(() => {
    flushSync(() => {
      setIsSettingsOpen(true);
      setIsDashboardOpen(false);
    });
  }, []);
  const handleOpenSettingsRef = useRef(handleOpenSettings);
  handleOpenSettingsRef.current = handleOpenSettings;

  /**
   * "Fix shortcut" on a launch failure: Settings, on the workspace, with that row already open.
   *
   * The failure was reported from the other window, so this both re-opens the panel and hands
   * `PrecisionSettings` the destination — it is mounted lazily and remounted often, and anything
   * told to it after it appears would race its own first render.
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

  /** Closes only the Settings surface; the process, tray, wheel and shortcuts stay active. */
  const handleClosePanelToBackground = useCallback(() => {
    flushSync(() => {
      setIsSettingsOpen(false);
      setIsDashboardOpen(false);
    });
  }, []);

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
      setIsDashboardOpen(false);
      setIsSettingsOpen(true);
    });
  };

  const handleUserProfileUpdate = useCallback((patch: Partial<UserProfile>) => {
    setUser((u) => (u ? { ...u, ...patch } : null));
  }, []);

  /** Theme for the opaque surfaces (titlebar + panels). */
  const panelTheme = config.appearanceTheme === 'white' ? 'white' : 'black';

  return (
    <div
      className={`
        fixed inset-0 w-full h-full overflow-hidden cursor-default select-none
        ${isDesktopMode ? 'bg-transparent' : 'bg-[#0D0D0D]'}
      `}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/*
        The window is ONE surface. There used to be `border` + `rounded-xl` + `shadow-[0_0_50px]`
        on this same `absolute inset-0` element: since the parent is `fixed inset-0 overflow-hidden`,
        the outer shadow was clipped and all that was left were the smudges in the corner notches —
        it read as a second layer behind a border drawn on top.
        `zenith-panel-surface` (index.css) replaces the three with a tokenized inner
        hairline + radius. `hasShadow:false` in main stays: the separation from the
        desktop comes from the radius and the surface contrast, not from an inner halo.
      */}
      <div
        data-zn-theme={panelTheme}
        data-window-state={windowState}
        className={`
        overflow-hidden [--zenith-title-bar-h:38px] absolute inset-0
        ${panelSurfaceOpen
          ? 'zenith-panel-surface !transition-none opacity-100 visible'
          : 'hidden !transition-none pointer-events-none'
        }
      `}>
        {/* CUSTOM TITLE BAR OVERLAY (for drag region + app name) */}
        {panelSurfaceOpen && (
          <div
            /* `zenith-titlebar` — styled in index.css, alongside the radial panel. */
            className="zenith-titlebar absolute top-0 left-0 right-0 h-[var(--zenith-title-bar-h)] z-[999] flex items-center justify-between pl-3 overflow-hidden"
            style={{ WebkitAppRegion: 'drag' } as any}
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

        {/**
         * Hide, do not unmount.
         *
         * The wheel no longer touches this window, so the subtree is never pulled out from under
         * the panel mid-gesture — but the rule that taught us that still holds: unmounting
         * `PrecisionSettings` replays its 0.28 s entrance and the `.zs-shell` fade, and the panel
         * looks like it reloaded when it never left.
         */}
        <div>
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
                      setSettingsNav({ sectionId: 'spaces', isSidebarCollapsed: false, focusShortcut: null });
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

        {/* The welcome card, over whatever the panel is showing. */}
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
                * The sticky notice waits for a surface it can actually be dismissed on — including
                * one raised by the wheel, in the other window, while nothing here was on screen. It
                * stays in state until the panel appears, which is also when it becomes dismissable.
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

    </div>
  );
}
