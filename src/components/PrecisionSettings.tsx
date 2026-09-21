import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  CheckSquare,
  ChevronDown,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronRight,
  File as FileGlyph,
  FilePlus2,
  FolderOpen,
  Globe2,
  HelpCircle,
  GripVertical,
  Image as ImageGlyph,
  Loader2,
  AlertTriangle,
  Braces,
  LayoutList,
  Monitor,
  Mouse,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Palette,
  Settings,
  Shapes,
  Shield,
  Square,
  SquareStack,
  TerminalSquare,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SETTINGS_CORNERS } from '../types';
import type { AppItem, SettingsCorner, UIConfig, UpdateChannel, UpdateState, Workspace } from '../types';
import { DEFAULT_UI_CONFIG } from '../defaults';
import {
  DOCK_GAP_MAX,
  DOCK_GAP_MIN,
  DOCK_POSITION_LABELS,
  SHORTCUT_DOCK_ICON_MAX,
  SHORTCUT_DOCK_ICON_MIN,
  STATUS_DOCK_ICON_MAX,
  STATUS_DOCK_ICON_MIN,
  normalizeShortcutDock,
  normalizeStatusDock,
  shortcutDockIsActive,
  statusDockIsActive,
  type DockPosition,
} from '../utils/screenDocks';
import { getIcon } from '../iconMap';
import { resolveWebsiteIconFields } from '../siteFavicon';
import { hostLabelFromUrl, looksFetchable, normalizeSiteUrl, resolveWebsiteTitle } from '../siteTitle';
import { SmartIcon } from './SmartIcon';
import { Collapse, isRevealScrolling } from './Collapse';
import { IconPicker } from './IconPicker';
import { CustomIconPanel } from './CustomIconPanel';
import { describeIconFile, type CustomIconPick } from '../utils/customIcon';
import { RovylLogo } from './RovylLogo';
import '../fonts-display.css';
import { NativeAppIcon, useInstalledApps, clearInstalledAppsMemory, type InstalledApp } from './installedApps';
import { radialCrowding } from '../utils/workspaceRadial';
import { startMenuAppIdToLaunchCommand } from '../utils/windowsLaunchCommand';
import { WheelPreview, MENU_RADIUS_RANGE } from './WheelPreview';
import { DockShortcutsManager } from './DockShortcuts';
import { DockPositionPicker } from './DockPositionPicker';
import { WorkspaceFileEditor, type WorkspaceFileEditorHandle } from './WorkspaceFileEditor';
import {
  BACK_KEY_OFF,
  DEFAULT_BACK_KEY,
  normalizeBackKey,
  rejectBackKey,
} from '../constants/radialBackKey';
import { helpTipPlacement, nextTypeAheadBuffer, selectMenuPlacement, typeAheadIndex } from './selectMenu';
import type { TipPlacement } from './selectMenu';
import { LANGUAGES, normalizeLanguage, translations, useTranslation } from '../i18n/useTranslation';

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
  | { kind: 'backKey' }
  | { kind: 'blocked' }
  | { kind: 'dockShortcuts' }
  | { kind: 'workspace'; index: number }
  | null;

interface SettingItem {
  key: string;
  /** Title of the group the row joins. Consecutive rows with the same group stay together. */
  group: string;
  title: string;
  description?: string;
  kind: 'bool' | 'range' | 'segmented' | 'select' | 'dockPosition' | 'open' | 'action' | 'color';
  enabled?: boolean;
  value?: string;
  min?: number;
  max?: number;
  step?: number;
  raw?: number;
  format?: (value: number) => string;
  /**
   * `hint` is support text drawn beside the label; `help` is a sentence too long to draw at
   * all, reachable from the option's own help affordance.
   */
  choices?: Array<{ value: string; label: string; hint?: string; help?: string }>;
  current?: string;
  /** `dockPosition` only: the other dock's region, drawn faint so a shared corner is a choice. */
  occupied?: { position: DockPosition; label: string };
  /**
   * Extra words the search box matches, beyond title/description/group.
   *
   * One row actually needs this. Every other setting is findable by the words already on it, but
   * those words are translated — so the person most in need of the Language row is the one who
   * just picked the wrong language and can no longer read the word "Language". Listing the
   * endonyms here means typing `Sprache`, `язык` or `语言` finds it from inside any locale.
   */
  keywords?: string;
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
  { id: 'spaces', label: 'Workspaces', caption: 'Contexts and their shortcuts.', icon: SquareStack },
  { id: 'trigger', label: 'Activation', caption: 'How and where the wheel appears.', icon: Mouse },
  { id: 'advanced', label: 'Advanced', caption: 'Performance, protection, and data.', icon: Shield },
  { id: 'appearance', label: 'Appearance', caption: 'Shape, presence, and theme.', icon: Palette },
  { id: 'general', label: 'General', caption: 'Core Rovyl behavior.', icon: Settings },
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
  const { t, dir } = useTranslation(config.language);

  const sectionsList = useMemo(() => [
    { id: 'spaces' as const, label: t('workspaces'), caption: t('workspacesDesc'), icon: SquareStack },
    { id: 'trigger' as const, label: t('trigger'), caption: t('triggerDesc'), icon: Mouse },
    { id: 'advanced' as const, label: t('advanced'), caption: t('advancedDesc'), icon: Shield },
    { id: 'appearance' as const, label: t('appearance'), caption: t('appearanceDesc'), icon: Palette },
    { id: 'general' as const, label: t('general'), caption: t('generalDesc'), icon: Settings },
  ], [t]);

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
        description: 'Downloaded and verified. Rovyl installs it the next time it starts.',
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
            ? `${updateInfo.percent}% done. You can keep working — Rovyl installs it the next time it starts.`
            : 'You can keep working — Rovyl installs it the next time it starts.',
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
      actionIcon: RefreshCw,
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
      clearInstalledAppsMemory();
      onClose();
    }, 240);
  }, [onClose]);

  useEffect(() => {
    return () => {
      clearInstalledAppsMemory();
    };
  }, []);

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

  /**
   * The two docks, normalized on read.
   *
   * Never field by field: a config written before one of these switches existed is missing it, and
   * a missing `iconSize` read as 0 is a dock that is enabled, placed, and invisible.
   */
  const statusDock = normalizeStatusDock(config.statusDock);
  const updateStatusDock = (patch: Partial<typeof statusDock>) =>
    update('statusDock', { ...statusDock, ...patch });
  const shortcutDock = normalizeShortcutDock(config.shortcutDock);
  const updateShortcutDock = (patch: Partial<typeof shortcutDock>) =>
    update('shortcutDock', { ...shortcutDock, ...patch });

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

    const keyboardTriggerOn = config.enableKeyboardTrigger !== false;
    const mouseTriggerOn = config.enableMouseTrigger !== false;
    const numberLaunchOn = config.radialNumberLaunch === true;
    const backKey = normalizeBackKey(config.radialBackKey);
    /** The other claimant on 1–9 — see the description of the quick-launch row. */
    const workspaceHotkeysOn = (config.workspaceSwitchMode ?? 'picker') !== 'picker';

    /**
     * Turning off the last trigger would leave no way in, so the other one comes on in the same
     * change — the pair behaves like a choice of route rather than two switches that can both be
     * down.
     *
     * The press is never refused. Someone switching the last trigger off is not making a mistake,
     * they are saying "not this one", and answering that with a toast leaves them to work out the
     * other half themselves; doing it for them is the answer they meant. Both keys move in ONE
     * `setConfig` so the two rows can never render a frame with nothing enabled.
     */
    const toggleTrigger = (key: 'enableKeyboardTrigger' | 'enableMouseTrigger') => {
      const other = key === 'enableKeyboardTrigger' ? 'enableMouseTrigger' : 'enableKeyboardTrigger';
      const turningOff = key === 'enableKeyboardTrigger' ? keyboardTriggerOn : mouseTriggerOn;
      const otherOn = key === 'enableKeyboardTrigger' ? mouseTriggerOn : keyboardTriggerOn;
      if (turningOff && !otherOn) {
        setConfig((current) => ({ ...current, [key]: false, [other]: true }));
        showToast(
          key === 'enableKeyboardTrigger'
            ? 'Switched to the mouse trigger'
            : 'Switched to the keyboard trigger',
        );
        return;
      }
      update(key, !turningOff);
    };

    return {
      general: [
        ...(canUpdate ? [{ key: 'update', group: 'Updates', ...updateRow }] : []),
        {
          /**
           * A select, not the segmented control this was while it held two languages: seven
           * 62px-minimum buttons are ~460px of row, which is wider than the control column and
           * would wrap into a block of chips no eye can scan.
           *
           * The group name stays the English "Language" on purpose — it is the one string in this
           * panel that has to stay findable by someone who cannot read the rest of it.
           */
          key: 'language', configKey: 'language', group: 'Language', title: t('language'),
          description: t('languageDesc'),
          kind: 'select', current: normalizeLanguage(config.language),
          choices: LANGUAGES.map((entry) => ({
            value: entry.value,
            label: entry.label,
            hint: entry.english,
          })),
          /**
           * Both halves of "how would they look for this": the name of the language they want
           * (`Deutsch`, `Русский`), and their own word for the word Language (`Sprache`, `语言`),
           * which every table already carries under the `language` key.
           */
          keywords: [
            ...LANGUAGES.map((entry) => `${entry.label} ${entry.english}`),
            ...Object.values(translations).map((table) => table.language),
          ].join(' '),
          onChange: (value) => update('language', value as UIConfig['language']),
        },
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
        /**
         * Each way in is a switch that owns its own settings, and the settings only exist while
         * the switch is on.
         *
         * What stood here was one switch, on the mouse group alone, described as "instead of the
         * keyboard" — which was not true (both worked at once, and always had) and left the
         * keyboard side looking like the thing you could not turn off. Two symmetrical switches
         * say the real shape: two independent triggers, either of which can be off.
         *
         * The trigger's own rows are the ones that collapse. Position and Hands-free below are
         * about the wheel once it is open, however it got there, so they stay put.
         */
        {
          key: 'keyboard', configKey: 'enableKeyboardTrigger', group: 'Keyboard',
          title: 'Enable keyboard trigger',
          description: 'Open the wheel with a keyboard shortcut.',
          kind: 'bool', enabled: keyboardTriggerOn,
          onToggle: () => toggleTrigger('enableKeyboardTrigger'),
        },
        ...(keyboardTriggerOn
          ? ([
              {
                key: 'shortcut', group: 'Keyboard', title: 'Global shortcut',
                description: 'Open the wheel over any application.',
                kind: 'open', value: config.globalShortcut, onOpen: () => setEditor({ kind: 'shortcut' }),
              },
              {
                key: 'shortcutMode', configKey: 'shortcutTriggerMode' as const, group: 'Keyboard',
                title: t('shortcutBehavior'),
                description: t('shortcutBehaviorDesc'),
                /**
                 * A dropdown, where every other two-way choice in this panel is a segmented
                 * control — because the two labels here cannot stay short in every language.
                 * "Toggle" and "Hold" mean nothing without saying what they do, so the labels
                 * carried their explanation in parentheses, and two parenthesised sentences side
                 * by side stretched the control across the row and wrapped in half the locales.
                 *
                 * The dropdown separates the two jobs the segmented control was doing at once:
                 * the label names the mode, and the sentence moves behind each option's help
                 * affordance, where it is one hover away instead of permanently in the way.
                 */
                kind: 'select', current: config.shortcutTriggerMode ?? 'toggle',
                choices: [
                  { value: 'toggle', label: t('shortcutToggle'), help: t('shortcutToggleHelp') },
                  { value: 'hold', label: t('shortcutHold'), help: t('shortcutHoldHelp') },
                ],
                onChange: (value) => update('shortcutTriggerMode', value as UIConfig['shortcutTriggerMode']),
              },
            ] as SettingItem[])
          : []),
        {
          key: 'mouse', configKey: 'enableMouseTrigger', group: 'Mouse',
          title: 'Enable mouse trigger',
          description: 'Open the wheel with a mouse button.',
          kind: 'bool', enabled: mouseTriggerOn,
          onToggle: () => toggleTrigger('enableMouseTrigger'),
        },
        ...(mouseTriggerOn
          ? ([
              {
                key: 'mouseButton', configKey: 'mouseTriggerButton' as const, group: 'Mouse', title: 'Trigger button',
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
                key: 'mouseMode', configKey: 'mouseTriggerMode' as const, group: 'Mouse', title: 'Gesture behavior',
                description: 'Click keeps the wheel open; hold runs the selection on release.',
                kind: 'segmented', current: config.mouseTriggerMode ?? 'click',
                choices: [{ value: 'click', label: 'Click' }, { value: 'hold', label: 'Hold' }],
                onChange: (value) => update('mouseTriggerMode', value as UIConfig['mouseTriggerMode']),
              },
            ] as SettingItem[])
          : []),
        {
          key: 'radialMonitor', configKey: 'radialMonitor', group: 'Position', title: 'Monitor',
          /**
           * The consequence, not the mechanism. Nobody opens this panel wanting to know which
           * `Display` object main asks for — they want to know which screen the thing they are about
           * to launch will be sitting on.
           */
          description:
            config.radialPlacement === 'cursor'
              ? 'Appearance opens the wheel under the pointer, so it is already on the screen the pointer is on — this choice has nothing left to decide.'
              : config.radialMonitor === 'cursor'
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
        {
          key: 'numberLaunch', configKey: 'radialNumberLaunch', group: 'Number keys',
          title: 'Quick launch with number keys',
          /**
           * Three things have to be here and nowhere else: that there is no Enter (it is the whole
           * point, and every other keyboard path on the wheel needs one), that the count follows
           * the wheel rather than any list in this panel, and — when it applies — what it takes
           * away. `workspaceSwitchMode: 'hotkeys'` also owns 1–9, and a feature that quietly
           * disables another one is a bug report waiting to be filed.
           */
          description:
            numberLaunchOn && workspaceHotkeysOn
              ? 'Press 1–9 to run the shortcut in that position — no Enter. The digits are the wheel’s now, so switching workspace by number is off; use the wheel or the scroll wheel instead.'
              : workspaceHotkeysOn
                ? 'Press 1–9 to run the shortcut in that position, counting clockwise from the top — no Enter. It takes the number keys away from workspace switching.'
                : 'Press 1–9 to run the shortcut in that position, counting clockwise from the top — no Enter, no aiming. Also turns on the key that steps back out of a folder.',
          kind: 'bool', enabled: numberLaunchOn,
          onToggle: () => update('radialNumberLaunch', !numberLaunchOn),
        },
        /** Only while there are numbers to show — same rule as the hands-free tunings above. */
        ...(numberLaunchOn
          ? ([
              {
                key: 'numberLabels', configKey: 'radialNumberLabels' as const, group: 'Number keys',
                title: 'Show numbers on the wheel',
                description:
                  'Draws each position’s digit on its icon. Turn it off once the wheel is in your hands — the keys go on working.',
                kind: 'bool', enabled: config.radialNumberLabels !== false,
                onToggle: () =>
                  update('radialNumberLabels', config.radialNumberLabels === false),
              },
              {
                key: 'backKey', configKey: 'radialBackKey' as const, group: 'Number keys',
                title: 'Key to leave a folder',
                /**
                 * Where it does NOT work is the whole reason a plain letter is safe to bind, so it
                 * is the sentence the row leads with. Someone who reads only the title would
                 * otherwise try it on the root wheel, watch it type into the filter, and file it
                 * as broken.
                 */
                description: backKey
                  ? `Press ${backKey} inside a folder to step back out, the same as clicking the hub. At the top level it stays an ordinary letter, so searching is unaffected.`
                  : 'No key assigned. The hub still goes back when clicked, and Backspace still works.',
                kind: 'open' as const, value: backKey || 'Off',
                onOpen: () => setEditor({ kind: 'backKey' }),
              },
            ] as SettingItem[])
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
          config.menuRadius, MENU_RADIUS_RANGE.min, MENU_RADIUS_RANGE.max,
          (value) => update('menuRadius', value), (value) => `${Math.round(value)} px`,
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
            config.radialSelectionMode === 'area'
              ? 'The wheel is cut into equal wedges — one per shortcut — and the one you point at fills up. Click anywhere inside it.'
              : config.radialInstantActivate === 'dwell'
                ? 'Launch without clicking is on, so the wheel always aims by direction — each item owns an equal slice of the screen.'
                : config.radialSelectionMode === 'cursor'
                  ? 'Only the icon under the pointer highlights. Release away from every icon to cancel.'
                  : 'Aim by direction: the slice you point toward highlights from anywhere on screen.',
          kind: 'segmented',
          /**
           * Area is Direction with the boundaries drawn — same maths, same muscle memory — so the
           * two sit next to each other and Pointer, which is the one that actually targets
           * something else, sits at the end.
           */
          choices: [
            { value: 'angle', label: 'Direction' },
            { value: 'area', label: 'Area' },
            { value: 'cursor', label: 'Pointer' },
          ],
          current:
            config.radialSelectionMode === 'cursor'
              ? 'cursor'
              : config.radialSelectionMode === 'area'
                ? 'area'
                : 'angle',
          onChange: (value) => update('radialSelectionMode', value as UIConfig['radialSelectionMode']),
        },
        {
          key: 'labels', configKey: 'alwaysShowAppLabels', group: 'Wheel', title: 'Persistent labels',
          description: 'Keep every target name visible.',
          kind: 'bool', enabled: config.alwaysShowAppLabels,
          onToggle: () => update('alwaysShowAppLabels', !config.alwaysShowAppLabels),
        },
        {
          key: 'workspacePill', configKey: 'showWorkspacePill', group: 'Wheel', title: 'Workspace name',
          description: 'Show the pill under the wheel with the current workspace and folder.',
          keywords: 'pill chip breadcrumb workspace name folder path label below under',
          kind: 'bool', enabled: config.showWorkspacePill !== false,
          onToggle: () => update('showWorkspacePill', config.showWorkspacePill === false),
        },
        {
          key: 'radialPlacement', configKey: 'radialPlacement', group: 'Position', title: 'Where it opens',
          /**
           * Said as the consequence, because that is the whole of the choice: the same wheel, the
           * same targets, a different distance for the hand. The clamp near an edge is mentioned —
           * someone who opens it in a corner and sees the wheel sit slightly inboard should find
           * that written down rather than think it missed.
           */
          description:
            config.radialPlacement === 'cursor'
              ? 'The wheel blooms under the pointer, so nothing is further away than the gesture that opened it. Near an edge it steps inward just enough to keep every target on screen.'
              : 'The wheel always blooms at the middle of the screen, wherever the pointer happens to be.',
          kind: 'segmented',
          choices: [
            { value: 'center', label: 'Screen center' },
            { value: 'cursor', label: 'At pointer' },
          ],
          current: config.radialPlacement === 'cursor' ? 'cursor' : 'center',
          keywords: 'mouse cursor location position place spawn appear under pointer center centre',
          onChange: (value) => update('radialPlacement', value as UIConfig['radialPlacement']),
        },
        range('backdrop', 'Presence', 'Background dimming',
          'How much the rest of the screen recedes. At 100% it goes: the desktop is covered edge to edge.',
          config.backdropOpacity ?? DEFAULT_UI_CONFIG.backdropOpacity, 0, 1,
          (value) => update('backdropOpacity', value), (value) => `${Math.round(value * 100)}%`,
          0.01, 'backdropOpacity'),
        /**
         * The docks, in the order they are met: the one you fill yourself first, the one that
         * reads the machine second. Everything under each is withdrawn rather than disabled while
         * its dock is off — the same rule the dwell tunings follow, because a placement control
         * for a strip that is not on screen is a control that does nothing.
         */
        {
          /**
           * No `configKey`, deliberately — and it is the one row here that must not have one.
           * The revert chip writes `DEFAULT_UI_CONFIG[key]`, and this key holds the user's own
           * icons: a small button whose label says "default" would delete every one of them. The
           * workspace rows leave it off for exactly the same reason.
           */
          key: 'shortcutDock', group: 'Shortcut dock',
          title: 'Shortcut dock',
          description: shortcutDock.items.length
            ? 'A strip of your own icons beside the open wheel. Click one to launch it.'
            : 'A strip of your own icons beside the open wheel — Chrome, Steam, a project folder, anything. Nothing is drawn until you add some.',
          keywords: 'dock strip icons taskbar corner launcher pinned chrome steam discord',
          kind: 'bool', enabled: shortcutDock.enabled,
          onToggle: () => updateShortcutDock({ enabled: !shortcutDock.enabled }),
        },
        ...(shortcutDock.enabled ? ([
          {
            key: 'shortcutDock-items', group: 'Shortcut dock', title: 'Icons',
            description: shortcutDock.items.length === 1
              ? '1 icon in the dock.'
              : `${shortcutDock.items.length} icons in the dock.`,
            kind: 'open' as const,
            value: shortcutDock.items.length ? 'Edit' : 'Add icons',
            onOpen: () => setEditor({ kind: 'dockShortcuts' as const }),
          },
          {
            key: 'shortcutDock-position', group: 'Shortcut dock', title: 'Where it sits',
            description: 'Pick the corner or edge on the screen below. The wheel opens over the whole screen while a dock is on — everything but the taskbar — so the corner is a real one.',
            keywords: 'corner edge top bottom left right center centre place position move',
            /**
             * The screen itself, not a list of six region names. A dropdown made the user translate
             * "Bottom center" into a place and then trust that they had; the picture is the place.
             */
            kind: 'dockPosition' as const,
            current: shortcutDock.position,
            value: DOCK_POSITION_LABELS[shortcutDock.position],
            occupied: statusDockIsActive(statusDock)
              ? { position: statusDock.position, label: 'System dock' }
              : undefined,
            onChange: (value: number | string) =>
              updateShortcutDock({ position: value as typeof shortcutDock.position }),
          },
          range('shortcutDock-size', 'Shortcut dock', 'Icon size',
            'How big each icon is drawn.',
            shortcutDock.iconSize, SHORTCUT_DOCK_ICON_MIN, SHORTCUT_DOCK_ICON_MAX,
            (value) => updateShortcutDock({ iconSize: Math.round(value) }),
            (value) => `${Math.round(value)} px`),
          range('shortcutDock-gap', 'Shortcut dock', 'Spacing',
            'The gap between neighbouring icons.',
            shortcutDock.gap, DOCK_GAP_MIN, DOCK_GAP_MAX,
            (value) => updateShortcutDock({ gap: Math.round(value) }),
            (value) => `${Math.round(value)} px`),
          {
            key: 'shortcutDock-labels', group: 'Shortcut dock', title: 'Names under the icons',
            description: 'Off by default: a strip of eight names is a menu, and the wheel is already that.',
            kind: 'bool' as const, enabled: shortcutDock.showLabels,
            onToggle: () => updateShortcutDock({ showLabels: !shortcutDock.showLabels }),
          },
        ]) : []),
        {
          key: 'statusDock', configKey: 'statusDock', group: 'System dock',
          title: 'System dock',
          description: 'Time, battery, network and volume, read live, beside the open wheel. The volume slider and the mute button work from here.',
          keywords: 'clock time battery network wifi volume sound tray indicators status corner',
          kind: 'bool', enabled: statusDock.enabled,
          onToggle: () => updateStatusDock({ enabled: !statusDock.enabled }),
        },
        ...(statusDock.enabled ? ([
          {
            key: 'statusDock-position', group: 'System dock', title: 'Where it sits',
            description: 'Pick the corner or edge on the screen below.',
            keywords: 'corner edge top bottom left right center centre place position move',
            kind: 'dockPosition' as const,
            current: statusDock.position,
            value: DOCK_POSITION_LABELS[statusDock.position],
            occupied: shortcutDockIsActive(shortcutDock)
              ? { position: shortcutDock.position, label: 'Shortcut dock' }
              : undefined,
            onChange: (value: number | string) =>
              updateStatusDock({ position: value as typeof statusDock.position }),
          },
          range('statusDock-size', 'System dock', 'Icon size',
            'How big the glyphs are drawn. The readouts beside them are set to match.',
            statusDock.iconSize, STATUS_DOCK_ICON_MIN, STATUS_DOCK_ICON_MAX,
            (value) => updateStatusDock({ iconSize: Math.round(value) }),
            (value) => `${Math.round(value)} px`),
          range('statusDock-gap', 'System dock', 'Spacing',
            'The gap between neighbouring readouts.',
            statusDock.gap, DOCK_GAP_MIN, DOCK_GAP_MAX,
            (value) => updateStatusDock({ gap: Math.round(value) }),
            (value) => `${Math.round(value)} px`),
          {
            key: 'statusDock-volume', group: 'System dock', title: 'Volume',
            description: 'Output level, with a slider you can drag. Click the glyph to mute.',
            kind: 'bool' as const, enabled: statusDock.showVolume,
            onToggle: () => updateStatusDock({ showVolume: !statusDock.showVolume }),
          },
          {
            key: 'statusDock-network', group: 'System dock', title: 'Network',
            description: 'Wi-Fi signal, or a wired connection. Click it for the Windows network panel.',
            kind: 'bool' as const, enabled: statusDock.showNetwork,
            onToggle: () => updateStatusDock({ showNetwork: !statusDock.showNetwork }),
          },
          {
            key: 'statusDock-battery', group: 'System dock', title: 'Battery',
            /** Said up front, because the row is otherwise a switch that visibly does nothing. */
            description: 'Charge level, and whether it is on the charger. Nothing is drawn on a machine with no battery.',
            kind: 'bool' as const, enabled: statusDock.showBattery,
            onToggle: () => updateStatusDock({ showBattery: !statusDock.showBattery }),
          },
          {
            key: 'statusDock-clock', group: 'System dock', title: 'Clock',
            description: 'The time, with the date under it.',
            kind: 'bool' as const, enabled: statusDock.showClock,
            onToggle: () => updateStatusDock({ showClock: !statusDock.showClock }),
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
        {
          key: 'performance', group: 'Performance', title: 'Precision mode',
          description: 'Prioritize immediate response and reduce visual effects.',
          kind: 'bool', enabled: config.performanceMode,
          onToggle: () => update('performanceMode', !config.performanceMode),
        },
        {
          key: 'strictOffline', configKey: 'strictOfflineMode', group: 'Performance', title: t('strictOffline'),
          description: t('strictOfflineDesc'),
          kind: 'bool', enabled: Boolean(config.strictOfflineMode),
          onToggle: () => update('strictOfflineMode', !config.strictOfflineMode),
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
          key: 'settingsCorner', configKey: 'showSettingsCorner', group: 'Settings shortcut',
          title: 'Settings button on the wheel',
          /**
           * Said with its cost, because it has one that shows: the overlay normally opens as a box
           * around the wheel, and a corner only means the screen's corner if the window is the
           * screen. And said with its one exclusion — aiming by direction hides the pointer, so
           * there is no hand to bring to a corner and the gear is not drawn in that mode.
           */
          description:
            config.radialInstantActivate === 'dwell'
              ? 'A gear in the corner of the open wheel, one click from these settings. Launch without clicking aims by direction and hides the pointer, so the gear stays off while that is on.'
              : 'A gear in the corner of the open wheel, one click from these settings. The wheel then opens over the whole screen instead of a box around itself, so the corner is a real one.',
          kind: 'bool', enabled: config.showSettingsCorner === true,
          keywords: 'gear cog icon corner open settings preferences shortcut button',
          onToggle: () => update('showSettingsCorner', !config.showSettingsCorner),
        },
        ...(config.showSettingsCorner === true ? [{
          key: 'settingsCornerPosition', configKey: 'settingsCorner' as const, group: 'Settings shortcut',
          title: 'Which corner',
          description: 'Where the gear sits. It steps inboard if the battery or weather pill is already there.',
          /**
           * A select: four corner names are ~380px of segmented control, wider than the column,
           * and the same reason the Language row stopped being one.
           */
          kind: 'select' as const,
          current: SETTINGS_CORNERS.includes(config.settingsCorner as SettingsCorner)
            ? (config.settingsCorner as SettingsCorner)
            : 'top-right',
          choices: [
            { value: 'top-right', label: 'Top right' },
            { value: 'top-left', label: 'Top left' },
            { value: 'bottom-right', label: 'Bottom right' },
            { value: 'bottom-left', label: 'Bottom left' },
          ],
          onChange: (value: number | string) => update('settingsCorner', value as SettingsCorner),
        }] : []),
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
  }, [config, gameMode, statusDock, shortcutDock, theme, apps, update, setConfig, updateRow, canUpdate, onReset, deleteWorkspace, reorderWorkspaces]);

  const trimmedQuery = query.trim().toLowerCase();
  const activeMeta = sectionsList.find((section) => section.id === sectionId) || SECTIONS[0];

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
    /**
     * A reveal is moving this box on purpose, and the position it is moving away from is the one
     * saved here — restoring it would undo the scroll frame by frame as it happened.
     */
    if (isRevealScrolling()) return;
    /** Write only when it has drifted: an equal `scrollTop` would still cancel a smooth scroll. */
    if (element.scrollTop !== scrollTopRef.current) element.scrollTop = scrollTopRef.current;
  });

  /**
   * The other half: the window growing under the panel, with React none the wiser.
   *
   * Rewriting after every commit only works while React is the one who notices, and the wheel is
   * not. Opening it over Settings takes the HWND from the panel's 880x600 to the whole monitor —
   * `[RadialOpen] ... hiding before resize (mode=windowed, panel=true)`, bounds 1920x1080, in the
   * diagnostic log — and that happens in the main process, frames before `open-menu` reaches the
   * renderer. For those frames the panel is still `inset-0` of a window that is now the screen:
   * this list is handed ~1040px of height instead of ~560, the section stops needing to scroll at
   * all, and Chromium clamps `scrollTop` to zero. No commit ran, so nothing put it back — and the
   * clamp arrives as an ordinary scroll event, so the zero was saved over the position it had just
   * destroyed. Appearance came back from the wheel at the top, every time.
   *
   * A `ResizeObserver` watches what actually changed: this box's own height. It is delivered after
   * layout and before paint, so the rewrite is never seen, and it does not care which route resized
   * the window — a box back at a height that can hold the offset gets the offset back.
   */
  const ignoreScrollRef = useRef(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      /** No box yet: nothing to put back, and `scrollTop` would be dropped on the floor anyway. */
      if (element.clientHeight === 0) return;
      /**
       * Shut the gate for a frame.
       *
       * A clamp is not reported in the frame it happens: the event is queued during that layout and
       * fires in the NEXT frame's scroll steps — which run before anything of ours does, so by the
       * time the handler could tell it apart it has already saved the zero. A flag cleared from a
       * `requestAnimationFrame` lifts exactly one frame later, after those scroll steps, which is
       * the one window in which no scroll report can be trusted.
       */
      ignoreScrollRef.current = true;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        ignoreScrollRef.current = false;
      });
      if (element.scrollTop !== scrollTopRef.current) element.scrollTop = scrollTopRef.current;
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [isOpen]);

  /** Search walks every category — searching only the open one forced a guess about where a setting lives. */
  const results = useMemo(() => {
    const matches = (item: SettingItem) =>
      !trimmedQuery
      || `${item.title} ${item.description ?? ''} ${item.group} ${item.keywords ?? ''}`
        .toLowerCase()
        .includes(trimmedQuery);

    const source = trimmedQuery
      ? sectionsList.flatMap((section) => sections[section.id].filter(matches))
      : sections[sectionId];

    /** Groups while keeping declaration order: the group is a label, not a card. */
    const groups: Array<{ name: string; items: SettingItem[] }> = [];
    for (const item of source) {
      const last = groups[groups.length - 1];
      if (last && last.name === item.group) last.items.push(item);
      else groups.push({ name: item.group, items: [item] });
    }
    return groups;
  }, [sections, sectionId, trimmedQuery, sectionsList]);

  const isEmpty = results.length === 0;

  if (!isOpen) return null;

  return (
    <div
      id="settings-container"
      className={`zs-shell${isDismissing ? ' is-dismissing' : ''}`}
      data-zn-theme={theme}
      dir={dir}
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
            <h2>{t('settings')}</h2>
          </div>

          <div className="zs-search">
            <Search size={14} strokeWidth={1.9} />
            <input
              id="zs-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              /** The rail comes back only if nothing was searched for; a query keeps its own box. */
              onBlur={() => { if (!query.trim()) setSearchForced(false); }}
              placeholder={t('searchSettings')}
              aria-label={t('searchSettings')}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>

          <nav className="zs-nav" aria-label="Settings sections">
            {sectionsList.map((section) => {
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
              /** A resize is still settling: see `ignoreScrollRef`. None of this is the user's doing. */
              if (ignoreScrollRef.current) return;
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
                          {/*
                            `initial={false}` is what tells a reveal apart from a repaint. The rows
                            already here when the section opened were not toggled into existence,
                            and opening all of them together would be a curtain over the list —
                            only the ones that arrive later, because a switch above them moved,
                            have anything to animate.
                          */}
                          <AnimatePresence initial={false}>
                            {group.items.map((item) => (
                              <Collapse key={item.key}>
                                <SettingRow
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
                              </Collapse>
                            ))}
                          </AnimatePresence>
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
      className={`zs-row${item.kind === 'range' ? ' is-slider' : ''}${item.kind === 'dockPosition' ? ' is-picker' : ''}${item.kind === 'open' ? ' is-openable' : ''}`
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

        {item.kind === 'select' && <SelectSettingControl item={item} describedBy={describedBy} />}

        {item.kind === 'range' && <span className="zs-readout">{item.value}</span>}

        {/* The picture answers "where"; this says it in words, for the search and the screen reader. */}
        {item.kind === 'dockPosition' && <span className="zs-readout is-place">{item.value}</span>}

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
      <AnimatePresence initial={false}>
        {item.kind === 'action' && item.confirm && confirming && (
          <Collapse key="confirm">
            <p className="zs-confirm-body" role="alert">
              <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
              <span>{item.confirm.body}</span>
            </p>
          </Collapse>
        )}
      </AnimatePresence>

      {item.kind === 'dockPosition' && (
        <DockPositionPicker
          value={item.current as DockPosition}
          onChange={(position) => item.onChange?.(position)}
          labelledBy={`${item.key}-label`}
          describedBy={describedBy}
          occupied={item.occupied}
        />
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

/**
 * The panel's dropdown. Two rows use it — Language, which outgrew the segmented control at seven
 * options, and Shortcut behavior, whose two options could not be named in the width a segmented
 * control had for them.
 *
 * A native `<select>` was the first version and the honest starting point: accessible,
 * keyboard-complete and free. What it is not is ours — Chromium draws the popup from the OS theme,
 * so it arrived as a grey Windows listbox in the middle of a panel that controls every other pixel
 * of itself, ignoring the type scale, the radii and the surface tokens.
 *
 * Replacing it means owing back everything the platform was doing unpaid, which is most of the
 * length of this component and all of the interesting parts: roving `aria-activedescendant` rather
 * than moved focus, type-ahead with an idle reset, Home/End, Escape cancelling versus Tab
 * committing, focus returning to the trigger on close, and the active option kept in view. Those
 * are not embellishments on a dropdown — for anyone not using a mouse, they ARE the dropdown.
 *
 * An option may also carry a `help` sentence, drawn as a mark it opens on hover rather than as
 * text in the list. That is for the labels that mean nothing on their own — Toggle, Hold — where
 * the alternative is a parenthesis on every row and a popup that is mostly explanation.
 */
/**
 * The shell, which is both where the popup is painted and what it is measured against.
 *
 * It has to be the same element for both or the arithmetic is against one box and the rendering
 * against another. `document.body` is not an option: the theme tokens and `dir` cascade from the
 * shell, so a popup parented to the body would come out unthemed and, in Arabic, the wrong way
 * round.
 */
const portalTarget = () => document.getElementById('settings-container');

function SelectSettingControl({ item, describedBy }: { item: SettingItem; describedBy?: string }) {
  const reduceMotion = useReducedMotion();
  const choices = item.choices ?? [];
  const selectedIndex = Math.max(0, choices.findIndex((choice) => choice.value === item.current));
  const [isOpen, setIsOpen] = useState(false);
  /**
   * Which option the keyboard is ON, which is not which option is CHOSEN. Arrowing must not
   * commit: a dropdown that applied each option as the highlight passed over it would, on this
   * row, retranslate the whole panel under the user five times on the way down to Deutsch.
   */
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [placement, setPlacement] =
    useState<{ left: number; top: number; width: number; drop: 'down' | 'up' }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<number, HTMLDivElement>());
  const typeAhead = useRef({ buffer: '', at: 0 });
  const listId = `${item.key}-listbox`;

  /**
   * The option whose help sentence is showing, and where that bubble was painted.
   *
   * Two pieces of state rather than one because the bubble cannot be placed until it has been
   * measured: `.zs-select-tip` fixes the width, the browser decides the height from the sentence,
   * and only then is it known whether it fits below the mark. So `helpFor` asks for the bubble,
   * `tipAt` is filled in by a layout effect once it exists, and until it does the bubble renders
   * hidden. Both happen before paint, so nothing is ever seen in the wrong place.
   */
  const [helpFor, setHelpFor] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<TipPlacement>();
  const tipRef = useRef<HTMLDivElement>(null);
  const helpIconRefs = useRef(new Map<number, HTMLSpanElement>());
  /**
   * Whether the list is being driven by keys, so the help can follow the highlight for someone
   * who has no pointer to hover with — without the bubble popping up every time a pointer merely
   * crosses an option on its way somewhere else.
   */
  const [byKeyboard, setByKeyboard] = useState(false);

  /**
   * Anchored to the trigger, measured against the shell, re-measured rather than remembered.
   *
   * Two constraints meet here. The row lives inside `.zs-scroll`, so a popup positioned within the
   * row would be clipped by that scroller the moment it was taller than the space beneath — hence
   * the portal out to the shell. But the shell sits inside `PanelTransition`'s `motion.div`, which
   * carries `filter: blur()`, and a filter makes its element the containing block for any
   * `position: fixed` descendant. So "fixed" here is not viewport-relative; it is relative to a box
   * starting below the title bar, and the first version of this menu duly opened a title-bar's
   * height too low. Absolute coordinates measured against the shell are immune to that, and to
   * whatever a future ancestor does with transforms.
   *
   * Re-measured on scroll and resize because an absolute popup does not travel with a row that
   * scrolls underneath it.
   */
  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const container = portalTarget();
    if (!trigger || !container) return;
    const bounds = container.getBoundingClientRect();
    setPlacement(
      selectMenuPlacement(
        trigger.getBoundingClientRect(),
        { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height },
        choices.length,
      ),
    );
  }, [choices.length]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setHelpFor(null);
      setByKeyboard(false);
      return;
    }
    measure();
    /** The bubble is anchored to a row that just moved, so it is dismissed rather than chased. */
    const reposition = () => {
      setHelpFor(null);
      measure();
    };
    /** Capture: the scroll that moves this row is `.zs-scroll`'s, and it does not reach `window`. */
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, measure]);

  /** Every opening starts from what is selected, not from wherever the last visit was left. */
  useEffect(() => {
    if (isOpen) setActiveIndex(selectedIndex);
  }, [isOpen, selectedIndex]);

  /**
   * Focus follows the list's own mounting, not `isOpen`, because those are not the same moment.
   *
   * The popup renders on `isOpen && placement`, and `placement` is only filled in by the layout
   * effect above — so the very first open commits once WITHOUT a list, and React flushes that
   * commit's passive effects before it starts the re-render that adds one. An effect keyed on
   * `isOpen` therefore ran against a `listRef` that was still null, exactly once per mount: the
   * first time anyone opened the dropdown the keyboard stayed outside it, arrow keys scrolled the
   * panel instead of walking the options, and Escape sailed past to close Settings. Every
   * subsequent open worked, because by then `placement` was already set — which is precisely the
   * shape of bug that gets reported as "sometimes".
   *
   * A callback ref cannot miss it: it is called with the node the moment the node exists.
   */
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    node?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (isOpen) optionRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeIndex]);

  /**
   * Arrowing onto an option with a help sentence shows it; arrowing off it takes it away.
   *
   * Keyed on the sentence rather than on `choices`, which is rebuilt on every render and would
   * make this an effect that runs every time anything in the panel changes.
   */
  const activeHelp = choices[activeIndex]?.help;
  useEffect(() => {
    if (!isOpen || !byKeyboard) return;
    setHelpFor(activeHelp ? activeIndex : null);
  }, [isOpen, byKeyboard, activeIndex, activeHelp]);

  useLayoutEffect(() => {
    if (helpFor === null) {
      setTipAt(undefined);
      return;
    }
    const container = portalTarget();
    const list = listRef.current;
    const icon = helpIconRefs.current.get(helpFor);
    const tip = tipRef.current;
    if (!container || !list || !icon || !tip) return;
    const bounds = container.getBoundingClientRect();
    setTipAt(
      helpTipPlacement(
        icon.getBoundingClientRect(),
        list.getBoundingClientRect(),
        { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height },
        tip.offsetHeight,
      ),
    );
  }, [helpFor]);

  const close = useCallback((returnFocus = true) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const commit = useCallback(
    (index: number) => {
      const choice = choices[index];
      if (choice) item.onChange?.(choice.value);
      close();
    },
    [choices, item, close],
  );

  /**
   * Type-ahead: the affordance people use without knowing they use it. `d` jumps to Deutsch.
   *
   * The buffer accumulates only while typing stays brisk, so `d`,`e` refines to Deutsch while a
   * `d` a minute later starts over rather than searching for `dd`. Both rules live in
   * `./selectMenu`, where they can be tested.
   */
  const jumpToTyped = useCallback(
    (key: string) => {
      const now = Date.now();
      const state = typeAhead.current;
      state.buffer = nextTypeAheadBuffer(state.buffer, key, now - state.at);
      state.at = now;
      const hit = typeAheadIndex(choices, activeIndex, state.buffer);
      if (hit !== null) setActiveIndex(hit);
    },
    [activeIndex, choices],
  );

  const onListKeyDown = (event: React.KeyboardEvent) => {
    setByKeyboard(true);
    const step = (delta: number) => {
      event.preventDefault();
      setActiveIndex((index) => Math.min(choices.length - 1, Math.max(0, index + delta)));
    };
    switch (event.key) {
      case 'ArrowDown': return step(1);
      case 'ArrowUp': return step(-1);
      case 'PageDown': return step(5);
      case 'PageUp': return step(-5);
      case 'Home': event.preventDefault(); return setActiveIndex(0);
      case 'End': event.preventDefault(); return setActiveIndex(choices.length - 1);
      case 'Enter':
      case ' ':
        event.preventDefault();
        return commit(activeIndex);
      case 'Escape':
        /** Stopped, or the panel's own Escape closes Settings out from behind the dropdown. */
        event.preventDefault();
        event.stopPropagation();
        return close();
      case 'Tab':
        /** Tab commits everywhere else in this panel; leaving it a cancel here would surprise. */
        return commit(activeIndex);
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          jumpToTyped(event.key);
        }
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  const selected = choices[selectedIndex];
  const labelOf = (choice: { label: string; hint?: string }) =>
    choice.hint && choice.hint !== choice.label ? `${choice.label} · ${choice.hint}` : choice.label;

  return (
    <div className="zs-select">
      <button
        ref={triggerRef}
        type="button"
        className={`zs-select-trigger${isOpen ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-labelledby={`${item.key}-label`}
        aria-describedby={describedBy}
        /**
         * `onMouseDown`, not `onClick`, and the shade below depends on it.
         *
         * The shade covers the trigger while the list is open. If both used `click`, pressing the
         * trigger to dismiss would be: mousedown closes via the shade, the shade unmounts, then
         * mouseup lands on the now-uncovered trigger and reopens it — the dropdown flickers and
         * never closes. Deciding on mousedown means the shade has already swallowed the gesture
         * and the trigger never hears about it. The keyboard path is `onKeyDown` below, so nothing
         * is lost by not having a click handler.
         *
         * `preventDefault` is the other half, and it is about where the keyboard ends up. A
         * mousedown's default action focuses the button it landed on, and that happens after the
         * effect below has already moved focus into the list — so opening with the mouse left
         * focus sitting on the trigger, where arrow keys scrolled the panel instead of walking
         * the options and Escape reached the panel and closed Settings outright. Declining the
         * default focus leaves the list's own the only one, and closing still hands it back.
         */
        onMouseDown={(event) => {
          event.preventDefault();
          setIsOpen((open) => !open);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{selected ? labelOf(selected) : ''}</span>
        <ChevronDown size={14} strokeWidth={1.9} aria-hidden="true" />
      </button>

      {isOpen && placement && createPortal(
        <>
          {/*
            Catches the dismissing click, and nothing else.

            Transparent, and covering the shell, so that closing the popup is not also a click on
            whatever sat underneath it — dismissing a dropdown should never double as toggling the
            switch that happened to be behind it.
          */}
          <div className="zs-select-shade" role="presentation" onMouseDown={() => close(false)} />
          <motion.div
            id={listId}
            ref={attachList}
            className="zs-select-list"
            role="listbox"
            tabIndex={-1}
            aria-labelledby={`${item.key}-label`}
            aria-activedescendant={`${item.key}-option-${activeIndex}`}
            style={{ left: placement.left, top: placement.top, width: placement.width }}
            initial={reduceMotion ? false : { opacity: 0, y: placement.drop === 'down' ? -4 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] }}
            onKeyDown={onListKeyDown}
          >
            {choices.map((choice, index) => (
              <div
                key={choice.value}
                id={`${item.key}-option-${index}`}
                ref={(node) => {
                  if (node) optionRefs.current.set(index, node);
                  else optionRefs.current.delete(index);
                }}
                role="option"
                aria-selected={index === selectedIndex}
                /**
                 * The help sentence is part of what this option IS, so it belongs in the name a
                 * screen reader reads — the bubble below is how the same sentence reaches someone
                 * looking at the list, and neither should be the only way to get it.
                 */
                aria-label={choice.help ? `${choice.label}. ${choice.help}` : undefined}
                className={`zs-select-option${index === activeIndex ? ' is-active' : ''}`}
                /** Pointer moves the highlight; it does not move focus off the listbox. */
                onMouseMove={() => {
                  setByKeyboard(false);
                  setActiveIndex(index);
                }}
                onClick={() => commit(index)}
              >
                <b>{choice.label}</b>
                {choice.hint && choice.hint !== choice.label && <small>{choice.hint}</small>}
                {choice.help && (
                  /*
                    A span, not a button, and deliberately so: an option may not contain anything
                    focusable — a `<button>` inside `role="option"` breaks the listbox for the
                    assistive tech that would be the only thing to benefit from it, and it has
                    nothing to announce anyway once the sentence is already in the option's name.
                    What is left is a pointer affordance, which is exactly what this is.
                  */
                  <span
                    className="zs-select-help"
                    ref={(node) => {
                      if (node) helpIconRefs.current.set(index, node);
                      else helpIconRefs.current.delete(index);
                    }}
                    aria-hidden="true"
                    onMouseEnter={() => {
                      setByKeyboard(false);
                      setHelpFor(index);
                    }}
                    onMouseLeave={() => setHelpFor((open) => (open === index ? null : open))}
                  >
                    <HelpCircle size={13} strokeWidth={1.9} />
                  </span>
                )}
                <Check
                  size={14}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  /**
                   * Always drawn, invisible unless chosen, because the help mark sits beside it:
                   * a check that only exists on one row shortens that row's end by its own width
                   * and the marks come out on two different columns, which reads as a mistake
                   * rather than as a check.
                   */
                  className={index === selectedIndex ? undefined : 'is-blank'}
                />
              </div>
            ))}
          </motion.div>

          {helpFor !== null && choices[helpFor]?.help && (
            /*
              Hidden until placed, and never in the way once it is.

              `pointer-events: none` in the stylesheet is the backstop: the bubble is placed clear
              of the popup, but it appears under a pointer already on its way to a click, and a
              surface that swallowed that click would turn "read what this does" into "the option
              stopped responding".
            */
            <div
              ref={tipRef}
              className="zs-select-tip"
              role="presentation"
              style={{
                left: tipAt?.left ?? 0,
                top: tipAt?.top ?? 0,
                visibility: tipAt ? 'visible' : 'hidden',
              }}
            >
              {choices[helpFor].help}
            </div>
          )}
        </>,
        portalTarget() ?? document.body,
      )}
    </div>
  );
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
  /** Which dock icon the glyph picker is open for. Unused by every other editor kind. */
  const [dockIconItemId, setDockIconItemId] = useState<string | null>(null);
  /**
   * Whether a workspace opens as controls or as its file. Remembered per machine: someone who
   * edits the text does it every time, and a toggle that forgets is one more click every time.
   */
  const [workspaceView, setWorkspaceViewState] = useState<'visual' | 'file'>(() => {
    try {
      return window.localStorage.getItem(WORKSPACE_VIEW_KEY) === 'file' ? 'file' : 'visual';
    } catch {
      return 'visual';
    }
  });
  const fileEditorRef = useRef<WorkspaceFileEditorHandle>(null);
  const isFileView = editor.kind === 'workspace' && workspaceView === 'file';
  /** A draft in the file view is applied on the way out, and a broken one keeps the dialog open. */
  const flushFile = () => !isFileView || !fileEditorRef.current || fileEditorRef.current.flush();
  const setWorkspaceView = (next: 'visual' | 'file') => {
    if (next === workspaceView || !flushFile()) return;
    setWorkspaceViewState(next);
    try { window.localStorage.setItem(WORKSPACE_VIEW_KEY, next); } catch { /* per-session then */ }
  };
  const leave = () => { if (flushFile()) close(); };

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

  if (editor.kind === 'backKey') {
    title = 'Back key';
    description = 'One key, pressed on its own, to step out of a folder.';
    content = (
      <BackKeyRecorder
        value={config.radialBackKey}
        onChange={(next) => update('radialBackKey', next)}
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

  if (editor.kind === 'dockShortcuts') {
    const dock = normalizeShortcutDock(config.shortcutDock);
    title = 'Dock icons';
    description = 'What sits in the strip beside the open wheel. Drag to reorder.';
    /**
     * The glyph picker is held HERE rather than inside the list, by item ID and not by position:
     * the list reorders and deletes underneath it, and an index would quietly start editing the
     * neighbour. Same reason `WorkspaceManager` holds `iconEditItemId`.
     */
    const iconEditItem = dockIconItemId
      ? dock.items.find((item) => item.id === dockIconItemId) ?? null
      : null;
    /** By id, against the dock as it is when the patch lands — "Default" fetches after an await. */
    const patchDockItem = (id: string, patch: (item: AppItem) => Partial<AppItem> | null) =>
      setConfig((current) => {
        const latest = normalizeShortcutDock(current.shortcutDock);
        let changed = false;
        const items = latest.items.map((item) => {
          if (item.id !== id) return item;
          const next = patch(item);
          if (!next) return item;
          changed = true;
          return { ...item, ...next };
        });
        return changed ? { ...current, shortcutDock: { ...latest, items } } : current;
      });
    /** The dock has no healing pass, but the same rules keep the two editors saying the same thing. */
    const setDockGlyph = (item: AppItem, iconName: string) =>
      patchDockItem(item.id, () => ({
        iconName,
        iconSource: itemFindsOwnIcon(item) ? 'custom' : 'lucide',
        customIconUrl: undefined,
        customIconFile: undefined,
      }));
    const resetDockIcon = (item: AppItem) => {
      patchDockItem(item.id, () => ({
        iconName: itemDefaultGlyph(item),
        iconSource: 'lucide',
        customIconUrl: undefined,
        customIconFile: undefined,
      }));
      if (!itemFindsOwnIcon(item)) return;
      void resolveAutomaticIcon(item).then((found) => {
        if (found) patchDockItem(item.id, (now) => (now.iconSource === 'custom' || now.customIconUrl ? null : found));
      });
    };
    content = (
      <>
        <DockShortcutsManager
          dock={dock}
          onChange={(items) => update('shortcutDock', { ...dock, items })}
          showToast={showToast}
          onPickIcon={setDockIconItemId}
        />
        <AnimatePresence>
          {iconEditItem && (
            <IconPickerModal
              key="dock-icon"
              titleId="dock-icon-modal-title"
              title="Dock icon"
              hint={`Shown in the dock for “${iconEditItem.label || 'this shortcut'}”.`}
              selectedIcon={itemFallbackIcon(iconEditItem)}
              picture={iconEditItem.customIconUrl
                ? {
                    url: iconEditItem.customIconUrl,
                    file: iconEditItem.customIconFile,
                    label: itemIconSummary(iconEditItem).title,
                    custom: iconEditItem.iconSource === 'custom',
                  }
                : null}
              canReset={!itemIconIsDefault(iconEditItem)}
              onSelect={(iconName) => setDockGlyph(iconEditItem, iconName)}
              onPicture={(pick) =>
                patchDockItem(iconEditItem.id, () => ({
                  iconSource: 'custom',
                  customIconUrl: pick.url,
                  customIconFile: pick.file,
                }))}
              onReset={() => resetDockIcon(iconEditItem)}
              onClose={() => setDockIconItemId(null)}
            />
          )}
        </AnimatePresence>
      </>
    );
  }


  if (editor.kind === 'workspace') {
    const index = editor.index;
    const workspace = config.workspaces[index];
    if (!workspace) return null;
    title = workspace.name;
    description = isFileView
      ? 'Edit the whole workspace as text — to move it, share it or change many shortcuts at once.'
      : 'Organize shortcuts and control how this workspace behaves.';
    content = isFileView ? (
      <WorkspaceFileEditor
        ref={fileEditorRef}
        workspace={workspace}
        isActive={config.activeWorkspaceIndex === index}
        onApply={(patch) => updateWorkspace(index, patch)}
        showToast={showToast}
      />
    ) : (
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
        language={config.language}
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
    <div className="zs-editor-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) leave(); }}>
      <motion.div
        className={`zs-editor${editor.kind === 'workspace' || editor.kind === 'blocked' || editor.kind === 'dockShortcuts' ? ' is-workspace' : ''}`}
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
          <div className="zs-editor-head-actions">
            {editor.kind === 'workspace' && (
              <div className="zs-view-toggle" role="radiogroup" aria-label="Edit as">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!isFileView}
                  className={!isFileView ? 'is-selected' : ''}
                  data-tip="Edit visually"
                  aria-label="Edit visually"
                  onClick={() => setWorkspaceView('visual')}
                >
                  <LayoutList size={14} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isFileView}
                  className={isFileView ? 'is-selected' : ''}
                  data-tip="Edit as a file"
                  aria-label="Edit as a file"
                  onClick={() => setWorkspaceView('file')}
                >
                  <Braces size={14} strokeWidth={1.9} />
                </button>
              </div>
            )}
            <button type="button" className="zs-editor-close" onClick={leave} aria-label="Close">
              <X size={15} strokeWidth={1.9} />
            </button>
          </div>
        </header>
        <div className={`zs-editor-body${isFileView ? ' is-file' : ''}`}>{content}</div>
        <footer>
          <button type="button" className="zs-btn is-primary" onClick={leave}>Done</button>
        </footer>
      </motion.div>
    </div>
  );
}


const WORKSPACE_VIEW_KEY = 'rovyl.workspaceEditorView';

type WorkspaceAddMode = 'app' | 'url' | 'folder' | 'file' | 'command' | null;

const APPS_PAGE_SIZE = 40;

function itemTypeLabel(item: AppItem) {
  if (item.type === 'folder') return 'Group';
  if (item.commandType === 'url') return 'URL';
  if (item.commandType === 'folder') return 'Folder';
  if (item.commandType === 'file') return 'File';
  if (item.commandType === 'command') return 'Command';
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
  return 'Reads the executable once so Windows keeps it cached, which can shorten the first launch. Some apps show a splash or a second instance when reused, and unsupported ones fall back to a normal launch.';
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

/**
 * The Lucide glyph a shortcut draws when it has no bitmap of its own.
 *
 * A saved `iconName` comes FIRST, for every kind. Folders and URLs used to skip it and return
 * 'Folder'/'Globe' unconditionally, which made this panel disagree with the wheel: `RadialMenu`
 * has always drawn `getIcon(app.iconName)`, so a folder whose glyph had been changed showed the
 * new icon on the wheel and a generic folder in the list that changed it. The per-type names stay
 * as the fallback for items that carry no name at all (discovery writes `iconName: ''`).
 */
function itemFallbackIcon(item: AppItem) {
  const picked = item.iconName?.trim();
  if (picked) return picked;
  if (item.type === 'folder' || item.commandType === 'folder') return 'Folder';
  if (item.commandType === 'url') return 'Globe';
  if (item.commandType === 'file') return 'File';
  if (item.commandType === 'command') return DEFAULT_COMMAND_ICON;
  return 'AppWindow';
}

/** The glyph a folder shortcut wears until somebody picks another one. */
const DEFAULT_FOLDER_ICON = 'Folder';
/** And a command's. A typed line has no file to pull a bitmap from either. */
const DEFAULT_COMMAND_ICON = 'TerminalSquare';

/**
 * Whether Rovyl finds this shortcut a picture by itself: the program's icon, the document type's,
 * the site's favicon. For these, "Default" means that picture, and a glyph chosen instead has to
 * be marked as the user's (`iconSource: 'custom'`) or the healing pass would put the picture back.
 * Folders, commands and groups have no picture of their own — their glyph is the default.
 */
function itemFindsOwnIcon(item: AppItem): boolean {
  return item.type !== 'folder' && (item.commandType === 'app' || item.commandType === 'file' || item.commandType === 'url');
}

/** The glyph "Default" goes back to for this kind of shortcut — the one the add form gives it. */
function itemDefaultGlyph(item: AppItem) {
  if (item.type === 'folder' || item.commandType === 'folder') return DEFAULT_FOLDER_ICON;
  if (item.commandType === 'command') return DEFAULT_COMMAND_ICON;
  if (item.commandType === 'url') return 'Globe';
  if (item.commandType === 'file') return 'File';
  return 'AppWindow';
}

/** Whether the icon is still what the shortcut came with, so "Default" has nothing to undo. */
function itemIconIsDefault(item: AppItem): boolean {
  if (item.iconSource === 'custom') return false;
  if (itemFindsOwnIcon(item)) return true;
  return !item.customIconUrl && itemFallbackIcon(item) === itemDefaultGlyph(item);
}

/** One line naming the icon in force, for the Icon field. */
function itemIconSummary(item: AppItem): { title: string; detail: string } {
  if (item.iconSource === 'custom' && item.customIconUrl) {
    return { title: describeIconFile(item.customIconFile) || 'Custom picture', detail: 'Your own picture' };
  }
  if (item.iconSource === 'custom') return { title: itemFallbackIcon(item), detail: 'Your own glyph' };
  if (itemFindsOwnIcon(item)) {
    const title = item.commandType === 'url' ? 'Site icon' : item.commandType === 'file' ? 'File type icon' : 'Program icon';
    return { title, detail: 'Found automatically · click to choose your own' };
  }
  return { title: itemFallbackIcon(item), detail: 'Shown on the wheel' };
}

/** "Folder icon", "Website icon"… — the modal's title. */
function itemIconModalTitle(item: AppItem): string {
  if (item.type === 'folder') return 'Group icon';
  switch (item.commandType) {
    case 'url': return 'Website icon';
    case 'folder': return 'Folder icon';
    case 'file': return 'File icon';
    case 'command': return 'Command icon';
    default: return 'App icon';
  }
}

/**
 * The icon Rovyl would have found for this shortcut, fetched again after "Default". The healing
 * pass cannot be relied on for it: it tries each target once per session, and a shortcut whose icon
 * was already found this session counts as tried.
 */
async function resolveAutomaticIcon(item: AppItem): Promise<Partial<AppItem> | null> {
  try {
    if (item.commandType === 'url') {
      const icon = await resolveWebsiteIconFields(item.command);
      return icon?.customIconUrl ? { customIconUrl: icon.customIconUrl, iconSource: icon.iconSource } : null;
    }
    const url = await window.electron?.getFileIcon?.(item.command);
    return url ? { customIconUrl: url, iconSource: 'native' } : null;
  } catch {
    return null;
  }
}

/**
 * Which shell reads a command shortcut, and whether its window shows. Shared by the add form and the
 * row editor so the two cannot drift apart.
 */
function CommandRunOptions({
  shell,
  windowMode,
  onShell,
  onWindow,
}: {
  shell: 'powershell' | 'cmd';
  windowMode: 'open' | 'hidden';
  onShell: (value: 'powershell' | 'cmd') => void;
  onWindow: (value: 'open' | 'hidden') => void;
}) {
  return (
    <div className="zs-launch-options zs-command-options">
      <div>
        <b>Shell</b>
        <small>{shell === 'cmd' ? 'Runs with Command Prompt (cmd.exe).' : 'Runs with Windows PowerShell.'}</small>
      </div>
      <div className="zs-segmented" role="radiogroup" aria-label="Shell">
        {([['powershell', 'PowerShell'], ['cmd', 'Command Prompt']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={shell === value}
            className={shell === value ? 'is-selected' : ''}
            onClick={() => onShell(value)}
          >{label}</button>
        ))}
      </div>
      <div>
        <b>Window</b>
        <small>
          {windowMode === 'hidden'
            ? 'Runs in the background with no window. Errors in the first moments still show a card.'
            : 'Opens a console that stays open, so you can read the output.'}
        </small>
      </div>
      <div className="zs-segmented" role="radiogroup" aria-label="Window">
        {([['open', 'Open'], ['hidden', 'Hidden']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={windowMode === value}
            className={windowMode === value ? 'is-selected' : ''}
            onClick={() => onWindow(value)}
          >{label}</button>
        ))}
      </div>
    </div>
  );
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

/** The workspace's own icon: its picture when it has one, its glyph otherwise or if the picture is gone. */
function WorkspaceIconArt({ workspace }: { workspace: Workspace }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [workspace.pickerIconUrl]);
  if (workspace.pickerIconUrl && !failed) {
    return (
      <img
        src={workspace.pickerIconUrl}
        alt=""
        className="zs-workspace-icon-img"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  const Glyph = getIcon(workspace.pickerIconName?.trim() || 'Layers');
  return <Glyph size={24} strokeWidth={1.6} />;
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

/** A picture the item is drawn with right now — one the user chose, or one Rovyl found. */
interface PictureInForce extends CustomIconPick {
  /** What the footer calls it: a file name, "Program icon"… */
  label: string;
  /** Chosen by the user, as opposed to found automatically. */
  custom: boolean;
}

/**
 * The icon chooser, as a modal — the workspace's icon and every shortcut's go through it.
 *
 * Two tabs. Glyph is the Lucide grid it always was. Picture takes a file, a drop or a paste: a PNG,
 * an SVG, an .ico, or one of the icons inside a program or DLL (`CustomIconPanel`). Whichever was
 * used last is the icon; the other is kept only as the glyph a missing picture falls back to.
 *
 * Mounting IS opening: the caller holds the "which icon" state, `AnimatePresence` handles the exit,
 * and `onClose` is the only way out — the escape key, the backdrop, the X and Done all take it.
 */
function IconPickerModal({
  titleId,
  title,
  hint,
  selectedIcon,
  picture,
  canReset,
  onSelect,
  onPicture,
  onReset,
  onClose,
}: {
  titleId: string;
  title: string;
  hint: string;
  /** The glyph name in force — never empty; with a picture in force it is only the fallback. */
  selectedIcon: string;
  picture: PictureInForce | null;
  /** Whether "Default" has anything to undo. */
  canReset: boolean;
  onSelect: (iconName: string) => void;
  onPicture: (pick: CustomIconPick) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  /** A modal that only closes with the mouse is a modal that traps whoever uses the keyboard. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Opens where the icon in force lives: a shortcut wearing a picture is most likely after another. */
  const [tab, setTab] = useState<'glyph' | 'picture'>(picture ? 'picture' : 'glyph');
  const [pictureFailed, setPictureFailed] = useState(false);
  useEffect(() => setPictureFailed(false), [picture?.url]);
  const PickedIcon = getIcon(selectedIcon);
  const showPicture = Boolean(picture) && !pictureFailed;

  return (
    <motion.div
      className="zs-icon-modal-layer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
      role="presentation"
    >
      <motion.div
        className="zs-icon-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 4 }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        /** A click inside must not close what a click outside closes. */
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <b id={titleId}>{title}</b>
            <small>{hint}</small>
          </div>
          <button type="button" onClick={onClose} aria-label="Close icon picker">
            <X size={14} />
          </button>
        </header>
        <div className="zs-icon-modal-tabs">
          <div className="zs-segmented" role="tablist" aria-label="Icon kind">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'glyph'}
              className={tab === 'glyph' ? 'is-selected' : ''}
              onClick={() => setTab('glyph')}
            >
              <Shapes size={13} strokeWidth={1.8} /> Glyph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'picture'}
              className={tab === 'picture' ? 'is-selected' : ''}
              onClick={() => setTab('picture')}
            >
              <ImageGlyph size={13} strokeWidth={1.8} /> Picture
            </button>
          </div>
        </div>
        <div className="zs-icon-modal-body" role="tabpanel">
          {tab === 'glyph' ? (
            /** No cell lit while a picture is drawn: the glyph is not what the wheel shows. */
            <IconPicker selectedIcon={picture ? '' : selectedIcon} onSelect={onSelect} />
          ) : (
            <CustomIconPanel current={picture?.custom ? picture : null} onPick={onPicture} />
          )}
        </div>
        {/**
          * Picking writes straight through, so once a glyph was clicked the modal had
          * nothing left to do — and no way out but the X in its corner, which reads as
          * discarding rather than confirming. The footer names what is set and ends the
          * choice on a button, the way every other editor here does.
          */}
        <footer>
          <span className="zs-icon-modal-pick">
            {showPicture ? (
              <img src={picture!.url} alt="" draggable={false} onError={() => setPictureFailed(true)} />
            ) : (
              <PickedIcon size={16} strokeWidth={1.7} />
            )}
            <b>{showPicture ? picture!.label : selectedIcon}</b>
          </span>
          <span className="zs-icon-modal-acts">
            {canReset && (
              <button type="button" className="zs-btn" onClick={onReset}>
                <RotateCcw size={13} /> Default
              </button>
            )}
            <button type="button" className="zs-btn is-primary" onClick={onClose}>Done</button>
          </span>
        </footer>
      </motion.div>
    </motion.div>
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
  language,
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
  language?: string;
}) {
  const { t } = useTranslation(language);
  const [addMode, setAddMode] = useState<WorkspaceAddMode>(null);
  const [isMultiSelect, setIsMultiSelect] = useState(false);
  const [isAddingSelected, setIsAddingSelected] = useState(false);
  const [selectedAppPaths, setSelectedAppPaths] = useState<Set<string>>(() => new Set());
  const { apps: installedApps, loading: loadingApps, error: appsError, reload: loadInstalledApps } =
    useInstalledApps(addMode === 'app');
  const [appSearch, setAppSearch] = useState('');

  useEffect(() => {
    setSelectedAppPaths(new Set());
    setIsMultiSelect(false);
  }, [addMode]);
  const [url, setUrl] = useState('');
  const [urlLabel, setUrlLabel] = useState('');
  /** Once a name has been typed, the page's own title stops overwriting it. */
  const [urlLabelTyped, setUrlLabelTyped] = useState(false);
  const [urlTitleLoading, setUrlTitleLoading] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderLabel, setFolderLabel] = useState('');
  const [filePath, setFilePath] = useState('');
  const [fileLabel, setFileLabel] = useState('');
  const [commandLine, setCommandLine] = useState('');
  const [commandLabel, setCommandLabel] = useState('');
  const [commandDir, setCommandDir] = useState('');
  const [commandShell, setCommandShell] = useState<'powershell' | 'cmd'>('powershell');
  const [commandWindow, setCommandWindow] = useState<'open' | 'hidden'>('open');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false);
  /**
   * Which shortcut's icon the picker is open for, held by id rather than by position: the list
   * reorders and deletes underneath it, and an index would quietly start editing the neighbour.
   */
  const [iconEditItemId, setIconEditItemId] = useState<string | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nameInputRef = useRef<HTMLInputElement>(null);

  /** Failed-launch rescue: scroll the row in and flash its editor open. */
  useEffect(() => {
    if (!focusAppId) return;
    const matchIndex = workspace.apps.findIndex((app) => app.id === focusAppId);
    if (matchIndex === -1) return;
    setEditingIndex(matchIndex);
    const timer = window.setTimeout(() => {
      itemRefs.current.get(focusAppId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      onFocusApplied?.();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [focusAppId, onFocusApplied, workspace.apps]);

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
    setFilePath('');
    setFileLabel('');
    setCommandLine('');
    setCommandLabel('');
    setCommandDir('');
    setCommandShell('powershell');
    setCommandWindow('open');
    setEditingIndex(openEditor ? newIndex : null);
  };

  const addAppPath = async (path: string, label?: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    const displayName = label?.trim() || cleanPath.split(/[/\\]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, '') || 'Application';
    let customIconUrl: string | undefined;
    try { customIconUrl = (await window.electron?.getFileIcon?.(cleanPath)) || undefined; } catch { /* use fallback */ }
    const safeId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;

    const nextItem: AppItem = {
      id: safeId, type: 'app', label: displayName,
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

  const addSelectedApps = async () => {
    if (selectedAppPaths.size === 0 || isAddingSelected) return;
    const selectedList = installedApps.filter((item) => item.Path && selectedAppPaths.has(item.Path));
    if (selectedList.length === 0) return;

    setIsAddingSelected(true);
    try {
      const newItems: AppItem[] = await Promise.all(
        selectedList.map(async (item) => {
          const rawPath = item.Path!;
          const cleanPath = startMenuAppIdToLaunchCommand(rawPath).trim();
          const displayName = item.DisplayName || item.Name || 'Application';
          let customIconUrl: string | undefined;
          try {
            // Check iconCache by trying rawPath first (fastest cache hit from list view), then cleanPath
            customIconUrl =
              (await window.electron?.getFileIcon?.(rawPath)) ||
              (await window.electron?.getFileIcon?.(cleanPath)) ||
              undefined;
          } catch {
            /* fallback */
          }
          const safeId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;

          const nextItem: AppItem = {
            id: safeId,
            type: 'app',
            label: displayName,
            iconName: 'AppWindow',
            iconSource: customIconUrl ? 'native' : 'lucide',
            customIconUrl,
            command: cleanPath,
            commandType: 'app',
            description: 'Application',
          };

          let isIde = isIdeApp(nextItem);
          if (window.electron?.appSupportsRecents) {
            try {
              isIde = await window.electron.appSupportsRecents(nextItem.label, nextItem.command);
            } catch {
              /* keep */
            }
          }
          return isIde ? { ...nextItem, hasRecents: true, terminalCommands: [] } : nextItem;
        })
      );

      updateWorkspace(workspaceIndex, { apps: [...workspace.apps, ...newItems] });
      setSelectedAppPaths(new Set());
      setIsMultiSelect(false);
      setAddMode(null);
      setAppSearch('');
      showToast(newItems.length === 1 ? (t('shortcutsTitle') + ': +1') : `${t('shortcutsTitle')}: +${newItems.length}`);
    } catch (e) {
      console.error('Failed to add selected applications:', e);
    } finally {
      setIsAddingSelected(false);
    }
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

  /** `Quarterly report.xlsx` → `Quarterly report`. The icon already says which kind of file it is. */
  const fileNameLabel = (value: string) =>
    value.split(/[/\\]/).filter(Boolean).pop()?.replace(/\.[^.\s]+$/, '') || 'File';

  const chooseDocumentFile = async () => {
    /** `any` — the Application picker's `.exe`/`.lnk` filter would hide every document in the folder. */
    const path = await window.electron?.selectFile?.({ mode: 'any' });
    if (!path) return;
    setFilePath(path);
    if (!fileLabel) setFileLabel(fileNameLabel(path));
  };

  /**
   * A file shortcut wears the icon Windows gives its type, extracted the same way an app's is: the
   * shell hands back the default handler's document icon, so a `.psd` looks like a Photoshop file
   * rather than one more identical page glyph. The Lucide fallback covers extraction failing — and
   * `iconSource` is only set to 'native' when there is something to show, or the healing pass would
   * spend its retries chasing an icon that never existed.
   */
  const addFile = async () => {
    const cleanPath = filePath.trim();
    if (!cleanPath) return;
    let customIconUrl: string | undefined;
    try { customIconUrl = (await window.electron?.getFileIcon?.(cleanPath)) || undefined; } catch { /* use fallback */ }
    addItem({
      id: crypto.randomUUID(), type: 'app', label: fileLabel.trim() || fileNameLabel(cleanPath),
      iconName: 'File', iconSource: customIconUrl ? 'native' : 'lucide', customIconUrl,
      command: cleanPath, commandType: 'file', description: 'File shortcut',
    });
  };

  /** `npm run dev -- --port 3000` → `npm run dev`: short enough for a wheel label. */
  const commandNameLabel = (value: string) => {
    const words = value.trim().split(/\s+/).filter(Boolean);
    const head = words.slice(0, 3).join(' ');
    return head.length > 24 ? `${head.slice(0, 23).trimEnd()}…` : head || 'Command';
  };

  const chooseCommandDir = async () => {
    const path = await window.electron?.selectFolder?.();
    if (path) setCommandDir(path);
  };

  /**
   * A typed command line. Nothing is checked here beyond it being non-empty: the shell is the only
   * judge of what the line means, and a failed run comes back as a launch card like any other.
   */
  const addCommand = () => {
    const line = commandLine.trim();
    if (!line) return;
    const dir = commandDir.trim();
    addItem({
      id: crypto.randomUUID(), type: 'app', label: commandLabel.trim() || commandNameLabel(line),
      iconName: DEFAULT_COMMAND_ICON, iconSource: 'lucide', command: line,
      commandType: 'command', description: 'Command',
      commandShell, commandWindow,
      ...(dir ? { workingDirectory: dir } : {}),
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
   * The icon modal's writes, by id and against the workspace as it is when they land: a picture is
   * stored and a "Default" icon fetched after an await, and by then the list may have moved.
   */
  const patchItemById = (id: string, patch: (item: AppItem) => Partial<AppItem> | null) => {
    updateWorkspace(workspaceIndex, (current) => {
      let changed = false;
      const apps = current.apps.map((item) => {
        if (item.id !== id) return item;
        const next = patch(item);
        if (!next) return item;
        changed = true;
        return { ...item, ...next };
      });
      return changed ? { apps } : {};
    });
  };

  const setItemGlyph = (item: AppItem, iconName: string) => {
    patchItemById(item.id, () => ({
      iconName,
      /** On a shortcut that finds its own picture, a glyph is a choice the healing pass must leave alone. */
      iconSource: itemFindsOwnIcon(item) ? 'custom' : 'lucide',
      customIconUrl: undefined,
      customIconFile: undefined,
    }));
  };

  const setItemPicture = (item: AppItem, pick: CustomIconPick) => {
    patchItemById(item.id, () => ({ iconSource: 'custom', customIconUrl: pick.url, customIconFile: pick.file }));
  };

  const resetItemIcon = (item: AppItem) => {
    const glyph = itemDefaultGlyph(item);
    if (!itemFindsOwnIcon(item)) {
      patchItemById(item.id, () => ({ iconName: glyph, iconSource: 'lucide', customIconUrl: undefined, customIconFile: undefined }));
      return;
    }
    /** A site with no favicon is a glyph, not a wait; a program is 'native' so the wheel shows it is coming. */
    patchItemById(item.id, () => ({
      iconName: glyph,
      iconSource: item.commandType === 'url' ? 'lucide' : 'native',
      customIconUrl: undefined,
      customIconFile: undefined,
    }));
    void resolveAutomaticIcon(item).then((found) => {
      if (!found) return;
      /** Only onto the shortcut still waiting for it — not one that picked something else meanwhile. */
      patchItemById(item.id, (now) => (now.iconSource === 'custom' || now.customIconUrl ? null : found));
    });
  };

  const workspacePicture: PictureInForce | null = workspace.pickerIconUrl
    ? {
        url: workspace.pickerIconUrl,
        file: workspace.pickerIconFile,
        label: describeIconFile(workspace.pickerIconFile) || 'Custom picture',
        custom: true,
      }
    : null;

  /** The shortcut the icon picker is open for, looked up fresh so a stale id closes the modal. */
  const iconEditIndex = iconEditItemId
    ? workspace.apps.findIndex((item) => item.id === iconEditItemId)
    : -1;
  const iconEditItem = iconEditIndex === -1 ? null : workspace.apps[iconEditIndex];

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
            <WorkspaceIconArt workspace={workspace} />
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
          <IconPickerModal
            key="workspace-icon"
            titleId="ws-icon-modal-title"
            title="Workspace icon"
            hint="Shown in the wheel picker, and on the workspace card."
            selectedIcon={workspace.pickerIconName?.trim() || 'Layers'}
            picture={workspacePicture}
            canReset={Boolean(workspace.pickerIconUrl) || (workspace.pickerIconName?.trim() || 'Layers') !== 'Layers'}
            onSelect={(iconName) => updateWorkspace(workspaceIndex, {
              pickerIconName: iconName,
              pickerIconUrl: undefined,
              pickerIconFile: undefined,
            })}
            onPicture={(pick) => updateWorkspace(workspaceIndex, { pickerIconUrl: pick.url, pickerIconFile: pick.file })}
            onReset={() => updateWorkspace(workspaceIndex, {
              pickerIconName: undefined,
              pickerIconUrl: undefined,
              pickerIconFile: undefined,
            })}
            onClose={() => setIsIconPickerOpen(false)}
          />
        )}
      </AnimatePresence>

      {/**
       * And the same modal for one shortcut's icon. Folders needed it first — every one arrived
       * wearing the same `Folder` glyph — and now every kind has it: an app can wear another
       * program's icon, a site a logo, a command a picture.
       */}
      <AnimatePresence>
        {iconEditItem && (
          <IconPickerModal
            key="item-icon"
            titleId="item-icon-modal-title"
            title={itemIconModalTitle(iconEditItem)}
            hint={`Shown on the wheel for “${iconEditItem.label || 'this shortcut'}”.`}
            selectedIcon={itemFallbackIcon(iconEditItem)}
            picture={iconEditItem.customIconUrl
              ? {
                  url: iconEditItem.customIconUrl,
                  file: iconEditItem.customIconFile,
                  label: itemIconSummary(iconEditItem).title,
                  custom: iconEditItem.iconSource === 'custom',
                }
              : null}
            canReset={!itemIconIsDefault(iconEditItem)}
            onSelect={(iconName) => setItemGlyph(iconEditItem, iconName)}
            onPicture={(pick) => setItemPicture(iconEditItem, pick)}
            onReset={() => resetItemIcon(iconEditItem)}
            onClose={() => setIconEditItemId(null)}
          />
        )}
      </AnimatePresence>

      <section className="zs-workspace-shortcuts">
        <div className="zs-workspace-section-head">
          <div><h3>Shortcuts</h3></div>
          <div className="zs-add-actions" aria-label="Add shortcut">
            <button type="button" className={addMode === 'app' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'app' ? null : 'app')}><Monitor size={14} /> Application</button>
            <button type="button" className={addMode === 'url' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'url' ? null : 'url')}><Globe2 size={14} /> URL</button>
            <button type="button" className={addMode === 'folder' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'folder' ? null : 'folder')}><FolderOpen size={14} /> Folder</button>
            <button type="button" className={addMode === 'file' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'file' ? null : 'file')}><FileGlyph size={14} /> File</button>
            <button type="button" className={addMode === 'command' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'command' ? null : 'command')}><TerminalSquare size={14} /> Command</button>
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
                      <input value={appSearch} onChange={(event) => setAppSearch(event.target.value)} placeholder={t('searchApps')} />
                    </label>
                    <button
                      type="button"
                      className={`zs-btn${isMultiSelect ? ' is-primary' : ''}`}
                      onClick={() => {
                        setIsMultiSelect(!isMultiSelect);
                        if (isMultiSelect) setSelectedAppPaths(new Set());
                      }}
                      title={t('multiSelect')}
                    >
                      {isMultiSelect ? <CheckSquare size={14} /> : <Square size={14} />}
                      <span>{t('multiSelect')}</span>
                    </button>
                    {isMultiSelect && (
                      <button
                        type="button"
                        className="zs-btn"
                        onClick={() => {
                          if (selectedAppPaths.size === filteredApps.length && filteredApps.length > 0) {
                            setSelectedAppPaths(new Set());
                          } else {
                            setSelectedAppPaths(new Set(filteredApps.map((a) => a.Path).filter(Boolean) as string[]));
                          }
                        }}
                        title={selectedAppPaths.size === filteredApps.length ? t('clearSelection') : t('selectAll')}
                      >
                        {selectedAppPaths.size === filteredApps.length ? <Square size={13} /> : <CheckSquare size={13} />}
                        <span>{selectedAppPaths.size === filteredApps.length ? t('clearSelection') : t('selectAll')}</span>
                      </button>
                    )}
                    <button type="button" className="zs-btn" onClick={chooseAppFile}><FilePlus2 size={14} /> {t('chooseFile')}</button>
                  </div>
                  <div className="zs-installed-apps" onScroll={handleAppsScroll}>
                    {loadingApps ? (
                      <div className="zs-manager-empty"><Loader2 className="zs-spin" size={18} /> {t('loadingApps')}</div>
                    ) : visibleApps.length ? (
                      visibleApps.map((item, index) => {
                        const isSelected = item.Path ? selectedAppPaths.has(item.Path) : false;
                        if (isMultiSelect) {
                          return (
                            <button
                              type="button"
                              key={`${item.Path}-${index}`}
                              className={isSelected ? 'is-selected' : ''}
                              onClick={() => {
                                if (!item.Path) return;
                                setSelectedAppPaths((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(item.Path!)) next.delete(item.Path!);
                                  else next.add(item.Path!);
                                  return next;
                                });
                              }}
                            >
                              <NativeAppIcon path={item.Path} size={28} className="zs-installed-app-icon" fallback={<Monitor size={15} />} />
                              <div><b>{item.DisplayName || item.Name}</b><small>{item.Path}</small></div>
                              {isSelected ? (
                                <CheckSquare size={16} style={{ color: 'var(--zn-focus, #3b82f6)', flex: 'none' }} />
                              ) : (
                                <Square size={16} style={{ opacity: 0.45, flex: 'none' }} />
                              )}
                            </button>
                          );
                        }
                        return (
                          <button
                            type="button"
                            key={`${item.Path}-${index}`}
                            onClick={() => addAppPath(startMenuAppIdToLaunchCommand(item.Path!), item.DisplayName || item.Name)}
                          >
                            <NativeAppIcon path={item.Path} size={28} className="zs-installed-app-icon" fallback={<Monitor size={15} />} />
                            <div><b>{item.DisplayName || item.Name}</b><small>{item.Path}</small></div>
                            <Plus size={14} />
                          </button>
                        );
                      })
                    ) : appsError ? (
                      <div className="zs-manager-empty">
                        Could not list applications.
                        <button type="button" className="zs-btn" onClick={() => loadInstalledApps(true)}>{t('tryAgain')}</button>
                      </div>
                    ) : (
                      <div className="zs-manager-empty">{t('noAppsFound')} {t('chooseFile')}</div>
                    )}
                  </div>
                  {!loadingApps && installedApps.length > 0 && (
                    <div className="zs-add-panel-foot">
                      <span>
                        {isMultiSelect && selectedAppPaths.size > 0
                          ? `${selectedAppPaths.size} ${t('selectedCount')}`
                          : `${visibleApps.length} / ${filteredApps.length} ${t('appsCount')}`}
                      </span>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {isMultiSelect && selectedAppPaths.size > 0 && (
                          <button
                            type="button"
                            className="zs-btn is-primary"
                            disabled={isAddingSelected}
                            onClick={() => void addSelectedApps()}
                          >
                            {isAddingSelected ? <Loader2 size={13} className="zs-spin" /> : <Plus size={13} />}
                            <span>{t('addSelected')} ({selectedAppPaths.size})</span>
                          </button>
                        )}
                        <button type="button" onClick={() => loadInstalledApps(true)}>{t('reloadList')}</button>
                      </div>
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
              {addMode === 'file' && (
                <div className="zs-add-form">
                  <button type="button" className="zs-folder-picker" onClick={chooseDocumentFile}>
                    <FileGlyph size={20} />
                    <div><b>{filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : 'Select a file'}</b><small>{filePath || 'Opens with whatever Windows uses for that file type'}</small></div>
                    <ChevronRight size={15} />
                  </button>
                  <label className="zs-field"><span>Name</span><input value={fileLabel} onChange={(event) => setFileLabel(event.target.value)} placeholder="Name shown on the wheel" /></label>
                  <button type="button" className="zs-btn is-primary" disabled={!filePath} onClick={() => void addFile()}><Plus size={14} /> Add file</button>
                </div>
              )}
              {addMode === 'command' && (
                <div className="zs-add-form is-command">
                  <label className="zs-field is-wide">
                    <span>Command line</span>
                    <input
                      autoFocus
                      value={commandLine}
                      spellCheck={false}
                      onChange={(event) => setCommandLine(event.target.value)}
                      placeholder={commandShell === 'cmd' ? 'ipconfig /flushdns && pause' : 'git pull; npm run dev'}
                      onKeyDown={(event) => { if (event.key === 'Enter') addCommand(); }}
                    />
                  </label>
                  <label className="zs-field"><span>Name</span><input value={commandLabel} onChange={(event) => setCommandLabel(event.target.value)} placeholder={commandLine.trim() ? commandNameLabel(commandLine) : 'Name shown on the wheel'} onKeyDown={(event) => { if (event.key === 'Enter') addCommand(); }} /></label>
                  <div className="zs-field is-with-action">
                    <span>Run in</span>
                    <div className="zs-field-row">
                      <input value={commandDir} spellCheck={false} onChange={(event) => setCommandDir(event.target.value)} placeholder="Your user folder" aria-label="Working folder" />
                      <button type="button" className="zs-btn" onClick={() => void chooseCommandDir()}><FolderOpen size={13} /> Browse</button>
                    </div>
                  </div>
                  <CommandRunOptions
                    shell={commandShell}
                    windowMode={commandWindow}
                    onShell={setCommandShell}
                    onWindow={setCommandWindow}
                  />
                  <button type="button" className="zs-btn is-primary" disabled={!commandLine.trim()} onClick={addCommand}><Plus size={14} /> Add command</button>
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
              {/*
                The editor opens the row rather than replacing it, and brings itself into view:
                the pencil sits at the right of a row that is often the last one on screen, so the
                form it opens was frequently below the fold the instant it existed.
              */}
              <AnimatePresence initial={false}>
              {editingIndex === index && (
                <Collapse key="editor">
                  <div className="zs-workspace-item-editor">
                    <label className="zs-field"><span>Name</span><input value={item.label} onChange={(event) => updateItem(index, { label: event.target.value })} /></label>
                    {/*
                      Every shortcut chooses its icon. `div`, not `label`: the control is a
                      button, and a label wrapping one steals the click on half its surface.
                    */}
                    {(() => {
                      const summary = itemIconSummary(item);
                      return (
                        <div className="zs-field">
                          <span>Icon</span>
                          <button
                            type="button"
                            className="zs-icon-field-button"
                            onClick={() => setIconEditItemId(item.id)}
                            aria-label={`Change the icon for ${item.label}`}
                          >
                            <WorkspaceItemIcon item={item} />
                            <div>
                              <b>{summary.title}</b>
                              <small>{summary.detail}</small>
                            </div>
                            <Pencil size={13} aria-hidden />
                          </button>
                        </div>
                      );
                    })()}
                    {/*
                      Applications do not show the command: whoever added the shortcut already chose
                      the app, and the value is an AUMID (`Microsoft.WindowsTerminal_…!App`) that
                      tells nobody anything and only fills half a line. URL and folder stay editable
                      — there the value is readable and is the only way to fix the target.
                    */}
                    {item.type !== 'folder' && item.commandType === 'command' && (
                      <>
                        <label className="zs-field is-wide">
                          <span>Command line</span>
                          <input
                            value={item.command}
                            spellCheck={false}
                            onChange={(event) => updateItem(index, { command: event.target.value })}
                          />
                        </label>
                        <div className="zs-field is-with-action">
                          <span>Run in</span>
                          <div className="zs-field-row">
                            <input
                              value={item.workingDirectory || ''}
                              spellCheck={false}
                              placeholder="Your user folder"
                              aria-label="Working folder"
                              onChange={(event) => updateItem(index, { workingDirectory: event.target.value || undefined })}
                            />
                            <button
                              type="button"
                              className="zs-btn"
                              onClick={async () => {
                                const picked = await window.electron?.selectFolder?.();
                                if (picked) updateItem(index, { workingDirectory: picked });
                              }}
                            ><FolderOpen size={13} /> Browse</button>
                          </div>
                        </div>
                        <CommandRunOptions
                          shell={item.commandShell ?? 'powershell'}
                          windowMode={item.commandWindow ?? 'open'}
                          onShell={(value) => updateItem(index, { commandShell: value })}
                          onWindow={(value) => updateItem(index, { commandWindow: value })}
                        />
                      </>
                    )}
                    {item.type !== 'folder' && item.commandType !== 'app' && item.commandType !== 'file' && item.commandType !== 'command' && (
                      <label className="zs-field">
                        <span>{item.commandType === 'url' ? 'URL' : 'Folder path'}</span>
                        <input value={item.command} onChange={(event) => updateItem(index, { command: event.target.value })} />
                      </label>
                    )}
                    {/*
                      A file keeps the picker next to the field, because that is how the target got
                      there and because a re-pick is the whole repair when the document has moved.
                      The path stays typeable: correcting one folder name beats walking a dialog.
                    */}
                    {item.type !== 'folder' && item.commandType === 'file' && (
                      <label className="zs-field is-with-action">
                        <span>File path</span>
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
                              const picked = await window.electron?.selectFile?.({ mode: 'any' });
                              if (picked) updateItem(index, { command: picked });
                            }}
                          ><FolderOpen size={13} /> Change</button>
                        </div>
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
                    {/*
                      No launch mode for files, same reason folders have none: every one of the three
                      describes what to do with a PROCESS, and a document has none — Windows picks the
                      program, and `shell.openPath` is the only rung the launch ever gets.
                    */}
                    {item.type !== 'folder' && item.commandType !== 'folder' && item.commandType !== 'file' && item.commandType !== 'command' && (
                      <div className="zs-launch-options">
                        <div>
                          <b>Launch mode</b>
                          <small>
                            {item.commandType === 'url' && (item.launchMode ?? 'normal') === 'reuse'
                              ? 'Uses the existing default browser process when available.'
                              : (item.launchMode ?? 'normal') === 'prewarm'
                              ? 'Warms the Windows file cache for this app and reuses an existing process when supported.'
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
                    {/*
                      Main's answer arrives after the editor is already open, so this block appears
                      on its own — the one reveal in the panel nobody asked for by clicking. It
                      opens like the rest, and does not drag the form around while it does: what the
                      user is looking at is the name field above it.
                    */}
                    <AnimatePresence initial={false}>
                    {isIde && (
                      <Collapse key="ide" reveal={false}>
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
                      </Collapse>
                    )}
                    </AnimatePresence>
                  </div>
                </Collapse>
              )}
              </AnimatePresence>
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
              <div className="zs-manager-empty is-large"><SquareStack size={22} /><b>This workspace is empty</b><span>Add an application, URL, folder, file, or command above.</span></div>
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
/**
 * Records the single key that leaves a folder.
 *
 * Deliberately NOT `ShortcutRecorder`. That one goes through main — pause the global shortcut,
 * record at the OS level, probe whether Windows will hand the combination over — because a global
 * accelerator has to be reserved system-wide. This key is only ever read by the wheel's own keydown
 * handler while the wheel is open, so there is nothing to reserve and nobody to ask: capturing it
 * in the panel is the whole job.
 */
function BackKeyRecorder({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = normalizeBackKey(value);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      /** A bare modifier is the user still reaching for the key, not the key. Keep listening. */
      if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      /** Escape leaves the recorder rather than being refused as a reserved key. */
      if (e.key === 'Escape') {
        setRecording(false);
        setError(null);
        return;
      }
      const reason = rejectBackKey(e.key, e.ctrlKey, e.altKey, e.metaKey);
      if (reason) {
        setError(reason);
        /** Still recording: a refusal is an invitation to try another key, not a dead card. */
        return;
      }
      setRecording(false);
      setError(null);
      onChangeRef.current(normalizeBackKey(e.key));
    };
    /** Capture, so the panel's own shortcuts and focused controls do not eat the keystroke first. */
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [recording]);

  return (
    <div className="zs-shortcut">
      <div className="zs-shortcut-keys">
        {current ? <kbd>{current}</kbd> : <kbd>None</kbd>}
      </div>
      <button
        type="button"
        className={`zs-btn${recording ? '' : ' is-primary'}`}
        onClick={() => {
          setError(null);
          setRecording((on) => !on);
        }}
      >
        {recording ? 'Press any key… (Escape to stop)' : 'Record new key'}
      </button>
      {/* Both ways back to a sane state: the shipped default, or nothing at all. */}
      <button
        type="button"
        className="zs-btn"
        onClick={() => {
          setRecording(false);
          setError(null);
          onChange(current === BACK_KEY_OFF ? DEFAULT_BACK_KEY : BACK_KEY_OFF);
        }}
      >
        {current === BACK_KEY_OFF ? `Use ${DEFAULT_BACK_KEY}` : 'Remove key'}
      </button>
      {error && (
        <p className="zs-shortcut-note is-warn" role="status">
          <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

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
        {recording ? 'Press a key or mouse button…' : 'Record new shortcut'}
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
