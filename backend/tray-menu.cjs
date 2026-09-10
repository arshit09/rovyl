"use strict";

/**
 * The shape of the tray menu, with no Electron in it.
 *
 * The menu stopped being two fixed rows and became a function of state — which workspace is
 * current, whether the triggers are paused and for how much longer, whether this build has an
 * updater at all. That is logic, and logic that only exists inside `Menu.buildFromTemplate` can
 * only be checked by looking at a tray with the mouse. Here it is a value, and
 * `scripts/tray-menu-smoke.mjs` reads it.
 *
 * `Menu.buildFromTemplate` is still called by the main process; this only decides what to hand it.
 * Icons arrive already resolved (`NativeImage` or null) because resolving them needs `nativeTheme`,
 * and a null one is omitted rather than passed — a menu item with a bad `icon` throws.
 */

/** How long "pause" can mean. Minutes, because the label says minutes. */
const PAUSE_CHOICES = [15, 30, 60];

/** Present the key only when there is an image, since `icon: null` is not the same as no icon. */
const withIcon = (icon) => (icon ? { icon } : {});

/**
 * @param {object} state
 * @param {Array<{name?: string}>} state.workspaces
 * @param {number} state.activeWorkspaceIndex
 * @param {number} state.pausedUntil epoch ms; 0 or past means not paused
 * @param {number} state.now
 * @param {string} state.version
 * @param {boolean} state.canCheckUpdates
 * @param {Record<string, unknown>} state.icons resolved images by base name, any may be null
 * @param {object} actions every click handler, so this module never reaches for one
 */
function buildTrayMenuTemplate({
  workspaces = [],
  activeWorkspaceIndex = 0,
  pausedUntil = 0,
  now = Date.now(),
  version = "",
  canCheckUpdates = false,
  icons = {},
  actions = {},
}) {
  const paused = pausedUntil > now;
  /**
   * Rounded UP and floored at 1: a pause with forty seconds left is still a pause, and "0 min left"
   * is the one number this label must never show.
   */
  const minutesLeft = paused ? Math.max(1, Math.ceil((pausedUntil - now) / 60000)) : 0;

  const items = [
    {
      label: "Open wheel",
      ...withIcon(icons.wheel),
      click: actions.openWheel,
    },
  ];

  /** With one workspace there is nothing to switch between, so the submenu does not appear. */
  if (workspaces.length > 1) {
    items.push({
      label: "Workspace",
      ...withIcon(icons.spaces),
      submenu: workspaces.map((workspace, index) => ({
        label: (workspace && workspace.name) || `Workspace ${index + 1}`,
        type: "radio",
        checked: index === activeWorkspaceIndex,
        click: () => actions.switchWorkspace && actions.switchWorkspace(index),
      })),
    });
  }

  items.push({ type: "separator" });

  items.push({
    label: paused ? `Paused — ${minutesLeft} min left` : "Pause trigger",
    ...withIcon(icons.pause),
    submenu: paused
      ? [
          { label: "Resume now", click: () => actions.setPause && actions.setPause(0) },
          { type: "separator" },
          ...PAUSE_CHOICES.map((minutes) => ({
            label: `Restart for ${minutes} minutes`,
            click: () => actions.setPause && actions.setPause(minutes),
          })),
        ]
      : PAUSE_CHOICES.map((minutes) => ({
          label: `For ${minutes} minutes`,
          click: () => actions.setPause && actions.setPause(minutes),
        })),
  });

  items.push({ type: "separator" });

  items.push({
    label: "Open Settings",
    ...withIcon(icons.settings),
    click: actions.openSettings,
  });

  /**
   * Only where an update can actually happen: the Store owns updates for an MSIX build, and an
   * unpackaged one has no updater at all. Elsewhere the row could only ever fail.
   */
  if (canCheckUpdates) {
    items.push({
      label: "Check for updates",
      ...withIcon(icons.update),
      click: actions.checkForUpdates,
    });
  }

  items.push({ type: "separator" });
  /** Not a control: the one thing a bug report always needs and nobody can find. */
  items.push({ label: `Rovyl ${version}`, enabled: false });
  items.push({
    label: "Quit",
    ...withIcon(icons.power),
    click: actions.quit,
  });

  return items;
}

module.exports = { buildTrayMenuTemplate, PAUSE_CHOICES };
