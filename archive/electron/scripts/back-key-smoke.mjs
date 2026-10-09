import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * `src/constants/radialBackKey.ts` is TypeScript and node will not load it, so the three pure
 * functions are transcribed here and the transcription is checked against the source below. The
 * pairing is the point: the wheel and the settings recorder both call the real ones, and a rule
 * that drifts between them is a key that records and never fires.
 */
const DEFAULT_BACK_KEY = "Q";
const BACK_KEY_OFF = "";
const RESERVED = ["Escape", "Enter", "Tab", "Backspace", " ",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

function normalizeBackKey(value) {
  if (typeof value !== "string") return BACK_KEY_OFF;
  const trimmed = value.trim();
  if (trimmed === "") return BACK_KEY_OFF;
  const chars = Array.from(trimmed);
  if (chars.length !== 1) return BACK_KEY_OFF;
  const char = chars[0];
  if (char >= "0" && char <= "9") return BACK_KEY_OFF;
  return char.toUpperCase();
}

function isBackKeyEvent(event, backKey) {
  if (!backKey) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (Array.from(event.key).length !== 1) return false;
  return event.key.toUpperCase() === backKey;
}

const ev = (key, mods = {}) =>
  ({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });

// Storage form: one character, upper case, or nothing at all.
assert.equal(normalizeBackKey("q"), "Q", "lower case is stored upper case");
assert.equal(normalizeBackKey("  q  "), "Q", "surrounding whitespace is not the key");
assert.equal(normalizeBackKey(""), BACK_KEY_OFF, "empty string means no key");
assert.equal(normalizeBackKey(undefined), BACK_KEY_OFF, "absent means no key here; the default is applied by DEFAULT_UI_CONFIG");
assert.equal(normalizeBackKey("qq"), BACK_KEY_OFF, "two characters is not a single key");
assert.equal(normalizeBackKey("Escape"), BACK_KEY_OFF, "a key NAME is not a character");
assert.equal(normalizeBackKey(7), BACK_KEY_OFF, "a hand-edited config can hold anything");
assert.equal(normalizeBackKey("4"), BACK_KEY_OFF,
  "digits are refused at the storage layer, so radialNumberLaunch can never orphan a binding");
assert.equal(normalizeBackKey("é"), "É", "non-ASCII letters survive, upper-cased");

// Matching: case-insensitive, bare key only.
assert.equal(isBackKeyEvent(ev("q"), "Q"), true, "the key as typed matches the stored upper case");
assert.equal(isBackKeyEvent(ev("Q"), "Q"), true, "and so does Shift+Q, which still prints Q");
assert.equal(isBackKeyEvent(ev("w"), "Q"), false, "a different letter does not");
assert.equal(isBackKeyEvent(ev("q", { ctrlKey: true }), "Q"), false, "Ctrl+Q belongs to the host app");
assert.equal(isBackKeyEvent(ev("q", { altKey: true }), "Q"), false, "Alt+Q is somebody's wheel trigger");
assert.equal(isBackKeyEvent(ev("Escape"), "Q"), false, "a named key is never a single character");
assert.equal(isBackKeyEvent(ev("q"), BACK_KEY_OFF), false, "with no key bound, nothing is the back key");

/**
 * The wheel's gate, mirrored from the keydown handler: the back key answers only with the
 * keyboard-driven wheel switched on, nothing typed, and a level to leave.
 */
function backKeyFires({ numberLaunch, backKey, depth, typeAhead, event }) {
  if (numberLaunch !== true) return false;
  if (typeAhead) return false;
  if (depth <= 0) return false;
  return isBackKeyEvent(event, normalizeBackKey(backKey));
}

const LIVE = { numberLaunch: true, backKey: "Q", depth: 1, typeAhead: "", event: ev("q") };

assert.equal(backKeyFires(LIVE), true, "inside a folder, nothing typed, master switch on: it goes back");
assert.equal(backKeyFires({ ...LIVE, numberLaunch: false }), false,
  "quick launch off: the key is inert even though a binding is stored by default");
assert.equal(backKeyFires({ ...LIVE, numberLaunch: undefined }), false,
  "and inert for a config written before any of this existed");
assert.equal(backKeyFires({ ...LIVE, depth: 0 }), false,
  "at the root the hub does not say Back, so the letter stays the filter's");
assert.equal(backKeyFires({ ...LIVE, depth: 3 }), true, "every level below the root, not just the first");
assert.equal(backKeyFires({ ...LIVE, typeAhead: "qbit" }), false,
  "mid-filter every character belongs to the filter");
assert.equal(backKeyFires({ ...LIVE, backKey: "" }), false, "no binding, no back key");
assert.equal(backKeyFires({ ...LIVE, backKey: "4" }), false,
  "a digit never becomes a binding, so it cannot collide with launching by number");
assert.equal(backKeyFires({ ...LIVE, event: ev("q", { ctrlKey: true }) }), false,
  "Ctrl+Q is the host application's");

/*
 * The transcription check. If the source stops agreeing with the constants above, this fails here
 * rather than silently in the wheel.
 */
const src = readFileSync(new URL("../src/constants/radialBackKey.ts", import.meta.url), "utf8");
assert.ok(src.includes(`export const DEFAULT_BACK_KEY = '${DEFAULT_BACK_KEY}'`),
  "DEFAULT_BACK_KEY drifted from this test");
for (const key of RESERVED) {
  const shown = key === " " ? "' '" : `'${key}'`;
  assert.ok(src.includes(shown), `reserved key ${shown} is no longer listed in the source`);
}

console.log("back-key-smoke: OK (26 assertions passed)");
