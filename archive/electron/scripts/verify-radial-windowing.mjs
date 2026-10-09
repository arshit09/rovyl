/**
 * Fails if the wheel ↔ main contract is removed by accident.
 * Update the arrays below if you refactor on purpose — keep in sync with .cursor/rules/zenith-radial-windowing.mdc
 *
 * The contract this guards changed shape when the wheel moved into its own window. It used to be
 * about two surfaces sharing one HWND without the DWM showing the seam: a `prepare-radial-show`
 * pass to get Settings off the compositor, a `nativeResizeRisk` hide-before-resize, a panel rect
 * remapped in the renderer. All of that is gone, and the `mustNotInclude` lists below are what stop
 * it coming back one well-meaning fix at a time.
 *
 * What is left is smaller and worth more:
 *
 *   1. One open handshake — `open-menu` → `radial-open-paint-done` → `radial-native-revealed` — so
 *      the overlay is never revealed before it has painted a frame.
 *   2. One resolver for which monitor the wheel is born on (`radialTargetDisplay`), asked by both
 *      the open and the idle parking. Two callers disagreeing is a visible resize on every open.
 *   3. Two windows that stay two windows: `radial.html` must not import the settings shell, and
 *      main must address each renderer by name rather than by whichever one is `mainWindow`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything the old single-window design needed, and nothing here may resurrect. */
const SHARED_WINDOW_RELICS = [
  "prepare-radial-show",
  "radial-prep-paint-done",
  "nativeWindowSizeMode",
  "panelOverlayActive",
  "panelOverlayKeptWindow",
  "keepExistingPanelWindow",
  "vacatePanelSurfaceThenOpen",
  "radialBoundsUnionWithPanel",
  "updateWindowSize(",
];

const checks = [
  {
    file: join(root, "backend", "electron-main.js"),
    mustInclude: [
      "zenith-verify:radial-handshake-main",
      "open-menu",
      "radial-open-paint-done",
      "radial-native-revealed",
      /** The overlay is a window of its own, created once and kept warm. */
      "createOverlayWindow",
      "ensureOverlayWindow",
      "radial.html",
      /**
       * Every renderer-bound message names its window. Reaching for `mainWindow.webContents.send`
       * with a wheel channel delivers it to a document that does not listen — silent, and invisible
       * until somebody uses the feature.
       */
      "function sendToOverlay",
      "function sendToSettings",
      /**
       * One resolver decides which monitor the wheel is born on, and both the open and the idle
       * parking have to ask it. Inlining `screen.getPrimaryDisplay()` back into either is silent:
       * idle would park on one screen while the open targeted another, and the resize between them
       * is a DWM flash.
       */
      "radialTargetDisplay",
      /** Idle keeps a painted, correctly-placed transparent surface — that is the whole point of it. */
      "collapseOverlayToIdle",
      "smallModeBounds",
    ],
    mustNotInclude: [
      "mainWindow.setOpacity(0.01)",
      "setImmediate(invalidatePaintSafe)",
      "IDLE_OVERLAY_COLLAPSED_SIZE",
      ...SHARED_WINDOW_RELICS,
    ],
  },
  {
    file: join(root, "backend", "electron-preload.js"),
    mustInclude: [
      "zenith-verify:radial-handshake-preload",
      "notifyRadialOpenPaintDone",
      "onRadialNativeRevealed",
      /** The wheel's own lifecycle, kept apart from Settings' show/hide. */
      "closeRadial",
      "onConfigChanged",
    ],
    mustNotInclude: SHARED_WINDOW_RELICS,
  },
  {
    file: join(root, "src", "RadialApp.tsx"),
    mustInclude: [
      "zenith-verify:radial-handshake-renderer",
      "onOpenMenu",
      "notifyRadialOpenPaintDone",
      "radialPendingPaintToken",
      "radialNativeRevealToken",
      "closeMenuFromTrigger",
      "closeOnly",
      "radialTriggerGenerationRef",
      /** A reader, never a writer: the settings window owns the file. */
      "onConfigChanged",
      "radialWorkspaceChanged",
    ],
    mustNotInclude: [
      /**
       * The wheel must not save. Two renderers writing one config file is the race this split was
       * built to make impossible, and it would fail quietly — last write wins, and the loser is
       * whatever the user just typed in Settings.
       */
      "saveFullConfig",
      "saveFullConfigSync",
      ...SHARED_WINDOW_RELICS,
    ],
  },
  {
    file: join(root, "src", "App.tsx"),
    mustInclude: [
      /** Settings is the only writer, and the only thing that surfaces a failed launch. */
      "saveFullConfigSync",
      "onRadialWorkspaceChanged",
      "onRadialLaunchFault",
      "publishDiscoveryPhase",
    ],
    mustNotInclude: [
      /** The wheel is not this document's business any more. */
      "RadialMenu",
      "radialOpenAwaitingFullscreen",
      ...SHARED_WINDOW_RELICS,
    ],
  },
  {
    file: join(root, "src", "radial-main.tsx"),
    mustInclude: ["RadialApp"],
    mustNotInclude: [
      /**
       * Not a style note. The overlay acknowledges a paint token that main waits on before it
       * reveals an already-painted HWND, and StrictMode's double-invoked effects would send that
       * acknowledgement twice for one open while tearing down and rebuilding every subscription.
       */
      "StrictMode",
    ],
  },
  {
    file: join(root, "src", "components", "RadialMenu.tsx"),
    mustInclude: ["animationReady", "isOpen && bloom", "setBloom(false)"],
  },
];

/**
 * Comments out, code left.
 *
 * The absence checks below have to read code only. Half the value of this refactor is in comments
 * that NAME what was removed and why — `prepare-radial-show`, `keepExistingPanelWindow`, the
 * three-mode window — and a verifier that cannot tell prose from code would force those
 * explanations to be deleted to stay green, which is exactly backwards: the next person needs them
 * most.
 *
 * Tracks strings so a `//` inside one is not mistaken for a comment. Regex literals are deliberately
 * not modelled: `/` only opens a comment when the next character is `/` or `*`, and neither pair can
 * appear literally inside a regex (an escaped slash is `\/`, never `//`).
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

let failed = false;
for (const { file, mustInclude = [], mustNotInclude = [] } of checks) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`verify-radial-windowing: missing file ${file}`);
    failed = true;
    continue;
  }
  /** Presence is checked against the whole file: some of these markers ARE comments. */
  for (const needle of mustInclude) {
    if (!text.includes(needle)) {
      console.error(
        `verify-radial-windowing: ${file} must include "${needle}" (radial windowing contract — see .cursor/rules/zenith-radial-windowing.mdc).`,
      );
      failed = true;
    }
  }
  /** Absence is checked against code alone — naming a dead mechanism in prose is how it stays dead. */
  const code = stripComments(text);
  for (const needle of mustNotInclude) {
    if (code.includes(needle)) {
      console.error(
        `verify-radial-windowing: ${file} must not include "${needle}" — it belongs to the single-window design the wheel was split out of, or it lets the wheel write the config file Settings owns.`,
      );
      failed = true;
    }
  }
}

/**
 * The two documents have to stay two. A value import of the settings shell from the wheel's entry
 * would not fail any build — it would quietly put the whole panel, the icon picker and the locale
 * tables in front of the first frame of a gesture that is supposed to take under a second.
 */
const radialEntry = join(root, "src", "RadialApp.tsx");
try {
  const text = stripComments(readFileSync(radialEntry, "utf8"));
  for (const [, specifier] of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    if (/(^|\/)(App|components\/PrecisionSettings)$/.test(specifier.replace(/^\.\//, ""))) {
      console.error(
        `verify-radial-windowing: ${radialEntry} imports "${specifier}" as a value — the wheel's chunk must not reach the settings shell.`,
      );
      failed = true;
    }
  }
} catch {
  /* the missing-file case is already reported above */
}

if (failed) {
  process.exit(1);
}

console.log("verify-radial-windowing: OK (two windows, one open handshake, one config writer)");
