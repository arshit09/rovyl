/**
 * The "Background dimming" scale — `src/utils/radialScrim.ts`.
 *
 * Three things have to hold at once, and they pull against each other:
 *
 * 1. 100% means the screen. Not a dark pool with a bright rim, not a dark rectangle the size of
 *    the radial's window: an opaque fill, edge to edge. That is the whole point of the change.
 * 2. Nobody's screen goes black because they updated. The default WAS the top of the old scale,
 *    so every existing profile carries a 1 that used to mean "half a pool" — it has to be
 *    converted, and converted to the exact alpha it was already painting.
 * 3. The radial window only stops being a box when it has to. It is the box that keeps a
 *    monitor-sized layered surface away from the DWM, and giving it up for a scrim that fades out
 *    inside it anyway would be paying for nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-backdrop-dim-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "radialScrim.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const {
    radialScrimAlphas,
    radialScrimGradient,
    radialScrimNeedsFullBleed,
    legacyBackdropOpacityToDim,
    legacyScrimPeak,
    BACKDROP_DIM_SCALE,
  } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  // ── 1. 100% means the screen ──────────────────────────────────────────────
  check(() => {
    const { peak, floor } = radialScrimAlphas(1);
    assert.equal(peak, 1, "at 100% the alpha under the wheel is opaque");
    assert.equal(floor, peak, "at 100% there is no falloff left: the fill is flat");
  });
  check(() => {
    const css = radialScrimGradient({ x: 400, y: 300 }, 1, 260);
    assert.ok(!css.includes("radial-gradient"), `a flat fill must not be drawn as a pool: ${css}`);
    assert.ok(css.includes("rgba(4,5,7,1.000)"), css);
  });
  check(() => assert.ok(radialScrimNeedsFullBleed(1), "100% needs the whole monitor"));

  // ── 2. The upgrade changes nothing on screen ──────────────────────────────
  check(() => {
    /** Every value anyone can have saved, including the 1 that was the default. */
    for (let legacy = 0; legacy <= 1.0001; legacy += 0.01) {
      const v = Math.round(legacy * 100) / 100;
      const converted = legacyBackdropOpacityToDim(v);
      const drift = Math.abs(radialScrimAlphas(converted).peak - legacyScrimPeak(v));
      assert.ok(
        drift < 0.01,
        `dim ${v} → ${converted} shifts the alpha by ${drift.toFixed(4)} (rounding to the slider's own 0.01 step is the only allowance)`,
      );
    }
  });
  check(() => {
    /** The one that matters most: the old default, which is what nearly every profile holds. */
    assert.equal(legacyBackdropOpacityToDim(1), 0.62);
    assert.ok(
      Math.abs(radialScrimAlphas(0.62).peak - 0.52) < 0.005,
      "the old top of the scale still paints the alpha it always did",
    );
  });
  check(() => {
    /** A converted config must stay a pool. Waking up to a sheet is the same shock, dimmer. */
    for (const legacy of [0, 0.25, 0.5, 0.75, 1]) {
      const converted = legacyBackdropOpacityToDim(legacy);
      assert.equal(radialScrimAlphas(converted).floor, 0, `dim ${legacy} → ${converted} must not fill out`);
      assert.ok(!radialScrimNeedsFullBleed(converted), `dim ${legacy} must not force a monitor-sized window`);
    }
  });
  check(() => assert.equal(BACKDROP_DIM_SCALE, 2, "bumping this without a converter strands every saved value"));

  // ── 3. The box is given up only when it has to be ─────────────────────────
  check(() => {
    assert.equal(radialScrimAlphas(0).floor, 0);
    assert.equal(radialScrimAlphas(0.7).floor, 0, "the pool is a pool for the whole lower range");
    for (const dim of [0, 0.3, 0.5, 0.62, 0.7]) {
      assert.ok(!radialScrimNeedsFullBleed(dim), `dim ${dim} still fits in the radial's box`);
    }
  });
  check(() => {
    /**
     * And when it does give it up, the edge it stops hiding must already be invisible — a window
     * that grows one frame after the rectangle becomes visible is worse than never growing.
     */
    let switchedAt = null;
    for (let dim = 0; dim <= 1.0001; dim += 0.005) {
      if (radialScrimNeedsFullBleed(dim)) { switchedAt = dim; break; }
    }
    assert.ok(switchedAt !== null, "some value has to need the monitor");
    assert.ok(
      radialScrimAlphas(switchedAt).floor <= 0.02,
      `the box is handed in at ${radialScrimAlphas(switchedAt).floor.toFixed(4)} alpha at the edge — visible before the window grows`,
    );
  });
  check(() => {
    /** Monotonic in both, or dragging the slider would darken and then lighten. */
    let lastPeak = -1;
    let lastFloor = -1;
    for (let dim = 0; dim <= 1.0001; dim += 0.01) {
      const { peak, floor } = radialScrimAlphas(dim);
      assert.ok(peak >= lastPeak, `peak went backwards at ${dim}`);
      assert.ok(floor >= lastFloor, `floor went backwards at ${dim}`);
      assert.ok(floor <= peak, `the rim cannot be darker than the middle (${dim})`);
      lastPeak = peak;
      lastFloor = floor;
    }
  });

  // ── Shape of the CSS the wheel actually gets ──────────────────────────────
  check(() => {
    const css = radialScrimGradient({ x: 100, y: 200 }, 0.62, 206);
    assert.ok(css.startsWith("radial-gradient(circle at 100px 200px,"), css);
    assert.ok(css.includes("rgba(4,5,7,0.000)"), "a pool has to reach true zero, or its own edge shows");
  });
  check(() => {
    /** Past the flatten point the last stop is the rest of the window, so it must not be zero. */
    const css = radialScrimGradient({ x: 0, y: 0 }, 0.9, 206);
    const stops = [...css.matchAll(/rgba\(4,5,7,([\d.]+)\)/g)].map((m) => Number(m[1]));
    assert.ok(stops.at(-1) > 0.02, `the fill outside the pool is what dims the screen: ${stops.at(-1)}`);
    assert.ok(stops.at(-1) < stops[0], "and it is still lighter than the middle");
  });
  check(() => {
    /** Nothing here may produce an alpha CSS will not take. */
    for (const dim of [-1, 0, 0.5, 1, 2, NaN, undefined]) {
      const css = radialScrimGradient({ x: 0, y: 0 }, dim, 206);
      for (const [, a] of css.matchAll(/rgba\(4,5,7,([\d.]+)\)/g)) {
        assert.ok(Number(a) >= 0 && Number(a) <= 1, `dim ${dim} produced alpha ${a}`);
      }
    }
  });
  check(() => {
    /** A config that lost the key falls back to the default, not to a blacked-out screen. */
    assert.deepEqual(radialScrimAlphas(undefined), radialScrimAlphas(0.6));
    assert.ok(!radialScrimNeedsFullBleed(undefined));
  });

  console.log(`backdrop-dim-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
