/**
 * The arithmetic behind the settings panel's dropdown.
 *
 * A custom dropdown is a promise to reimplement what `<select>` was doing for nothing, and the two
 * halves that are not markup are here: where the popup lands, and where a keystroke goes. Both
 * fail quietly. A placement bug shows up only in a short panel or near an edge — the popup is
 * simply in the wrong place, and often only for the people it happens to. A type-ahead bug shows
 * up only when a letter is pressed twice, and reads as the list being stuck rather than as a bug.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-select-menu-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "components", "selectMenu.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const {
    selectMenuPlacement,
    helpTipPlacement,
    typeAheadIndex,
    nextTypeAheadBuffer,
    menuHeight,
    MENU_MIN_WIDTH,
    MENU_ROW_HEIGHT,
    MENU_MARGIN,
    MENU_GAP,
    TIP_WIDTH,
    TYPE_AHEAD_RESET_MS,
  } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  /** The real row: the seven languages, as the Language setting builds them. */
  const LANGS = [
    { value: "en", label: "English", hint: "English" },
    { value: "es", label: "Español", hint: "Spanish" },
    { value: "zh", label: "简体中文", hint: "Chinese (Simplified)" },
    { value: "pt", label: "Português", hint: "Portuguese" },
    { value: "ru", label: "Русский", hint: "Russian" },
    { value: "de", label: "Deutsch", hint: "German" },
    { value: "ar", label: "العربية", hint: "Arabic" },
  ];
  const at = (code) => LANGS.findIndex((entry) => entry.value === code);

  /* ── placement ─────────────────────────────────────────────────────────── */

  /**
   * The real geometry, and the reason every assertion below reads in container coordinates.
   *
   * The settings shell does NOT start at the top of the window — it begins under the app's custom
   * title bar, which is what `top: 36` stands for here. Placements come back relative to that box,
   * so a correct downward placement is a small number like 6, never 6 + 36.
   */
  const SHELL = { top: 36, left: 0, width: 1280, height: 764 };
  /** A row control near the top of the settings panel: plenty of room underneath. */
  const roomy = { top: 200, bottom: 230, right: 900, width: 150 };
  /** Viewport y to the container-relative y the popup will actually be painted at. */
  const inShell = (viewportY) => viewportY - SHELL.top;

  check(() => {
    const place = selectMenuPlacement(roomy, SHELL, LANGS.length);
    assert.equal(place.drop, "down", "with room below, the list drops down");
    assert.ok(place.top > inShell(roomy.bottom), "a downward list starts below the trigger");
  });

  check(() => {
    /**
     * The regression this file was rewritten for.
     *
     * The popup used `position: fixed` with viewport coordinates. But `PanelTransition` wraps the
     * panel in a `motion.div` carrying `filter: blur()`, and a filter makes that element the
     * containing block for any fixed descendant — so the popup was PAINTED against a box starting
     * below the title bar while being MEASURED against the window, and opened exactly one title
     * bar too low. Pinning the gap to the constant makes that impossible to reintroduce quietly.
     */
    const place = selectMenuPlacement(roomy, SHELL, LANGS.length);
    const gap = place.top - inShell(roomy.bottom);
    assert.equal(gap, MENU_GAP, `the gap under the trigger must be exactly MENU_GAP, got ${gap}`);
  });

  check(() => {
    /** The same trigger with the shell further down the window: the offset must not leak in. */
    const deeper = selectMenuPlacement(roomy, { ...SHELL, top: 120, height: 680 }, LANGS.length);
    assert.equal(
      deeper.top,
      roomy.bottom + MENU_GAP - 120,
      "placement tracks the container, not the window",
    );
  });

  check(() => {
    const place = selectMenuPlacement(roomy, SHELL, LANGS.length);
    assert.equal(place.width, MENU_MIN_WIDTH, "a narrow trigger still gets a readable list");
    assert.equal(
      place.left + place.width,
      roomy.right - SHELL.left,
      "the list aligns to the trigger's right edge, which is where the control sits in the row",
    );
  });

  check(() => {
    const wide = { ...roomy, width: 320, right: 900 };
    assert.equal(selectMenuPlacement(wide, SHELL, LANGS.length).width, 320, "a wide trigger keeps its width");
  });

  check(() => {
    /** Bottom of the panel: not enough underneath, so it flips above the trigger. */
    const low = { top: 720, bottom: 750, right: 900, width: 150 };
    const place = selectMenuPlacement(low, SHELL, LANGS.length);
    assert.equal(place.drop, "up", "with no room below, the list flips up");
    assert.ok(
      place.top + menuHeight(LANGS.length) <= inShell(low.top),
      "an upward list ends above the trigger",
    );
    assert.ok(place.top >= MENU_MARGIN, "and never starts off the top of the container");
  });

  check(() => {
    /**
     * Squeezed both ways. Neither side fits, so it takes the roomier one rather than flipping to
     * whichever merely overflows less by accident.
     */
    const squeezed = { top: 150, bottom: 180, right: 900, width: 150 };
    /** floor 400: 206px below, 100px above, and the list needs 276. */
    const place = selectMenuPlacement(squeezed, { top: 36, left: 0, width: 1280, height: 364 }, LANGS.length);
    assert.equal(place.drop, "down", "206px below beats 100px above, though neither fits");
  });

  check(() => {
    const squeezed = { top: 336, bottom: 366, right: 900, width: 150 };
    /** floor 380: nothing below at all, 286px above. */
    const place = selectMenuPlacement(squeezed, { top: 36, left: 0, width: 1280, height: 344 }, LANGS.length);
    assert.equal(place.drop, "up", "286px above beats nothing below");
  });

  check(() => {
    /** A trigger hard against the right edge: the list must not hang off it. */
    const edge = { top: 200, bottom: 230, right: 1278, width: 150 };
    const place = selectMenuPlacement(edge, SHELL, LANGS.length);
    assert.ok(place.left + place.width <= SHELL.width - MENU_MARGIN + 1, "clamped inside the right edge");
  });

  check(() => {
    /** And against the left, which is where a single Math.max gets it wrong under RTL. */
    const edge = { top: 200, bottom: 230, right: 40, width: 30 };
    const place = selectMenuPlacement(edge, SHELL, LANGS.length);
    assert.ok(place.left >= MENU_MARGIN, "never off the left edge");
  });

  check(() => {
    /** A container too narrow for the list still starts inside it, not at -120. */
    const place = selectMenuPlacement(
      { top: 200, bottom: 230, right: 180, width: 150 },
      { top: 36, left: 0, width: 200, height: 764 },
      7,
    );
    assert.ok(place.left >= MENU_MARGIN, `left should stay inside the container, got ${place.left}`);
  });

  check(() => {
    /** A container inset from the left must not push the popup off its own edge. */
    const place = selectMenuPlacement(
      { top: 200, bottom: 230, right: 300, width: 40 },
      { top: 36, left: 240, width: 1040, height: 764 },
      LANGS.length,
    );
    assert.ok(place.left >= MENU_MARGIN, "clamped to the container's left edge, not the window's");
  });

  check(() => {
    assert.ok(menuHeight(50) <= 320, "a long list is capped and scrolls, rather than growing past the panel");
    assert.ok(menuHeight(2) < menuHeight(7), "a short list is not padded to full height");
  });

  /* ── type-ahead ────────────────────────────────────────────────────────── */

  check(() => {
    assert.equal(typeAheadIndex(LANGS, 0, "d"), at("de"), "`d` finds Deutsch");
    assert.equal(typeAheadIndex(LANGS, 0, "de"), at("de"), "`de` still finds Deutsch");
  });

  check(() => {
    /** The English name is matched too: someone hunting German may not type `Deutsch`. */
    assert.equal(typeAheadIndex(LANGS, 0, "germ"), at("de"), "`germ` finds Deutsch by its English name");
    assert.equal(typeAheadIndex(LANGS, 0, "chin"), at("zh"), "`chin` finds 简体中文");
    assert.equal(typeAheadIndex(LANGS, 0, "port"), at("pt"), "`port` finds Português");
  });

  check(() => {
    /** Non-Latin endonyms have to be reachable in their own script, not only via English. */
    assert.equal(typeAheadIndex(LANGS, 0, "Рус"), at("ru"), "Cyrillic type-ahead finds Русский");
    assert.equal(typeAheadIndex(LANGS, 0, "简"), at("zh"), "a Han character finds 简体中文");
    assert.equal(typeAheadIndex(LANGS, 0, "الع"), at("ar"), "Arabic type-ahead finds العربية");
  });

  check(() => {
    /**
     * A single letter CYCLES. `e` from English moves on to Español rather than re-finding the row
     * the highlight is already on — the bug that reads as the list being stuck.
     */
    const first = typeAheadIndex(LANGS, -1, "e");
    assert.equal(first, at("en"), "`e` starts at English");
    const second = typeAheadIndex(LANGS, first, "e");
    assert.equal(second, at("es"), "`e` again moves to Español");
    const third = typeAheadIndex(LANGS, second, "e");
    assert.equal(third, at("en"), "`e` a third time wraps back to English");
  });

  check(() => {
    /** A longer buffer REFINES: it must include the row `d` just landed on, not skip past it. */
    const afterD = typeAheadIndex(LANGS, 0, "d");
    assert.equal(typeAheadIndex(LANGS, afterD, "de"), afterD, "`de` stays on the Deutsch `d` found");
  });

  check(() => {
    assert.equal(typeAheadIndex(LANGS, 5, "eng"), at("en"), "the search wraps past the end of the list");
  });

  check(() => {
    assert.equal(typeAheadIndex(LANGS, 0, "xyz"), null, "no match returns null rather than moving");
    assert.equal(typeAheadIndex(LANGS, 0, ""), null, "an empty buffer matches nothing");
    assert.equal(typeAheadIndex([], 0, "a"), null, "an empty list does not throw");
  });

  check(() => {
    assert.equal(typeAheadIndex(LANGS, 0, "ESPA"), at("es"), "matching is case-insensitive");
  });

  check(() => {
    /** -1 is the real starting `activeIndex` before anything is highlighted. */
    const hit = typeAheadIndex(LANGS, -1, "a");
    assert.ok(hit !== null && hit >= 0 && hit < LANGS.length, `index out of range: ${hit}`);
  });

  check(() => {
    assert.equal(nextTypeAheadBuffer("d", "e", 120), "de", "brisk typing extends the buffer");
    assert.equal(nextTypeAheadBuffer("d", "e", TYPE_AHEAD_RESET_MS + 1), "e", "a pause starts a new buffer");
    assert.equal(nextTypeAheadBuffer("", "d", 9e9), "d", "the very first keystroke is its own buffer");
  });

  /**
   * The help bubble. It hangs off the mark inside the popup, so the arithmetic is against a 13px
   * glyph near the right edge of a panel — every interesting case is an edge case, and the two
   * that matter both fail silently: a bubble that hangs off the panel is simply cut in half, and
   * one that does not flip near the floor is a sentence nobody can read.
   */
  /**
   * The Shortcut behavior popup as it really opens: two options, right-aligned to a row that ends
   * near the right edge of the panel, each with a 13px mark at the end of it.
   */
  const POPUP = { top: 342, bottom: 414 };
  const MARK_TOGGLE = { top: 356, bottom: 369, left: 1180, right: 1193 };
  const MARK_HOLD = { top: 388, bottom: 401, left: 1180, right: 1193 };
  const TIP_H = 56;
  const centreOf = (mark) => (mark.left + mark.right) / 2;

  check(() => {
    const tip = helpTipPlacement(MARK_HOLD, POPUP, SHELL, TIP_H);
    assert.equal(tip.drop, "down", "with room below, the bubble hangs under the popup");
    assert.equal(tip.top, POPUP.bottom + MENU_GAP - SHELL.top, "one gap under it");
    assert.ok(tip.top + SHELL.top - MARK_HOLD.bottom < MENU_ROW_HEIGHT, "which is right under the last mark");
  });

  check(() => {
    /** The first mark's bubble must land in the same place, not on the option below it. */
    const tip = helpTipPlacement(MARK_TOGGLE, POPUP, SHELL, TIP_H);
    assert.equal(tip.top, POPUP.bottom + MENU_GAP - SHELL.top, "it drops to the foot of the popup");
    assert.ok(tip.top + SHELL.top >= POPUP.bottom, "and covers none of the list");
  });

  check(() => {
    /** Tied to the mark by its column, wherever it ended up vertically. */
    const roomy = { top: 356, bottom: 369, left: 500, right: 513 };
    const tip = helpTipPlacement(roomy, { top: 342, bottom: 414 }, SHELL, TIP_H);
    assert.equal(tip.left + TIP_WIDTH / 2, centreOf(roomy) - SHELL.left, "centred on the mark");
  });

  check(() => {
    /** At the end of the option, centring would overhang the panel, so the clamp takes over. */
    const tip = helpTipPlacement(MARK_HOLD, POPUP, SHELL, TIP_H);
    assert.ok(
      tip.left + TIP_WIDTH <= SHELL.width - MENU_MARGIN,
      `bubble runs past the panel: ${tip.left + TIP_WIDTH} > ${SHELL.width - MENU_MARGIN}`,
    );
    assert.ok(tip.left + TIP_WIDTH / 2 < centreOf(MARK_HOLD) - SHELL.left, "clamped, so no longer centred");
  });

  check(() => {
    /** Mirrored: in Arabic the popup is over at the left, and the clamp is the other one. */
    const rtl = { top: 356, bottom: 369, left: 40, right: 53 };
    assert.equal(
      helpTipPlacement(rtl, POPUP, SHELL, TIP_H).left,
      MENU_MARGIN,
      "held off the near edge as well as the far one",
    );
  });

  check(() => {
    /** A popup near the floor: below would cut the sentence off, so it goes above the whole list. */
    const floorPopup = { top: SHELL.top + SHELL.height - 80, bottom: SHELL.top + SHELL.height - 8 };
    const mark = { top: floorPopup.bottom - 26, bottom: floorPopup.bottom - 13, left: 500, right: 513 };
    const tip = helpTipPlacement(mark, floorPopup, SHELL, TIP_H);
    assert.equal(tip.drop, "up", "no room below flips the bubble above");
    assert.equal(tip.top + TIP_H, floorPopup.top - MENU_GAP - SHELL.top, "clear of the popup's top edge");
  });

  check(() => {
    /** Neither side fits: it stays inside the shell rather than hanging off the top of it. */
    const squeezed = { top: 0, left: 0, width: 900, height: TIP_H };
    const mark = { top: 20, bottom: 33, left: 500, right: 513 };
    const tip = helpTipPlacement(mark, { top: 10, bottom: 40 }, squeezed, TIP_H);
    assert.equal(tip.drop, "up", "below does not fit");
    assert.equal(tip.top, MENU_MARGIN, "and above is clamped to the shell");
  });

  check(() => {
    /** A shell too narrow for any of it still yields a box inside the shell, not outside it. */
    const narrow = { top: 0, left: 0, width: TIP_WIDTH, height: 400 };
    const tip = helpTipPlacement(MARK_HOLD, POPUP, narrow, TIP_H);
    assert.equal(tip.left, MENU_MARGIN, "pinned to the near edge rather than off the far one");
  });

  console.log(`select-menu-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
