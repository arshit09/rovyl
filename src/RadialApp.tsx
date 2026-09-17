import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RadialMenu } from './components/RadialMenu';
import type { AppItem, Coordinates, UIConfig, Workspace } from './types';
import { DEFAULT_UI_CONFIG, MINIMAL_MAIN_WORKSPACE_APPS } from './defaults';
import { normalizeStoredConfig } from './configHydration';
import { preloadIconsByName } from './iconMap';
import { radialScrimNeedsFullBleed } from './utils/radialScrim';
import { useSystemStatus } from './components/ScreenDocks';
import {
  docksNeedFullBleed,
  normalizeShortcutDock,
  normalizeStatusDock,
  statusDockNeedsHelper,
} from './utils/screenDocks';
import type { DiscoveryPhase } from './discovery';

/**
 * The wheel's own renderer.
 *
 * It lives in a window of its own — `radial.html` in a transparent, always-on-top overlay that
 * Settings never shares. That is the whole point of the split, and almost everything this file does
 * NOT do is the evidence: there is no panel to keep alive under the wheel, no window to resize
 * between a dashboard rect and a monitor-sized one, no surface to vacate before a move, and no
 * stale DWM texture to cover, because this window has only ever painted one thing.
 *
 * It is also a strict READER of the config. `App.tsx`, in the settings window, is the only writer
 * and the only thing that touches disk. Anything the wheel changes — the active workspace, the
 * direction hint — it applies locally for the frame and then reports to main, which hands it to the
 * writer. One writer is what keeps two renderers from racing each other over the same file.
 */

/** Every Lucide glyph name a config can put on screen: shortcuts, folders, workspaces, centre button. */
function* iterateItemIconNames(items: AppItem[]): Generator<string | undefined> {
  for (const item of items) {
    yield item.iconName;
    if (item.children?.length) yield* iterateItemIconNames(item.children);
  }
}

function* iterateConfigIconNames(config: UIConfig, apps: AppItem[]): Generator<string | undefined> {
  yield config.centerButton?.iconName;
  /** The shortcut dock draws glyphs too, and it is on screen at the same moment the wheel is. */
  yield* iterateItemIconNames(config.shortcutDock?.items ?? []);
  yield* iterateItemIconNames(apps);
  for (const workspace of config.workspaces ?? []) {
    yield workspace.pickerIconName;
    yield* iterateItemIconNames(workspace.apps ?? []);
  }
}

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

export default function RadialApp() {
  /* zenith-verify:radial-handshake-renderer — the wheel's half of the open handshake; see scripts/verify-radial-windowing.mjs */
  const [config, setConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG);
  const configRef = useRef(config);
  configRef.current = config;

  const [apps, setApps] = useState<AppItem[]>(MINIMAL_MAIN_WORKSPACE_APPS);
  const [discoveryPhase, setDiscoveryPhase] = useState<DiscoveryPhase>('idle');
  const [updateReady, setUpdateReady] = useState(false);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isMenuOpenRef = useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;

  const [menuPosition, setMenuPosition] = useState<Coordinates>({ x: 0, y: 0 });
  const [radialClientSize, setRadialClientSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  /**
   * This window's top-left corner on screen, as main reported it in `open-menu`.
   *
   * The hold gesture's cursor samples arrive as absolute screen points and something has to turn
   * them into client ones. `window.screenX/Y` is still the wrong instrument even now that this
   * window is the wheel's alone: main has just moved it, possibly to another monitor, and the
   * renderer's copy of those metrics lags a frame behind the `setBounds` that put it there.
   */
  const [radialWindowOrigin, setRadialWindowOrigin] = useState<Coordinates | null>(null);
  const [triggerSource, setTriggerSource] = useState<'mmb' | 'mmb-click' | 'shortcut'>('shortcut');
  /** Remounts the visual tree on every open; no geometry/transition from the previous session survives. */
  const [radialMountKey, setRadialMountKey] = useState(0);
  /** Token prepared while still hidden, and token whose native window has already been revealed. */
  const [radialPendingPaintToken, setRadialPendingPaintToken] = useState<number | null>(null);
  const [radialNativeRevealToken, setRadialNativeRevealToken] = useState<number | null>(null);
  /** Invalidates an async open when the same trigger is used to close. */
  const radialTriggerGenerationRef = useRef(0);
  /** Stops the `click` generated after the `mouseup` that closed the wheel from reaching anything. */
  const radialClickShieldUntilRef = useRef(0);

  /* ------------------------------------------------------------------ */
  /* Config: read once, then follow the writer                           */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;

    const applyBlob = (blob: any) => {
      if (cancelled || !blob) return;
      const next = normalizeStoredConfig(blob.config ?? blob);
      setConfig(next);
      const mainWs = next.workspaces?.find((ws) => ws.id === 'workspace-1' || ws.name === 'Main');
      if (mainWs?.apps?.length) setApps(mainWs.apps);
      else if (Array.isArray(blob.apps) && blob.apps.length) setApps(blob.apps);
    };

    void window.electron?.getFullConfig?.().then(applyBlob).catch(() => undefined);
    /** The writer saved: take the new file rather than guessing what changed. */
    const off = window.electron?.onConfigChanged?.(applyBlob);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.electron?.onDiscoveryPhase?.((phase) => setDiscoveryPhase(phase));
    return () => off?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electron?.getUpdateState?.().then((state) => {
      if (!cancelled) setUpdateReady(state?.state === 'ready');
    }).catch(() => undefined);
    const off = window.electron?.onUpdateState?.((payload) => {
      setUpdateReady(payload?.state === 'ready');
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  /**
   * A config that only names curated glyphs never pays for the full Lucide chunk; one that does
   * — because the user picked something else in the icon picker — fetches it here, well before the
   * wheel opens, so the right glyph is already on screen at the first paint.
   */
  useEffect(() => {
    preloadIconsByName(iterateConfigIconNames(config, apps));
  }, [config, apps]);

  /* ------------------------------------------------------------------ */
  /* The docks                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Normalized once, here, and handed to everything that needs them.
   *
   * Two things read these and they must not disagree: the window geometry below, which decides
   * whether the overlay takes the whole monitor, and the wheel, which draws the docks in it. A
   * dock that believes it is placed in the screen's corner while the window is a box around the
   * wheel is a strip floating on a diagonal, and that divergence would be invisible in the code.
   */
  const statusDock = useMemo(() => normalizeStatusDock(config.statusDock), [config.statusDock]);
  const shortcutDock = useMemo(() => normalizeShortcutDock(config.shortcutDock), [config.shortcutDock]);

  /**
   * The live readings, held HERE rather than in the wheel.
   *
   * `RadialMenu` is remounted on every open — `radialMountKey` — so a reading kept inside it would
   * reset to "unknown" at the start of every gesture and the dock would paint blanks until the
   * next poll answered. This component survives every open the session has.
   */
  const systemStatus = useSystemStatus(statusDockNeedsHelper(statusDock));

  /* ------------------------------------------------------------------ */
  /* Geometry this window asks main for                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Size of the overlay window. Labels sit outside the icons; the gesture margin is what guarantees
   * that dragging to pick the direction (and the click that confirms it) stays inside the window —
   * mouse events come from the window, outside it the angle freezes and the selection never
   * confirms. Raise it if short.
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
       * its own edge has to stop being a box: main opens the overlay over the whole monitor instead.
       */
      fullBleed:
        radialScrimNeedsFullBleed(config.backdropOpacity) ||
        /**
         * The corner gear asks for the same thing, for the same reason: the box has no corners
         * worth the name. Placed in it, the gear floats a couple of hundred pixels off the wheel
         * on a diagonal — not in the corner of anything the user can see. Over the monitor, the
         * corner is the screen's.
         */
        config.showSettingsCorner === true ||
        /** And so does either dock, which is placed against a screen edge or is placed nowhere. */
        docksNeedFullBleed(statusDock, shortcutDock),
      /** Which monitor the wheel is born on — main needs it BEFORE an open. */
      monitor: config.radialMonitor === 'cursor' ? 'cursor' : 'primary',
      /** And where on it. Same reason: the box is placed before this renderer hears about the open. */
      placement: config.radialPlacement === 'cursor' ? 'cursor' : 'center',
      /**
       * The visible reach of the wheel — ring plus a whole tile, so the outer edge of an icon and
       * its label still land on the screen when the pointer is in a corner. Deliberately NOT the
       * gesture margin that `size` carries: clamping by that would push the wheel a quarter of a
       * screen away from the pointer and make the setting a lie.
       */
      ring: Math.round(radius + icon),
    });
  }, [
    config.menuRadius,
    config.iconSize,
    config.backdropOpacity,
    config.showSettingsCorner,
    config.radialMonitor,
    config.radialPlacement,
    statusDock,
    shortcutDock,
  ]);

  /**
   * Click-free execution: this renderer is the one that knows it is on, but the one that has to
   * park the pointer at the centre of the wheel is main — the warp happens before `open-menu`, and
   * so before the wheel exists here.
   */
  useEffect(() => {
    window.electron?.setRadialCursorCapture?.(config.radialInstantActivate === 'dwell');
  }, [config.radialInstantActivate]);

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */

  const handleMenuCloseRef = useRef<
    ((selectedId: string | null, selectedApp?: AppItem | null) => void) | null
  >(null);

  /** True when a new trigger should close the wheel instead of opening it. */
  const closeMenuFromTrigger = useCallback(() => {
    if (!isMenuOpenRef.current) return false;
    radialTriggerGenerationRef.current += 1;
    /** RadialMenu swallows any pending mouseup from this gesture without confirming the active slice. */
    window.dispatchEvent(new CustomEvent('zenith-radial-toggle-close'));
    handleMenuCloseRef.current?.(null);
    return true;
  }, []);

  /**
   * Main has already put this window exactly where the wheel goes and it is still hidden: all that
   * is left is to draw, confirm the paint, and let main reveal an HWND that is already correct.
   *
   * Compare with what this used to be, when one window served both surfaces: a resize awaited
   * across an IPC, a panel rect remapped into client coordinates, an opaque cover over the old
   * texture, and a second pass through the whole function after the panel had been emptied off the
   * compositor. None of it survives, because none of it was ever about the wheel.
   */
  const openMenu = useCallback((data: {
    clientPosition?: Coordinates | null;
    clientSize?: { width: number; height: number } | null;
    windowOrigin?: Coordinates | null;
    source?: 'mmb' | 'mmb-click' | 'shortcut';
    paintToken?: number;
  }) => {
    radialTriggerGenerationRef.current += 1;

    const clientSize = data.clientSize ?? { width: window.innerWidth, height: window.innerHeight };
    /** The wheel is always born at the centre of its own window; main sizes the window, not the wheel. */
    const clientPosition =
      data.clientPosition ?? { x: clientSize.width / 2, y: clientSize.height / 2 };

    flushSync(() => {
      setIsMenuOpen(true);
      setRadialMountKey((key) => key + 1);
      setTriggerSource(data.source ?? 'shortcut');
      setMenuPosition(clientPosition);
      setRadialClientSize(clientSize);
      setRadialWindowOrigin(data.windowOrigin ?? null);
      setRadialPendingPaintToken(
        typeof data.paintToken === 'number' ? data.paintToken : null,
      );
    });

    /**
     * The native window is still hidden. One rAF followed by a task confirms the paint of the
     * zero-alpha frame; two full rAFs made the open noticeably slow.
     */
    if (typeof data.paintToken === 'number') {
      const paintToken = data.paintToken;
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          window.electron?.notifyRadialOpenPaintDone?.(paintToken);
        }, 0);
      });
    }

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  useEffect(() => {
    const cleanupMenu = window.electron?.onOpenMenu?.((data: any) => {
      if (data?.closeOnly) {
        closeMenuFromTrigger();
        return;
      }
      /** Second MMB / shortcut with the wheel already open: toggle (close) instead of reopening. */
      if (closeMenuFromTrigger()) return;
      openMenuRef.current({
        clientPosition: data?.clientPosition ?? null,
        clientSize: data?.clientSize ?? null,
        windowOrigin: data?.windowOrigin ?? null,
        source: data?.source ?? 'shortcut',
        paintToken: data?.paintToken,
      });
    });

    const cleanupRevealed = window.electron?.onRadialNativeRevealed?.((paintToken) => {
      setRadialNativeRevealToken(paintToken);
    });

    const cleanupMouseUp = window.electron?.onMouseUp?.(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 1 }));
    });

    /** Main hid the overlay behind this renderer's back (game mode, quit, a lost gesture). */
    const cleanupHidden = window.electron?.onRadialHidden?.(() => {
      setIsMenuOpen(false);
      setRadialPendingPaintToken(null);
    });

    const cleanupCleanMemory = window.electron?.onCleanMemory?.(() => {
      if (typeof (window as any).gc === 'function') {
        try {
          (window as any).gc();
        } catch (_) {
          /* ignore */
        }
      }
    });

    return () => {
      cleanupMenu?.();
      cleanupRevealed?.();
      cleanupMouseUp?.();
      cleanupHidden?.();
      cleanupCleanMemory?.();
    };
  }, [closeMenuFromTrigger]);

  /** Nothing outside the wheel may receive the click that closed it. */
  useEffect(() => {
    const blockClickThrough = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const belongsToRadial = !!target?.closest('[data-zenith-radial-modal="true"]');
      if (isMenuOpenRef.current && belongsToRadial) return;
      if (!isMenuOpenRef.current && Date.now() > radialClickShieldUntilRef.current) return;
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isMenuOpenRef.current) {
        handleMenuCloseRef.current?.(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Workspaces                                                          */
  /* ------------------------------------------------------------------ */

  const targetWorkspaceIndexRef = useRef(config.activeWorkspaceIndex);
  targetWorkspaceIndexRef.current = config.activeWorkspaceIndex;
  const switchDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Applied here for the frame, reported to main for the file.
   *
   * The wheel cannot wait for a round trip through the writer to redraw — the gesture is still in
   * the user's hand. So the switch is local and immediate, and the `config-changed` that comes back
   * a moment later carries the same index this already set.
   */
  const handleWorkspaceSwitch = useCallback((workspaceIndex: number) => {
    const configData = configRef.current;
    if (workspaceIndex < 0 || workspaceIndex >= configData.workspaces.length) return;
    const workspace = configData.workspaces[workspaceIndex];
    if (!workspace || !workspace.enabled) return;
    if (workspaceIndex === targetWorkspaceIndexRef.current) return;
    targetWorkspaceIndexRef.current = workspaceIndex;

    if (switchDebounceTimer.current) clearTimeout(switchDebounceTimer.current);
    /** 80ms: imperceptible for single presses, collapses rapid sequences into one switch. */
    switchDebounceTimer.current = setTimeout(() => {
      const index = targetWorkspaceIndexRef.current;
      setConfig((prev) => ({ ...prev, activeWorkspaceIndex: index }));
      window.electron?.radialWorkspaceChanged?.(index);
      switchDebounceTimer.current = null;
    }, 80);
  }, []);

  useEffect(() => {
    const cleanup = window.electron?.onSwitchWorkspace?.((index: number) => {
      handleWorkspaceSwitch(index);
    });
    return () => cleanup?.();
  }, [handleWorkspaceSwitch]);

  /**
   * The direction-mode hint has had its showing and does not come back. One-way, and reported to
   * the writer rather than saved here.
   */
  const handleDirectionHintSeen = useCallback(() => {
    if (configRef.current.hasSeenDirectionHint === true) return;
    setConfig((current) =>
      current.hasSeenDirectionHint === true
        ? current
        : { ...current, hasSeenDirectionHint: true },
    );
    window.electron?.radialDirectionHintSeen?.();
  }, []);

  /* ------------------------------------------------------------------ */
  /* Launching                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The card that reports a failed launch belongs to Settings, and Settings is another window now.
   *
   * That is not a downgrade: it was already the case that a failure during a wheel-only session had
   * nowhere to be dismissed, so the card waited for a panel to appear. It still waits — the writer
   * just holds it in the other process, and shows it the moment Settings is on screen.
   */
  const reportLaunchFailure = useCallback((
    result: { ok: false; error: string; details?: unknown },
    item?: AppItem,
  ) => {
    console.error('Execution failed:', result.error);
    const cfg = configRef.current;
    const workspaceIndex = cfg.activeWorkspaceIndex;
    const workspaceApps = cfg.workspaces[workspaceIndex]?.apps || [];
    const rootId = item ? findRootAncestorId(workspaceApps, item.id) : undefined;
    window.electron?.reportRadialLaunchFault?.({
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
  }, []);

  const executeAction = useCallback((
    command: string,
    commandType: 'app' | 'url' | 'folder' | 'file' | 'command',
    itemForFault?: AppItem,
    options?: {
      openTerminal?: boolean;
      terminalCommands?: string[];
      workingDirectory?: string;
      launchMode?: 'normal' | 'reuse' | 'prewarm';
      commandShell?: 'powershell' | 'cmd';
      commandWindow?: 'open' | 'hidden';
    },
  ) => {
    if (!command) return;
    /** Internal widgets (Notes / Alarm / Stopwatch / Pomodoro) were removed — ignore leftovers. */
    if (command.startsWith('internal:')) return;
    if (!window.electron) return;

    void Promise.resolve(window.electron.executeCommand(command, commandType, options))
      .then((result) => {
        if (!result || result.ok !== false) return;
        reportLaunchFailure(result as { ok: false; error: string; details?: unknown }, itemForFault);
      })
      .catch((error) => {
        /** A rejection means the IPC itself broke; the ladder answers with `ok: false` instead. */
        reportLaunchFailure(
          { ok: false, error: `Unexpected error while running command: ${error?.message || error}` },
          itemForFault,
        );
      });
  }, [reportLaunchFailure]);

  const handleMenuClose = useCallback((selectedId: string | null, selectedApp?: AppItem | null) => {
    const cfg = configRef.current;
    const currentWorkspaceApps = cfg.workspaces[cfg.activeWorkspaceIndex]?.apps || apps;

    radialClickShieldUntilRef.current = Date.now() + 400;
    setIsMenuOpen(false);
    setRadialPendingPaintToken(null);

    /** The overlay goes back to being an invisible, click-through box on the desktop. */
    window.electron?.closeRadial?.();

    if (!selectedId) return;

    if (selectedId === '__CENTER__') {
      const centerConfig = cfg.centerButton;
      if (centerConfig.type === 'cancel') return;
      if (centerConfig.type === 'app' || centerConfig.type === 'widget') {
        const targetApp = findAppRecursive(currentWorkspaceApps, centerConfig.target);
        const command = targetApp ? targetApp.command : centerConfig.target;
        executeAction(command, targetApp?.commandType || 'app', targetApp, {
          openTerminal: targetApp?.openTerminal,
          terminalCommands: targetApp?.terminalCommands,
          workingDirectory: targetApp?.workingDirectory,
          launchMode: targetApp?.launchMode,
          commandShell: targetApp?.commandShell,
          commandWindow: targetApp?.commandWindow,
        });
        return;
      }
      if (centerConfig.type === 'command') {
        executeAction(centerConfig.target, centerConfig.commandType || 'app');
      }
      return;
    }

    const app = selectedApp ?? findAppRecursive(currentWorkspaceApps, selectedId);
    if (app) {
      executeAction(app.command, app.commandType || 'app', app, {
        openTerminal: app.openTerminal,
        terminalCommands: app.terminalCommands,
        workingDirectory: app.workingDirectory,
        launchMode: app.launchMode,
        commandShell: app.commandShell,
        commandWindow: app.commandWindow,
      });
    }
  }, [apps, executeAction]);

  handleMenuCloseRef.current = handleMenuClose;

  /**
   * The corner gear.
   *
   * The wheel comes down through its own close path first — that is what tells main the overlay is
   * idle again and puts the taskbar back — and only then is Settings asked for. `toggle-settings`
   * would take the wheel down by itself (`forceCloseRadial`), but from behind this renderer's
   * back, leaving it to hear about its own close over IPC.
   */
  const handleOpenSettings = useCallback(() => {
    handleMenuCloseRef.current?.(null);
    window.electron?.toggleSettings?.();
  }, []);

  /* ------------------------------------------------------------------ */

  const radialApps = useMemo(() => {
    const w = config.workspaces[config.activeWorkspaceIndex];
    return w?.apps?.length ? w.apps : apps;
  }, [config.workspaces, config.activeWorkspaceIndex, apps]);

  const radialCurrentWorkspace: Workspace | undefined = useMemo(
    () => config.workspaces[config.activeWorkspaceIndex],
    [config.workspaces, config.activeWorkspaceIndex],
  );

  return (
    <div
      className="fixed inset-0 w-full h-full overflow-hidden cursor-default select-none bg-transparent"
      onContextMenu={(e) => {
        e.preventDefault();
        if (isMenuOpen) handleMenuCloseRef.current?.(null);
      }}
    >
      <RadialMenu
        key={radialMountKey}
        isOpen={isMenuOpen}
        position={menuPosition}
        viewportSize={radialClientSize}
        onClose={handleMenuClose}
        apps={radialApps}
        config={config}
        triggerSource={triggerSource}
        windowOrigin={radialWindowOrigin}
        updateReady={updateReady}
        discoveryPhase={discoveryPhase}
        onWorkspaceSwitch={handleWorkspaceSwitch}
        onDirectionHintSeen={handleDirectionHintSeen}
        onOpenSettings={handleOpenSettings}
        systemStatus={systemStatus}
        currentWorkspace={radialCurrentWorkspace}
        animationReady={
          radialPendingPaintToken === null ||
          radialNativeRevealToken === radialPendingPaintToken
        }
      />
    </div>
  );
}
