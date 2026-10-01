/**
 * The catalog: every installed app and every game Rovyl can find, as one de-duplicated list.
 *
 * Sources are independent and best-effort — one failing costs its own entries and a log line,
 * never the rest. The result is cached by which sources are on, so the wheel opening is not a scan.
 */
"use strict";

const { listDesktopEntries } = require("./apps.cjs");
const { listSteamGames } = require("./steam.cjs");
const { listLutrisGames } = require("./lutris.cjs");
const { listHeroicGames } = require("./heroic.cjs");

/** Priority order: the first source to claim a launch command keeps it. */
const SOURCE_ORDER = ["desktop", "steam", "lutris", "heroic"];

const sources = {
  desktop: async (force) => listDesktopEntries(await require("../linux-apps.cjs").listInstalledApps({ force })),
  steam: () => listSteamGames(),
  lutris: () => listLutrisGames(),
  heroic: () => listHeroicGames(),
};

const normalise = (command) => String(command || "").trim().toLowerCase().replace(/\s+/g, " ");
const steamAppId = (command) => /steam:\/\/rungameid\/(\d+)/i.exec(String(command || ""))?.[1] ?? null;

/** Lists in priority order in, one list out; a command (or a Steam appid) is kept once. */
function mergeEntries(lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of list) {
      const keys = [normalise(entry.command)];
      const appId = steamAppId(entry.command);
      if (appId) keys.push(`steam:${appId}`);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      merged.push(entry);
    }
  }
  return merged;
}

let cached = null;
let cachedKey = "";
let inFlight = null;

async function getCatalog(options = {}) {
  if (process.platform !== "linux") return [];
  const enabled = options.sources || {};
  const names = SOURCE_ORDER.filter((name) => enabled[name]);
  const key = names.join(",");
  if (!options.force && cached && cachedKey === key) return cached;
  if (inFlight && inFlight.key === key && !options.force) return inFlight.promise;

  const promise = (async () => {
    const settled = await Promise.allSettled(names.map((name) => sources[name](Boolean(options.force))));
    const lists = settled.map((result, i) => {
      if (result.status === "fulfilled" && Array.isArray(result.value)) return result.value;
      if (result.status === "rejected") console.warn(`[Catalog] ${names[i]} failed: ${result.reason?.message || result.reason}`);
      return [];
    });
    cached = mergeEntries(lists);
    cachedKey = key;
    return cached;
  })().finally(() => {
    inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}

function invalidateCatalog() {
  cached = null;
  cachedKey = "";
}

module.exports = { getCatalog, invalidateCatalog, mergeEntries, sources };
