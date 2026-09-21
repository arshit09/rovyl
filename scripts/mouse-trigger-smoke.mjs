import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * The trigger binding is parsed in three languages: TypeScript for the settings recorder and the
 * welcome card, CommonJS for main, and C# for the hook that actually swallows the button. This
 * runs the CommonJS one for real and checks the other two still agree with it.
 *
 * The failure it exists to catch is silent by nature: a binding that records in Settings and never
 * fires, or fires and is never given back to the window underneath.
 *
 *   npm run test:mouse-trigger
 */

const require = createRequire(import.meta.url);
const {
  MOUSE_TRIGGER_VK,
  DEFAULT_MOUSE_TRIGGER,
  parseMouseTrigger,
  normalizeMouseTrigger,
  mouseTriggerAllowsHold,
} = require("../backend/mouse-trigger.cjs");

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

/* ── The three values that existed before bindings had modifiers ─────────── */

check(() => assert.equal(normalizeMouseTrigger("middle"), "middle", "the shipped default survives"));
check(() => assert.equal(normalizeMouseTrigger("x1"), "x1", "and so does the back side-button"));
check(() => assert.equal(normalizeMouseTrigger("x2"), "x2", "and the forward one"));
check(() => assert.equal(DEFAULT_MOUSE_TRIGGER, "middle", "the default is still the wheel button"));

/* ── The VKs the helper's TRIGGER command takes ──────────────────────────── */

check(() => assert.equal(parseMouseTrigger("middle").vk, 4, "middle is VK_MBUTTON"));
check(() => assert.equal(parseMouseTrigger("x1").vk, 5, "x1 is XBUTTON1"));
check(() => assert.equal(parseMouseTrigger("x2").vk, 6, "x2 is XBUTTON2"));
check(() => assert.equal(parseMouseTrigger("Ctrl+left").vk, 1, "left is VK_LBUTTON"));
check(() => assert.equal(parseMouseTrigger("Ctrl+right").vk, 2, "right is VK_RBUTTON"));

/* ── The modifier mask, bit for bit as GetCurrentModifierMask builds it ──── */

check(() => assert.equal(parseMouseTrigger("Ctrl+x1").modMask, 1, "Ctrl is bit 1"));
check(() => assert.equal(parseMouseTrigger("Alt+x1").modMask, 2, "Alt is bit 2"));
check(() => assert.equal(parseMouseTrigger("Shift+x1").modMask, 4, "Shift is bit 4"));
check(() => assert.equal(parseMouseTrigger("Super+x1").modMask, 8, "Win is bit 8"));
check(() => assert.equal(parseMouseTrigger("Ctrl+Alt+Shift+Super+x1").modMask, 15, "all four together"));
check(() => assert.equal(parseMouseTrigger("middle").modMask, 0, "no modifiers means the button alone"));

/* ── The one rule ────────────────────────────────────────────────────────── */

check(() => assert.equal(normalizeMouseTrigger("left"), null,
  "a bare left click is the primary click of the whole system and is never a binding"));
check(() => assert.equal(normalizeMouseTrigger("right"), null,
  "and a bare right click is every context menu in Windows"));
check(() => assert.equal(normalizeMouseTrigger("Shift+left"), "Shift+left",
  "with a modifier held it is free, which is the whole reason the grammar exists"));
check(() => assert.equal(normalizeMouseTrigger("Alt+right"), "Alt+right", "same for right"));

/* ── Hold is not on offer for the primary and secondary buttons ──────────── */

check(() => assert.equal(mouseTriggerAllowsHold("middle"), true, "the wheel button can be held"));
check(() => assert.equal(mouseTriggerAllowsHold("x1"), true, "and so can a side button"));
check(() => assert.equal(mouseTriggerAllowsHold("Ctrl+Alt+x2"), true, "modifiers do not change that"));
check(() => assert.equal(mouseTriggerAllowsHold("Ctrl+left"), false,
  "holding the primary button down for a whole gesture is a drag everywhere else in Windows"));
check(() => assert.equal(mouseTriggerAllowsHold("Alt+right"), false, "same for the secondary button"));
check(() => assert.equal(mouseTriggerAllowsHold("nonsense"), true,
  "an unreadable binding falls back to the default, which can be held"));

/* ── Canonical form: what gets written to disk ───────────────────────────── */

check(() => assert.equal(normalizeMouseTrigger("shift+CTRL+left"), "Ctrl+Shift+left",
  "modifiers are re-ordered and re-cased, so one binding has exactly one spelling"));
check(() => assert.equal(normalizeMouseTrigger("mouse4"), "x1", "the shortcut field's spelling still parses"));
check(() => assert.equal(normalizeMouseTrigger("wheel"), "middle", "and the old segmented control's"));
check(() => assert.equal(normalizeMouseTrigger("win+x2"), "Super+x2", "Win is stored as Super, as in the shortcut field"));

/* ── Anything else a hand-edited config can hold ─────────────────────────── */

check(() => assert.equal(normalizeMouseTrigger(""), null, "empty is not a binding"));
check(() => assert.equal(normalizeMouseTrigger("Ctrl"), null, "a modifier with no button is not a binding"));
check(() => assert.equal(normalizeMouseTrigger("x1+x2"), null, "the hook watches exactly one button"));
check(() => assert.equal(normalizeMouseTrigger("x3"), null, "a button this build cannot name is refused, not guessed"));
check(() => assert.equal(normalizeMouseTrigger(7), null, "and so is anything that is not a string"));
check(() => assert.equal(normalizeMouseTrigger(undefined), null,
  "absent means absent; the default is applied by the caller, not here"));

/* ── The TypeScript half ─────────────────────────────────────────────────── */

const ts = readFileSync(new URL("../src/constants/mouseTrigger.ts", import.meta.url), "utf8");

check(() => assert.ok(ts.includes(`export const DEFAULT_MOUSE_TRIGGER = '${DEFAULT_MOUSE_TRIGGER}'`),
  "the renderer's default drifted from main's"));
for (const button of Object.keys(MOUSE_TRIGGER_VK)) {
  check(() => assert.ok(new RegExp(`\\b${button}:`).test(ts),
    `the renderer has no label for '${button}', so a binding main accepts would draw blank`));
}
check(() => assert.ok(/NEEDS_MODIFIER[^=]*=\s*new Set\(\['left', 'right'\]\)/.test(ts),
  "the renderer no longer refuses exactly the two buttons main refuses"));
check(() => assert.ok(ts.includes("0: 'left'") && ts.includes("1: 'middle'") && ts.includes("2: 'right'") &&
  ts.includes("3: 'x1'") && ts.includes("4: 'x2'"),
  "MouseEvent.button no longer maps onto the five buttons the hook knows"));

/* ── The C# half ─────────────────────────────────────────────────────────── */

const cs = readFileSync(new URL("../backend/native-helper/rovyl-helper.cs", import.meta.url), "utf8");

check(() => assert.ok(cs.includes("if (vk != 1 && vk != 2 && vk != 4 && vk != 5 && vk != 6) vk = 4;"),
  "the helper no longer accepts every VK main can send it — bindings would silently become the wheel"));
check(() => assert.ok(cs.includes("MOUSEEVENTF_LEFTDOWN") && cs.includes("MOUSEEVENTF_RIGHTDOWN"),
  "the helper cannot replay a left/right press, so a plain click under the pointer would be eaten"));
check(() => assert.ok(/TriggerModMask != 0 && GetCurrentModifierMask\(\) != TriggerModMask/.test(cs),
  "the helper stopped gating the press on the modifiers, so Ctrl+left would take every click"));
check(() => assert.ok(cs.includes("if (!isDown && !TriggerPressed)"),
  "the helper stopped pairing the release to a press it took, so releases would leak"));
check(() => assert.ok(cs.includes("parts.Length >= 4 && parts.Length <= 7"),
  "the helper no longer accepts the TRIGGER command with a modifier mask on the end"));

/* ── Main sends what the helper expects ──────────────────────────────────── */

const mainJs = readFileSync(new URL("../backend/electron-main.js", import.meta.url), "utf8");

check(() => assert.ok(
  mainJs.includes("`TRIGGER ${virtualKey} ${mode} ${slop} ${clickHoldMs} ${clickDragPx} ${modMask || 0}`"),
  "the TRIGGER command main writes no longer carries the modifier mask"));
check(() => assert.ok(!/MOUSE_TRIGGER_BUTTONS/.test(mainJs),
  "main still has a hand-written list of buttons beside the shared parser"));
check(() => assert.ok(/mouseTriggerAllowsHold\(binding\.token\)[\s\S]{0,120}"hold"/.test(mainJs),
  "main no longer coerces a left/right binding to click before arming the hook"));

/* ── Settings does not offer a gesture it cannot arm ─────────────────────── */

const panel = readFileSync(new URL("../src/components/PrecisionSettings.tsx", import.meta.url), "utf8");

check(() => assert.ok(/const triggerAllowsHold = mouseTriggerAllowsHold\(/.test(panel),
  "the panel stopped asking whether this binding has a gesture to choose"));
check(() => assert.ok(/\.\.\.\(triggerAllowsHold[\s\S]{0,200}key: 'mouseMode'/.test(panel),
  "the gesture row is no longer hidden for the bindings that cannot use it"));
check(() => assert.ok(/mouseTriggerAllowsHold\(next\) \? \{\} : \{ mouseTriggerMode: 'click'/.test(panel),
  "recording a click-only button no longer writes the gesture back to click with it"));

console.log(`mouse-trigger-smoke: OK (${assertions} assertions passed)`);
