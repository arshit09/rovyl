/**
 * The wheel's hotkey on a GNOME Wayland session.
 *
 * Electron's `globalShortcut` runs through XWayland there, and an X11 grab only sees a key while an
 * X11 window has focus — which is exactly "works while Rovyl is focused, silent everywhere else".
 * The one place that does see every key is the compositor, so the binding is handed to GNOME as a
 * custom keybinding that runs `rovyl --toggle`; the running copy takes the press through the
 * single-instance channel.
 *
 * Rovyl owns exactly one entry, at a path of its own. It never reads, edits or removes the user's
 * other custom shortcuts, only appends its path to the list and takes it out again.
 */
"use strict";

const { execFile } = require("node:child_process");

const SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const ENTRY_SCHEMA = `${SCHEMA}.custom-keybinding`;
const ENTRY_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/rovyl/";

const MODIFIERS = {
  ctrl: "<Control>", control: "<Control>", commandorcontrol: "<Control>", cmdorctrl: "<Control>",
  alt: "<Alt>", option: "<Alt>", shift: "<Shift>",
  super: "<Super>", meta: "<Super>", win: "<Super>", cmd: "<Super>", command: "<Super>",
};
const KEYS = {
  space: "space", tab: "Tab", enter: "Return", return: "Return", escape: "Escape", esc: "Escape",
  backspace: "BackSpace", delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "Page_Up", pagedown: "Page_Down", up: "Up", down: "Down", left: "Left", right: "Right",
  "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon",
  "'": "apostrophe", "`": "grave", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
  plus: "plus",
};

/** An Electron accelerator ("Alt+Shift+E") as GNOME writes it ("<Alt><Shift>e"), or null. */
function acceleratorToGnome(accelerator) {
  const parts = String(accelerator || "").split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop();
  let out = "";
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) return null;
    if (!out.includes(mod)) out += mod;
  }
  const lower = key.toLowerCase();
  let name = null;
  if (/^[a-z0-9]$/i.test(key)) name = lower;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) name = key.toUpperCase();
  else name = KEYS[lower] ?? null;
  return name ? out + name : null;
}

function isGnomeWayland(env = process.env) {
  return (
    process.platform === "linux" &&
    (env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY)) &&
    /gnome/i.test(env.XDG_CURRENT_DESKTOP || "")
  );
}

const gsettings = (args) =>
  new Promise((resolve, reject) => {
    execFile("gsettings", args, { timeout: 5000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim()),
    );
  });

/** gsettings parses its value argument as a GVariant, so a string has to arrive quoted. */
const variantString = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** `['/a/', '/b/']` or `@as []` → array of paths. */
const parsePathList = (text) => [...String(text).matchAll(/'([^']+)'/g)].map((m) => m[1]);
const formatPathList = (paths) => `[${paths.map((p) => `'${p}'`).join(", ")}]`;

async function setList(update) {
  const current = parsePathList(await gsettings(["get", SCHEMA, "custom-keybindings"]));
  const next = update(current);
  if (next.length === current.length && next.every((p, i) => p === current[i])) return;
  await gsettings(["set", SCHEMA, "custom-keybindings", formatPathList(next)]);
}

/** Creates or updates Rovyl's entry. `command` is run by GNOME, so it is the whole launch line. */
async function install(accelerator, command) {
  const binding = acceleratorToGnome(accelerator);
  if (!binding) throw new Error(`no GNOME form for '${accelerator}'`);
  const entry = `${ENTRY_SCHEMA}:${ENTRY_PATH}`;
  await gsettings(["set", entry, "name", variantString("Rovyl")]);
  await gsettings(["set", entry, "command", variantString(command)]);
  await gsettings(["set", entry, "binding", variantString(binding)]);
  await setList((list) => (list.includes(ENTRY_PATH) ? list : [...list, ENTRY_PATH]));
  return binding;
}

/** Takes Rovyl's entry out; leaves every other shortcut as it was. */
async function remove() {
  await setList((list) => list.filter((p) => p !== ENTRY_PATH));
  try {
    await gsettings(["reset-recursively", `${ENTRY_SCHEMA}:${ENTRY_PATH}`]);
  } catch (e) {
    /* nothing was stored */
  }
}

module.exports = { acceleratorToGnome, isGnomeWayland, install, remove, parsePathList, formatPathList };
