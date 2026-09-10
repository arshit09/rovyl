/**
 * `filterRadialApps` — the whole of the wheel's type-ahead.
 *
 * Past about a dozen shortcuts a slice is 30° or less and aiming stops being a skill; typing
 * narrows the ring until the slices are wide again. The narrowing sits between the level state and
 * everything that reads it, so a mistake here is not a wrong list — it is a wrong RING: the layout,
 * the hit-testing and the dwell timer all take their item count from this and would agree with each
 * other about the wrong thing.
 *
 * The order matters as much as the membership. A ring that reshuffles on each keystroke cannot be
 * aimed at, which was the point of filtering.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-radial-filter-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "workspaceRadial.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { filterRadialApps, radialCrowding } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  const app = (label) => ({ id: label, type: "app", label, command: "", iconName: "" });
  const RING = [
    "Google Chrome",
    "Visual Studio Code",
    "Discord",
    "Telegram",
    "Spotify",
    "Steam",
    "Slack",
  ].map(app);
  const labels = (items) => items.map((i) => i.label);

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  check(() => assert.deepEqual(labels(filterRadialApps(RING, "")), labels(RING), "empty query keeps the ring"));
  check(() => assert.equal(filterRadialApps(RING, ""), RING, "empty query returns the SAME array — no re-render, no relayout"));
  check(() => assert.deepEqual(labels(filterRadialApps(RING, "   ")), labels(RING), "whitespace is not a query"));

  check(() => assert.deepEqual(labels(filterRadialApps(RING, "s")), ["Spotify", "Steam", "Slack"], "one letter means prefix only, and keeps ring order"));
  check(() => {
    /** The reason one letter is prefix-only: "s" is inside five of these seven names. */
    const containsS = RING.filter((i) => i.label.toLowerCase().includes("s"));
    assert.ok(containsS.length > 3, "fixture must actually exercise this");
    assert.equal(filterRadialApps(RING, "s").length, 3, "a single letter must NARROW the ring");
  });
  check(() => assert.deepEqual(labels(filterRadialApps(RING, "sp")), ["Spotify"]));
  check(() => assert.deepEqual(labels(filterRadialApps(RING, "SPOT")), ["Spotify"], "case-insensitive"));

  check(() => {
    /** "code" is not the start of "Visual Studio Code" — the contains rule is what saves it. */
    assert.deepEqual(labels(filterRadialApps(RING, "code")), ["Visual Studio Code"]);
  });

  check(() => {
    /** Prefix before contains, and each group in ring order — never interleaved by score. */
    const ring = ["Steam", "Instagram", "Slack"].map(app);
    assert.deepEqual(labels(filterRadialApps(ring, "st")), ["Steam", "Instagram"]);
  });

  check(() => assert.deepEqual(labels(filterRadialApps(RING, "visual studio")), ["Visual Studio Code"], "a query typed with spaces still matches"));
  check(() => assert.deepEqual(labels(filterRadialApps(RING, "visualstudio")), ["Visual Studio Code"], "and typed without them"));
  check(() => {
    /** Deliberately not an initials match: that needs scoring, and scoring reorders the ring. */
    assert.deepEqual(labels(filterRadialApps(RING, "vscode")), []);
  });

  check(() => assert.deepEqual(labels(filterRadialApps(RING, "zzz")), [], "no matches is an empty ring, not the full one"));

  check(() => {
    /** A nameless item can never be typed to, and must not silently become a match for everything. */
    const ring = [app("Spotify"), { id: "x", type: "app", label: "", command: "", iconName: "" }];
    assert.deepEqual(labels(filterRadialApps(ring, "s")), ["Spotify"]);
    assert.deepEqual(labels(filterRadialApps(ring, "")).length, 2, "but it is still on the unfiltered ring");
  });

  check(() => {
    /** Every result is an item from the input, not a copy: the render keys off identity. */
    const out = filterRadialApps(RING, "s");
    for (const item of out) assert.ok(RING.includes(item));
  });

  check(() => assert.deepEqual(labels(filterRadialApps([], "x")), [], "an empty level filters to an empty level"));

  // ── Crowding guidance ─────────────────────────────────────────────────────
  check(() => {
    /** Silence up to the last count whose whole slice fits inside a wrist flick's ~15 degrees. */
    for (const count of [0, 1, 8, 12]) {
      assert.equal(radialCrowding(count, "angle"), null, `${count} items should say nothing`);
    }
  });
  check(() => assert.equal(radialCrowding(13, "angle").severity, "caution", "just over is a caution"));
  check(() => assert.equal(radialCrowding(18, "angle").severity, "caution"));
  check(() => assert.equal(radialCrowding(19, "angle").severity, "warning", "past 18 it is a guess"));

  check(() => {
    /** The number in the sentence must be the real slice, or the warning is worse than none. */
    const m = radialCrowding(20, "angle").message;
    assert.ok(m.includes("18°"), m);
    /** No article before the number: 8, 11 and 18 are all reachable and all take "an". */
    assert.ok(!/\ba \d+°/.test(m), `article before a degree count: ${m}`);
    assert.ok(m.includes("20 shortcuts"), m);
  });

  check(() => {
    /** Pointer mode narrows nothing — it shrinks the icons — so it must not talk about slices. */
    const m = radialCrowding(20, "cursor").message;
    assert.ok(!m.includes("°"), `pointer mode should not cite an angle: ${m}`);
    assert.ok(m.includes("icon"), m);
  });

  check(() => {
    /** An unset mode is direction mode, which is what the wheel actually does by default. */
    assert.equal(radialCrowding(20, undefined).message, radialCrowding(20, "angle").message);
  });

  check(() => {
    /** Both severities have to name the way out, or the note is only bad news. */
    for (const count of [13, 25]) {
      assert.match(radialCrowding(count, "angle").message, /folder/i);
    }
  });

  console.log(`radial-filter-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
