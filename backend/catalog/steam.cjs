/**
 * Steam games installed on this machine, read from the library files Steam itself keeps.
 *
 * Not an API anyone promised to keep stable, so every read is tolerant: a missing folder, an
 * unmounted second library or a half-written manifest costs that one entry, never the scan.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Tools Steam installs into the same folders; they are not games a person launches. */
const TOOL_NAME = /^(proton\b|steam linux runtime|steamworks common redistributables)/i;

/** Valve's text format: `"key" "value"` pairs and `"key" { … }` blocks. */
function parseVdf(text) {
  const tokens = String(text).match(/"(?:\\.|[^"\\])*"|[{}]/g) || [];
  let index = 0;
  const unquote = (token) => token.slice(1, -1).replace(/\\(.)/g, "$1");
  const readBlock = () => {
    const out = {};
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token === "}") return out;
      if (token === "{") continue;
      const key = unquote(token);
      const next = tokens[index];
      if (next === "{") {
        index++;
        out[key] = readBlock();
      } else if (next !== undefined && next !== "}") {
        index++;
        out[key] = unquote(next);
      }
    }
    return out;
  };
  return readBlock();
}

/** One `appmanifest_*.acf`, or null when it lacks an id or a name (or is cut off). */
function parseAcf(text) {
  const state = parseVdf(text).AppState;
  if (!state || !state.appid || !state.name) return null;
  return { appid: String(state.appid), name: String(state.name), installdir: String(state.installdir || "") };
}

function defaultRoots() {
  const home = os.homedir();
  return [
    path.join(home, ".local", "share", "Steam"),
    path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
}

async function libraryPaths(root) {
  const paths = new Set([root]);
  for (const file of [path.join(root, "steamapps", "libraryfolders.vdf"), path.join(root, "config", "libraryfolders.vdf")]) {
    try {
      const folders = parseVdf(await fs.promises.readFile(file, "utf8")).libraryfolders || {};
      for (const entry of Object.values(folders)) {
        if (entry && typeof entry === "object" && entry.path) paths.add(String(entry.path));
      }
    } catch (e) {
      /* no such file: this root simply has no extra libraries */
    }
  }
  return [...paths];
}

async function listSteamGames(options = {}) {
  const roots = options.roots || defaultRoots();
  const seen = new Set();
  const games = [];
  for (const root of roots) {
    for (const library of await libraryPaths(root)) {
      let names;
      try {
        names = await fs.promises.readdir(path.join(library, "steamapps"));
      } catch (e) {
        continue;
      }
      for (const name of names.filter((n) => /^appmanifest_\d+\.acf$/.test(n))) {
        let manifest = null;
        try {
          manifest = parseAcf(await fs.promises.readFile(path.join(library, "steamapps", name), "utf8"));
        } catch (e) {
          /* unreadable: skip it */
        }
        if (!manifest || TOOL_NAME.test(manifest.name) || seen.has(manifest.appid)) continue;
        seen.add(manifest.appid);
        games.push({
          id: `steam:${manifest.appid}`,
          name: manifest.name,
          command: `steam steam://rungameid/${manifest.appid}`,
          iconPath: `steam_icon_${manifest.appid}`,
          categories: ["Game"],
          kind: "game",
          source: "steam",
        });
      }
    }
  }
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { parseVdf, parseAcf, listSteamGames, TOOL_NAME };
