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
 * @param {string} state.updateState idle | checking | current | downloading | ready | error
 * @param {string|null} state.updateVersion version the updater is working on, when it knows one
 * @param {string|null} state.updateNotice current | error — the answer to a check started from this
 *   menu, held on the row for a moment before it goes back to being a button
 * @param {Record<string, unknown>} state.icons resolved images by base name, any may be null
 * @param {object} actions every click handler, so this module never reaches for one
 * @param {(key: string, vars?: Record<string, unknown>) => string} [state.t] the translator; the
 *   default is English read straight from the table, NOT `i18n.t`, so a caller that never passes
 *   one — `scripts/tray-menu-smoke.mjs` — gets the same labels whatever language the process is in
 */
const { TABLES } = require("./i18n.cjs");

/**
 * English, read from the table rather than through `i18n.t`, so it does not depend on whatever
 * language the process happens to be set to. This is only the default: `electron-main.js` passes
 * the real translator.
 */
function englishLabel(key, vars) {
  const value = TABLES.en[key] || key;
  if (!vars) return value;
  return String(value).replace(/\{(\w+)\}/g, (slot, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : slot,
  );
}

function buildTrayMenuTemplate({
  workspaces = [],
  activeWorkspaceIndex = 0,
  pausedUntil = 0,
  now = Date.now(),
  version = "",
  canCheckUpdates = false,
  updateState = "idle",
  updateVersion = null,
  updateNotice = null,
  icons = {},
  actions = {},
  t = englishLabel,
}) {
  const paused = pausedUntil > now;
  /**
   * Rounded UP and floored at 1: a pause with forty seconds left is still a pause, and "0 min left"
   * is the one number this label must never show.
   */
  const minutesLeft = paused ? Math.max(1, Math.ceil((pausedUntil - now) / 60000)) : 0;

  const items = [
    /**
     * Not a control: the one thing a bug report always needs and nobody can find. The mark rides
     * beside it for the same reason the settings foot carries one — at the head of the menu the
     * row has to say whose menu this is before it says which build.
     */
    { label: `Rovyl ${version}`, ...withIcon(icons.brand), enabled: false },
    { type: "separator" },
    {
      label: t("trayOpenWheel"),
      ...withIcon(icons.wheel),
      click: actions.openWheel,
    },
  ];

  /** With one workspace there is nothing to switch between, so the submenu does not appear. */
  if (workspaces.length > 1) {
    items.push({
      label: t("trayWorkspace"),
      ...withIcon(icons.spaces),
      submenu: workspaces.map((workspace, index) => ({
        label: (workspace && workspace.name) || t("trayWorkspaceN", { n: index + 1 }),
        type: "radio",
        checked: index === activeWorkspaceIndex,
        click: () => actions.switchWorkspace && actions.switchWorkspace(index),
      })),
    });
  }

  items.push({ type: "separator" });

  items.push({
    label: paused ? t("trayPausedLeft", { minutes: minutesLeft }) : t("trayPause"),
    ...withIcon(icons.pause),
    submenu: paused
      ? [
          { label: t("trayResume"), click: () => actions.setPause && actions.setPause(0) },
          { type: "separator" },
          ...PAUSE_CHOICES.map((minutes) => ({
            label: t("trayPauseRestart", { minutes }),
            click: () => actions.setPause && actions.setPause(minutes),
          })),
        ]
      : PAUSE_CHOICES.map((minutes) => ({
          label: t("trayPauseFor", { minutes }),
          click: () => actions.setPause && actions.setPause(minutes),
        })),
  });

  items.push({ type: "separator" });

  items.push({
    label: t("traySettings"),
    ...withIcon(icons.settings),
    click: actions.openSettings,
  });

  /**
   * Only where an update can actually happen: the Store owns updates for an MSIX build, and an
   * unpackaged one has no updater at all. Elsewhere the row could only ever fail.
   */
  if (canCheckUpdates) {
    /**
     * One row, whatever the updater is doing — never a "Check for updates" sitting next to an
     * update that is already downloaded. Mid-flight the row is a status line, not a button: there
     * is nothing to ask for while the answer is on its way.
     */
    if (updateState === "ready") {
      items.push({
        label: updateVersion
          ? t("trayUpdateReadyVersion", { version: updateVersion })
          : t("trayUpdateReady"),
        ...withIcon(icons.update),
        click: actions.installUpdate,
      });
    } else if (updateState === "downloading") {
      items.push({
        label: updateVersion
          ? t("trayDownloadingVersion", { version: updateVersion })
          : t("trayDownloading"),
        ...withIcon(icons.update),
        enabled: false,
      });
    } else if (updateNotice === "current" || updateNotice === "error") {
      /**
       * The answer, where the question was asked. Disabled for the same reason the status rows
       * are: pressing "you're up to date" means nothing, and a second check a second later would
       * only say it again.
       */
      items.push({
        label: updateNotice === "current" ? "You're on the latest version" : "Couldn't check for updates",
        ...withIcon(icons.update),
        enabled: false,
      });
    } else if (updateState === "checking") {
      items.push({
        label: t("trayChecking"),
        ...withIcon(icons.update),
        enabled: false,
      });
    } else {
      items.push({
        label: t("trayCheckUpdates"),
        ...withIcon(icons.update),
        click: actions.checkForUpdates,
      });
    }
  }

  items.push({ type: "separator" });
  items.push({
    label: t("trayQuit"),
    ...withIcon(icons.power),
    click: actions.quit,
  });

  return items;
}

module.exports = { buildTrayMenuTemplate, PAUSE_CHOICES };
