/**
 * Games installed through Heroic (Epic via legendary, GOG via gogdl), from the `installed.json`
 * each of them keeps. Two layouts exist in the wild — an object keyed by app name and an array —
 * and both are read.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseHeroicInstalled(json, runner) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return [];
  }
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data) : [];
  const games = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const appName = row.app_name || row.appName;
    const title = row.title || row.name;
    if (!appName || !title) continue;
    games.push({
      id: `heroic:${runner}:${appName}`,
      name: String(title),
      command: `heroic heroic://launch/${runner}/${appName}`,
      categories: ["Game"],
      kind: "game",
      source: "heroic",
    });
  }
  return games;
}

async function listHeroicGames(options = {}) {
  const configDir = options.configDir || path.join(os.homedir(), ".config", "heroic");
  const files = [
    ["legendary", path.join(configDir, "legendaryConfig", "legendary", "installed.json")],
    ["gog", path.join(configDir, "gogdlConfig", "heroic_gogdl", "installed.json")],
  ];
  const games = [];
  for (const [runner, file] of files) {
    try {
      games.push(...parseHeroicInstalled(await fs.promises.readFile(file, "utf8"), runner));
    } catch (e) {
      /* this store is not set up */
    }
  }
  return games;
}

module.exports = { parseHeroicInstalled, listHeroicGames };
