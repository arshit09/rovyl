const test = require("node:test");
const assert = require("node:assert");
const { listDesktopEntries } = require("./apps.cjs");
const catalog = require("./index.cjs");

const entry = (over) => ({ id: "x", name: "X", command: "x", categories: [], kind: "app", source: "desktop", ...over });

test("desktop entries: games are marked, NoDisplay dropped, args kept", () => {
  const list = listDesktopEntries([
    { id: "portal", name: "Portal 2", command: "steam", args: ["steam://rungameid/620"], icon: "steam_icon_620", categories: ["Game"], noDisplay: false },
    { id: "handler", name: "Handler", command: "h", args: [], categories: [], noDisplay: true },
    { id: "gimp", name: "GIMP", command: "gimp", args: [], categories: ["Graphics"], noDisplay: false },
  ]);
  assert.deepStrictEqual(list.map((e) => [e.name, e.kind]), [["Portal 2", "game"], ["GIMP", "app"]]);
  assert.strictEqual(list[0].command, "steam steam://rungameid/620");
});

test("a game store's own entry stays an app, a game that merely uses it stays a game", () => {
  const list = listDesktopEntries([
    { id: "steam", name: "Steam", command: "/usr/bin/steam", args: [], categories: ["Network", "Game"] },
    { id: "portal", name: "Portal 2", command: "steam", args: ["steam://rungameid/620"], categories: ["Game"] },
  ]);
  assert.deepStrictEqual(list.map((e) => e.kind), ["app", "game"]);
});

test("a pinned Steam game and its Steam entry are listed once, the desktop one kept", () => {
  const desktop = entry({ id: "desktop:portal", command: "steam steam://rungameid/620", kind: "game" });
  const steam = entry({ id: "steam:620", command: "steam steam://rungameid/620", kind: "game", source: "steam" });
  const other = entry({ id: "steam:730", command: "steam steam://rungameid/730", kind: "game", source: "steam" });
  const merged = catalog.mergeEntries([[desktop], [steam, other]]);
  assert.deepStrictEqual(merged.map((e) => e.id), ["desktop:portal", "steam:730"]);
});

test("one source failing leaves the others", async () => {
  if (process.platform !== "linux") return;
  const saved = { ...catalog.sources };
  catalog.sources.desktop = async () => { throw new Error("boom"); };
  catalog.sources.steam = async () => [entry({ id: "steam:1", command: "steam steam://rungameid/1", source: "steam", kind: "game" })];
  const warn = console.warn;
  console.warn = () => {};
  try {
    catalog.invalidateCatalog();
    const result = await catalog.getCatalog({ sources: { desktop: true, steam: true } });
    assert.deepStrictEqual(result.map((e) => e.id), ["steam:1"]);
  } finally {
    console.warn = warn;
    Object.assign(catalog.sources, saved);
    catalog.invalidateCatalog();
  }
});
