import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  DWELL_MS_MAX,
  DWELL_MS_MIN,
  DWELL_MS_STEP,
  clampDirectionSensitivity,
  clampDwellMs,
} from '../constants/radialDwell';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Globe2,
  GripVertical,
  Loader2,
  AlertTriangle,
  Monitor,
  Mouse,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Palette,
  Settings,
  Shield,
  SquareStack,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppItem, UIConfig, UpdateChannel, UpdateState, Workspace } from '../types';
import { DEFAULT_UI_CONFIG } from '../defaults';
import { normalizeTaskbarOverlay } from '../utils/taskbarOverlay';
import { getIcon } from '../iconMap';
import { resolveWebsiteIconFields } from '../siteFavicon';
import { hostLabelFromUrl, looksFetchable, normalizeSiteUrl, resolveWebsiteTitle } from '../siteTitle';
import { SmartIcon } from './SmartIcon';
import { IconPicker } from './IconPicker';
import { RovylLogo } from './RovylLogo';
import '../fonts-display.css';
import { NativeAppIcon, useInstalledApps, type InstalledApp } from './installedApps';
import { radialCrowding } from '../utils/workspaceRadial';
import { startMenuAppIdToLaunchCommand } from '../utils/windowsLaunchCommand';
import { WheelPreview } from './WheelPreview';

interface PrecisionSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  apps: AppItem[];
  setApps: (value: AppItem[] | ((prev: AppItem[]) => AppItem[])) => void;
  config: UIConfig;
  setConfig: (value: UIConfig | ((prev: UIConfig) => UIConfig)) => void;
  onReset: () => void;
  onOpenDashboard: () => void;
  /**
   * Where the user was. Lives in `App` because this component does not survive using the app:
   * the wheel over the panel, the collapse to the island and the shortcut with Settings tucked
   * away all unmount it, and anything held as local state went back to `general` unasked.
   */
  nav: SettingsNav;
  setNav: React.Dispatch<React.SetStateAction<SettingsNav>>;
  /**
   * Whether the Start Menu scan is still to come. "This workspace is empty — add an application" is
   * the wrong advice while a scan that will fill it is pending: it invites the user to redo work
   * that is already on its way.
   */
  discoveryPhase?: 'idle' | 'waiting' | 'scanning';
  /** State of the license active on this machine — the settings row mirrors it. */
  /** True while a request to open the license card is pending. */
  /** Called as soon as the request is honoured, so App can clear it. */
  isPage?: boolean;
}

export type SectionId = 'general' | 'trigger' | 'appearance' | 'spaces' | 'advanced';

/**
 * The navigation that has to outlive the tree: open section and sidebar.
 *
 * Only the TYPE crosses the boundary into `App` — `import type` is erased at compile time and this
 * module goes on being loaded by `React.lazy` alone. Exporting the initial value here put the
 * whole of Settings in the chunk the wheel waits on to paint.
 */
export interface SettingsNav {
  sectionId: SectionId;
  isSidebarCollapsed: boolean;
  /**
   * "Take me to this shortcut" — set by the Fix action on a launch-failure card, and cleared the
   * moment it is honoured.
   *
   * It travels through `nav` because that is the one piece of settings state that survives this
   * component being unmounted, and the request is made while it is unmounted: the wheel is what
   * was on screen when the launch failed. A prop read once on mount would be missed by a panel
   * that is already open, and a prop read on every render would re-open the editor after the user
   * closed it.
   */
  focusShortcut?: { workspaceIndex: number; appId: string } | null;
}

/** Patch a workspace directly, or from what it is at the moment the update runs. See `updateWorkspace`. */
export type WorkspaceUpdater = (
  index: number,
  patch: Partial<Workspace> | ((workspace: Workspace) => Partial<Workspace>),
) => void;

/** The modal is reserved for what does not fit in a row: long lists, recording and editing. */
type Editor =
  | { kind: 'shortcut' }
  | { kind: 'blocked' }
  | { kind: 'workspace'; index: number }
  | null;

interface SettingItem {
  key: string;
  /** Title of the group the row joins. Consecutive rows with the same group stay together. */
  group: string;
  title: string;
  description?: string;
  kind: 'bool' | 'range' | 'segmented' | 'open' | 'action' | 'color';
  enabled?: boolean;
  value?: string;
  min?: number;
  max?: number;
  step?: number;
  raw?: number;
  format?: (value: number) => string;
  choices?: Array<{ value: string; label: string }>;
  current?: string;
  onToggle?: () => void;
  onChange?: (value: number | string) => void;
  onOpen?: () => void;
  onRun?: () => void;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  /** An action that exists but cannot be asked for yet — the download already under way. */
  actionDisabled?: boolean;
  /**
   * A second press, in the row, for an action nothing can take back.
   *
   * Everything else destructive in this panel deletes immediately and offers Undo, which is the
   * better trade because it costs nothing to the people who meant it. That trade needs the action
   * to be reversible, and "Restore defaults" is not: main deletes the config files and the icon
   * store, clears session storage, and relaunches — there is no session left for a toast to live
   * in, let alone anything to put back.
   */
  confirm?: { body: string; cta: string };
  /** Optional destructive shortcut shown beside the regular row control. */
  onDelete?: () => void;
  deleteLabel?: string;
  /**
   * The `UIConfig` key this row edits, when it edits exactly one.
   *
   * That is all a row has to declare: whether it is at its default and how to put it back are
   * both derivable from the key, and deriving them is the point — a per-row "revert" written by
   * hand seventeen times is seventeen chances to name the wrong default, and no chance at all of
   * noticing when one of them drifts from `DEFAULT_UI_CONFIG`.
   *
   * Rows without one are rows with nothing to revert TO: a workspace, an export, the shortcut
   * recorder's own card.
   */
  configKey?: keyof UIConfig;
  /** Position in the reorderable list. Only the rows that define it accept a drag. */
  reorderIndex?: number;
  /** `insertBefore` is the index in the ORIGINAL list the item has to end up before. */
  onReorder?: (from: number, insertBefore: number) => void;
}

/**
 * Glyphs in the vocabulary of macOS System Settings: a simple, recognisable object (gear, mouse,
 * palette, stack of windows, shield) instead of the abstract Windows/web panel icon.
 * Monochrome — color stays reserved for action or state, never for navigation.
 */
const SECTIONS: Array<{ id: SectionId; label: string; caption: string; icon: LucideIcon }> = [
  { id: 'general', label: 'General', caption: 'Core Rovyl behavior.', icon: Settings },
  { id: 'trigger', label: 'Activation', caption: 'How and where the wheel appears.', icon: Mouse },
  { id: 'appearance', label: 'Appearance', caption: 'Shape, presence, and theme.', icon: Palette },
  { id: 'spaces', label: 'Workspaces', caption: 'Contexts and their shortcuts.', icon: SquareStack },
  { id: 'advanced', label: 'Advanced', caption: 'Performance, protection, and data.', icon: Shield },
];

export const PrecisionSettings: React.FC<PrecisionSettingsProps> = ({
  isOpen,
  onClose,
  apps,
  config,
  setConfig,
  onReset,
  nav,
  setNav,
  discoveryPhase = 'idle',
}) => {
  /**
   * Both values are still read and written like local state — only where they live changed.
   * The functional `setNav` calls keep two writes in the same commit from erasing each other.
   */
  const { sectionId, isSidebarCollapsed } = nav;
  const setSectionId = useCallback(
    (value: React.SetStateAction<SectionId>) =>
      setNav((current) => ({
        ...current,
        sectionId:
          typeof value === 'function'
            ? (value as (previous: SectionId) => SectionId)(current.sectionId)
            : value,
      })),
    [setNav],
  );
  const setIsSidebarCollapsed = useCallback(
    (value: React.SetStateAction<boolean>) =>
      setNav((current) => ({
        ...current,
        isSidebarCollapsed:
          typeof value === 'function'
            ? (value as (previous: boolean) => boolean)(current.isSidebarCollapsed)
            : value,
      })),
    [setNav],
  );
  const [editor, setEditor] = useState<Editor>(null);
  /**
   * What the preview draws — the same rule `App` uses to decide what the wheel draws, and it has
   * to stay the same rule: a preview of a different list is worse than no preview.
   */
  /**
   * Same value as the shipped default? Compared through JSON so an object-valued key is judged by
   * its contents; every scalar in `UIConfig` gets the same answer either way.
   *
   * Component scope, not inside the items memo: the rows declare which key they edit, and the
   * revert is attached where they are rendered.
   */
  const isAtDefault = useCallback(
    (key: keyof UIConfig) => {
      const current = config[key];
      const fallback = DEFAULT_UI_CONFIG[key];
      if (Object.is(current, fallback)) return true;
      /** An unset key IS the default: the value the app runs on comes from the same constant. */
      if (current === undefined) return true;
      try {
        return JSON.stringify(current) === JSON.stringify(fallback);
      } catch (e) {
        return false;
      }
    },
    [config],
  );

  const previewApps = useMemo(() => {
    const workspace = config.workspaces[config.activeWorkspaceIndex];
    return workspace?.apps?.length ? workspace.apps : apps;
  }, [config.workspaces, config.activeWorkspaceIndex, apps]);
  /** Survives only until `WorkspaceManager` has expanded the row; `nav` is cleared immediately. */
  const [focusAppId, setFocusAppId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /**
   * A toast that can undo what it is reporting.
   *
   * `seq` is what restarts the timer: two deletions in a row produce two toasts with the same
   * words, and without it the second one inherits the first one's countdown and can vanish almost
   * as it appears.
   */
  const [toast, setToast] = useState<{ seq: number; message: string; undo?: () => void } | null>(null);
  const toastSeq = useRef(0);
  /** Executable version (absent outside Electron — the foot is then left with the name). */
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** License activated: the content fades out before the window closes. */
  const [isDismissing, setIsDismissing] = useState(false);
  /**
   * Updates: the panel is now the only place with the ACTION — the native Windows box was
   * removed. The badge on the radial hub warns; what and when are decided here.
   *
   * ONE state, ONE row. There were two: "Version X is ready / Restart now" and, right below it, a
   * "Check for updates" that stayed there with the installer already on disk. Pressing it
   * downloaded the same file again and put the row back into "downloading" — the UI went
   * backwards, and "so is it ready or not?" was a fair question. The state comes from main; the
   * row is its projection.
   */
  const [updateInfo, setUpdateInfo] = useState<UpdateState>({ state: 'idle' });
  /**
   * Channel: only `direct` (the NSIS installer) has an updater. On the Store the store updates it,
   * and an unpackaged build has nothing to call — a button that only ever errors is worse than none.
   */
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(
    /** Until main answers we do not know: better the row appears late than appears dead. */
    'unsupported',
  );
  const canUpdate = updateChannel === 'direct';

  useEffect(() => {
    let cancelled = false;
    void window.electron?.getBuildChannel?.().then((channel) => {
      if (!cancelled && channel) setUpdateChannel(channel);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electron?.getUpdateState?.().then((state) => {
      if (!cancelled && state) setUpdateInfo(state);
    }).catch(() => undefined);
    const off = window.electron?.onUpdateState?.((payload) => {
      if (payload) setUpdateInfo(payload);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /**
   * The button decides nothing: it asks, and main answers with the state it ended up in. A check
   * already under way joins the one that exists, and with something downloaded main refuses — so
   * the local `checking` exists only for the window between the click and the first answer.
   */
  const [updateChecking, setUpdateChecking] = useState(false);
  const runUpdateCheck = useCallback(async () => {
    if (!window.electron?.checkForUpdates) return;
    setUpdateChecking(true);
    try {
      const result = await window.electron.checkForUpdates();
      if (result && !result.ok && result.code !== 'CHECK_FAILED') {
        /** No updater in this build: hide the row rather than leave it explaining an error. */
        setUpdateChannel(result.code === 'STORE_BUILD' ? 'store' : 'unsupported');
      } else if (result?.ok && result.state) {
        /** Echo from main; the `update-state` event usually arrives first, and says the same. */
        setUpdateInfo((current) =>
          current.state === result.state ? current : { ...current, state: result.state!, version: result.version ?? current.version },
        );
      } else if (result && !result.ok) {
        setUpdateInfo((current) => ({ ...current, state: 'error', error: result.error }));
      }
    } catch (e) {
      setUpdateInfo((current) => ({ ...current, state: 'error' }));
    } finally {
      setUpdateChecking(false);
    }
  }, []);

  /**
   * The update row, derived from the state — not one row per thing that can happen.
   *
   * The rule that was missing: while something is under way (`checking`, `downloading`) the row is
   * information, not a button. And after `ready` there is nothing left to check — the installer is
   * already on disk, and the only action left is choosing when to restart.
   */
  const updateRow = useMemo(() => {
    /** The updater usually knows the version, but "Version  is ready" must not reach the screen. */
    const version = updateInfo.version || null;

    if (updateInfo.state === 'ready') {
      return {
        title: version ? `Version ${version} is ready` : 'An update is ready',
        description: 'Downloaded and verified. Rovyl restarts to finish.',
        kind: 'action' as const,
        actionLabel: 'Restart now',
        actionIcon: ArrowUpFromLine,
        onRun: () => window.electron?.installUpdateNow?.(),
      };
    }

    if (updateInfo.state === 'downloading') {
      return {
        title: version ? `Downloading version ${version}` : 'Downloading an update',
        description:
          typeof updateInfo.percent === 'number'
            ? `${updateInfo.percent}% done. You can keep working — Rovyl installs it when you restart.`
            : 'You can keep working — Rovyl installs it when you restart.',
        kind: 'action' as const,
        actionLabel: 'Downloading…',
        actionIcon: ArrowDownToLine,
        actionDisabled: true,
        onRun: () => {},
      };
    }

    const checking = updateChecking || updateInfo.state === 'checking';
    const description = checking
      ? 'Looking for a newer version…'
      : updateInfo.state === 'error'
        ? 'Could not reach the update server.'
        : updateInfo.state === 'current'
          ? version
            ? `You're on the latest version (${version}).`
            : "You're on the latest version."
          : 'Rovyl checks automatically a few seconds after launch.';

    return {
      title: 'Check for updates',
      description,
      kind: 'action' as const,
      actionLabel: checking ? 'Checking…' : updateInfo.state === 'error' ? 'Try again' : 'Check now',
      actionIcon: ArrowDownToLine,
      actionDisabled: checking,
      onRun: () => void runUpdateCheck(),
    };
  }, [updateInfo, updateChecking, runUpdateCheck]);

  const reduceMotion = useReducedMotion();

  /**
   * Close with a visible exit. Activating the license shut the panel dead in the same frame; here
   * the content fades first and the window only goes afterwards. See `.zs-shell.is-dismissing`.
   */
  const dismissWithFade = useCallback(() => {
    setIsDismissing(true);
    window.setTimeout(() => {
      setIsDismissing(false);
      onClose();
    }, 240);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void window.electron?.getAppVersion?.().then((version) => {
      if (!cancelled && typeof version === 'string') setAppVersion(version);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  /**
   * Ctrl+K / Ctrl+F, when the box it is aiming at may not be on screen.
   *
   * The sidebar hides the search input twice over — once when the user collapses it, and again
   * under 760px, which Windows reaches at 150% scaling on an ordinary laptop. `focus()` on a
   * `display: none` element does nothing at all, so the shortcut was silent in exactly the states
   * where a keyboard route matters most. The rail gives way while the shortcut is asking for it,
   * and takes itself back when the search is left empty.
   */
  const [searchForced, setSearchForced] = useState(false);
  /** Bumped by every request; the layout effect below reads it and nothing else. */
  const [searchFocusSeq, setSearchFocusSeq] = useState(0);

  const focusSearch = useCallback(() => {
    setIsSidebarCollapsed(false);
    const input = document.getElementById('zs-search-input') as HTMLInputElement | null;
    /** `offsetParent` is null for a `display: none` element, which is exactly what to test for. */
    if (!input || input.offsetParent === null) setSearchForced(true);
    setSearchFocusSeq((seq) => seq + 1);
  }, [setIsSidebarCollapsed]);

  /**
   * Focus after the rail has actually widened, and not a frame later.
   *
   * `useLayoutEffect` runs once React has written the DOM and the browser has laid it out, so the
   * input is focusable by the time this reads it. The first attempt used two nested
   * `requestAnimationFrame`s, and rAF is throttled in a window that does not have focus — which is
   * every window the moment before someone alt-tabs to it.
   */
  useLayoutEffect(() => {
    if (!searchFocusSeq) return;
    const input = document.getElementById('zs-search-input') as HTMLInputElement | null;
    if (!input || input.offsetParent === null) return;
    input.focus();
    input.select();
    /**
     * Keyed on the request alone. Listing `searchForced` here too meant that RELEASING it — which
     * is what leaving an empty search box does — re-ran this and took the focus straight back, so
     * the box could not be left at all.
     *
     * One dep is enough because `focusSearch` sets all three pieces of state in one batch: React
     * commits them together, and a layout effect runs after that commit with the rail already wide.
     */
  }, [searchFocusSeq]);

  const theme = config.appearanceTheme === 'white' ? 'white' : 'black';

  const update = useCallback(
    <K extends keyof UIConfig>(key: K, value: UIConfig[K]) => {
      setConfig((current) => ({ ...current, [key]: value }));
    },
    [setConfig],
  );

  const gameMode = config.gameMode ?? {
    enabled: false,
    mode: 'list' as const,
    blockedApps: '',
    autoDetectGames: false,
  };
  const updateGameMode = (patch: Partial<typeof gameMode>) => {
    const next = { ...gameMode, ...patch };
    update('gameMode', next);
    window.electron?.setGameMode?.(next);
  };

  const taskbar = normalizeTaskbarOverlay(config.taskbarOverlay);
  const updateTaskbar = (patch: Partial<typeof taskbar>) => {
    const next = { ...taskbar, ...patch };
    update('taskbarOverlay', next);
    /** Main is what enacts this, and it must not wait for the next save to hear about it. */
    window.electron?.setTaskbarOverlay?.(next);
  };

  /**
   * Which taskbar this machine has, as reported by the helper: 'classic' | 'mixed' | 'xaml'.
   *
   * Null while nobody has asked yet. On a Windows 11 bar rebuilt in XAML (22H2 and later) the
   * Start button, the clock, the tray and the task buttons are not windows at all, so there is
   * nothing an outside process can hide -- and the four switches below are withdrawn rather than
   * left there doing nothing. Asked for only when this section is on screen: answering it costs a
   * helper process, and the feature is off for most people.
   */
  const [taskbarKind, setTaskbarKind] = useState<string | null>(null);
  useEffect(() => {
    if (sectionId !== 'appearance' || taskbarKind !== null) return;
    let cancelled = false;
    window.electron?.getTaskbarCapability?.().then((kind) => {
      /** Never gate the WRITE on `cancelled` -- only the setState, which is all it can speak for. */
      if (!cancelled && typeof kind === 'string') setTaskbarKind(kind);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sectionId, taskbarKind]);
  /** Unknown reads as capable: on Win10, which is the common case, withdrawing them would be wrong. */
  const taskbarElementsReachable = taskbarKind !== 'xaml';

  /**
   * A patch, or a function of the workspace as it is when the update actually runs.
   *
   * Undo needs the second form. A patch is built at the moment it is described, and an undo is
   * described up to seven seconds before anyone presses it — restoring `{ apps: <the old array> }`
   * would also silently revert whatever else was edited in that window.
   */
  const updateWorkspace: WorkspaceUpdater = (index, patch) => {
    setConfig((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace, i) =>
        i === index
          ? { ...workspace, ...(typeof patch === 'function' ? patch(workspace) : patch) }
          : workspace,
      ),
    }));
  };

  const showToast = (message: string, undo?: () => void) => {
    toastSeq.current += 1;
    setToast({ seq: toastSeq.current, message, undo });
  };

  /** Nobody reads a toast they are reaching for: while the pointer is on it, it has no timer. */
  const [toastHeld, setToastHeld] = useState(false);
  useEffect(() => {
    if (!toast || toastHeld) return;
    /**
     * An undo has to outlast the reaction it is asking for. 2.2 s is right for "Workspace created",
     * which is only telling you something, and far too short for a decision.
     */
    const timer = window.setTimeout(() => setToast(null), toast.undo ? 7000 : 2200);
    return () => window.clearTimeout(timer);
  }, [toast, toastHeld]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      /**
       * The Escape that closes the wheel is not ours.
       *
       * `RadialMenu` listens in CAPTURE and calls `preventDefault` before this bubble listener runs,
       * but not `stopPropagation` — so the same key reached here and closed the panel as well: an
       * Escape with the wheel over Settings dismissed both instead of only the wheel.
       * Whoever has claimed the key marks it; we respect the mark.
       */
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (editor) setEditor(null);
        else onClose();
        return;
      }
      /**
       * Ctrl+K and Ctrl+F. Ctrl+F because it is what a settings page is, and Ctrl+K because it is
       * what everything else with a search box has taught people to press.
       */
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'f' || key === 'k')) {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, editor, onClose]);

  /**
   * Honour a pending "open this shortcut" and take the request out of `nav` in the same tick.
   *
   * Clearing it here rather than in `WorkspaceManager` matters: `nav` outlives this component, so a
   * request left in it would re-open the editor every time Settings was opened afterwards. The row
   * id moves to local state, which is unmounted with the panel — exactly the lifetime it needs.
   */
  useEffect(() => {
    const target = nav.focusShortcut;
    if (!target) return;
    setEditor({ kind: 'workspace', index: target.workspaceIndex });
    setFocusAppId(target.appId);
    setNav((current) => ({ ...current, focusShortcut: null }));
  }, [nav.focusShortcut, setNav]);

  useEffect(() => {
    if (!isOpen) return;

    const toggleSidebar = () => setIsSidebarCollapsed((collapsed) => !collapsed);
    const navigate = (event: Event) => {
      const direction = (event as CustomEvent<'back' | 'forward'>).detail;
      setQuery('');
      setSectionId((current) => {
        const currentIndex = SECTIONS.findIndex((section) => section.id === current);
        const delta = direction === 'back' ? -1 : 1;
        return SECTIONS[Math.max(0, Math.min(SECTIONS.length - 1, currentIndex + delta))].id;
      });
    };

    window.addEventListener('zenith-settings-toggle-sidebar', toggleSidebar);
    window.addEventListener('zenith-settings-navigation', navigate);
    return () => {
      window.removeEventListener('zenith-settings-toggle-sidebar', toggleSidebar);
      window.removeEventListener('zenith-settings-navigation', navigate);
    };
  }, [isOpen]);

  /**
   * The key belongs to the POSITION, not to the workspace.
   *
   * Each workspace used to keep its key forever: reordering left the second card holding key 2 in
   * first place, and deleting one from the middle opened permanent holes — the "1, 2, 4". The
   * visible order and the key order are now the same thing, computed in one place.
   *
   * Past the ninth position there is no key: `hotkey: 0` means reachable only through the picker
   * and the mouse wheel, which was already the contract of the type.
   */
  const withPositionalHotkeys = (list: Workspace[]): Workspace[] =>
    list.map((workspace, index) => {
      const hotkey = index < 9 ? index + 1 : 0;
      return workspace.hotkey === hotkey ? workspace : { ...workspace, hotkey };
    });

  const addWorkspace = () => {
    setConfig((current) => {
      const usedNames = new Set(current.workspaces.map((workspace) => workspace.name));
      let workspaceNumber = current.workspaces.length + 1;
      while (usedNames.has(`Workspace ${workspaceNumber}`)) workspaceNumber += 1;

      return {
        ...current,
        workspaces: withPositionalHotkeys([
          ...current.workspaces,
          {
            id: crypto.randomUUID(),
            name: `Workspace ${workspaceNumber}`,
            enabled: true,
            hotkey: 0,
            apps: [],
            color: '#FFFFFF',
          },
        ]),
      };
    });
    showToast('Workspace created');
  };

  /**
   * Delete now, offer it back for seven seconds.
   *
   * This asked `window.confirm` first: a native modal, drawn by Windows, in front of a frameless
   * transparent window it knows nothing about — and it blocks the renderer while it is up. The
   * question it asked was also the wrong one, because a yes/no before the fact makes the user
   * predict whether they will regret it, and they answer it the same way every time until the one
   * time they should not have. Undo asks nothing and is still there after they have seen the
   * result.
   *
   * The undo re-inserts the workspace it took rather than restoring a snapshot of the whole array,
   * so a rename or a reorder made during those seven seconds survives being undone.
   */
  const deleteWorkspace = useCallback((index: number) => {
    const workspace = config.workspaces[index];
    if (!workspace) return;
    if (config.workspaces.length <= 1) {
      showToast('Keep at least one workspace');
      return;
    }
    const previousActiveIndex = config.activeWorkspaceIndex;

    setConfig((current) => {
      if (current.workspaces.length <= 1 || !current.workspaces[index]) return current;
      const workspaces = withPositionalHotkeys(
        current.workspaces.filter((_, workspaceIndex) => workspaceIndex !== index),
      );
      let activeWorkspaceIndex = current.activeWorkspaceIndex;
      if (activeWorkspaceIndex === index) activeWorkspaceIndex = Math.min(index, workspaces.length - 1);
      else if (activeWorkspaceIndex > index) activeWorkspaceIndex -= 1;

      return { ...current, workspaces, activeWorkspaceIndex };
    });
    setEditor((current) => current?.kind === 'workspace' && current.index === index ? null : current);

    const shortcuts = workspace.apps?.length ?? 0;
    showToast(
      shortcuts > 0
        ? `Deleted “${workspace.name}” and ${shortcuts} ${shortcuts === 1 ? 'shortcut' : 'shortcuts'}`
        : `Deleted “${workspace.name}”`,
      () => {
        setConfig((current) => {
          /** Undo twice, or undo something that came back another way, must not duplicate it. */
          if (current.workspaces.some((item) => item.id === workspace.id)) return current;
          const workspaces = [...current.workspaces];
          workspaces.splice(Math.min(index, workspaces.length), 0, workspace);
          return {
            ...current,
            workspaces: withPositionalHotkeys(workspaces),
            activeWorkspaceIndex: Math.min(previousActiveIndex, workspaces.length - 1),
          };
        });
      },
    );
  }, [config.workspaces, config.activeWorkspaceIndex, setConfig]);

  /**
   * Reorder workspaces by dragging.
   *
   * `insertBefore` refers to the ORIGINAL list: once the source is removed, everything that sat
   * ahead of it shifts one place, so the target drops by one when dragging downwards.
   */
  const reorderWorkspaces = useCallback((from: number, insertBefore: number) => {
    setConfig((current) => {
      if (!current.workspaces[from]) return current;
      const workspaces = [...current.workspaces];
      const [moved] = workspaces.splice(from, 1);
      const target = Math.max(
        0,
        Math.min(from < insertBefore ? insertBefore - 1 : insertBefore, workspaces.length),
      );
      if (target === from) return current;
      workspaces.splice(target, 0, moved);
      const renumbered = withPositionalHotkeys(workspaces);
      /**
       * `activeWorkspaceIndex` is a POSITION, not an id. Reordering without remapping it silently
       * swapped the current workspace for another — the same care `deleteWorkspace` takes.
       */
      const activeId = current.workspaces[current.activeWorkspaceIndex]?.id;
      const remapped = renumbered.findIndex((workspace) => workspace.id === activeId);
      return {
        ...current,
        workspaces: renumbered,
        activeWorkspaceIndex: remapped >= 0 ? remapped : current.activeWorkspaceIndex,
      };
    });
  }, [setConfig]);

  const exportConfig = async () => {
    const result = await window.electron?.exportConfig?.();
    showToast(result?.success ? 'Backup exported' : result?.error || 'Could not export settings');
  };

  const importConfig = async () => {
    const result = await window.electron?.importConfig?.();
    showToast(result?.success ? 'Settings imported' : result?.error || 'Could not import settings');
  };

  const sections = useMemo<Record<SectionId, SettingItem[]>>(() => {
    const range = (
      key: string,
      group: string,
      title: string,
      description: string,
      raw: number,
      min: number,
      max: number,
      onChange: (value: number) => void,
      format: (value: number) => string,
      step = 1,
      configKey?: keyof UIConfig,
    ): SettingItem => ({
      key, group, title, description, kind: 'range', raw, min, max, step, onChange, format,
      value: format(raw), configKey,
    });

    return {
      general: [
        {
          key: 'openAtLogin', configKey: 'openAtLogin', group: 'Startup', title: 'Start with Windows',
          description: 'Rovyl is ready as soon as you sign in to Windows.',
          kind: 'bool', enabled: Boolean(config.openAtLogin),
          onToggle: () => {
            const next = !config.openAtLogin;
            update('openAtLogin', next);
            window.electron?.setLoginItemSettings?.({ openAtLogin: next });
          },
        },
        {
          key: 'workspaceSwitchMode', configKey: 'workspaceSwitchMode', group: 'Workspaces', title: 'Workspace switching',
          description: 'Use the visual wheel picker or number keys.',
          kind: 'segmented', current: config.workspaceSwitchMode ?? 'picker',
          choices: [{ value: 'picker', label: 'Picker' }, { value: 'hotkeys', label: 'Keys' }],
          onChange: (value) => update('workspaceSwitchMode', value as UIConfig['workspaceSwitchMode']),
        },
      ],
      trigger: [
        {
          key: 'shortcut', group: 'Keyboard', title: 'Global shortcut',
          description: 'Open the wheel over any application.',
          kind: 'open', value: config.globalShortcut, onOpen: () => setEditor({ kind: 'shortcut' }),
        },
        {
          key: 'mouse', configKey: 'enableMouseTrigger', group: 'Mouse', title: 'Mouse trigger',
          description: 'Open Rovyl with a mouse button instead of the keyboard.',
          kind: 'bool', enabled: config.enableMouseTrigger,
          onToggle: () => update('enableMouseTrigger', !config.enableMouseTrigger),
        },
        {
          key: 'mouseButton', configKey: 'mouseTriggerButton', group: 'Mouse', title: 'Trigger button',
          description: 'Side buttons are usually free; left and right stay with Windows.',
          kind: 'segmented', current: config.mouseTriggerButton ?? 'middle',
          choices: [
            { value: 'middle', label: 'Wheel' },
            { value: 'x1', label: 'Back' },
            { value: 'x2', label: 'Forward' },
          ],
          onChange: (value) => update('mouseTriggerButton', value as UIConfig['mouseTriggerButton']),
        },
        {
          key: 'mouseMode', configKey: 'mouseTriggerMode', group: 'Mouse', title: 'Gesture behavior',
          description: 'Click keeps the wheel open; hold runs the selection on release.',
          kind: 'segmented', current: config.mouseTriggerMode ?? 'click',
          choices: [{ value: 'click', label: 'Click' }, { value: 'hold', label: 'Hold' }],
          onChange: (value) => update('mouseTriggerMode', value as UIConfig['mouseTriggerMode']),
        },
        {
          key: 'radialMonitor', configKey: 'radialMonitor', group: 'Position', title: 'Monitor',
          /**
           * The consequence, not the mechanism. Nobody opens this panel wanting to know which
           * `Display` object main asks for — they want to know which screen the thing they are about
           * to launch will be sitting on.
           */
          description:
            config.radialMonitor === 'cursor'
              ? 'The wheel opens on the screen the pointer is already on, so what you launch lands where you are working.'
              : 'The wheel always opens on the main screen, wherever the pointer happens to be.',
          kind: 'segmented',
          choices: [
            { value: 'primary', label: 'Main screen' },
            { value: 'cursor', label: 'Follow pointer' },
          ],
          current: config.radialMonitor === 'cursor' ? 'cursor' : 'primary',
          onChange: (value) => update('radialMonitor', value as UIConfig['radialMonitor']),
        },
        range('threshold', 'Position', 'Activation zone', 'Cursor distance required to confirm a target.',
          config.activationThreshold, 20, 120, (value) => update('activationThreshold', value), (value) => `${Math.round(value)} px`,
          1, 'activationThreshold'),
        {
          key: 'instant', configKey: 'radialInstantActivate', group: 'Hands-free', title: 'Launch without clicking',
          /** The way OUT belongs in the description: with the pointer hidden, it is not guessable. */
          description:
            'Hides the pointer and picks by direction — move toward a target and it opens by itself. Escape closes the wheel without opening anything.',
          /**
           * A switch, not a segmented control. Everything binary in this panel is `bool`; a
           * segmented control is always a choice between named pairs (Picker/Keys, Click/Hold,
           * Direction/Pointer) and none of them has an "Off". Here the two sides are not a pair:
           * with this on, clicking goes on working exactly as before, so what exists is the absence
           * of a feature — which is precisely what the switch says.
           *
           * It lives in Activation and not in Appearance: this decides HOW the wheel is driven and
           * run — it hides the pointer and trades aiming by position for aiming by direction. None
           * of that is looks, and beside the trigger is where someone goes looking for it.
           *
           * Comparing against `'dwell'` also coerces `'swipe'`, reserved in the type and not implemented.
           */
          kind: 'bool',
          enabled: config.radialInstantActivate === 'dwell',
          onToggle: () =>
            update(
              'radialInstantActivate',
              config.radialInstantActivate === 'dwell' ? 'off' : 'dwell',
            ),
        },
        /**
         * The two tunings only exist while the gesture does. Leaving them visible with it off is
         * offering controls that control nothing — and sensitivity, alone in the list, does not
         * say what it is sensitivity to.
         */
        ...(config.radialInstantActivate === 'dwell'
          ? [
              {
                key: 'instantSensitivity',
                configKey: 'radialInstantSensitivity' as const,
                group: 'Hands-free',
                title: 'Direction sensitivity',
                description:
                  'How far your hand must travel before that direction is chosen. High picks on the smallest movement.',
                kind: 'segmented' as const,
                current: clampDirectionSensitivity(config.radialInstantSensitivity),
                choices: [
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ],
                onChange: (value: number | string) =>
                  update('radialInstantSensitivity', value as UIConfig['radialInstantSensitivity']),
              },
              range('dwellMs', 'Hands-free', 'Hover time',
                'How long a target must stay aimed before it opens. Drag to zero and the direction opens the moment it commits.',
                clampDwellMs(config.radialInstantDwellMs), DWELL_MS_MIN, DWELL_MS_MAX,
                (value) => update('radialInstantDwellMs', value),
                /**
                 * "0 ms" would read as one number among others — and what zero does is not wait
                 * less, it is to have no wait at all. The word says the behavior; the rest of the
                 * scale goes on saying the time.
                 */
                (value) => (Math.round(value) === 0 ? 'Instant' : `${Math.round(value)} ms`),
                DWELL_MS_STEP, 'radialInstantDwellMs'),
            ]
          : []),
      ],
      appearance: [
        {
          key: 'theme', configKey: 'appearanceTheme', group: 'Theme', title: 'Rovyl surfaces',
          description: 'Applies to the window and title bar. The wheel remains dark.',
          kind: 'segmented', current: theme,
          choices: [{ value: 'black', label: 'Black' }, { value: 'white', label: 'White' }],
          onChange: (value) => update('appearanceTheme', value as UIConfig['appearanceTheme']),
        },
        range('radius', 'Wheel', 'Orbital radius', 'Perceived wheel diameter.',
          config.menuRadius, 90, 220, (value) => update('menuRadius', value), (value) => `${Math.round(value)} px`,
          1, 'menuRadius'),
        range('iconSize', 'Wheel', 'Icon size', 'Visual weight of each target.',
          config.iconSize, 36, 92, (value) => update('iconSize', value), (value) => `${Math.round(value)} px`,
          1, 'iconSize'),
        range('spacing', 'Wheel', 'Target spacing', 'Free space between items.',
          config.appSpacing ?? 10, 0, 40, (value) => update('appSpacing', value), (value) => `${Math.round(value)} px`,
          1, 'appSpacing'),
        {
          key: 'radialHoverColor', configKey: 'radialHoverColor', group: 'Wheel', title: 'Hover color',
          description: 'Color used by the target under the pointer.',
          kind: 'color', value: config.radialHoverColor ?? '#FFFFFF',
          onChange: (value) => update('radialHoverColor', String(value)),
        },
        {
          key: 'aim', configKey: 'radialSelectionMode', group: 'Wheel', title: 'Targeting',
          /**
           * With launch without clicking on there is no pointer on screen, so "aim with the
           * pointer" is not an option that can exist — the wheel always falls back to sectors by
           * direction. Saying so here is the minimum: a segmented control that still moves and
           * changes nothing is worse than a disabled one.
           */
          description:
            config.radialInstantActivate === 'dwell'
              ? 'Launch without clicking is on, so the wheel always aims by direction — each item owns an equal slice of the screen.'
              : config.radialSelectionMode === 'cursor'
                ? 'Only the icon under the pointer highlights. Release away from every icon to cancel.'
                : 'Aim by direction: the slice you point toward highlights from anywhere on screen.',
          kind: 'segmented',
          choices: [
            { value: 'angle', label: 'Direction' },
            { value: 'cursor', label: 'Pointer' },
          ],
          current: config.radialSelectionMode === 'cursor' ? 'cursor' : 'angle',
          onChange: (value) => update('radialSelectionMode', value as UIConfig['radialSelectionMode']),
        },
        {
          key: 'labels', configKey: 'alwaysShowAppLabels', group: 'Wheel', title: 'Persistent labels',
          description: 'Keep every target name visible.',
          kind: 'bool', enabled: config.alwaysShowAppLabels,
          onToggle: () => update('alwaysShowAppLabels', !config.alwaysShowAppLabels),
        },
        range('backdrop', 'Presence', 'Background dimming',
          'How much the rest of the screen recedes. At 100% it goes: the desktop is covered edge to edge.',
          config.backdropOpacity ?? DEFAULT_UI_CONFIG.backdropOpacity, 0, 1,
          (value) => update('backdropOpacity', value), (value) => `${Math.round(value * 100)}%`,
          0.01, 'backdropOpacity'),
        {
          key: 'taskbar', configKey: 'taskbarOverlay', group: 'Presence', title: 'Quiet the taskbar',
          description: taskbarElementsReachable
            ? 'Hide parts of the Windows taskbar while the wheel is open, on the screen the wheel is on. Everything comes back when it closes.'
            : 'This version of Windows builds its taskbar in a way no other app can take apart, so only the background can be changed here.',
          kind: 'bool', enabled: taskbar.enabled,
          onToggle: () => updateTaskbar({ enabled: !taskbar.enabled }),
        },
        /**
         * Withdrawn rather than disabled, and withdrawn entirely on a Windows 11 XAML bar — the
         * same rule the dwell tunings follow: a switch that stays on screen controlling nothing is
         * worse than one that is not offered.
         */
        ...(taskbar.enabled && taskbarElementsReachable ? ([
          {
            key: 'taskbar-start', group: 'Presence', title: 'Keep the Start button',
            description: 'Start and Task View stay on the bar.',
            kind: 'bool' as const, enabled: taskbar.showStart,
            onToggle: () => updateTaskbar({ showStart: !taskbar.showStart }),
          },
          {
            key: 'taskbar-apps', group: 'Presence', title: 'Keep pinned and open apps',
            description: 'The app buttons, and anything else docked beside them.',
            kind: 'bool' as const, enabled: taskbar.showApps,
            onToggle: () => updateTaskbar({ showApps: !taskbar.showApps }),
          },
          {
            key: 'taskbar-tray', group: 'Presence', title: 'Keep the notification area',
            description: 'Tray icons and the chevron that holds the rest.',
            kind: 'bool' as const, enabled: taskbar.showTray,
            onToggle: () => updateTaskbar({ showTray: !taskbar.showTray }),
          },
          {
            key: 'taskbar-clock', group: 'Presence', title: 'Keep the clock',
            description: 'The time and date at the end of the bar.',
            kind: 'bool' as const, enabled: taskbar.showClock,
            onToggle: () => updateTaskbar({ showClock: !taskbar.showClock }),
          },
        ]) : []),
        ...(taskbar.enabled ? ([
          {
            key: 'taskbar-transparent', group: 'Presence', title: 'Make the bar transparent',
            /**
             * The caveat belongs in the row, not in a release note. This is the only part of Rovyl
             * that changes something about Windows it cannot put back exactly.
             */
            description:
              'The bar itself goes, and whatever you kept above still shows. Windows does not report how the bar was painted before, so its background is restored to the standard look — which can differ slightly from a custom theme.',
            kind: 'bool' as const, enabled: taskbar.transparent,
            onToggle: () => updateTaskbar({ transparent: !taskbar.transparent }),
          },
        ]) : []),
      ],
      spaces: [
        ...config.workspaces.map((workspace, index) => ({
          key: workspace.id,
          group: 'Your workspaces',
          title: workspace.name,
          description: workspace.hotkey ? `Key ${workspace.hotkey}` : 'Picker / mouse wheel',
          kind: 'open' as const,
          /** Same vocabulary as the editor: current / available / paused. */
          value: config.activeWorkspaceIndex === index ? 'Current' : workspace.enabled ? 'Available' : 'Paused',
          onOpen: () => setEditor({ kind: 'workspace' as const, index }),
          onDelete: config.workspaces.length > 1 ? () => deleteWorkspace(index) : undefined,
          deleteLabel: `Delete ${workspace.name}`,
          reorderIndex: index,
          onReorder: reorderWorkspaces,
        })),
        {
          key: 'new-space', group: 'Your workspaces', title: 'New workspace',
          description: 'Create another context for your shortcuts.',
          kind: 'action', actionLabel: 'Create', actionIcon: Plus, onRun: addWorkspace,
        },
      ],
      advanced: [
        ...(canUpdate ? [{ key: 'update', group: 'Updates', ...updateRow }] : []),
        {
          key: 'performance', group: 'Performance', title: 'Precision mode',
          description: 'Prioritize immediate response and reduce visual effects.',
          kind: 'bool', enabled: config.performanceMode,
          onToggle: () => update('performanceMode', !config.performanceMode),
        },
        {
          key: 'game', group: 'Protection', title: 'Fullscreen protection',
          description: 'Prevent accidental openings during games and videos.',
          kind: 'bool', enabled: gameMode.enabled,
          onToggle: () => updateGameMode({ enabled: !gameMode.enabled }),
        },
        ...(gameMode.enabled ? [{
          key: 'scope', group: 'Protection', title: 'Scope', description: 'All fullscreen apps or only a selected list.',
          kind: 'segmented' as const, current: gameMode.mode,
          choices: [{ value: 'all', label: 'All' }, { value: 'list', label: 'List' }],
          onChange: (value: number | string) => updateGameMode({ mode: value as 'all' | 'list' }),
        }] : []),
        ...(gameMode.enabled && gameMode.mode === 'list' ? [
          {
            key: 'auto-games', group: 'Protection', title: 'Detect games automatically',
            description: 'Uses game-store folders and engine files; protection still applies only in fullscreen.',
            kind: 'bool' as const, enabled: gameMode.autoDetectGames,
            onToggle: () => updateGameMode({ autoDetectGames: !gameMode.autoDetectGames }),
          },
          {
            key: 'blocked', group: 'Protection', title: 'Protected applications',
            description: 'Choose installed applications visually. No executable names required.',
            kind: 'open' as const,
            value: gameMode.blockedApps ? 'Edit list' : 'Choose apps',
            onOpen: () => setEditor({ kind: 'blocked' as const }),
          },
        ] : []),
        {
          key: 'export', group: 'Data', title: 'Export settings',
          description: 'Save a portable copy of your configuration.',
          kind: 'action', actionLabel: 'Export', actionIcon: ArrowUpFromLine, onRun: exportConfig,
        },
        {
          key: 'import', group: 'Data', title: 'Import settings',
          kind: 'action', actionLabel: 'Import', actionIcon: ArrowDownToLine, onRun: importConfig,
        },
        {
          key: 'reset', group: 'Data', title: 'Restore defaults',
          description: 'Erase local settings and start over.',
          kind: 'action', actionLabel: 'Restore', onRun: onReset,
          confirm: {
            body: 'Every workspace, shortcut, icon and preference on this PC is deleted and Rovyl restarts. This cannot be undone — use Export settings first if you want a copy.',
            cta: 'Erase everything',
          },
        },
      ],
    };
  }, [config, gameMode, taskbar, taskbarElementsReachable, theme, apps, update, updateRow, canUpdate, onReset, deleteWorkspace, reorderWorkspaces]);

  const trimmedQuery = query.trim().toLowerCase();
  const activeMeta = SECTIONS.find((section) => section.id === sectionId)!;

  /**
   * Where the list was, after touching a setting.
   *
   * Toggling an option halfway down the page sent the list back to the top, and the row that had
   * just been touched ended up off screen — with no way to confirm what had been done. The page
   * does not unmount in that commit, so there is nothing in React putting the position back: it is
   * Chromium's own scroll that is lost, and it is lost by more than one route (the panel's subtree
   * passes through `display:none` on the wheel gesture, and an option that hides the rows below it
   * shrinks the content under the current `scrollTop`). Saving the position and writing it back
   * after every commit covers them all, without depending on knowing which one ran.
   *
   * `useLayoutEffect` with no dependency list: it runs once the DOM is written and BEFORE paint, so
   * the restore is never seen. And a ref, not state: writing on every scroll event cannot cost a
   * render.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  /** Changing section (or entering/leaving search) is another page: that MUST start at the top. */
  const scrollKey = trimmedQuery ? 'search' : sectionId;
  const scrollKeyRef = useRef(scrollKey);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (scrollKeyRef.current !== scrollKey) {
      scrollKeyRef.current = scrollKey;
      scrollTopRef.current = 0;
      element.scrollTop = 0;
      return;
    }
    /** Write only when it has drifted: an equal `scrollTop` would still cancel a smooth scroll. */
    if (element.scrollTop !== scrollTopRef.current) element.scrollTop = scrollTopRef.current;
  });

  /** Search walks every category — searching only the open one forced a guess about where a setting lives. */
  const results = useMemo(() => {
    const matches = (item: SettingItem) =>
      !trimmedQuery || `${item.title} ${item.description ?? ''} ${item.group}`.toLowerCase().includes(trimmedQuery);

    const source = trimmedQuery
      ? SECTIONS.flatMap((section) => sections[section.id].filter(matches))
      : sections[sectionId];

    /** Groups while keeping declaration order: the group is a label, not a card. */
    const groups: Array<{ name: string; items: SettingItem[] }> = [];
    for (const item of source) {
      const last = groups[groups.length - 1];
      if (last && last.name === item.group) last.items.push(item);
      else groups.push({ name: item.group, items: [item] });
    }
    return groups;
  }, [sections, sectionId, trimmedQuery]);

  const isEmpty = results.length === 0;

  /**
   * Which sections hold something the user has changed, so the sidebar stops being five words with
   * nothing behind them.
   *
   * The dot marks a section holding something that no longer matches `DEFAULT_UI_CONFIG` — which is
   * a better answer to "what have I changed here" than a recency stamp would be: it needs no clock,
   * no per-setting timestamp in the config, and it stays true a month later, when "recently" has
   * stopped meaning anything.
   *
   * A row count sat beside it once and was dropped: how many settings a section has is decided by
   * this file, not by the user, so the number read the same on every visit and answered nothing.
   *
   * It reuses exactly what the per-row revert reuses, so a row and its section can never disagree
   * about whether it has been touched.
   */
  const sectionChanged = useMemo(() => {
    const changed = {} as Record<SectionId, boolean>;
    for (const section of SECTIONS) {
      changed[section.id] = (sections[section.id] ?? []).some(
        (row) => row.configKey && !isAtDefault(row.configKey),
      );
    }
    return changed;
  }, [sections, isAtDefault]);

  if (!isOpen) return null;

  return (
    <div
      id="settings-container"
      className={`zs-shell${isDismissing ? ' is-dismissing' : ''}`}
      data-zn-theme={theme}
    >
      <motion.section
        className={`zs-window${isSidebarCollapsed ? ' is-sidebar-collapsed' : ''}${searchForced ? ' is-search-forced' : ''}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
        aria-label="Rovyl Settings"
      >
        <aside className="zs-sidebar">
          <div className="zs-sidebar-head">
            <h2>Settings</h2>
          </div>

          <div className="zs-search">
            <Search size={14} strokeWidth={1.9} />
            <input
              id="zs-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              /** The rail comes back only if nothing was searched for; a query keeps its own box. */
              onBlur={() => { if (!query.trim()) setSearchForced(false); }}
              placeholder="Search"
              aria-label="Search settings"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>

          <nav className="zs-nav" aria-label="Settings sections">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={!trimmedQuery && sectionId === section.id ? 'is-active' : ''}
                  aria-current={!trimmedQuery && sectionId === section.id ? 'page' : undefined}
                  onClick={() => { setSectionId(section.id); setQuery(''); }}
                >
                  <Icon size={15} strokeWidth={1.8} />
                  <span className="zs-nav-label">{section.label}</span>
                  {/*
                    The dot is deliberately not a `span`: the collapse rule above takes those away
                    with the label, and this is the half that still reads on a 60px rail.
                  */}
                  {sectionChanged[section.id] && (
                    <i className="zs-nav-dot" role="img" aria-label="Changed from default" title="Changed from default" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="zs-sidebar-foot">
            {/* The mark rides with the name so the foot reads as the app signing itself, not as a stray label. */}
            <span className="zs-sidebar-brand">
              <RovylLogo size={13} color="currentColor" />
              <b>Rovyl</b>
            </span>
            {appVersion && <span>{appVersion}</span>}
          </div>
        </aside>

        <main className="zs-main">
          <div
            className="zs-scroll"
            ref={scrollRef}
            onScroll={(event) => {
              /**
               * Only what someone actually scrolled. A box with no height is the panel coming back
               * from `display:none` with `scrollTop` already lost — recording that zero would be
               * recording exactly what this pair of refs exists to undo.
               */
              if (event.currentTarget.clientHeight === 0) return;
              scrollTopRef.current = event.currentTarget.scrollTop;
            }}
          >
            <div className="zs-canvas">
              <motion.header
                className="zs-page-head"
                key={`head-${trimmedQuery ? 'search' : sectionId}`}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                <h1>{trimmedQuery ? 'Results' : activeMeta.label}</h1>
                <p>{trimmedQuery ? `Settings matching “${query.trim()}”.` : activeMeta.caption}</p>
              </motion.header>

              {isEmpty ? (
                <p className="zs-empty">No settings found.</p>
              ) : (
                <motion.div
                  key={`body-${trimmedQuery ? `q-${trimmedQuery}` : sectionId}`}
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  {/*
                    Only on Appearance, and only outside search. Every setting it answers to lives
                    in this section, and a search result set is a list of rows from anywhere — a
                    wheel drawn over it would be illustrating settings that are not on screen.
                  */}
                  {sectionId === 'appearance' && !trimmedQuery && (
                    <WheelPreview config={config} apps={previewApps} />
                  )}
                  {results.map((group) => (
                    <section className="zs-group" key={group.name}>
                      <h2 className="zs-group-title">{group.name}</h2>
                      {group.name === 'Your workspaces' && !trimmedQuery ? (
                        /** Outside search the grid rules; while searching, the rows go on giving results. */
                        <WorkspaceCards
                          workspaces={config.workspaces}
                          activeIndex={config.activeWorkspaceIndex ?? 0}
                          onOpen={(index) => setEditor({ kind: 'workspace', index })}
                          onCreate={addWorkspace}
                          onReorder={reorderWorkspaces}
                          onDelete={deleteWorkspace}
                        />
                      ) : (
                        <div className="zs-rows">
                          {group.items.map((item) => (
                            <SettingRow
                              key={item.key}
                              item={item}
                              /**
                               * Derived here rather than in each row's definition: one rule for
                               * seventeen rows, and a row that stops matching `DEFAULT_UI_CONFIG`
                               * cannot go on claiming it is at its default.
                               */
                              onResetToDefault={
                                item.configKey && !isAtDefault(item.configKey)
                                  ? () => {
                                      const key = item.configKey as keyof UIConfig;
                                      update(key, DEFAULT_UI_CONFIG[key]);
                                      if (key === 'openAtLogin') {
                                        window.electron?.setLoginItemSettings?.({
                                          openAtLogin: Boolean(DEFAULT_UI_CONFIG.openAtLogin),
                                        });
                                      }
                                    }
                                  : undefined
                              }
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </motion.div>
              )}
            </div>
          </div>
        </main>

        <AnimatePresence>
          {editor && (
            <SettingsEditor
              editor={editor}
              close={() => setEditor(null)}
              config={config}
              update={update}
              updateWorkspace={updateWorkspace}
              deleteWorkspace={deleteWorkspace}
              showToast={showToast}
              discoveryPhase={discoveryPhase}
              setConfig={setConfig}
              apps={apps}
              gameMode={gameMode}
              updateGameMode={updateGameMode}
              onCloseSettings={dismissWithFade}
              reduceMotion={Boolean(reduceMotion)}
              focusAppId={focusAppId}
              onFocusApplied={() => setFocusAppId(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.seq}
              className={`zs-toast${toast.undo ? ' has-action' : ''}`}
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              onMouseEnter={() => setToastHeld(true)}
              onMouseLeave={() => setToastHeld(false)}
              onFocusCapture={() => setToastHeld(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setToastHeld(false);
              }}
            >
              {toast.undo ? <Undo2 size={13} strokeWidth={2.2} /> : <Check size={13} strokeWidth={2.2} />}
              <span className="zs-toast-text">{toast.message}</span>
              {toast.undo && (
                <button
                  type="button"
                  className="zs-toast-action"
                  /** Closing here and not in each undo: a toast still offering what it just did is
                      an invitation to press it twice, and every undo would have to remember. */
                  onClick={() => { toast.undo?.(); setToast(null); setToastHeld(false); }}
                >Undo</button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>
    </div>
  );
};

/** One row, one structure: copy on the left, control aligned right. */
function SettingRow({
  item,
  onResetToDefault,
}: {
  item: SettingItem;
  /** Present only while the row differs from `DEFAULT_UI_CONFIG`; absent is "nothing to revert". */
  onResetToDefault?: () => void;
}) {
  const ActionIcon = item.actionIcon;
  const describedBy = item.description ? `${item.key}-desc` : undefined;
  const reorderable = typeof item.reorderIndex === 'number' && Boolean(item.onReorder);
  /** Edge under the cursor: decides whether the dropped item lands before or after this row. */
  const [dropEdge, setDropEdge] = useState<'above' | 'below' | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  /** Only a grab on the handle drags: a whole draggable row stole the click that opens it. */
  const [armed, setArmed] = useState(false);
  /**
   * Armed only while the user is looking at it. A row left holding "Erase everything" is a mine
   * for whoever scrolls past it later, so the question withdraws itself after ten seconds.
   */
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 10000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const dragProps = reorderable
    ? {
        draggable: armed,
        onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
          event.dataTransfer.setData('text/plain', String(item.reorderIndex));
          event.dataTransfer.effectAllowed = 'move';
          setIsDragging(true);
        },
        onDragEnd: () => {
          setIsDragging(false);
          setDropEdge(null);
          setArmed(false);
        },
        onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          setDropEdge(event.clientY < rect.top + rect.height / 2 ? 'above' : 'below');
        },
        onDragLeave: () => setDropEdge(null),
        onDrop: (event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          const from = Number(event.dataTransfer.getData('text/plain'));
          const edge = dropEdge;
          setDropEdge(null);
          setIsDragging(false);
          if (!Number.isInteger(from)) return;
          const target = item.reorderIndex as number;
          item.onReorder?.(from, edge === 'below' ? target + 1 : target);
        },
      }
    : {};

  return (
    <div
      className={`zs-row${item.kind === 'range' ? ' is-slider' : ''}${item.kind === 'open' ? ' is-openable' : ''}`
        + `${reorderable ? ' is-reorderable' : ''}${isDragging ? ' is-dragging' : ''}`
        + `${dropEdge === 'above' ? ' is-drop-above' : ''}${dropEdge === 'below' ? ' is-drop-below' : ''}`}
      onClick={item.kind === 'open' ? item.onOpen : undefined}
      {...dragProps}
    >
      {reorderable && (
        <span
          className="zs-row-grip"
          aria-hidden="true"
          onPointerDown={() => setArmed(true)}
          onPointerUp={() => setArmed(false)}
        >
          <GripVertical size={14} strokeWidth={1.9} />
        </span>
      )}
      <div className="zs-row-copy">
        <b id={`${item.key}-label`}>{item.title}</b>
        {item.description && <small id={describedBy}>{item.description}</small>}
      </div>

      <div className="zs-row-control" onClick={(event) => event.stopPropagation()}>
        {/*
          Ahead of the control, and the slot stays even when the button does not.

          The button used to be appended after the control, in a flex box aligned to the right: it
          did not sit beside the switch, it PUSHED it: the first click on a toggle grew the row's
          right edge by a button and the switch slid left, out from under the pointer that had just
          hit it. A reserved column costs the same 26px on every row and never moves anything.
        */}
        <span className="zs-row-revert-slot">
          {onResetToDefault && (
            <button
              type="button"
              className="zs-row-revert"
              onClick={onResetToDefault}
              aria-label={`Reset ${item.title} to default`}
              title="Reset to default"
            >
              <RotateCcw size={13} strokeWidth={1.9} />
            </button>
          )}
        </span>

        {item.kind === 'bool' && (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(item.enabled)}
            aria-labelledby={`${item.key}-label`}
            aria-describedby={describedBy}
            className="zs-switch"
            onClick={item.onToggle}
          >
            <i />
          </button>
        )}

        {item.kind === 'segmented' && (
          <div className="zs-segmented" role="radiogroup" aria-labelledby={`${item.key}-label`}>
            {item.choices?.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={item.current === choice.value}
                className={item.current === choice.value ? 'is-selected' : ''}
                onClick={() => item.onChange?.(choice.value)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}

        {item.kind === 'range' && <span className="zs-readout">{item.value}</span>}

        {item.kind === 'color' && <ColorSettingControl item={item} describedBy={describedBy} />}

        {item.kind === 'open' && (
          <>
            <button type="button" className="zs-btn is-value" onClick={item.onOpen} aria-labelledby={`${item.key}-label`}>
              <b>{item.value}</b>
              <ChevronRight size={14} strokeWidth={1.9} />
            </button>
            {item.onDelete && (
              <button
                type="button"
                className="zs-btn is-delete-icon"
                onClick={item.onDelete}
                aria-label={item.deleteLabel || `Delete ${item.title}`}
                title={item.deleteLabel || `Delete ${item.title}`}
              >
                <Trash2 size={14} strokeWidth={1.9} />
              </button>
            )}
          </>
        )}

        {item.kind === 'action' && !item.confirm && (
          <button
            type="button"
            className="zs-btn"
            onClick={item.onRun}
            disabled={item.actionDisabled}
            aria-labelledby={`${item.key}-label`}
          >
            {ActionIcon && <ActionIcon size={14} strokeWidth={1.9} />}
            {item.actionLabel}
          </button>
        )}

        {item.kind === 'action' && item.confirm && !confirming && (
          <button
            type="button"
            className="zs-btn"
            onClick={() => setConfirming(true)}
            aria-labelledby={`${item.key}-label`}
          >
            {ActionIcon && <ActionIcon size={14} strokeWidth={1.9} />}
            {item.actionLabel}
          </button>
        )}

        {item.kind === 'action' && item.confirm && confirming && (
          <div className="zs-confirm-actions">
            <button type="button" className="zs-btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="zs-btn is-danger" onClick={item.onRun}>{item.confirm.cta}</button>
          </div>
        )}
      </div>

      {/* Under the row, not over it: what it says is the reason the second press exists. */}
      {item.kind === 'action' && item.confirm && confirming && (
        <p className="zs-confirm-body" role="alert">
          <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
          <span>{item.confirm.body}</span>
        </p>
      )}

      {item.kind === 'range' && (
        <div className="zs-slider">
          <span className="zs-slider-bounds">{item.format?.(item.min ?? 0)}</span>
          <input
            type="range"
            min={item.min}
            max={item.max}
            step={item.step}
            value={item.raw}
            aria-labelledby={`${item.key}-label`}
            aria-describedby={describedBy}
            onChange={(event) => item.onChange?.(Number(event.target.value))}
          />
          <span className="zs-slider-bounds">{item.format?.(item.max ?? 0)}</span>
        </div>
      )}
    </div>
  );
}

function normalizeHexInput(value: string): string | null {
  const hex = value.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

function ColorSettingControl({ item, describedBy }: { item: SettingItem; describedBy?: string }) {
  const normalizedValue = normalizeHexInput(item.value ?? '') ?? '#FFFFFF';
  const [draft, setDraft] = useState(normalizedValue.slice(1));

  useEffect(() => setDraft(normalizedValue.slice(1)), [normalizedValue]);

  const commit = (value: string) => {
    const normalized = normalizeHexInput(value);
    if (normalized) item.onChange?.(normalized);
  };

  return (
    <div className="zs-color-control">
      <label className="zs-color-swatch" title="Open color palette">
        <span style={{ backgroundColor: normalizedValue }} />
        <input
          type="color"
          value={normalizedValue}
          aria-labelledby={`${item.key}-label`}
          aria-describedby={describedBy}
          onInput={(event) => commit((event.currentTarget as HTMLInputElement).value)}
          onChange={(event) => commit(event.target.value)}
        />
      </label>
      <span className="zs-color-prefix">#</span>
      <input
        className="zs-color-hex"
        value={draft}
        maxLength={6}
        inputMode="text"
        spellCheck={false}
        aria-label="Hex color"
        onChange={(event) => {
          const next = event.target.value
            .replace(/^#/, '')
            .replace(/[^0-9a-f]/gi, '')
            .slice(0, 6);
          setDraft(next);
          commit(next);
        }}
        onBlur={() => setDraft(normalizedValue.slice(1))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(draft);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

type ProtectedAppRow = { raw: string; label: string; tokens: string[] };

function parseProtectedApps(value: string): ProtectedAppRow[] {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean).map((raw) => {
    const separator = raw.indexOf('::');
    const matchPart = separator >= 0 ? raw.slice(0, separator).trim() : raw;
    const label = separator >= 0 ? raw.slice(separator + 2).trim() || matchPart : matchPart;
    return { raw, label, tokens: matchPart.split('|').map((token) => token.trim().toLowerCase()).filter(Boolean) };
  });
}

function protectedAppSegment(app: InstalledApp): ProtectedAppRow | null {
  const source = String(app.Path || '').trim();
  const label = String(app.DisplayName || app.Name || '').replace(/[,:|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!source || !label) return null;

  const base = source.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() || source.toLowerCase();
  let primary = base;
  if (!primary.endsWith('.exe')) {
    const head = primary.split(/\s+/)[0];
    const dotted = head.split('.').filter((part) => /^[a-z0-9]+$/i.test(part));
    primary = dotted.length > 1 ? `${dotted[dotted.length - 1]}.exe` : primary;
  }

  const tokens = new Set<string>([primary]);
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
  for (const word of words) tokens.add(word);
  const joined = words.join('');
  if (joined.length >= 5) tokens.add(joined);
  const matchPart = [...tokens].join('|');
  return { raw: `${matchPart}::${label}`, label, tokens: [...tokens] };
}

function ProtectedAppsManager({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { apps, loading, error, reload } = useInstalledApps(true);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(40);
  const rows = useMemo(() => parseProtectedApps(value), [value]);
  const selectedTokens = useMemo(() => new Set(rows.flatMap((row) => row.tokens)), [rows]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return apps.filter((item) => !term || `${item.DisplayName || ''} ${item.Name || ''}`.toLowerCase().includes(term));
  }, [apps, search]);
  useEffect(() => setVisibleCount(40), [search, apps]);

  const commit = (next: ProtectedAppRow[]) => onChange(next.map((row) => row.raw).join(', '));
  const add = (app: InstalledApp) => {
    const next = protectedAppSegment(app);
    if (!next || next.tokens.some((token) => selectedTokens.has(token))) return;
    commit([...rows, next]);
  };

  return (
    <div className="zs-workspace-manager">
      <section className="zs-workspace-shortcuts">
        <div className="zs-workspace-section-head">
          <div><h3>Selected applications</h3></div>
        </div>
        <div className="zs-workspace-items">
          {rows.map((row) => (
            <div className="zs-workspace-item" key={row.raw}>
              <div className="zs-workspace-item-main">
                <span className="zs-workspace-app-icon"><Monitor size={16} /></span>
                <div className="zs-workspace-item-copy"><b>{row.label}</b><small><em>Protected in fullscreen</em></small></div>
                <div className="zs-item-actions">
                  <button type="button" onClick={() => commit(rows.filter((item) => item.raw !== row.raw))} aria-label={`Remove ${row.label}`}><Trash2 size={13} /></button>
                </div>
              </div>
            </div>
          ))}
          {!rows.length && <div className="zs-manager-empty"><Monitor size={18} /> No applications selected yet.</div>}
        </div>
      </section>

      <section className="zs-workspace-shortcuts">
        <div className="zs-add-panel-head">
          <label className="zs-search is-manager-search">
            <Search size={14} />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search installed applications" />
          </label>
          <button type="button" className="zs-btn" onClick={() => reload(true)}>Reload</button>
        </div>
        <div
          className="zs-installed-apps"
          onScroll={(event) => {
            const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
            if (scrollHeight - scrollTop - clientHeight < 180) setVisibleCount((count) => Math.min(count + 40, filtered.length));
          }}
        >
          {loading ? (
            <div className="zs-manager-empty"><Loader2 className="zs-spin" size={18} /> Loading applications…</div>
          ) : filtered.length ? (
            filtered.slice(0, visibleCount).map((item, index) => {
              const segment = protectedAppSegment(item);
              const selected = !!segment?.tokens.some((token) => selectedTokens.has(token));
              return (
                <button type="button" key={`${item.Path}-${index}`} disabled={selected} onClick={() => add(item)}>
                  <NativeAppIcon path={item.Path} size={28} className="zs-installed-app-icon" fallback={<Monitor size={15} />} />
                  <div><b>{item.DisplayName || item.Name}</b><small>{selected ? 'Already selected' : 'Installed application'}</small></div>
                  {selected ? <Check size={14} /> : <Plus size={14} />}
                </button>
              );
            })
          ) : error ? (
            <div className="zs-manager-empty">Could not list applications.<button type="button" className="zs-btn" onClick={() => reload(true)}>Try again</button></div>
          ) : (
            <div className="zs-manager-empty">No applications found.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsEditor({
  editor,
  close,
  config,
  update,
  updateWorkspace,
  deleteWorkspace,
  showToast,
  discoveryPhase,
  setConfig,
  apps,
  gameMode,
  updateGameMode,
  onCloseSettings,
  reduceMotion,
  focusAppId,
  onFocusApplied,
}: {
  editor: Exclude<Editor, null>;
  close: () => void;
  config: UIConfig;
  update: <K extends keyof UIConfig>(key: K, value: UIConfig[K]) => void;
  updateWorkspace: WorkspaceUpdater;
  /** The one delete: it renumbers the positional hotkeys and offers the workspace back. */
  deleteWorkspace: (index: number) => void;
  showToast: (message: string, undo?: () => void) => void;
  discoveryPhase: 'idle' | 'waiting' | 'scanning';
  setConfig: PrecisionSettingsProps['setConfig'];
  apps: AppItem[];
  gameMode: UIConfig['gameMode'];
  updateGameMode: (patch: Partial<UIConfig['gameMode']>) => void;
  /** Activating the license closes the panel: the user came to unlock the wheel, not to configure. */
  onCloseSettings?: () => void;
  reduceMotion: boolean;
  /** A shortcut a launch failure asked to have open. Consumed once, then reported back. */
  focusAppId?: string | null;
  onFocusApplied?: () => void;
}) {
  let title = 'Edit setting';
  let description = 'Changes are applied immediately.';
  let content: React.ReactNode = null;

  if (editor.kind === 'shortcut') {
    title = 'Global shortcut';
    description = 'Record a combination that does not conflict with your applications.';
    content = (
      <ShortcutRecorder
        value={config.globalShortcut}
        onChange={(next) => update('globalShortcut', next)}
        config={config}
      />
    );
  }

  if (editor.kind === 'blocked') {
    title = 'Protected applications';
    description = 'Choose installed applications; Rovyl handles process matching automatically.';
    content = (
      <ProtectedAppsManager
        value={gameMode.blockedApps}
        onChange={(blockedApps) => updateGameMode({ blockedApps })}
      />
    );
  }


  if (editor.kind === 'workspace') {
    const index = editor.index;
    const workspace = config.workspaces[index];
    if (!workspace) return null;
    title = workspace.name;
    description = 'Organize shortcuts and control how this workspace behaves.';
    content = (
      <WorkspaceManager
        workspace={workspace}
        workspaceIndex={index}
        isActive={config.activeWorkspaceIndex === index}
        canDelete={config.workspaces.length > 1}
        focusAppId={focusAppId}
        onFocusApplied={onFocusApplied}
        showToast={showToast}
        selectionMode={config.radialSelectionMode}
        discoveryPhase={discoveryPhase}
        updateWorkspace={updateWorkspace}
        makeActive={() => update('activeWorkspaceIndex', index)}
        /**
         * The same delete as the list's, and it was not before. This branch filtered the array
         * inline and skipped `withPositionalHotkeys`, so removing anything but the last workspace
         * left the survivors holding their old numbers — key 1 bound to nothing, key 3 opening
         * what had become the second workspace. Two paths, one of them wrong; now one path.
         */
        deleteWorkspace={() => deleteWorkspace(index)}
      />
    );
  }

  return (
    <div className="zs-editor-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <motion.div
        className={`zs-editor${editor.kind === 'workspace' || editor.kind === 'blocked' ? ' is-workspace' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985, y: 4 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" onClick={close} aria-label="Close">
            <X size={15} strokeWidth={1.9} />
          </button>
        </header>
        <div className="zs-editor-body">{content}</div>
        <footer>
          <button type="button" className="zs-btn is-primary" onClick={close}>Done</button>
        </footer>
      </motion.div>
    </div>
  );
}


type WorkspaceAddMode = 'app' | 'url' | 'folder' | null;

const APPS_PAGE_SIZE = 40;

function itemTypeLabel(item: AppItem) {
  if (item.type === 'folder') return 'Group';
  if (item.commandType === 'url') return 'URL';
  if (item.commandType === 'folder') return 'Folder';
  return 'Application';
}

/**
 * Cheap guess, used only while main has not answered and outside Electron. It does not decide on
 * its own: `electron.app.Antigravity` (the agent, with no recent projects) contains "antigravity"
 * and would pass for an IDE. `useIdeRecentsSupport` decides, by asking main whether a profile
 * really exists.
 */
function isIdeApp(item: Pick<AppItem, 'label' | 'command' | 'commandType'>): boolean {
  if (item.commandType !== 'app') return false;
  const label = (item.label || '').trim().toLowerCase();
  const value = `${label} ${item.command || ''}`.toLowerCase();
  const keywords = [
    'visual studio code', 'visualstudiocode', 'visual studio', 'vscode', 'code.exe', 'cursor', 'antigravity', 'windsurf',
    'intellij', 'webstorm', 'pycharm', 'phpstorm', 'rider', 'clion', 'goland',
    'android studio', 'sublime text', 'atom.exe', 'zed.exe',
  ];
  return label === 'code' || keywords.some((keyword) => value.includes(keyword));
}


/** Stable key per item: the profile depends on the label + command pair. */
function ideProbeKey(item: Pick<AppItem, 'label' | 'command'>): string {
  return `${item.label || ''}||${item.command || ''}`;
}

/**
 * Asks main, for each candidate item, whether an IDE profile with an MRU really exists. The result
 * is `undefined` until the answer arrives — in that window the local guess stands, so the section
 * does not flicker when settings open.
 */
function useIdeRecentsSupport(items: AppItem[]): Map<string, boolean> {
  const [support, setSupport] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    const probe = window.electron?.appSupportsRecents;
    if (!probe) return;
    let cancelled = false;

    const pending = items.filter((item) => item.commandType === 'app' && !support.has(ideProbeKey(item)));
    if (pending.length === 0) return;

    void Promise.all(
      pending.map(async (item) => {
        try {
          return [ideProbeKey(item), await probe(item.label || '', item.command || '')] as const;
        } catch (e) {
          return [ideProbeKey(item), false] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSupport((current) => {
        const next = new Map(current);
        entries.forEach(([key, value]) => next.set(key, value));
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [items, support]);

  return support;
}


/**
 * The real risks of each launch mode. `Normal` has no note: a warning in every state stops being
 * a warning. The other two change how Windows behaves and can surprise — saying so beforehand is
 * worth more than explaining afterwards.
 */
function launchModeRisk(commandType: AppItem['commandType'], mode: 'normal' | 'reuse' | 'prewarm'): string | null {
  if (mode === 'normal') return null;
  if (mode === 'reuse') {
    return commandType === 'url'
      ? 'Reuses the browser already running: the page can land in an existing window or tab group instead of a new one, and profile or private windows may be ignored.'
      : 'Reuses the process already running: an IDE can switch the project open in the current window instead of opening another. Apps without support fall back to a normal launch.';
  }
  return 'Keeps executable data in memory, so RAM stays in use in the background even after you close the app. Some apps show a splash or a second instance when reused, and unsupported ones fall back to a normal launch.';
}

/**
 * Whether an application's launch line is worth showing the user — i.e. whether it is a path.
 *
 * The row deliberately hides an application's command, because for a Store app it is an AUMID
 * (`Microsoft.WindowsTerminal_8wekyb3d8bbwe!App`) that tells nobody anything. That reasoning does
 * not extend to `D:\Tools\thing.exe`: there the command is the target, and when a launch fails
 * because the file moved, editing it is the whole repair. So the field appears for path-like
 * commands only, and AUMIDs stay hidden as before.
 */
function isPathLikeCommand(command: string): boolean {
  const value = (command || '').trim().replace(/^"([\s\S]*)"$/, '$1');
  if (!value) return false;
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    /\.(exe|lnk|bat|cmd|com)(\s|$)/i.test(value)
  );
}

function itemFallbackIcon(item: AppItem) {
  if (item.type === 'folder' || item.commandType === 'folder') return 'Folder';
  if (item.commandType === 'url') return 'Globe';
  return item.iconName || 'AppWindow';
}

/**
 * An item's bitmap icon, falling back to its Lucide glyph when the bitmap will not load.
 *
 * The fallback is not decoration. `customIconUrl` names a file the main process keeps in userData,
 * and there are ordinary ways for the file to be gone — a profile copied by hand, a downgrade to a
 * build that does not serve the scheme, an icon collected while its reference was still in flight.
 * The wheel already handles this (`RadialMenu` swaps to the glyph on `onError`); these two call
 * sites chose between image and glyph in the *parent*, so an image that failed rendered nothing at
 * all rather than the glyph.
 */
function ItemBitmapOrGlyph({
  item,
  className,
  displayScale,
  glyphSize,
  glyphStroke,
}: {
  item: AppItem;
  className: string;
  displayScale: number;
  glyphSize: number;
  glyphStroke: number;
}) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [item.customIconUrl]);
  const Icon = getIcon(itemFallbackIcon(item));
  if (item.customIconUrl && !failed) {
    return (
      <SmartIcon
        src={item.customIconUrl}
        className={className}
        displayScale={displayScale}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Icon size={glyphSize} strokeWidth={glyphStroke} />;
}

function WorkspaceItemIcon({ item }: { item: AppItem }) {
  return (
    <span className="zs-workspace-app-icon" aria-hidden>
      <ItemBitmapOrGlyph
        item={item}
        className="zs-workspace-native-icon"
        displayScale={0.78}
        glyphSize={17}
        glyphStroke={1.8}
      />
    </span>
  );
}


/**
 * A workspace preview: the wheel in miniature, with the real icons in the real positions.
 *
 * The list was an inventory — "Main · 5 shortcuts · key 1" — describing something spatial. It did
 * not say what the workspace is, nor how it will look, and it made the order of the shortcuts
 * invisible, which was precisely what made being able to reorder them mean anything.
 */
function WorkspaceWheelPreview({ workspace, accent }: { workspace: Workspace; accent: string }) {
  const items = workspace.apps.slice(0, 8);
  const radius = 34;
  return (
    <div className="zs-ws-preview" aria-hidden>
      <span className="zs-ws-preview-ring" style={{ borderColor: `${accent}44` }} />
      <span className="zs-ws-preview-hub" style={{ background: accent }} />
      {items.map((item, index) => {
        const angle = ((index * (360 / items.length)) - 90) * (Math.PI / 180);
        return (
          <span
            key={item.id}
            className="zs-ws-preview-slot"
            style={{
              transform: `translate(${(radius * Math.cos(angle)).toFixed(1)}px, ${(radius * Math.sin(angle)).toFixed(1)}px)`,
            }}
          >
            <ItemBitmapOrGlyph
              item={item}
              className="zs-ws-preview-img"
              displayScale={0.82}
              glyphSize={12}
              glyphStroke={1.9}
            />
          </span>
        );
      })}
      {workspace.apps.length === 0 && <span className="zs-ws-preview-empty">empty</span>}
    </div>
  );
}

function WorkspaceCards({
  workspaces,
  activeIndex,
  onOpen,
  onCreate,
  onReorder,
  onDelete,
}: {
  workspaces: Workspace[];
  activeIndex: number;
  onOpen: (index: number) => void;
  onCreate: () => void;
  onReorder: (from: number, insertBefore: number) => void;
  onDelete: (index: number) => void;
}) {
  /**
   * In a grid the WHOLE card is the thing you pick up — there is no handle.
   *
   * In the list the handle was needed because the row has other targets along its width and
   * dragging over them stole their click. A card is a single object, like an icon on a home
   * screen: it is picked up wherever it is touched.
   */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<{ index: number; edge: 'before' | 'after' } | null>(null);

  const endDrag = () => {
    setDragIndex(null);
    setDropEdge(null);
  };

  return (
    <div className="zs-ws-grid">
      {workspaces.map((workspace, index) => {
        const accent = workspace.color || 'currentColor';
        const isCurrent = index === activeIndex;
        return (
          <div
            key={workspace.id}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onOpen(index);
            }}
            className={`zs-ws-card${isCurrent ? ' is-current' : ''}${workspace.enabled ? '' : ' is-paused'}`
              + `${dragIndex === index ? ' is-dragging' : ''}`
              + `${dropEdge?.index === index && dropEdge.edge === 'before' ? ' is-drop-before' : ''}`
              + `${dropEdge?.index === index && dropEdge.edge === 'after' ? ' is-drop-after' : ''}`}
            onClick={() => onOpen(index)}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', String(index));
              event.dataTransfer.effectAllowed = 'move';
              setDragIndex(index);
            }}
            onDragEnd={endDrag}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              /** Grid: the cards flow horizontally, so the edge is decided on the X axis. */
              const rect = event.currentTarget.getBoundingClientRect();
              setDropEdge({
                index,
                edge: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
              });
            }}
            onDragLeave={() => setDropEdge((current) => (current?.index === index ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              const from = Number(event.dataTransfer.getData('text/plain'));
              const edge = dropEdge?.index === index ? dropEdge.edge : 'before';
              endDrag();
              if (!Number.isInteger(from)) return;
              onReorder(from, edge === 'after' ? index + 1 : index);
            }}
          >
            <WorkspaceWheelPreview workspace={workspace} accent={accent} />
            <span className="zs-ws-card-head">
              <b>{workspace.name}</b>
              {workspace.hotkey ? <em>{workspace.hotkey}</em> : null}
            </span>
            {/*
              Only the states worth saying. A tally of shortcuts sat here, read off a thumbnail
              that already draws every one of them — so the line is now empty, and gone, on a
              workspace that is simply available.
            */}
            {(isCurrent || !workspace.enabled) && <small>{isCurrent ? 'Current' : 'Paused'}</small>}
            {workspaces.length > 1 && (
              <button
                type="button"
                className="zs-ws-card-delete"
                aria-label={`Delete ${workspace.name}`}
                title={`Delete ${workspace.name}`}
                onClick={(event) => {
                  /** The whole card opens the editor; this button must not fire that as well. */
                  event.stopPropagation();
                  onDelete(index);
                }}
              >
                <Trash2 size={13} strokeWidth={1.9} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="zs-ws-card is-new" onClick={onCreate}>
        <Plus size={18} strokeWidth={1.9} />
        <small>New workspace</small>
      </button>
    </div>
  );
}

function WorkspaceManager({
  workspace,
  workspaceIndex,
  isActive,
  canDelete,
  updateWorkspace,
  makeActive,
  deleteWorkspace,
  focusAppId,
  onFocusApplied,
  showToast,
  selectionMode,
  discoveryPhase,
}: {
  workspace: Workspace;
  workspaceIndex: number;
  isActive: boolean;
  canDelete: boolean;
  updateWorkspace: WorkspaceUpdater;
  makeActive: () => void;
  deleteWorkspace: () => void;
  /** Set when the user clicked "Fix shortcut" on a failed launch: expand that row and show it. */
  focusAppId?: string | null;
  onFocusApplied?: () => void;
  showToast: (message: string, undo?: () => void) => void;
  /** Direction vs pointer changes what a crowded wheel actually costs, so the warning needs it. */
  selectionMode: UIConfig['radialSelectionMode'];
  discoveryPhase: 'idle' | 'waiting' | 'scanning';
}) {
  const [addMode, setAddMode] = useState<WorkspaceAddMode>(null);
  const { apps: installedApps, loading: loadingApps, error: appsError, reload: loadInstalledApps } =
    useInstalledApps(addMode === 'app');
  const [appSearch, setAppSearch] = useState('');
  const [url, setUrl] = useState('');
  const [urlLabel, setUrlLabel] = useState('');
  /** Once a name has been typed, the page's own title stops overwriting it. */
  const [urlLabelTyped, setUrlLabelTyped] = useState(false);
  const [urlTitleLoading, setUrlTitleLoading] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderLabel, setFolderLabel] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  /**
   * The row a failed launch asked for: expanded, and scrolled to.
   *
   * By id, because the index is not stable — the card can sit on screen while the list is
   * reordered. If the id is gone (deleted between the failure and the click) the workspace simply
   * stays open, which is still where the user needs to be.
   */
  useEffect(() => {
    if (!focusAppId) return;
    const index = workspace.apps.findIndex((item) => item.id === focusAppId);
    if (index >= 0) {
      setEditingIndex(index);
      /** After paint: the row is only tall enough to be worth centring once its editor is in it. */
      requestAnimationFrame(() => {
        itemRefs.current.get(focusAppId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
    onFocusApplied?.();
  }, [focusAppId, workspace.apps, onFocusApplied]);

  /** A modal that only closes with the mouse is a modal that traps whoever uses the keyboard. */
  useEffect(() => {
    if (!isIconPickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      /** Do not let Escape bubble up and close the workspace editor underneath. */
      event.stopPropagation();
      setIsIconPickerOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isIconPickerOpen]);
  const WorkspaceIcon = getIcon(workspace.pickerIconName?.trim() || 'Layers');

  const addItem = (item: AppItem, openEditor = false) => {
    const newIndex = workspace.apps.length;
    updateWorkspace(workspaceIndex, { apps: [...workspace.apps, item] });
    setAddMode(null);
    setAppSearch('');
    setUrl('');
    setUrlLabel('');
    setUrlLabelTyped(false);
    setUrlTitleLoading(false);
    setFolderPath('');
    setFolderLabel('');
    setEditingIndex(openEditor ? newIndex : null);
  };

  const addAppPath = async (path: string, label?: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    const displayName = label?.trim() || cleanPath.split(/[/\\]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, '') || 'Application';
    let customIconUrl: string | undefined;
    try { customIconUrl = (await window.electron?.getFileIcon?.(cleanPath)) || undefined; } catch { /* use fallback */ }
    const nextItem: AppItem = {
      id: crypto.randomUUID(), type: 'app', label: displayName,
      iconName: 'AppWindow', iconSource: customIconUrl ? 'native' : 'lucide', customIconUrl,
      command: cleanPath, commandType: 'app', description: 'Application',
    };
    /** Main confirms before the flag is saved; the local guess only serves outside Electron. */
    let isIde = isIdeApp(nextItem);
    if (window.electron?.appSupportsRecents) {
      try {
        isIde = await window.electron.appSupportsRecents(nextItem.label, nextItem.command);
      } catch (e) {
        /* keep the local guess */
      }
    }
    addItem(isIde ? { ...nextItem, hasRecents: true, terminalCommands: [] } : nextItem, isIde);
  };

  const chooseAppFile = async () => {
    const path = await window.electron?.selectFile?.();
    if (path) await addAppPath(path);
  };

  /**
   * The Name field promises to fill itself in, so it does it here rather than at the moment of
   * adding: the page's own <title> lands in the field a beat after the address stops changing,
   * where it can still be read and edited before the shortcut exists.
   */
  useEffect(() => {
    if (addMode !== 'url' || urlLabelTyped) return;
    const address = url.trim();
    /** A changed address invalidates the name it produced, so the old title does not linger. */
    setUrlLabel('');
    if (!looksFetchable(address)) {
      setUrlTitleLoading(false);
      return;
    }
    let cancelled = false;
    setUrlTitleLoading(true);
    const timer = window.setTimeout(() => {
      void resolveWebsiteTitle(address).then((title) => {
        if (cancelled) return;
        setUrlTitleLoading(false);
        /** No title is not a name: the field stays empty and `addUrl` falls back to the host. */
        if (title) setUrlLabel(title);
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addMode, url, urlLabelTyped]);

  const addUrl = async () => {
    const normalized = normalizeSiteUrl(url);
    if (!normalized) return;
    const typedLabel = urlLabel.trim();
    /** The icon and the name are two independent fetches; neither should wait on the other. */
    const [icon, title] = await Promise.all([
      resolveWebsiteIconFields(normalized),
      typedLabel ? Promise.resolve(null) : resolveWebsiteTitle(normalized),
    ]);
    addItem({
      id: crypto.randomUUID(), type: 'app',
      label: typedLabel || title || hostLabelFromUrl(normalized),
      iconName: 'Globe', iconSource: icon?.iconSource || 'lucide', customIconUrl: icon?.customIconUrl,
      command: normalized, commandType: 'url', description: 'Web link',
    });
  };

  const chooseFolder = async () => {
    const path = await window.electron?.selectFolder?.();
    if (!path) return;
    setFolderPath(path);
    if (!folderLabel) setFolderLabel(path.split(/[/\\]/).filter(Boolean).pop() || 'Folder');
  };

  const addFolder = () => {
    if (!folderPath) return;
    addItem({
      id: crypto.randomUUID(), type: 'app', label: folderLabel.trim() || 'Folder',
      iconName: 'Folder', iconSource: 'lucide', command: folderPath,
      commandType: 'folder', description: 'Folder shortcut',
    });
  };

  /**
   * Dragging in the shortcut list.
   *
   * The up/down arrows forced a move one item at a time; on a wheel of ten shortcuts, putting the
   * last one first was nine clicks. `insertBefore` refers to the ORIGINAL list: once the source is
   * removed, everything that sat ahead of it shifts one place.
   */
  /**
   * The drag only arms when the gesture starts ON THE HANDLE.
   *
   * With `draggable` fixed on the whole row, any drag over the name or the buttons turned into a
   * reorder, and the ghost Windows draws took the open edit form along with it.
   */
  const [itemDragArmed, setItemDragArmed] = useState<number | null>(null);
  const [itemDragIndex, setItemDragIndex] = useState<number | null>(null);
  const [itemDropEdge, setItemDropEdge] = useState<{ index: number; edge: 'above' | 'below' } | null>(null);

  const reorderItems = (from: number, insertBefore: number) => {
    const apps = [...workspace.apps];
    if (!apps[from]) return;
    const [moved] = apps.splice(from, 1);
    const target = Math.max(0, Math.min(from < insertBefore ? insertBefore - 1 : insertBefore, apps.length));
    if (target === from) return;
    apps.splice(target, 0, moved);
    updateWorkspace(workspaceIndex, { apps });
    /** The open editor follows the item, or it would end up editing the neighbour. */
    if (editingIndex === from) setEditingIndex(target);
    else if (editingIndex !== null) {
      const shifted = editingIndex > from ? editingIndex - 1 : editingIndex;
      setEditingIndex(shifted >= target ? shifted + 1 : shifted);
    }
  };

  const moveItem = (from: number, delta: number) => {
    const to = from + delta;
    if (to < 0 || to >= workspace.apps.length) return;
    const next = [...workspace.apps];
    [next[from], next[to]] = [next[to], next[from]];
    updateWorkspace(workspaceIndex, { apps: next });
    if (editingIndex === from) setEditingIndex(to);
  };

  /** Confirmation from main: only a real IDE profile enables the recents section. */
  const ideSupport = useIdeRecentsSupport(workspace.apps);

  /** The wheel divides 360° by this list; past a point that is a geometry problem, not a taste one. */
  const crowding = useMemo(
    () => radialCrowding(workspace.apps.length, selectionMode),
    [workspace.apps.length, selectionMode],
  );

  /**
   * Remove a shortcut, and keep it for as long as the toast lives.
   *
   * The button did `apps.filter(...)` inline, which lost two things. The item, obviously — a
   * shortcut with a hand-picked icon and a set of automated commands, gone to a click on a 13px
   * target between "move down" and "edit". And the expanded editor's place: `editingIndex` is a
   * position, so deleting a row ABOVE an open one left the editor showing its neighbour, with the
   * name field already focused on the wrong shortcut. Reorder had always adjusted for that; delete
   * never did.
   */
  const removeItem = (index: number) => {
    const item = workspace.apps[index];
    if (!item) return;
    updateWorkspace(workspaceIndex, {
      apps: workspace.apps.filter((_, itemIndex) => itemIndex !== index),
    });
    setEditingIndex((current) => {
      if (current === null) return current;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
    showToast(`Removed “${item.label}”`, () => {
      updateWorkspace(workspaceIndex, (current) => {
        /** Already back — undone twice, or re-added by hand. Adding it again would duplicate it. */
        if (current.apps.some((existing) => existing.id === item.id)) return {};
        const apps = [...current.apps];
        apps.splice(Math.min(index, apps.length), 0, item);
        return { apps };
      });
    });
  };

  const updateItem = (index: number, patch: Partial<AppItem>) => {
    updateWorkspace(workspaceIndex, {
      apps: workspace.apps.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    });
  };

  /**
   * Self-correction: items saved as IDEs before this check existed (the Antigravity agent, for
   * example) would go on forever asking for recents that are not there. As soon as main confirms
   * there is no profile, the flag leaves the config.
   */
  useEffect(() => {
    const stale = workspace.apps
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.hasRecents && ideSupport.get(ideProbeKey(item)) === false);
    if (stale.length === 0) return;
    updateWorkspace(workspaceIndex, {
      apps: workspace.apps.map((item) =>
        item.hasRecents && ideSupport.get(ideProbeKey(item)) === false
          ? { ...item, hasRecents: false }
          : item,
      ),
    });
  }, [ideSupport, workspace.apps, workspaceIndex, updateWorkspace]);

  const filteredApps = useMemo(() => {
    const term = appSearch.trim().toLowerCase();
    return installedApps.filter((item) =>
      !term || `${item.DisplayName || ''} ${item.Name || ''}`.toLowerCase().includes(term),
    );
  }, [installedApps, appSearch]);

  // Incremental reveal — the list is 300+ entries on a normal machine and each
  // visible row lazily pulls a native icon.
  const [visibleCount, setVisibleCount] = useState(APPS_PAGE_SIZE);
  useEffect(() => { setVisibleCount(APPS_PAGE_SIZE); }, [appSearch, installedApps]);
  const visibleApps = filteredApps.slice(0, visibleCount);
  const handleAppsScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 180) {
      setVisibleCount((previous) => Math.min(previous + APPS_PAGE_SIZE, filteredApps.length));
    }
  };

  return (
    <div className="zs-workspace-manager">
      <section className="zs-workspace-overview">
        {/**
         * The icon is the column's anchor, not a button stranded beside the field: square, the
         * size of the name block, aligned along the baseline with the input. The meta line below
         * closes the column at the same height as the status block, so neither is left
         * floating with empty space under it.
         */}
        <div className="zs-workspace-identity">
          <button
            type="button"
            className={`zs-workspace-icon-button${isIconPickerOpen ? ' is-active' : ''}`}
            onClick={() => setIsIconPickerOpen((open) => !open)}
            aria-expanded={isIconPickerOpen}
            aria-label="Change workspace icon"
            title="Change icon"
          >
            <WorkspaceIcon size={24} strokeWidth={1.6} />
            <Pencil size={10} strokeWidth={2} />
          </button>
          <label className="zs-workspace-name-field">
            <span>Workspace name</span>
            <input
              value={workspace.name}
              onChange={(event) => updateWorkspace(workspaceIndex, { name: event.target.value })}
            />
          </label>
          {/**
           * The two states live on the SAME identity row.
           *
           * They sat in a block of their own, and since `.zs-workspace-overview` is a flex column,
           * two 32px icons reserved an entire band of the panel's width for themselves.
           *
           * And they carry no `disabled`: Chromium does not deliver mouse events to disabled
           * elements, so the tip never appeared in exactly the cases where it was needed —
           * when the button is inert and the user wants to know why. They stay active, with
           * `aria-disabled`, and the click does nothing.
           */}
          <div className="zs-workspace-flags">
            <button
              type="button"
              role="switch"
              aria-checked={workspace.enabled}
              aria-label="Available on the wheel"
              aria-disabled={isActive}
              className={`zs-flag-btn${workspace.enabled ? ' is-on' : ''}${isActive ? ' is-inert' : ''}`}
              data-tip={
                isActive
                  ? 'Always shown while current'
                  : workspace.enabled
                    ? 'Shown on the wheel — click to hide'
                    : 'Hidden from the wheel — click to show'
              }
              onClick={() => {
                if (isActive) return;
                updateWorkspace(workspaceIndex, { enabled: !workspace.enabled });
              }}
            >
              {workspace.enabled ? <Eye size={15} strokeWidth={1.8} /> : <EyeOff size={15} strokeWidth={1.8} />}
            </button>
            <button
              type="button"
              aria-label="Make current workspace"
              aria-pressed={isActive}
              aria-disabled={isActive}
              className={`zs-flag-btn${isActive ? ' is-on is-inert' : ''}`}
              data-tip={isActive ? 'This is the current workspace' : 'Make this the current workspace'}
              onClick={() => {
                if (isActive) return;
                /** Making it current implies being available — otherwise the result is an impossible state. */
                if (!workspace.enabled) updateWorkspace(workspaceIndex, { enabled: true });
                makeActive();
              }}
            >
              <Check size={15} strokeWidth={2.2} />
            </button>
          </div>
          {/* Past the ninth workspace `withPositionalHotkeys` assigns 0, which is not a key. */}
          {workspace.hotkey ? (
            <p className="zs-workspace-meta"><span>Key {workspace.hotkey}</span></p>
          ) : null}
        </div>
{/**
         * Two states, two icons, two tooltips.
         *
         * They were two rows with a title and a paragraph each — four lines of text explaining two
         * switches, at the top of a screen whose subject is the shortcuts. The text moves into
         * `title`, which only appears to whoever hesitates; whoever knows sees two icons and moves on.
         *
         * They are still distinct controls: a state (available) and an action (make current).
         * The current space cannot be hidden, or the wheel would open in a space the picker
         * does not show — hence the `disabled`.
         */}

      </section>

      {/**
       * The picker stopped growing in the middle of the page.
       *
       * Expanded inline, it pushed the shortcut list down and fought it for the same space —
       * choosing an icon looked like editing the shortcuts. As a modal it owns the screen while
       * it lasts, has a title of its own, and gives the page back intact when it closes.
       */}
      <AnimatePresence>
        {isIconPickerOpen && (
          <motion.div
            className="zs-icon-modal-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={() => setIsIconPickerOpen(false)}
            role="presentation"
          >
            <motion.div
              className="zs-icon-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ws-icon-modal-title"
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              /** A click inside must not close what a click outside closes. */
              onClick={(event) => event.stopPropagation()}
            >
              <header>
                <div>
                  <b id="ws-icon-modal-title">Workspace icon</b>
                  <small>Shown in the wheel picker, and on the workspace card.</small>
                </div>
                <button type="button" onClick={() => setIsIconPickerOpen(false)} aria-label="Close icon picker">
                  <X size={14} />
                </button>
              </header>
              <div className="zs-icon-modal-body">
                <IconPicker
                  selectedIcon={workspace.pickerIconName?.trim() || 'Layers'}
                  onSelect={(iconName) => updateWorkspace(workspaceIndex, { pickerIconName: iconName })}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="zs-workspace-shortcuts">
        <div className="zs-workspace-section-head">
          <div><h3>Shortcuts</h3></div>
          <div className="zs-add-actions" aria-label="Add shortcut">
            <button type="button" className={addMode === 'app' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'app' ? null : 'app')}><Monitor size={14} /> Application</button>
            <button type="button" className={addMode === 'url' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'url' ? null : 'url')}><Globe2 size={14} /> URL</button>
            <button type="button" className={addMode === 'folder' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'folder' ? null : 'folder')}><FolderOpen size={14} /> Folder</button>
          </div>
        </div>

        {/*
          Said where the twenty-first shortcut is added, and only once there are enough for it to
          be true. A note on every workspace is not a warning, it is furniture.
        */}
        {crowding && (
          <p className={`zs-crowding${crowding.severity === 'warning' ? ' is-warning' : ''}`} role="note">
            <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
            <span>{crowding.message}</span>
          </p>
        )}

        <div className={`zs-workspace-workbench${addMode ? ' is-split' : ''}`}>
        <AnimatePresence mode="wait">
          {addMode && (
            <motion.div className="zs-add-panel" key={addMode} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {addMode === 'app' && (
                <>
                  <div className="zs-add-panel-head">
                    <label className="zs-search is-manager-search">
                      <Search size={14} />
                      <input value={appSearch} onChange={(event) => setAppSearch(event.target.value)} placeholder="Search installed applications" />
                    </label>
                    <button type="button" className="zs-btn" onClick={chooseAppFile}><FilePlus2 size={14} /> Choose file</button>
                  </div>
                  <div className="zs-installed-apps" onScroll={handleAppsScroll}>
                    {loadingApps ? (
                      <div className="zs-manager-empty"><Loader2 className="zs-spin" size={18} /> Loading applications…</div>
                    ) : visibleApps.length ? (
                      visibleApps.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.Path}-${index}`}
                          /**
                           * The listed `Path` is an AppID, so it is wrapped as a launch line rather
                           * than stored as one — see `startMenuAppIdToLaunchCommand`.
                           */
                          onClick={() => addAppPath(startMenuAppIdToLaunchCommand(item.Path!), item.DisplayName || item.Name)}
                        >
                          <NativeAppIcon path={item.Path} size={28} className="zs-installed-app-icon" fallback={<Monitor size={15} />} />
                          <div><b>{item.DisplayName || item.Name}</b><small>{item.Path}</small></div>
                          <Plus size={14} />
                        </button>
                      ))
                    ) : appsError ? (
                      <div className="zs-manager-empty">
                        Could not list applications.
                        <button type="button" className="zs-btn" onClick={() => loadInstalledApps(true)}>Try again</button>
                      </div>
                    ) : (
                      <div className="zs-manager-empty">No applications found. Use “Choose file”.</div>
                    )}
                  </div>
                  {!loadingApps && installedApps.length > 0 && (
                    <div className="zs-add-panel-foot">
                      <span>{visibleApps.length} of {filteredApps.length} applications</span>
                      <button type="button" onClick={() => loadInstalledApps(true)}>Reload list</button>
                    </div>
                  )}
                </>
              )}
              {addMode === 'url' && (
                <div className="zs-add-form">
                  <label className="zs-field"><span>Address</span><input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" onKeyDown={(event) => { if (event.key === 'Enter') void addUrl(); }} /></label>
                  <label className="zs-field"><span>Name</span><input value={urlLabel} onChange={(event) => { setUrlLabel(event.target.value); setUrlLabelTyped(true); }} placeholder={urlTitleLoading ? 'Reading the page title…' : 'Filled automatically'} onKeyDown={(event) => { if (event.key === 'Enter') void addUrl(); }} /></label>
                  <button type="button" className="zs-btn is-primary" disabled={!url.trim()} onClick={() => void addUrl()}><Plus size={14} /> Add URL</button>
                </div>
              )}
              {addMode === 'folder' && (
                <div className="zs-add-form">
                  <button type="button" className="zs-folder-picker" onClick={chooseFolder}>
                    <FolderOpen size={20} />
                    <div><b>{folderPath ? folderPath.split(/[/\\]/).filter(Boolean).pop() : 'Select a folder'}</b><small>{folderPath || 'Opens File Explorer'}</small></div>
                    <ChevronRight size={15} />
                  </button>
                  <label className="zs-field"><span>Name</span><input value={folderLabel} onChange={(event) => setFolderLabel(event.target.value)} placeholder="Name shown on the wheel" /></label>
                  <button type="button" className="zs-btn is-primary" disabled={!folderPath} onClick={addFolder}><Plus size={14} /> Add folder</button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="zs-workspace-items">
          {workspace.apps.map((item, index) => {
            /** Main's answer rules; the local guess only covers the wait and the web mode. */
            const confirmed = ideSupport.get(ideProbeKey(item));
            const isIde = confirmed ?? isIdeApp(item);
            return (
            <div
              className={`zs-workspace-item${editingIndex === index ? ' is-editing' : ''}`
                + `${itemDragIndex === index ? ' is-dragging' : ''}`
                + `${itemDropEdge?.index === index && itemDropEdge.edge === 'above' ? ' is-drop-above' : ''}`
                + `${itemDropEdge?.index === index && itemDropEdge.edge === 'below' ? ' is-drop-below' : ''}`}
              key={`${item.id}-${index}`}
              ref={(node) => {
                if (node) itemRefs.current.set(item.id, node);
                else itemRefs.current.delete(item.id);
              }}
              draggable={itemDragArmed === index && editingIndex !== index}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', String(index));
                event.dataTransfer.effectAllowed = 'move';
                /** The ghost is the row header alone, never the editor expanded beneath it. */
                const header = event.currentTarget.querySelector('.zs-workspace-item-main');
                if (header instanceof HTMLElement) {
                  const rect = header.getBoundingClientRect();
                  event.dataTransfer.setDragImage(header, event.clientX - rect.left, event.clientY - rect.top);
                }
                setItemDragIndex(index);
              }}
              onDragEnd={() => { setItemDragIndex(null); setItemDropEdge(null); setItemDragArmed(null); }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                setItemDropEdge({
                  index,
                  edge: event.clientY < rect.top + rect.height / 2 ? 'above' : 'below',
                });
              }}
              onDragLeave={() => setItemDropEdge((current) => (current?.index === index ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer.getData('text/plain'));
                const edge = itemDropEdge?.index === index ? itemDropEdge.edge : 'above';
                setItemDragIndex(null);
                setItemDropEdge(null);
                if (!Number.isInteger(from)) return;
                reorderItems(from, edge === 'below' ? index + 1 : index);
              }}
            >
              <div className="zs-workspace-item-main">
                <span
                  className="zs-item-grip"
                  aria-hidden="true"
                  onPointerDown={() => { if (editingIndex !== index) setItemDragArmed(index); }}
                  onPointerUp={() => setItemDragArmed(null)}
                >
                  <GripVertical size={14} strokeWidth={1.9} />
                </span>
                <WorkspaceItemIcon item={item} />
                <div className="zs-workspace-item-copy">
                  <b>{item.label}</b>
                  <small><em>{itemTypeLabel(item)}</em></small>
                </div>
                <div className="zs-item-actions">
                  <button type="button" disabled={index === 0} onClick={() => moveItem(index, -1)} aria-label={`Move ${item.label} up`}><ChevronUp size={14} /></button>
                  <button type="button" disabled={index === workspace.apps.length - 1} onClick={() => moveItem(index, 1)} aria-label={`Move ${item.label} down`}><ChevronDown size={14} /></button>
                  <button type="button" className={editingIndex === index ? 'is-active' : ''} onClick={() => setEditingIndex(editingIndex === index ? null : index)} aria-label={`Edit ${item.label}`}><Pencil size={13} /></button>
                  <button type="button" onClick={() => removeItem(index)} aria-label={`Remove ${item.label}`}><Trash2 size={13} /></button>
                </div>
              </div>
              {editingIndex === index && (
                <div className="zs-workspace-item-editor">
                  <label className="zs-field"><span>Name</span><input value={item.label} onChange={(event) => updateItem(index, { label: event.target.value })} /></label>
                  {/*
                    Applications do not show the command: whoever added the shortcut already chose
                    the app, and the value is an AUMID (`Microsoft.WindowsTerminal_…!App`) that
                    tells nobody anything and only fills half a line. URL and folder stay editable
                    — there the value is readable and is the only way to fix the target.
                  */}
                  {item.type !== 'folder' && item.commandType !== 'app' && (
                    <label className="zs-field">
                      <span>{item.commandType === 'url' ? 'URL' : 'Folder path'}</span>
                      <input value={item.command} onChange={(event) => updateItem(index, { command: event.target.value })} />
                    </label>
                  )}
                  {item.type !== 'folder' && item.commandType === 'app' && isPathLikeCommand(item.command) && (
                    <label className="zs-field is-with-action">
                      <span>Target</span>
                      <div className="zs-field-row">
                        <input
                          value={item.command}
                          spellCheck={false}
                          onChange={(event) => updateItem(index, { command: event.target.value })}
                        />
                        <button
                          type="button"
                          className="zs-btn"
                          onClick={async () => {
                            const picked = await window.electron?.selectFile?.();
                            if (picked) updateItem(index, { command: picked });
                          }}
                        ><FolderOpen size={13} /> Change</button>
                      </div>
                    </label>
                  )}
                  {item.type !== 'folder' && item.commandType !== 'folder' && (
                    <div className="zs-launch-options">
                      <div>
                        <b>Launch mode</b>
                        <small>
                          {item.commandType === 'url' && (item.launchMode ?? 'normal') === 'reuse'
                            ? 'Uses the existing default browser process when available.'
                            : (item.launchMode ?? 'normal') === 'prewarm'
                            ? 'Caches executable data in Windows memory and reuses an existing process when supported.'
                            : (item.launchMode ?? 'normal') === 'reuse'
                              ? 'Prefers the existing IDE, app, or browser process.'
                              : 'Uses the standard Windows launch behavior.'}
                        </small>
                      </div>
                      <div className="zs-segmented" role="radiogroup" aria-label="Launch mode">
                        {(item.commandType === 'url'
                          ? ([['normal', 'Normal'], ['reuse', 'Reuse']] as const)
                          : ([['normal', 'Normal'], ['reuse', 'Reuse'], ['prewarm', 'Warm']] as const)
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={(item.launchMode ?? 'normal') === value}
                            className={(item.launchMode ?? 'normal') === value ? 'is-selected' : ''}
                            onClick={() => updateItem(index, { launchMode: value })}
                          >{label}</button>
                        ))}
                      </div>
                      {(() => {
                        const risk = launchModeRisk(item.commandType, item.launchMode ?? 'normal');
                        if (!risk) return null;
                        return (
                          <p className="zs-launch-risk" role="note">
                            <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
                            <span>{risk}</span>
                          </p>
                        );
                      })()}
                    </div>
                  )}
                  {isIde && (
                    <div className="zs-ide-options">
                      <div className="zs-ide-options-head">
                        <div><b>IDE integration</b><small>Recent projects and automated terminal commands.</small></div>
                      </div>
                      <div className="zs-ide-toggle-row">
                        <div><b id={`ide-recents-${item.id}`}>Show recent folders</b><small>Open the IDE as a submenu containing its recent projects.</small></div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={Boolean(item.hasRecents)}
                          aria-labelledby={`ide-recents-${item.id}`}
                          className="zs-switch"
                          onClick={() => updateItem(index, { hasRecents: !item.hasRecents })}
                        ><i /></button>
                      </div>
                      <div className="zs-ide-toggle-row">
                        <div><b id={`ide-terminal-${item.id}`}>Open terminal for recent folders</b><small>Starts a terminal in the selected project directory.</small></div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={Boolean(item.openTerminalForRecents)}
                          aria-labelledby={`ide-terminal-${item.id}`}
                          className="zs-switch"
                          disabled={!item.hasRecents}
                          onClick={() => updateItem(index, { openTerminalForRecents: !item.openTerminalForRecents })}
                        ><i /></button>
                      </div>
                      <div className="zs-ide-commands">
                        <div className="zs-ide-commands-head">
                          <div><b>Automated commands</b><small>Executed in the selected recent project folder.</small></div>
                          <button type="button" className="zs-btn" onClick={() => updateItem(index, { terminalCommands: [...(item.terminalCommands || []), ''] })}><Plus size={13} /> Add command</button>
                        </div>
                        {(item.terminalCommands || []).map((command, commandIndex) => (
                          <div className="zs-command-row" key={`${item.id}-command-${commandIndex}`}>
                            <input
                              value={command}
                              placeholder={commandIndex === 0 ? 'npm install' : 'npm run dev'}
                              aria-label={`Automated command ${commandIndex + 1}`}
                              onChange={(event) => updateItem(index, {
                                terminalCommands: (item.terminalCommands || []).map((current, i) => i === commandIndex ? event.target.value : current),
                              })}
                            />
                            <button type="button" aria-label={`Remove command ${commandIndex + 1}`} onClick={() => updateItem(index, {
                              terminalCommands: (item.terminalCommands || []).filter((_, i) => i !== commandIndex),
                            })}><X size={13} /></button>
                          </div>
                        ))}
                        {!item.terminalCommands?.length && <p className="zs-ide-empty">No automated commands configured.</p>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );})}
          {!workspace.apps.length && (
            discoveryPhase !== 'idle' ? (
              /** Empty because a scan has not run yet, not because there is nothing to add. */
              <div className="zs-manager-empty is-large">
                <Loader2 className="zs-spin" size={22} />
                <b>{discoveryPhase === 'scanning' ? 'Looking through your Start menu…' : 'Finding your applications'}</b>
                <span>Rovyl fills this workspace by itself. You can add more above at any time.</span>
              </div>
            ) : (
              <div className="zs-manager-empty is-large"><SquareStack size={22} /><b>This workspace is empty</b><span>Add an application, URL, or folder above.</span></div>
            )
          )}
        </div>
        </div>
      </section>

      <button type="button" className="zs-delete-workspace" disabled={!canDelete} onClick={deleteWorkspace}>
        <Trash2 size={14} /> Delete workspace
      </button>
    </div>
  );
}

/** Every combination Rovyl itself already answers to, so a clash with one is named, not probed. */
function ownShortcutOwners(config: UIConfig): Map<string, string> {
  const owners = new Map<string, string>();
  const key = (accelerator: string) =>
    accelerator.replace(/Win/g, 'Super').split('+').map((part) => part.trim().toLowerCase()).sort().join('+');
  const walk = (items: AppItem[], workspaceName: string) => {
    for (const item of items) {
      if (item.shortcut) owners.set(key(item.shortcut), `${item.label} in ${workspaceName}`);
      if (item.children?.length) walk(item.children, workspaceName);
    }
  };
  for (const workspace of config.workspaces) walk(workspace.apps || [], workspace.name);
  return owners;
}

type ShortcutStatus =
  | { kind: 'idle' }
  | { kind: 'checking'; accelerator: string }
  | { kind: 'taken'; accelerator: string; by?: string; hint?: string }
  | { kind: 'invalid'; accelerator: string }
  | { kind: 'ok'; accelerator: string };

/**
 * Record a shortcut, and find out at the moment of pressing it whether Windows will give it up.
 *
 * Nothing checked before. A combination another application already owned was written into the
 * config, failed to register on the next pass, and left a settings row naming a shortcut that did
 * nothing — with Rovyl quietly falling back to Alt+Shift+F9 without saying so. The answer only
 * exists by asking the OS (see `probe-shortcut`), so it is asked here, before the value is kept.
 *
 * Rovyl's own bindings are matched first and by name, because "already used by Cursor in Main" is
 * something the user can act on and "taken" is not.
 */
function ShortcutRecorder({
  value,
  onChange,
  config,
}: {
  value: string;
  onChange: (value: string) => void;
  config: UIConfig;
}) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<ShortcutStatus>({ kind: 'idle' });

  const owners = useMemo(() => ownShortcutOwners(config), [config]);
  const ownersRef = useRef(owners);
  ownersRef.current = owners;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const check = useCallback(async (accelerator: string): Promise<ShortcutStatus> => {
    const key = accelerator
      .replace(/Win/g, 'Super')
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .sort()
      .join('+');
    const owner = ownersRef.current.get(key);
    if (owner) return { kind: 'taken', accelerator, by: owner };

    const probe = window.electron?.probeShortcut;
    /** Outside Electron there is nothing to ask; accepting is better than refusing on no evidence. */
    if (!probe) return { kind: 'ok', accelerator };
    try {
      const result = await probe(accelerator);
      if (result?.available || result?.reason === 'rovyl') return { kind: 'ok', accelerator };
      return result?.reason === 'invalid'
        ? { kind: 'invalid', accelerator }
        : { kind: 'taken', accelerator, hint: result?.hint };
    } catch (e) {
      return { kind: 'ok', accelerator };
    }
  }, []);

  useEffect(() => {
    if (!recording) return;
    const cleanup = window.electron?.onShortcutRecorded?.((shortcut) => {
      if (!shortcut) return;
      /**
       * Recording stops either way — holding the keyboard hostage while the probe runs would make
       * the next keypress a second capture — but the value is only kept if the answer is yes.
       */
      window.electron?.stopShortcutRecording?.();
      setRecording(false);
      setStatus({ kind: 'checking', accelerator: shortcut });
      void check(shortcut).then((next) => {
        setStatus(next);
        if (next.kind === 'ok') onChangeRef.current(shortcut);
        /** Resume last: re-registering before the probe would make Rovyl the app holding the key. */
        window.electron?.resumeGlobalShortcut?.();
      });
    });
    return cleanup;
  }, [recording, check]);

  useEffect(() => () => {
    window.electron?.stopShortcutRecording?.();
    window.electron?.resumeGlobalShortcut?.();
  }, []);

  /** The saved one, checked when the card opens: a combination can be lost long after it was set. */
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    void check(value).then((next) => {
      if (!cancelled && next.kind !== 'ok') setStatus(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keys = value.split('+').filter(Boolean);

  const note = (() => {
    if (status.kind === 'checking') return { tone: 'muted', text: `Checking ${status.accelerator}…` };
    if (status.kind === 'invalid') {
      return { tone: 'warn', text: `${status.accelerator} is not a combination Windows can reserve. Include Ctrl, Alt or Shift.` };
    }
    if (status.kind === 'taken') {
      if (status.by) {
        return { tone: 'warn', text: `${status.accelerator} is already used by ${status.by}. The shortcut was not changed.` };
      }
      /** With a hint we can name the culprit, so the generic sentence about Windows only gets in the way. */
      return {
        tone: 'warn',
        text: status.hint
          ? `${status.accelerator} is already taken. ${status.hint}`
          : `${status.accelerator} is already taken by another application, so Windows will not give it to Rovyl. The shortcut was not changed.`,
      };
    }
    return null;
  })();

  return (
    <div className="zs-shortcut">
      <div className="zs-shortcut-keys">
        {keys.map((key) => <kbd key={key}>{key}</kbd>)}
      </div>
      <button
        type="button"
        className={`zs-btn${recording ? '' : ' is-primary'}`}
        onClick={() => {
          if (recording) {
            window.electron?.stopShortcutRecording?.();
            window.electron?.resumeGlobalShortcut?.();
            setRecording(false);
          } else {
            setStatus({ kind: 'idle' });
            window.electron?.pauseGlobalShortcut?.();
            window.electron?.startShortcutRecording?.();
            setRecording(true);
          }
        }}
      >
        {recording ? 'Press the key combination…' : 'Record new shortcut'}
      </button>
      {note && (
        <p className={`zs-shortcut-note${note.tone === 'warn' ? ' is-warn' : ''}`} role="status">
          {note.tone === 'warn' && <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />}
          <span>{note.text}</span>
        </p>
      )}
    </div>
  );
}
