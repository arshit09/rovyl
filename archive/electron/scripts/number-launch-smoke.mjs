import assert from "node:assert/strict";

/**
 * Who owns a digit pressed on an open wheel.
 *
 * Three features want 1-9 and only one of them can have each keystroke: quick launch
 * (`radialNumberLaunch`), the workspace keys — which are 1-9 by position until one is recorded —
 * and the type-ahead filter. The real routing lives in `RadialMenu`'s keydown handler and is not
 * reachable from node, so it is mirrored here — the pairing that matters is that this file and
 * that handler agree, and the cases below are the ones that were wrong before they were written.
 *
 * `bound` is whether a workspace answers to this digit. It stands in for `workspaceKeys`, which
 * has already had the digits taken out of it while quick launch is on, so nothing here has to test
 * that setting twice.
 */
function routeDigit({ key, numberLaunch, bound, itemCount, typeAhead }) {
  if (typeAhead) return "filter";
  if (numberLaunch && key >= "1" && key <= "9") {
    if (parseInt(key, 10) - 1 < itemCount) return "launch";
    /* No slice under it — falls through rather than being swallowed. */
  }
  if (!numberLaunch && bound) return "workspace";
  if (key >= "1" && key <= "8" && parseInt(key, 10) - 1 < itemCount) return "aim";
  return "filter";
}

/**
 * Mirrors `set-workspace-shortcuts` in electron-main: when main registers 1-9 globally.
 *
 * Main no longer assumes the digits — it registers the key list the renderer sends
 * (`workspaceKeyBindings`), and `sanitizeWorkspaceBindings` drops every digit from it while quick
 * launch is claiming them. The answer for the DIGITS is therefore unchanged, which is what this
 * mirrors; that a recorded LETTER survives the same claim is `workspace-key-smoke`.
 */
function registersGlobalDigits(numberKeysClaimed) {
  return numberKeysClaimed !== true;
}

const BOUND = { bound: true, itemCount: 6, typeAhead: "" };
const FREE = { bound: false, itemCount: 6, typeAhead: "" };

// Quick launch off: a digit a workspace answers to goes there.
assert.equal(routeDigit({ ...BOUND, key: "2", numberLaunch: false }), "workspace",
  "without quick launch, 2 goes into the workspace holding it");
assert.equal(routeDigit({ ...FREE, key: "2", numberLaunch: false }), "aim",
  "a digit no workspace claims only aims, Enter still required");

// Quick launch on: it takes them, bound or not.
assert.equal(routeDigit({ ...BOUND, key: "2", numberLaunch: true }), "launch",
  "quick launch beats the workspace key for the same digit");
assert.equal(routeDigit({ ...FREE, key: "2", numberLaunch: true }), "launch",
  "and runs the slice where nothing else wanted the digit");
assert.equal(routeDigit({ ...BOUND, key: "9", numberLaunch: true, itemCount: 9 }), "launch",
  "the ninth slice is reachable");

// A digit with no slice under it is a character, not a silent no-op and not a workspace switch.
assert.equal(routeDigit({ ...BOUND, key: "7", numberLaunch: true, itemCount: 4 }), "filter",
  "past the last slice: falls through to the filter, never to the workspace key");
assert.equal(routeDigit({ ...FREE, key: "7", numberLaunch: true, itemCount: 4 }), "filter",
  "past the last slice with nothing bound reaches the filter too");

// Once something is typed, every digit is a character — "Photoshop 2024" has to be reachable.
assert.equal(routeDigit({ ...BOUND, key: "2", numberLaunch: true, typeAhead: "photo" }), "filter",
  "a running filter owns the digits");
assert.equal(routeDigit({ ...BOUND, key: "2", numberLaunch: false, typeAhead: "photo" }), "filter",
  "and did so before quick launch existed");

// Main must release the keys the renderer was told to handle, or they never arrive.
assert.equal(registersGlobalDigits(false), true,
  "nothing claiming them: main registers the global digits");
assert.equal(registersGlobalDigits(true), false,
  "quick launch claims them: main must not consume 1-9 globally");
assert.equal(registersGlobalDigits(undefined), true,
  "an older renderer sending no claim keeps the shipped behaviour");

console.log("number-launch-smoke: OK (12 assertions passed)");
