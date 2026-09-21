import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The key that switches to one workspace, once it stopped being the digit of its position.
 *
 * `src/constants/workspaceHotkey.ts` is TypeScript and node will not load it, so the pure
 * functions are transcribed here and the transcription is checked against the source at the
 * bottom. Three separate places act on these answers — the settings recorder, the wheel's keydown
 * handler and the global registration in main — and a rule that drifts between them is a key that
 * records, reads back correctly and never fires.
 */

const NONE = "";

function positionalWorkspaceKey(index) {
  return index < 9 ? String(index + 1) : NONE;
}

function normalizeWorkspaceKey(value) {
  if (typeof value !== "string") return NONE;
  const trimmed = value.trim();
  if (trimmed === "") return NONE;
  const chars = Array.from(trimmed);
  if (chars.length !== 1) return NONE;
  return chars[0].toUpperCase();
}

function workspaceKeyAt(workspace, index) {
  const stored = workspace.hotkeyKey;
  if (typeof stored !== "string") return positionalWorkspaceKey(index);
  if (stored.trim() === "") return NONE;
  return normalizeWorkspaceKey(stored) || positionalWorkspaceKey(index);
}

function isDefaultWorkspaceKey(workspace) {
  return typeof workspace.hotkeyKey !== "string";
}

function workspaceKeyBindings(config) {
  const workspaces = config.workspaces || [];
  const bindings = [];
  const seen = new Set();
  const take = (recorded) => {
    workspaces.forEach((workspace, index) => {
      if (isDefaultWorkspaceKey(workspace) === recorded) return;
      const key = workspaceKeyAt(workspace, index);
      if (!key || seen.has(key)) return;
      seen.add(key);
      bindings.push({ key, index });
    });
  };
  take(true);
  take(false);
  return bindings.sort((a, b) => a.index - b.index);
}

/* ---- The three states of `hotkeyKey`, which is the whole design ---- */

assert.equal(workspaceKeyAt({}, 0), "1",
  "a workspace nobody has edited follows its position, exactly as it always did");
assert.equal(workspaceKeyAt({}, 8), "9", "down to the ninth");
assert.equal(workspaceKeyAt({}, 9), NONE,
  "and past it there is no key, which was already the contract of `hotkey: 0`");
assert.equal(workspaceKeyAt({ hotkeyKey: "k" }, 4), "K", "a recorded key is stored upper case");
assert.equal(workspaceKeyAt({ hotkeyKey: "K" }, 4), "K", "and read back as it was stored");
assert.equal(workspaceKeyAt({ hotkeyKey: "" }, 0), NONE,
  "the empty string is a deliberate no-key and outranks the position");
assert.equal(workspaceKeyAt({ hotkeyKey: "   " }, 0), NONE, "and so is whitespace somebody typed");
assert.equal(workspaceKeyAt({ hotkeyKey: "7" }, 0), "7",
  "digits are allowed here, unlike the back key: they are what this field ships with");
assert.equal(workspaceKeyAt({ hotkeyKey: "Escape" }, 2), "3",
  "a hand-edited key NAME falls back to the position rather than leaving the workspace mute");
assert.equal(workspaceKeyAt({ hotkeyKey: 4 }, 2), "3", "so does a config holding the wrong type");
assert.equal(workspaceKeyAt({ hotkeyKey: "é" }, 0), "É", "non-ASCII keys survive, upper-cased");

/*
 * The difference that matters: an ABSENT key follows a reorder, a REMOVED one does not. Nothing
 * else in the model distinguishes "never touched" from "deliberately none", and without it the
 * workspace that just gave its key away would be handed one back on the next renumber.
 */
assert.equal(workspaceKeyAt({}, 0), "1", "absent, first place");
assert.equal(workspaceKeyAt({}, 2), "3", "absent, moved to third place: the key moved with it");
assert.equal(workspaceKeyAt({ hotkeyKey: "" }, 0), NONE, "removed, first place");
assert.equal(workspaceKeyAt({ hotkeyKey: "" }, 2), NONE, "removed, still removed after the move");

/* ---- The binding table, which main registers and the wheel looks keys up in ---- */

const CONFIG = {
  workspaces: [
    { name: "Main" },
    { name: "Design", hotkeyKey: "D" },
    { name: "Paused", hotkeyKey: "" },
    { name: "Games" },
  ],
};

assert.deepEqual(
  workspaceKeyBindings(CONFIG),
  [{ key: "1", index: 0 }, { key: "D", index: 1 }, { key: "4", index: 3 }],
  "defaults and recorded keys in one table; a removed key contributes nothing",
);
assert.deepEqual(workspaceKeyBindings({ workspaces: [] }), [], "no workspaces, no bindings");

/*
 * A duplicate the recorder never agreed to. It refuses to create one, so these arrive by a
 * hand-edited config, an imported workspace file, or — the one that happens by accident — a
 * reorder moving somebody's positional default onto a digit that was recorded elsewhere.
 *
 * The recorded key wins, whichever way round they sit. The alternative is that a key somebody
 * chose stops working because an unrelated workspace was dragged somewhere.
 */
assert.deepEqual(
  workspaceKeyBindings({ workspaces: [{ name: "A", hotkeyKey: "2" }, { name: "B" }] }),
  [{ key: "2", index: 0 }],
  "recorded beats the default sitting on the same digit, and the loser gets no binding at all",
);
assert.deepEqual(
  workspaceKeyBindings({ workspaces: [{ name: "A" }, { name: "B", hotkeyKey: "1" }] }),
  [{ key: "1", index: 1 }],
  "and still wins from BEHIND, where taking the earlier one would have been the easy rule",
);
assert.deepEqual(
  workspaceKeyBindings({ workspaces: [{ name: "A", hotkeyKey: "X" }, { name: "B", hotkeyKey: "X" }] }),
  [{ key: "X", index: 0 }],
  "between two recorded keys the earlier wins — arbitrary, but fixed, where claim order is not",
);

/* ---- The home launcher, which is now the only thing the wheel opens on ---- */

/** Mirrors `getRootRadialApps`: the launcher, unless there is only one place it could go. */
function rootIsHomeLauncher(config) {
  return (config.workspaces || []).filter((w) => w.enabled !== false).length > 1;
}

assert.equal(rootIsHomeLauncher(CONFIG), true,
  "more than one workspace: the wheel opens on the launcher, with no setting to turn it off");
assert.equal(rootIsHomeLauncher({ workspaces: [{ name: "Main" }] }), false,
  "one workspace: a launcher offering a single destination is a step that asks to be skipped");
assert.equal(
  rootIsHomeLauncher({ workspaces: [{ name: "Main" }, { name: "Old", enabled: false }] }),
  false,
  "and a hidden workspace does not count towards the second one",
);

/* ---- Who owns a keystroke on an open wheel ---- */

/**
 * Mirrors the `workspaceKeys` memo in `RadialMenu`, which is the list BOTH main and the wheel's
 * keydown handler use. Quick launch claims 1-9 for running the slice in that position, so those
 * come out of the table while it is on — and only those. A key somebody recorded as a letter is
 * claimed by nobody and keeps working; switching it off by association would be a setting that
 * saves, reads back correctly and does nothing.
 */
function liveBindings(config, numberLaunch) {
  const bindings = workspaceKeyBindings(config);
  if (numberLaunch !== true) return bindings;
  return bindings.filter((b) => b.key < "0" || b.key > "9");
}

assert.deepEqual(
  liveBindings(CONFIG, false).map((b) => b.key),
  ["1", "D", "4"],
  "quick launch off: every key switches workspace, the way it always has",
);
assert.deepEqual(
  liveBindings(CONFIG, true).map((b) => b.key),
  ["D"],
  "quick launch on: the digits go to launching, the recorded letter still switches",
);
assert.deepEqual(
  liveBindings({ workspaces: [{ name: "A" }, { name: "B" }] }, true),
  [],
  "a config still entirely on its positional defaults goes quiet, which is what the setting says",
);

/**
 * Mirrors the workspace branch of `RadialMenu`'s keydown handler.
 *
 * There is no mode to test any more. The wheel always opens on the home launcher and the keys
 * always reach the workspaces from it — the `workspaceSwitchMode` that made those two alternatives
 * is gone, along with the state where a recorded key did nothing at all.
 *
 * A key on a DISABLED workspace enters nothing: that workspace is not on the launcher, so making
 * it current would leave the wheel on a level that no longer matches. The keystroke stays a
 * character, which is what `enterWorkspace` returning false means at the call site.
 */
function routeKey({ key, config, numberLaunch, typeAhead, ctrl = false, alt = false }) {
  if (typeAhead) return "filter";
  if (ctrl || alt) return "ignored";
  if (Array.from(key).length !== 1) return "ignored";
  const hit = liveBindings(config, numberLaunch).find((b) => b.key === key.toUpperCase());
  if (!hit) return "filter";
  return config.workspaces[hit.index].enabled === false ? "filter" : `enter:${hit.index}`;
}

const LIVE = { config: CONFIG, numberLaunch: false, typeAhead: "" };

assert.equal(routeKey({ ...LIVE, key: "1" }), "enter:0", "the positional digit goes into its workspace");
assert.equal(routeKey({ ...LIVE, key: "d" }), "enter:1",
  "a recorded key matches however the layout cased it");
assert.equal(routeKey({ ...LIVE, key: "D" }), "enter:1", "Shift+D prints D and still matches");
assert.equal(routeKey({ ...LIVE, key: "3" }), "filter",
  "the removed key reaches the filter instead of entering a workspace it no longer opens");
assert.equal(routeKey({ ...LIVE, key: "z" }), "filter", "an unbound letter is a character");
assert.equal(routeKey({ ...LIVE, key: "d", typeAhead: "disc" }), "filter",
  "mid-filter every character belongs to the filter, or Discord cannot be typed");
assert.equal(routeKey({ ...LIVE, key: "d", ctrl: true }), "ignored",
  "Ctrl+D belongs to somebody else — only the bare key counts");
assert.equal(routeKey({ ...LIVE, key: "d", alt: true }), "ignored", "and so does Alt+D");
assert.equal(routeKey({ ...LIVE, key: "Escape" }), "ignored", "a key NAME is never a binding");
assert.equal(
  routeKey({
    ...LIVE,
    key: "d",
    config: { workspaces: [{ name: "Main" }, { name: "Design", hotkeyKey: "D", enabled: false }] },
  }),
  "filter",
  "a key on a hidden workspace enters nothing and stays a character",
);

/*
 * The cost of the feature, stated once so it cannot be lost: a letter bound to a workspace stops
 * filtering. That has always been true of the digits and is the same trade, which is why the
 * recorder says so before the key is kept.
 */
assert.equal(routeKey({ ...LIVE, key: "d" }), "enter:1",
  "D enters Design rather than starting a filter for Discord");

/* ---- Transcription check ---- */

const src = readFileSync(new URL("../src/constants/workspaceHotkey.ts", import.meta.url), "utf8");
assert.ok(src.includes("export const WORKSPACE_KEY_NONE = ''"),
  "WORKSPACE_KEY_NONE drifted from this test");
assert.ok(src.includes("return index < 9 ? String(index + 1) : WORKSPACE_KEY_NONE"),
  "positionalWorkspaceKey drifted from this test");
assert.ok(src.includes("if (stored.trim() === '') return WORKSPACE_KEY_NONE"),
  "the deliberate-no-key state drifted from this test");
assert.ok(src.includes("return normalizeWorkspaceKey(stored) || positionalWorkspaceKey(index)"),
  "the fallback for a corrupted stored key drifted from this test");
assert.ok(src.includes("if (isDefaultWorkspaceKey(workspace) === recorded) return;"),
  "the two passes that let a recorded key beat a positional one are gone from the source");

const radial = readFileSync(new URL("../src/components/RadialMenu.tsx", import.meta.url), "utf8");
assert.ok(radial.includes("binding.key < '0' || binding.key > '9'"),
  "the wheel no longer strips the digits quick launch claims");

const main = readFileSync(new URL("../backend/electron-main.js", import.meta.url), "utf8");
assert.ok(main.includes('numberKeysClaimed === true && key >= "0" && key <= "9"'),
  "main no longer refuses to register the digits quick launch claims");

/*
 * The setting that used to make the launcher optional. Its absence is load-bearing: the whole
 * design above assumes the wheel always opens on the workspaces and the keys always reach them,
 * so a `workspaceSwitchMode` coming back would silently invalidate every assertion in this file.
 */
const radialSrc = readFileSync(new URL("../src/utils/workspaceRadial.ts", import.meta.url), "utf8");
assert.ok(!/cfg\.workspaceSwitchMode/.test(radialSrc),
  "workspaceSwitchMode is back in the root-level decision");
assert.ok(radialSrc.includes("if (enabledWorkspaceCount(cfg) <= 1) return currentWorkspaceApps;"),
  "the one-workspace shortcut past the launcher drifted from this test");
const typesSrc = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
assert.ok(!/workspaceSwitchMode\?:/.test(typesSrc), "workspaceSwitchMode is back on UIConfig");

console.log("workspace-key-smoke: OK (47 assertions passed)");
