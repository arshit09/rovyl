/**
 * Games installed through Lutris, asked of Lutris itself (`--list-games --json`) rather than by
 * opening its database, so a schema change on their side is not a break on ours.
 */
"use strict";

const { execFile } = require("node:child_process");

/** A row counts only when it is installed (`installed_at` set, or a directory) and has a name. */
function parseLutrisList(json) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.id != null && r.name && (r.installed_at || r.installed === true))
    .map((r) => ({
      id: `lutris:${r.id}`,
      name: String(r.name),
      command: `lutris lutris:rungameid/${r.id}`,
      categories: ["Game"],
      kind: "game",
      source: "lutris",
    }));
}

function listLutrisGames() {
  return new Promise((resolve) => {
    execFile("lutris", ["--list-games", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      /** Lutris prints log lines before the JSON on some versions; take from the first bracket. */
      const start = String(stdout).indexOf("[");
      resolve(start < 0 ? [] : parseLutrisList(String(stdout).slice(start)));
    });
  });
}

module.exports = { parseLutrisList, listLutrisGames };
