/**
 * The automatic workspaces — `src/utils/autoWorkspaces.ts`.
 * Run: node scripts/auto-workspaces-smoke.mjs
 *
 * What a person would notice: games that do not fit a ring split at the right number, apps land in
 * the folder a reader expects, nothing empty is drawn, and the off switches mean off.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-auto-ws-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "autoWorkspaces.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });
  const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  const on = { apps: true, games: true, sources: { desktop: true, steam: true, lutris: true, heroic: true } };
  const entry = (name, kind, categories = []) => ({ id: `t:${name}`, name, command: name.toLowerCase(), categories, kind, source: "desktop" });
  const games = (n) => Array.from({ length: n }, (_, i) => entry(`Game ${String.fromCharCode(65 + (i % 26))}${i}`, "game", ["Game"]));
  const count = (items) => items.reduce((sum, i) => sum + (i.children ? count(i.children) : 1), 0);

  // Games: 12 stays flat, 13 splits, every folder at most 12 and nothing lost.
  const flat = m.buildAutoWorkspaces(games(12), on, {}).find((w) => w.id === "auto-games");
  assert.equal(flat.apps.length, 12);
  assert.ok(flat.apps.every((a) => a.type !== "folder"), "12 games are not in folders");
  const split = m.buildAutoWorkspaces(games(13), on, {}).find((w) => w.id === "auto-games");
  assert.ok(split.apps.length >= 2 && split.apps.every((a) => a.type === "folder" && a.children.length <= 12));
  assert.equal(count(split.apps), 13);
  const names = split.apps.flatMap((f) => f.children.map((c) => c.label));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "A-Z across folders");

  // Apps: category folders in a fixed order, games excluded, empty folders omitted, unknown -> Other.
  const mixed = [
    entry("Firefox", "app", ["Network", "WebBrowser"]),
    entry("GIMP", "app", ["Graphics"]),
    entry("Weird", "app", ["X-Whatever"]),
    entry("Portal", "game", ["Game"]),
  ];
  const apps = m.buildAutoWorkspaces(mixed, on, {}).find((w) => w.id === "auto-apps");
  assert.deepEqual(apps.apps.map((f) => f.label), ["Internet", "Graphics", "Other"]);
  assert.equal(count(apps.apps), 3, "the game is not in All apps");

  // Switches and emptiness.
  assert.equal(m.buildAutoWorkspaces(mixed, { ...on, games: false }, {}).some((w) => w.id === "auto-games"), false);
  assert.equal(m.buildAutoWorkspaces(mixed, { ...on, apps: false }, {}).some((w) => w.id === "auto-apps"), false);
  assert.deepEqual(m.buildAutoWorkspaces([entry("Firefox", "app", ["Network"])], on, {}).map((w) => w.id), ["auto-apps"], "no games, no Games");
  assert.deepEqual(m.buildAutoWorkspaces([], on, {}), []);

  // Icons: a resolved one is used, a missing one falls back to a glyph.
  const withIcon = m.buildAutoWorkspaces([entry("Firefox", "app", ["Network"])], on, { "t:Firefox": "rovyl-icon://x.png" });
  const item = withIcon[0].apps[0].children[0];
  assert.equal(item.customIconUrl, "rovyl-icon://x.png");
  assert.equal(item.iconSource, "native");
  const noIcon = m.buildAutoWorkspaces([entry("Firefox", "app", ["Network"])], on, {})[0].apps[0].children[0];
  assert.equal(noIcon.iconSource, "lucide");

  // Wiring helpers.
  assert.equal(m.isAutoWorkspace({ id: "auto-games" }), true);
  assert.equal(m.isAutoWorkspace({ id: "workspace-1" }), false);
  const cfg = { workspaces: [{ id: "workspace-1" }] };
  assert.equal(m.withAutoWorkspaces(cfg, []), cfg, "nothing to add: same object");
  assert.deepEqual(m.withAutoWorkspaces(cfg, apps ? [apps] : []).workspaces.map((w) => w.id), ["workspace-1", "auto-apps"]);
  assert.equal(cfg.workspaces.length, 1, "the user's config is not mutated");

  console.log("auto-workspaces smoke: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
