/**
 * What the tray menu is made of, asserted without a tray.
 *
 * It used to be two fixed rows — Open Settings, Quit — and nothing about it could be wrong. It is
 * now a function of state: which workspace is ticked, whether the triggers are paused and for how
 * long, whether this build has an updater. Every one of those is a thing that can silently come
 * out wrong on somebody else's machine, in a native menu that no screenshot and no DOM query can
 * reach. So the template is a value (`backend/tray-menu.cjs`) and this reads it.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildTrayMenuTemplate, PAUSE_CHOICES } = require(join(root, "backend", "tray-menu.cjs"));

const labels = (items) => items.map((item) => (item.type === "separator" ? "---" : item.label));
const find = (items, label) => items.find((item) => item.label === label);

const BASE = {
  workspaces: [{ name: "Main" }, { name: "Streaming" }],
  activeWorkspaceIndex: 0,
  pausedUntil: 0,
  now: 1_000_000,
  version: "1.4.0",
  canCheckUpdates: true,
  icons: {},
  actions: {},
};

let assertions = 0;
const check = (message, fn) => { fn(); assertions += 1; };

// ── Everything the item asked for is on the menu ──────────────────────────────
const full = buildTrayMenuTemplate(BASE);
check("all five additions present", () => {
  const text = labels(full).join("|");
  for (const expected of ["Open wheel", "Workspace", "Pause trigger", "Open Settings", "Check for updates", "Rovyl 1.4.0", "Quit"]) {
    assert.ok(text.includes(expected), `missing "${expected}" in ${text}`);
  }
});

check("the version line is a label, not a control", () => {
  assert.equal(find(full, "Rovyl 1.4.0").enabled, false);
});

// ── Workspaces ────────────────────────────────────────────────────────────────
check("every workspace is listed, and exactly the current one is ticked", () => {
  const submenu = find(full, "Workspace").submenu;
  assert.deepEqual(submenu.map((i) => i.label), ["Main", "Streaming"]);
  assert.deepEqual(submenu.map((i) => i.checked), [true, false]);
  assert.deepEqual(submenu.map((i) => i.type), ["radio", "radio"]);
});

check("the tick follows the active index", () => {
  const submenu = find(buildTrayMenuTemplate({ ...BASE, activeWorkspaceIndex: 1 }), "Workspace").submenu;
  assert.deepEqual(submenu.map((i) => i.checked), [false, true]);
});

check("an unnamed workspace still gets a label", () => {
  const submenu = find(buildTrayMenuTemplate({ ...BASE, workspaces: [{}, { name: "B" }] }), "Workspace").submenu;
  assert.deepEqual(submenu.map((i) => i.label), ["Workspace 1", "B"]);
});

check("one workspace means no submenu at all — there is nothing to switch between", () => {
  const single = buildTrayMenuTemplate({ ...BASE, workspaces: [{ name: "Main" }] });
  assert.equal(find(single, "Workspace"), undefined);
  assert.ok(labels(single).includes("Open wheel"), "the rest of the menu survives");
});

check("switching calls back with the index that was clicked", () => {
  const seen = [];
  const menu = buildTrayMenuTemplate({ ...BASE, actions: { switchWorkspace: (i) => seen.push(i) } });
  find(menu, "Workspace").submenu[1].click();
  assert.deepEqual(seen, [1]);
});

// ── Pause ─────────────────────────────────────────────────────────────────────
check("not paused: the choices are offered and nothing counts down", () => {
  const pause = find(full, "Pause trigger");
  assert.deepEqual(pause.submenu.map((i) => i.label), PAUSE_CHOICES.map((m) => `For ${m} minutes`));
  assert.ok(!pause.submenu.some((i) => i.label === "Resume now"));
});

check("paused: the label says how much is left, and Resume is first", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, pausedUntil: BASE.now + 12 * 60_000 });
  const pause = find(menu, "Paused — 12 min left");
  assert.ok(pause, `expected a countdown label, got ${labels(menu).join("|")}`);
  assert.equal(pause.submenu[0].label, "Resume now");
});

check("a part-minute still reads as a minute, never as zero", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, pausedUntil: BASE.now + 40_000 });
  assert.ok(find(menu, "Paused — 1 min left"), labels(menu).join("|"));
});

check("an expired pause is not a pause", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, pausedUntil: BASE.now - 1 });
  assert.ok(find(menu, "Pause trigger"), labels(menu).join("|"));
});

check("Resume asks for zero minutes; a choice asks for its own", () => {
  const asked = [];
  const menu = buildTrayMenuTemplate({
    ...BASE, pausedUntil: BASE.now + 60_000, actions: { setPause: (m) => asked.push(m) },
  });
  const pause = find(menu, "Paused — 1 min left");
  pause.submenu[0].click();
  pause.submenu[2].click();
  assert.deepEqual(asked, [0, PAUSE_CHOICES[0]]);
});

// ── Updates ───────────────────────────────────────────────────────────────────
check("no updater, no row", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, canCheckUpdates: false });
  assert.equal(find(menu, "Check for updates"), undefined);
  assert.ok(find(menu, "Open Settings"), "and the row above it stays");
});

check("downloaded: the row is the restart, and the check is gone", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, updateState: "ready", updateVersion: "1.5.1" });
  assert.equal(find(menu, "Check for updates"), undefined, "checking again would re-download it");
  assert.ok(find(menu, "Restart to update to 1.5.1"), labels(menu).join("|"));
});

check("the restart row installs, it does not check", () => {
  const called = [];
  const menu = buildTrayMenuTemplate({
    ...BASE,
    updateState: "ready",
    updateVersion: "1.5.1",
    actions: { installUpdate: () => called.push("install"), checkForUpdates: () => called.push("check") },
  });
  find(menu, "Restart to update to 1.5.1").click();
  assert.deepEqual(called, ["install"]);
});

check("mid-flight the row is a status line, not a button", () => {
  for (const [state, label] of [["downloading", "Downloading 1.5.1…"], ["checking", "Checking for updates…"]]) {
    const menu = buildTrayMenuTemplate({ ...BASE, updateState: state, updateVersion: "1.5.1" });
    const row = find(menu, label);
    assert.ok(row, `expected "${label}" in ${labels(menu).join("|")}`);
    assert.equal(row.enabled, false);
    assert.equal(find(menu, "Check for updates"), undefined);
  }
});

check("a failed check leaves something to press again", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, updateState: "error" });
  assert.ok(find(menu, "Check for updates"), labels(menu).join("|"));
});

// ── Icons ─────────────────────────────────────────────────────────────────────
check("a missing glyph omits the key rather than passing null", () => {
  const menu = buildTrayMenuTemplate({ ...BASE, icons: { wheel: null, settings: { fake: true } } });
  assert.ok(!("icon" in find(menu, "Open wheel")), "null icon must not be passed through");
  assert.deepEqual(find(menu, "Open Settings").icon, { fake: true });
});

// ── Shape ─────────────────────────────────────────────────────────────────────
check("no separator opens, closes, or doubles up", () => {
  for (const menu of [full, buildTrayMenuTemplate({ ...BASE, workspaces: [{ name: "Main" }], canCheckUpdates: false })]) {
    const shape = labels(menu);
    assert.notEqual(shape[0], "---", "menu starts with a separator");
    assert.notEqual(shape[shape.length - 1], "---", "menu ends with a separator");
    for (let i = 1; i < shape.length; i++) {
      assert.ok(!(shape[i] === "---" && shape[i - 1] === "---"), `double separator at ${i}`);
    }
  }
});

check("every clickable row has something to call", () => {
  const walk = (items) => {
    for (const item of items) {
      if (item.submenu) { walk(item.submenu); continue; }
      if (item.type === "separator" || item.enabled === false) continue;
      assert.equal(typeof item.click, "function", `${item.label} has no click`);
    }
  };
  walk(buildTrayMenuTemplate({
    ...BASE,
    actions: {
      openWheel: () => {}, switchWorkspace: () => {}, setPause: () => {},
      openSettings: () => {}, checkForUpdates: () => {}, quit: () => {},
    },
  }));
});

console.log(`tray-menu-smoke: OK (${assertions} assertions)`);
