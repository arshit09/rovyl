/**
 * The two corner docks, end to end: the shape of a dock, the shape of a reading, and the three
 * places that have to agree about the reading's field order.
 *
 * The reading travels as one space-separated line from a C# helper, through a CommonJS parser in
 * the main process, into a React component. Nothing type-checks across that boundary: the field
 * ORDER in `RovylSystemStatus.Reading.Line()` and the order `parseSystemStatusLine` reads are two
 * independent decisions, and getting them apart means the battery pill showing the volume — a
 * failure that looks like a hardware bug and is impossible to find by reading either side alone.
 * So this loads both and asserts they agree.
 *
 * It also holds the rules that decide whether a HELPER PROCESS runs at all. A dock left switched
 * on with every readout unticked must cost exactly what "off" costs, and that is decided here
 * (`statusDockNeedsHelper`), not by the component.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), "rovyl-screen-docks-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "screenDocks.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const docks = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
  const {
    DEFAULT_SHORTCUT_DOCK,
    DEFAULT_STATUS_DOCK,
    DOCK_GAP_MAX,
    DOCK_GAP_MIN,
    DOCK_POSITIONS,
    DOCK_POSITION_LABELS,
    SHORTCUT_DOCK_ICON_MAX,
    SHORTCUT_DOCK_ICON_MIN,
    STATUS_DOCK_ICON_MAX,
    STATUS_DOCK_ICON_MIN,
    docksNeedFullBleed,
    normalizeShortcutDock,
    normalizeStatusDock,
    occupiedDockPositions,
    shortcutDockIsActive,
    statusDockIsActive,
    statusDockNeedsHelper,
  } = docks;

  /* -- Both docks ship off ------------------------------------------------
     They paint something beside the wheel that was never there, and one of
     them is empty until somebody fills it. A strip appearing in the corner
     because a person updated is a fault report, not a feature arriving. */

  assert.equal(DEFAULT_STATUS_DOCK.enabled, false, "the system dock must ship off");
  assert.equal(DEFAULT_SHORTCUT_DOCK.enabled, false, "the shortcut dock must ship off");
  assert.deepEqual(DEFAULT_SHORTCUT_DOCK.items, [], "the shortcut dock must ship empty");
  assert.equal(docksNeedFullBleed(DEFAULT_STATUS_DOCK, DEFAULT_SHORTCUT_DOCK), false,
    "defaults must not force the overlay to take the whole monitor");
  assert.equal(statusDockNeedsHelper(DEFAULT_STATUS_DOCK), false,
    "defaults must not start a helper process");

  /* -- A missing field takes its DEFAULT, never a zero --------------------
     A config written before one of these switches existed is missing it. Read
     as 0, `iconSize` is a dock that is enabled, placed, and invisible — and
     read as `false`, a readout is one the user is told they turned off. */

  const fromNothing = normalizeStatusDock(undefined);
  assert.deepEqual(fromNothing, DEFAULT_STATUS_DOCK, "an absent status dock is the default one");
  assert.deepEqual(normalizeShortcutDock(null), DEFAULT_SHORTCUT_DOCK,
    "an absent shortcut dock is the default one");
  assert.deepEqual(normalizeStatusDock({ enabled: true }), { ...DEFAULT_STATUS_DOCK, enabled: true },
    "one stored field must not blank the rest");

  /* Nothing a config can hold may produce a dock that is enabled, placed and
     invisible. A value that is not a number at all takes the default; one that
     is a number out of range is clamped. Either way it lands inside the range
     the slider offers, which is what "never 0" actually means. */
  for (const bad of [0, -1, NaN, Infinity, "big", null, undefined, {}, []]) {
    const status = normalizeStatusDock({ iconSize: bad, gap: bad }).iconSize;
    assert.ok(status >= STATUS_DOCK_ICON_MIN && status <= STATUS_DOCK_ICON_MAX,
      `a status iconSize of ${String(bad)} produced ${status}, which no slider can show`);
    const shortcut = normalizeShortcutDock({ iconSize: bad, gap: bad }).iconSize;
    assert.ok(shortcut >= SHORTCUT_DOCK_ICON_MIN && shortcut <= SHORTCUT_DOCK_ICON_MAX,
      `a shortcut iconSize of ${String(bad)} produced ${shortcut}, which no slider can show`);
  }

  /* Not a number at all: the DEFAULT, not the minimum. There was no choice to
     preserve, and a config that lost the key must not read as "smallest". */
  for (const missing of [undefined, null, "big", {}]) {
    assert.equal(normalizeStatusDock({ iconSize: missing }).iconSize, DEFAULT_STATUS_DOCK.iconSize);
    assert.equal(normalizeShortcutDock({ gap: missing }).gap, DEFAULT_SHORTCUT_DOCK.gap);
  }

  /* A number out of range IS clamped rather than replaced: it was a real choice,
     just one this build no longer offers the whole of. */
  assert.equal(normalizeStatusDock({ iconSize: 9999 }).iconSize, STATUS_DOCK_ICON_MAX);
  assert.equal(normalizeStatusDock({ iconSize: 1 }).iconSize, STATUS_DOCK_ICON_MIN);
  assert.equal(normalizeShortcutDock({ iconSize: 9999 }).iconSize, SHORTCUT_DOCK_ICON_MAX);
  assert.equal(normalizeShortcutDock({ iconSize: 1 }).iconSize, SHORTCUT_DOCK_ICON_MIN);
  assert.equal(normalizeShortcutDock({ gap: 9999 }).gap, DOCK_GAP_MAX);
  assert.equal(normalizeShortcutDock({ gap: -5 }).gap, DOCK_GAP_MIN);

  /* Every default must itself be inside the range its slider offers, or the
     panel opens showing a value it cannot reach again. */
  assert.ok(DEFAULT_STATUS_DOCK.iconSize >= STATUS_DOCK_ICON_MIN
    && DEFAULT_STATUS_DOCK.iconSize <= STATUS_DOCK_ICON_MAX);
  assert.ok(DEFAULT_SHORTCUT_DOCK.iconSize >= SHORTCUT_DOCK_ICON_MIN
    && DEFAULT_SHORTCUT_DOCK.iconSize <= SHORTCUT_DOCK_ICON_MAX);
  assert.ok(DEFAULT_STATUS_DOCK.gap >= DOCK_GAP_MIN && DEFAULT_STATUS_DOCK.gap <= DOCK_GAP_MAX);
  assert.ok(DEFAULT_SHORTCUT_DOCK.gap >= DOCK_GAP_MIN && DEFAULT_SHORTCUT_DOCK.gap <= DOCK_GAP_MAX);

  assert.equal(normalizeStatusDock({ position: "middle" }).position, DEFAULT_STATUS_DOCK.position,
    "an unknown region falls back rather than placing the dock nowhere");
  for (const position of DOCK_POSITIONS) {
    assert.equal(normalizeStatusDock({ position }).position, position);
    assert.equal(typeof DOCK_POSITION_LABELS[position], "string",
      `every region needs a name for the settings select: ${position}`);
  }

  /* A stored `items` that is not a list, or holds entries with no id, must not
     reach the dock: `key={item.id}` on undefined is a React remount storm. */
  assert.deepEqual(normalizeShortcutDock({ items: "nope" }).items, []);
  assert.deepEqual(normalizeShortcutDock({ items: [null, { label: "no id" }, { id: "a" }] }).items,
    [{ id: "a" }], "entries without an id are dropped");

  /* -- On with nothing selected costs what off costs ---------------------- */

  const allOff = normalizeStatusDock({
    enabled: true, showClock: false, showBattery: false, showNetwork: false, showVolume: false,
  });
  assert.equal(statusDockIsActive(allOff), false, "a dock with no readouts draws nothing");
  assert.equal(statusDockNeedsHelper(allOff), false, "and starts no helper");

  const clockOnly = normalizeStatusDock({
    enabled: true, showClock: true, showBattery: false, showNetwork: false, showVolume: false,
  });
  assert.equal(statusDockIsActive(clockOnly), true, "a clock-only dock is on screen");
  assert.equal(statusDockNeedsHelper(clockOnly), false,
    "a clock comes from Date — it must not cost a helper process");

  for (const readout of ["showBattery", "showNetwork", "showVolume"]) {
    const one = normalizeStatusDock({
      enabled: true, showClock: false, showBattery: false, showNetwork: false, showVolume: false,
      [readout]: true,
    });
    assert.equal(statusDockNeedsHelper(one), true, `${readout} can only be answered by the helper`);
  }

  /* A dock that is switched off answers nothing, whatever is ticked under it. */
  assert.equal(statusDockNeedsHelper(normalizeStatusDock({ enabled: false, showVolume: true })), false);

  /* -- Empty is not "on screen" ------------------------------------------- */

  const emptyDock = normalizeShortcutDock({ enabled: true, items: [] });
  assert.equal(shortcutDockIsActive(emptyDock), false, "an enabled but empty dock draws nothing");
  assert.equal(docksNeedFullBleed(allOff, emptyDock), false,
    "two docks with nothing in them must not cost the overlay its cheap box");
  assert.equal(occupiedDockPositions(allOff, emptyDock).size, 0,
    "and the gear must not dodge a strip that is not there");

  const filled = normalizeShortcutDock({ enabled: true, position: "top-left", items: [{ id: "x" }] });
  assert.equal(docksNeedFullBleed(allOff, filled), true,
    "a dock in a corner needs the corner to be the screen's");
  assert.deepEqual([...occupiedDockPositions(clockOnly, filled)].sort(),
    ["bottom-right", "top-left"], "both regions are reported, so the gear can step out of either");

  /* Both docks in one region is one occupied region, not two. */
  const shared = normalizeShortcutDock({ enabled: true, position: "bottom-right", items: [{ id: "x" }] });
  assert.deepEqual([...occupiedDockPositions(clockOnly, shared)], ["bottom-right"]);

  /* -- The reading, across the three files -------------------------------- */

  const { UNKNOWN_SYSTEM_STATUS, parseSystemStatusLine } = require(
    join(root, "backend", "system-status.cjs"),
  );

  /* Unknown is -1 everywhere, never 0: a desktop has no battery and a cable has
     no signal quality, and a readout that cannot tell those from "empty" shows
     a flat battery to somebody whose machine is fine. */
  assert.equal(UNKNOWN_SYSTEM_STATUS.volume, -1);
  assert.equal(UNKNOWN_SYSTEM_STATUS.signal, -1);
  assert.equal(UNKNOWN_SYSTEM_STATUS.battery, -1);
  assert.equal(UNKNOWN_SYSTEM_STATUS.network, "none");

  assert.deepEqual(parseSystemStatusLine("STATUS 42 0 wifi 78 91 1"), {
    volume: 42, muted: false, network: "wifi", signal: 78, battery: 91, charging: true,
  });
  assert.deepEqual(parseSystemStatusLine("STATUS 0 1 ethernet -1 -1 0"), {
    volume: 0, muted: true, network: "ethernet", signal: -1, battery: -1, charging: false,
  });

  /* Anything malformed keeps the reading the dock already had, rather than
     filling the gaps with zeroes that read as real measurements. */
  for (const bad of [
    "", "READY", "STATUS", "STATUS 42 0 wifi 78 91", "STATUS 42 0 wifi 78 91 1 2",
    "STATUS x 0 wifi 78 91 1", "STATUS 42 2 wifi 78 91 1", "STATUS 42 0 carrier-pigeon 78 91 1",
    "STATUS 42 0 wifi 78 91 2", null, undefined, 7,
  ]) {
    assert.equal(parseSystemStatusLine(bad), null, `must reject: ${JSON.stringify(bad)}`);
  }

  /* -- And the C# that produces it ---------------------------------------- */

  const helperSource = readFileSync(
    join(root, "backend", "native-helper", "rovyl-helper.cs"), "utf8",
  );

  /* The emit, pinned field by field. Change the order on either side and this
     names the other — which is the whole reason it reads the .cs at all. */
  const emit = helperSource.match(
    /return\s+"STATUS\s+"([\s\S]*?);\s*\n\s*\}/,
  );
  assert.ok(emit, "RovylSystemStatus.Reading.Line() must still build the STATUS line by hand");
  const emitted = emit[1]
    .split("+")
    .map((piece) => piece.trim())
    .filter((piece) => piece && !/^"[\s]*"$/.test(piece))
    .map((piece) => piece.replace(/^\(|\)$/g, "").split(/\s/)[0].replace(/[^A-Za-z]/g, ""));
  assert.deepEqual(emitted, ["Volume", "Muted", "Network", "Signal", "Battery", "Charging"],
    "the STATUS field order must match what parseSystemStatusLine reads");

  /* The four verbs main sends. A helper that silently ignores one is a slider
     that does nothing, with nothing in any log to say why. */
  for (const verb of ["POLL", "WATCH", "VOL", "MUTE", "EXIT"]) {
    assert.ok(helperSource.includes(`verb == "${verb}"`),
      `the helper must still answer ${verb}`);
  }

  /* The dispatch in Main. Without this entry the process prints usage and exits,
     and every readout stays unknown forever. */
  assert.ok(helperSource.includes('args[0] == "system-status"'),
    "rovyl-helper.exe must still route the system-status mode");

  /* -- The settings panel offers every knob ------------------------------- */

  const panel = readFileSync(join(root, "src", "components", "PrecisionSettings.tsx"), "utf8");
  for (const key of [
    "shortcutDock-items", "shortcutDock-position", "shortcutDock-size", "shortcutDock-gap",
    "statusDock-position", "statusDock-size", "statusDock-gap",
    "statusDock-clock", "statusDock-battery", "statusDock-network", "statusDock-volume",
  ]) {
    assert.ok(panel.includes(`'${key}'`), `Settings must still offer the ${key} row`);
  }

  /* -- And what the components actually draw ------------------------------ */

  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "scripts", "screen-docks-smoke.entry.tsx"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "render.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { collect } = await import(pathToFileURL(join(outDir, "render.mjs")).href);
  const drawn = collect();

  /* Two docks asked for the same region are ONE positioned shell with both
     plates stacked in it. Two shells would be two boxes against the same edge,
     drawn on top of each other — which is the whole reason one component draws
     both docks rather than each drawing itself. */
  assert.equal(drawn.sharedRegionShells, 1, "one region is one shell");
  assert.equal(drawn.sharedRegionPlates, 2, "and still holds both docks");
  assert.equal(drawn.separateRegionShells, 2, "two regions are two shells");
  assert.equal(drawn.separateRegionPlates, 2);

  /* The sliders have to reach the DOM, or they are settings that do nothing. */
  assert.equal(drawn.shortcutGapApplied, true, "the shortcut dock's gap must be applied");
  assert.equal(drawn.statusGapApplied, true, "the system dock's gap must be applied");
  assert.equal(drawn.shortcutTileSized, true,
    "a tile is the icon size, plus the label row when names are on");

  assert.equal(drawn.tileCount, 2, "every configured icon is drawn");
  assert.equal(drawn.labelsShown, true);
  assert.equal(drawn.orderKept, true, "the order of a dock is its content");

  /* The case a naive readout gets wrong: a desktop PC has no battery, and -1
     must draw NOTHING rather than an empty one at 0%. */
  assert.equal(drawn.laptopShowsBattery, true);
  assert.equal(drawn.desktopShowsBattery, false, "a machine with no battery shows no battery");
  assert.equal(drawn.desktopShowsZeroPercent, false, "and never falls back to 0%");
  assert.equal(drawn.laptopShowsSignal, true, "Wi-Fi reports how well it is connected");
  assert.equal(drawn.ethernetShowsNoSignal, true, "a cable has no signal quality to report");

  assert.equal(drawn.volumeFillApplied, true, "the bar reads the level");
  assert.equal(drawn.mutedFillIsEmpty, true, "a muted endpoint draws an empty bar");

  assert.equal(drawn.emptyRendersNothing, true,
    "nothing configured must put nothing in the document");
  assert.equal(drawn.closedIsInert, true,
    "a closing dock still animates but must not take a click");

  /* The picker is a picture of the model, so the two have to hold the same six
     regions. A position the wheel honours and the picker does not draw is a
     setting nobody can reach — and nothing else in the build would say so. */
  assert.deepEqual(drawn.pickerGridPositions, drawn.modelPositions,
    "the picker must offer every region the docks can be placed in");
  assert.equal(drawn.pickerCells, 6, "six regions, six targets");
  assert.equal(drawn.pickerChecked, 1, "exactly one is chosen");
  assert.equal(drawn.pickerChecksTheChosenOne, true, "and it is the one that was passed in");
  assert.equal(drawn.pickerTabStops, 1,
    "six radios are one tab stop — the arrows move the choice inside the group");

  /* Both docks may share a region (ScreenDocks stacks them); the picker's job is
     to make that a decision rather than a surprise. */
  assert.equal(drawn.pickerMarksSibling, true, "the other dock's region is marked");
  assert.equal(drawn.pickerNamesSibling, true, "and named, for anyone not looking at the picture");
  assert.equal(drawn.pickerUnsharedIsClean, true, "with no dock to share with, nothing is marked");

  /* The gear's step: both plates plus the gap between them, and zero for a
     corner no dock is in — the gear must not dodge a strip that is not there. */
  assert.equal(drawn.stackEmptyRegion, 0);
  assert.ok(drawn.stackBothOnLeft > 0, "a shared region reports the height of both plates");

  console.log("screen-docks-smoke: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
