/**
 * `linux-apps` entries as catalog entries. This is the same discovery the app picker already uses;
 * only the shape changes, plus the one judgement the catalog adds: is this a game?
 */
"use strict";

/**
 * Game stores list themselves under Games in their own `.desktop` files. They are programs you
 * open, not games you play, so they stay in All apps.
 */
const LAUNCHERS = new Set(["steam", "steam-runtime", "lutris", "heroic", "heroic-games-launcher", "itch", "minigalaxy", "bottles"]);
const baseName = (command) => String(command).split("/").pop();

const quoteIfNeeded = (arg) => (/[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg);

function listDesktopEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.noDisplay !== true && e.command && (e.name || e.id))
    .map((e) => {
      const categories = Array.isArray(e.categories) ? e.categories : [];
      return {
        id: `desktop:${e.id || e.name}`,
        name: String(e.name || e.id),
        /** Arguments stay: a pinned Steam game is `steam steam://rungameid/N`, not `steam`. */
        command: [e.command, ...(Array.isArray(e.args) ? e.args : [])].map(quoteIfNeeded).join(" "),
        ...(e.icon ? { iconPath: String(e.icon) } : {}),
        categories,
        kind:
          categories.includes("Game") && !((!Array.isArray(e.args) || !e.args.length) && LAUNCHERS.has(baseName(e.command)))
            ? "game"
            : "app",
        source: "desktop",
      };
    });
}

module.exports = { listDesktopEntries };
