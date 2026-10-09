/**
 * Area targeting's geometry — `src/utils/radialSectors.ts`.
 *
 * The wheel is allowed exactly one opinion about where a target is. The pointer resolves an index;
 * the SVG paints a wedge. If those two ever disagree, the wheel lights one shortcut and opens
 * another — and it does so silently, at the one moment the user is least able to tell what went
 * wrong. This file exists to make that class of bug impossible to ship:
 *
 * 1. Every direction on the plane belongs to exactly one item, and to the item whose wedge covers
 *    it. Proved by sweeping the full circle at a fine step, for every wheel size worth having.
 * 2. The shares are equal. That is the whole promise of the mode: two items, half the screen each;
 *    four items, a quarter each.
 * 3. The paths are paths. A one-item wheel is the case that breaks naively — an arc whose ends
 *    coincide draws nothing — and a wheel with one shortcut still has to show its area.
 * 4. The highlight arrives at nothing. The wedge reaches the edge of the window, so whatever alpha
 *    it still has there is drawn as a straight cut across the desktop. Its gradient therefore has
 *    to land on exactly zero at the rim, with its stops in order and sampled densely enough that a
 *    fade hundreds of pixels long does not band.
 * 5. And it still arrives at nothing once the beam is drawn STRAIGHT out along the wedge rather
 *    than in a ring around the hub. A linear fade crosses the wedge's far corners before its tip,
 *    so the zero has to be moved in to meet them — otherwise the rim keeps alpha the window cuts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-radial-sectors-"));

/** Wheel sizes that matter: one item, the even splits the user names, and a crowded wheel. */
const COUNTS = [1, 2, 3, 4, 5, 6, 8, 12, 20];

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "radialSectors.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const {
    sectorBoundsDeg,
    sectorIndexForDelta,
    annularSectorPath,
    polarPoint,
    sectorBeamAlphas,
    sectorBeamLean,
    sectorBeamStops,
    sectorCentreDeg,
    sectorReachStops,
    sectorGradientStops,
    sectorSoloFadeMask,
    SECTOR_FILL_ALPHA,
    SECTOR_EDGE_ALPHA,
    SECTOR_SEAM_ALPHA,
    SECTOR_SEAM_REACH,
  } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  /** Which wedge a bearing falls in, read off the DRAWN bounds — never off the aim's arithmetic. */
  const drawnIndexAt = (deg, count) => {
    for (let i = 0; i < count; i += 1) {
      const { startDeg, endDeg } = sectorBoundsDeg(i, count);
      const offset = ((deg - startDeg) % 360 + 360) % 360;
      if (offset < endDeg - startDeg) return i;
    }
    return null;
  };

  // ── 1. What is lit is what opens ──────────────────────────────────────────
  check(() => {
    for (const count of COUNTS) {
      const sliceAngle = 360 / count;
      for (let deg = 0; deg < 360; deg += 0.05) {
        /**
         * Skip the seams themselves. A boundary is one line, not an area: which side of it a
         * float lands on is a rounding question and no user can aim at it on purpose. What has to
         * hold is the INSIDE of every wedge.
         */
        const fromSeam = Math.abs((((deg + 90 + sliceAngle / 2) % sliceAngle) + sliceAngle) % sliceAngle);
        if (fromSeam < 0.01 || sliceAngle - fromSeam < 0.01) continue;

        const rad = (deg * Math.PI) / 180;
        const aimed = sectorIndexForDelta(Math.cos(rad) * 200, Math.sin(rad) * 200, count);
        const painted = drawnIndexAt(deg, count);
        assert.equal(
          aimed,
          painted,
          `${count} items, bearing ${deg.toFixed(2)}°: the aim says ${aimed}, the wedge drawn there is ${painted}`,
        );
      }
    }
  });

  // ── 2. Equal shares ───────────────────────────────────────────────────────
  check(() => {
    for (const count of COUNTS) {
      const spans = Array.from({ length: count }, (_, i) => {
        const { startDeg, endDeg } = sectorBoundsDeg(i, count);
        return endDeg - startDeg;
      });
      for (const span of spans) {
        assert.ok(
          Math.abs(span - 360 / count) < 1e-9,
          `${count} items: a wedge spans ${span}°, not ${360 / count}°`,
        );
      }
      assert.ok(
        Math.abs(spans.reduce((sum, span) => sum + span, 0) - 360) < 1e-9,
        `${count} items: the wedges must add up to the whole plane`,
      );
    }
  });

  /** The wheel's own convention: item 0 is at twelve o'clock, and straight up must select it. */
  check(() => {
    for (const count of COUNTS) {
      assert.equal(sectorIndexForDelta(0, -200, count), 0, `${count} items: straight up is item 0`);
    }
  });

  /** Two items really is half the screen each — the example the mode is explained with. */
  check(() => {
    assert.equal(sectorIndexForDelta(200, 0, 2), 1, "two items: the right half belongs to item 1");
    assert.equal(sectorIndexForDelta(-200, 0, 2), 0, "two items: the left half belongs to item 0");
    assert.equal(sectorIndexForDelta(0, 200, 2), 1, "two items: straight down is item 1's half");
  });

  /** An empty level has no share to give out. */
  check(() => assert.equal(sectorIndexForDelta(100, 100, 0), null));

  // ── 3. The paths are drawable ─────────────────────────────────────────────
  check(() => {
    for (const count of COUNTS) {
      for (let i = 0; i < count; i += 1) {
        const { startDeg, endDeg } = sectorBoundsDeg(i, count);
        const d = annularSectorPath(60, 300, startDeg, endDeg);
        assert.ok(d.startsWith("M "), `${count}/${i}: a path starts with a move`);
        assert.ok(d.endsWith(" Z"), `${count}/${i}: a filled wedge has to close`);
        assert.ok(!/NaN|Infinity|undefined/.test(d), `${count}/${i}: ${d}`);
        /** Both radii have to appear, or what was drawn is a disc and not a ring. */
        assert.ok(d.includes("A 300 300"), `${count}/${i}: no outer arc in ${d}`);
        assert.ok(d.includes("A 60 60"), `${count}/${i}: no inner arc in ${d}`);
      }
    }
  });

  /** One item owns the plane, and the ring it gets is stitched from two halves. */
  check(() => {
    const { startDeg, endDeg } = sectorBoundsDeg(0, 1);
    assert.equal(endDeg - startDeg, 360);
    const d = annularSectorPath(60, 300, startDeg, endDeg);
    assert.equal((d.match(/A 300 300/g) || []).length, 2, `the outer ring needs two arcs: ${d}`);
    assert.equal((d.match(/A 60 60/g) || []).length, 2, `the inner ring needs two arcs: ${d}`);
  });

  /** The seams are drawn from the same bounds the wedges are, so they land on the wedges' edges. */
  check(() => {
    const outer = 300;
    for (const count of COUNTS.filter((c) => c > 1)) {
      for (let i = 0; i < count; i += 1) {
        const { startDeg } = sectorBoundsDeg(i, count);
        const near = polarPoint(outer, 60, startDeg);
        const far = polarPoint(outer, outer, startDeg);
        assert.ok(
          Math.abs(Math.hypot(near.x - outer, near.y - outer) - 60) < 1e-9 &&
            Math.abs(Math.hypot(far.x - outer, far.y - outer) - outer) < 1e-9,
          `${count}/${i}: the seam does not run from the dead zone to the rim`,
        );
      }
    }
  });

  // ── 4. The highlight arrives at nothing ───────────────────────────────────
  const ALPHAS = [SECTOR_FILL_ALPHA, SECTOR_EDGE_ALPHA, SECTOR_SEAM_ALPHA];
  /** Every shape of wheel: a tight dead zone against a distant rim, and the squeezed opposite. */
  const GEOMETRIES = [
    [0.12, 0.32], [0.2, 0.5], [0.05, 0.2], [0.4, 0.7], [0.6, 0.62], [0.88, 0.9],
  ];

  check(() => {
    for (const [inner, falloff] of GEOMETRIES) {
      for (const [near, far] of ALPHAS) {
        const stops = sectorGradientStops(inner, falloff, near, far);
        const last = stops[stops.length - 1];
        assert.equal(
          last.offset,
          1,
          `inner ${inner} / falloff ${falloff}: the gradient must run all the way to the rim`,
        );
        assert.ok(
          last.opacity < 1e-9,
          `inner ${inner} / falloff ${falloff}: alpha ${last.opacity} at the rim would be cut by the window edge`,
        );
      }
    }
  });

  /** Out-of-order stops are silently clamped by SVG, which would collapse the fade into a ring. */
  check(() => {
    for (const [inner, falloff] of GEOMETRIES) {
      for (const [near, far] of ALPHAS) {
        const stops = sectorGradientStops(inner, falloff, near, far);
        for (let i = 1; i < stops.length; i += 1) {
          assert.ok(
            stops[i].offset >= stops[i - 1].offset,
            `inner ${inner} / falloff ${falloff}: stop ${i} at ${stops[i].offset} goes backwards`,
          );
        }
        for (const stop of stops) {
          assert.ok(stop.offset >= 0 && stop.offset <= 1, `offset ${stop.offset} is off the gradient`);
          assert.ok(stop.opacity >= 0 && stop.opacity <= 1, `opacity ${stop.opacity} is not an alpha`);
        }
      }
    }
  });

  /** Monotonic, and never brighter than where it started: a dissolve, not a second glow. */
  check(() => {
    for (const [inner, falloff] of GEOMETRIES) {
      const [near, far] = SECTOR_FILL_ALPHA;
      const stops = sectorGradientStops(inner, falloff, near, far);
      for (let i = 1; i < stops.length; i += 1) {
        assert.ok(
          stops[i].opacity <= stops[i - 1].opacity + 1e-9,
          `inner ${inner}: alpha rises again at stop ${i} (${stops[i - 1].opacity} → ${stops[i].opacity})`,
        );
      }
      assert.ok(stops[0].opacity <= 1 && stops[0].opacity === near);
    }
  });

  /**
   * The samples reproduce the curve they stand for.
   *
   * A gradient is drawn as straight lines between its stops, so the stop list is an approximation
   * of `(1 - t)²` and the question is how good. Too few and the dissolve becomes a fan of flat
   * facets with a visible kink at every stop — which is the same defect as a sudden fade, just
   * repeated. (Stop density is NOT what keeps an 8-bit ramp from banding: that is fixed by the
   * total alpha range over the distance, and no number of stops changes it.)
   */
  check(() => {
    for (const [inner, falloff] of GEOMETRIES) {
      for (const [near, far] of ALPHAS) {
        const stops = sectorGradientStops(inner, falloff, near, far);
        const plateau = stops[1].offset;
        if (plateau >= 1 - 1e-9) continue;
        let worst = 0;
        for (let i = 1; i < stops.length - 1; i += 1) {
          const a = stops[i];
          const b = stops[i + 1];
          if (b.offset - a.offset < 1e-9) continue;
          /** Sample the chord against the curve it is standing in for. */
          for (let k = 1; k < 8; k += 1) {
            const offset = a.offset + ((b.offset - a.offset) * k) / 8;
            const chord = a.opacity + ((b.opacity - a.opacity) * k) / 8;
            const t = (offset - plateau) / (stops[stops.length - 1].offset - plateau);
            worst = Math.max(worst, Math.abs(chord - far * (1 - t) * (1 - t)));
          }
        }
        assert.ok(
          worst <= 0.004,
          `inner ${inner} / falloff ${falloff}: the stops miss the curve by ${worst.toFixed(4)} — the fade will show facets`,
        );
      }
    }
  });

  // ── 5. The beam leans, the reach arrives, and the product does both ──────
  /**
   * The wedge is lit by the two multiplied: a LINEAR gradient along its own bisector, masked by
   * the ring the whole plane shares. Neither could do the job alone. A straight gradient holds its
   * value on lines ACROSS the beam, and such a line meets the rim — so on its own it would have to
   * be finished by the wedge's far corners, which on a wide wedge is barely half way out, leaving a
   * short triangle cut off by a chord with the lit sides running past it. And the ring on its own
   * fades in arcs, which is the thing that carries no direction at all.
   *
   * What is checked here is the product, at the two places it can go wrong: on the rim, where
   * anything left standing is cut by the window; and across a wedge at one radius, where too much
   * lean stops being a direction and becomes a bulge out of the slice's own sides.
   */
  /** What a gradient paints at `offset`, the way SVG does it — straight lines between stops. */
  const alphaAt = (stops, offset) => {
    if (offset <= stops[0].offset) return stops[0].opacity;
    for (let i = 1; i < stops.length; i += 1) {
      if (offset <= stops[i].offset) {
        const span = stops[i].offset - stops[i - 1].offset;
        if (span < 1e-12) return stops[i].opacity;
        const t = (offset - stops[i - 1].offset) / span;
        return stops[i - 1].opacity + (stops[i].opacity - stops[i - 1].opacity) * t;
      }
    }
    return stops[stops.length - 1].opacity;
  };

  /**
   * What is actually painted at radius `r` (as a fraction of the rim), `theta` off the bisector.
   * The beam is read at the point's distance ALONG the bisector, which is what a straight gradient
   * measures; the reach is read at its distance from the hub.
   */
  const paintedAlpha = (beam, reach, r, theta) =>
    alphaAt(beam, r * Math.cos(theta)) * alphaAt(reach, r);

  /** The rim is cut by the window, so the product has to be nothing there — from every direction. */
  check(() => {
    for (const count of COUNTS) {
      const lean = sectorBeamLean(count);
      const half = Math.PI / count;
      for (const [inner, falloff] of GEOMETRIES) {
        const reach = sectorReachStops(inner, falloff, lean);
        for (const [near, far] of ALPHAS) {
          const beam = sectorBeamStops(inner, falloff, near, far, lean);
          for (let k = 0; k <= 8; k += 1) {
            const theta = (-half + (2 * half * k) / 8) * 0.999;
            assert.ok(
              paintedAlpha(beam, reach, 1, theta) < 1e-9,
              `${count} items, inner ${inner}: alpha left on the rim at ${((theta * 180) / Math.PI).toFixed(1)}° off the beam`,
            );
          }
          /** And it gets there by fading, not by stopping: still falling on the way out. */
          let previous = Infinity;
          for (let k = 0; k <= 40; k += 1) {
            const r = inner + ((1 - inner) * k) / 40;
            const alpha = paintedAlpha(beam, reach, r, 0);
            assert.ok(
              alpha <= previous + 1e-9,
              `${count} items, inner ${inner}: the beam brightens again at ${r.toFixed(3)} of the way out`,
            );
            previous = alpha;
          }
        }
      }
    }
  });

  /**
   * The lean is a direction, not a bulge.
   *
   * A straight gradient always leaves the sides of a wedge a little ahead of its axis, so at one
   * radius the edges are brighter than the middle. That is what makes the light read as going
   * somewhere — and past a point it instead reads as the highlight spilling sideways out of the
   * slice it belongs to, which is the three-item wheel's whole complaint. `sectorBeamLean` buys the
   * lean in proportion to `cos(half slice)` for exactly this reason, so the wider the wedge, the
   * less of it is taken.
   */
  check(() => {
    for (const count of COUNTS) {
      const lean = sectorBeamLean(count);
      assert.ok(lean > 0 && lean <= 1, `${count} items: a lean of ${lean} is not a fraction`);
      if (count <= 2) {
        assert.ok(
          Math.abs(lean - 1) < 1e-9,
          `${count} items: a half-plane has no direction to lean in — its own flat side lies across the beam`,
        );
      }
      const half = Math.PI / count;
      for (const [inner, falloff] of GEOMETRIES) {
        const reach = sectorReachStops(inner, falloff, lean);
        const [near, far] = SECTOR_FILL_ALPHA;
        const beam = sectorBeamStops(inner, falloff, near, far, lean);
        for (let k = 1; k <= 20; k += 1) {
          const r = inner + ((1 - inner) * k) / 20;
          const axis = paintedAlpha(beam, reach, r, 0);
          const edge = paintedAlpha(beam, reach, r, half * 0.999);
          /**
           * Only where there is light to be judged. Under this the composite is a rounding error
           * on a desktop, and the ratio between two numbers that small is not a look anyone sees.
           */
          if (axis < 0.02) continue;
          assert.ok(
            edge <= axis * 1.4 + 1e-9,
            `${count} items, inner ${inner}: at ${r.toFixed(2)} the sides are ${(edge / axis).toFixed(2)}× the axis — that is a bulge, not a beam`,
          );
          assert.ok(
            edge >= axis - 1e-9,
            `${count} items: a straight beam cannot be dimmer at the sides than on its own axis`,
          );
        }
      }
    }
  });

  /** A wheel with room for the lean has to actually take it, or nothing was bought at all. */
  check(() => {
    const [near, far] = SECTOR_FILL_ALPHA;
    const beam = sectorBeamStops(0.2, 0.5, near, far, sectorBeamLean(8));
    assert.ok(
      beam[beam.length - 1].opacity < far * 0.5,
      "eight items: the beam reaches the rim at nearly full strength — there is no direction in it",
    );
    assert.ok(
      beam[beam.length - 1].opacity > 0,
      "the beam only leans; arriving at nothing is the reach's job, and a zero here would double it",
    );
  });

  /**
   * And the split costs the wheel nothing it had. Along the bisector the two multiply back to the
   * curve the wedge has always faded on — same hold, same `(1 - t)²`, same arrival — so what the
   * beam buys is the direction alone, and not a dimmer or a shorter highlight.
   */
  check(() => {
    for (const count of COUNTS) {
      const lean = sectorBeamLean(count);
      for (const [inner, falloff] of GEOMETRIES) {
        for (const [near, far] of ALPHAS) {
          const beam = sectorBeamStops(inner, falloff, near, far, lean);
          const reach = sectorReachStops(inner, falloff, lean);
          const asBefore = sectorGradientStops(inner, falloff, near, far);
          const plateau = asBefore[1].offset;
          for (let k = 0; k <= 40; k += 1) {
            const r = inner + ((1 - inner) * k) / 40;
            const painted = paintedAlpha(beam, reach, r, 0);
            if (r >= plateau) {
              assert.ok(
                Math.abs(painted - alphaAt(asBefore, r)) < 0.002,
                `${count} items, inner ${inner}: at ${r.toFixed(3)} the beam paints ${painted.toFixed(4)} where the wedge always painted ${alphaAt(asBefore, r).toFixed(4)}`,
              );
            } else {
              /**
               * Inside the hold the two differ by design and by one thing only: the beam's ramp
               * from `near` to `far` starts at the centre rather than at the dead zone, so that the
               * wedge's foreshortened inner corners land on it instead of in front of it. It is
               * still the same hold, between the same two alphas.
               */
              assert.ok(
                painted <= near + 1e-9 && painted >= far - 1e-9,
                `${count} items, inner ${inner}: the hold paints ${painted.toFixed(4)}, outside [${far}, ${near}]`,
              );
            }
          }
        }
      }
    }
  });

  /** The reach is a factor, so it has to be one: never above full, never negative, never rising. */
  check(() => {
    for (const count of COUNTS) {
      const lean = sectorBeamLean(count);
      for (const [inner, falloff] of GEOMETRIES) {
        const reach = sectorReachStops(inner, falloff, lean);
        assert.equal(reach[reach.length - 1].offset, 1, `${count} items: the reach must span the plane`);
        assert.ok(reach[reach.length - 1].opacity < 1e-9, `${count} items: the reach must end at nothing`);
        for (let i = 0; i < reach.length; i += 1) {
          assert.ok(
            reach[i].opacity >= 0 && reach[i].opacity <= 1 + 1e-9,
            `${count} items: a mask value of ${reach[i].opacity} is not a factor`,
          );
          if (i > 0) {
            assert.ok(reach[i].offset >= reach[i - 1].offset, `${count} items: reach stop ${i} goes backwards`);
            assert.ok(
              reach[i].opacity <= reach[i - 1].opacity + 1e-9,
              `${count} items: the reach brightens again at stop ${i}`,
            );
          }
        }
      }
    }
  });

  /**
   * The gradient points where the aim does. Its vector is the wedge's bisector, and if those two
   * ever parted the wheel would light a beam down one slice while opening the item in another.
   */
  check(() => {
    for (const count of COUNTS) {
      for (let i = 0; i < count; i += 1) {
        const deg = sectorCentreDeg(i, count);
        const { startDeg, endDeg } = sectorBoundsDeg(i, count);
        assert.ok(
          Math.abs(deg - (startDeg + endDeg) / 2) < 1e-9,
          `${count}/${i}: the beam runs down ${deg}°, the wedge is centred on ${(startDeg + endDeg) / 2}°`,
        );
        const rad = (deg * Math.PI) / 180;
        assert.equal(
          sectorIndexForDelta(Math.cos(rad) * 200, Math.sin(rad) * 200, count),
          i,
          `${count}/${i}: aiming straight down the beam must select the item it belongs to`,
        );
      }
    }
  });

  /**
   * The wider the wedge, the less alpha it is given, because what the eye weighs is the light and
   * a wedge's share of the plane is `1 / count`. Never above what the numbers were tuned to be.
   */
  check(() => {
    let previous = 0;
    for (const count of COUNTS) {
      const [near, far] = sectorBeamAlphas(SECTOR_FILL_ALPHA, count);
      assert.ok(
        near <= SECTOR_FILL_ALPHA[0] + 1e-9 && far <= SECTOR_FILL_ALPHA[1] + 1e-9,
        `${count} items: the temper brightened the wedge past its calibration`,
      );
      assert.ok(near > far && far > 0, `${count} items: ${near}/${far} is not a hold that ramps down`);
      assert.ok(
        near >= previous - 1e-9,
        `${count} items: a narrower wedge came out dimmer than a wider one`,
      );
      previous = near;
      /**
       * The point of the square root: the light a wedge puts on the desktop — alpha times its
       * share of the plane — has to FALL as the wedge widens, or the wide one is a wash; and it has
       * to rise, or the crowded wheel's slivers are invisible. Halfway is between the two.
       */
      const light = near / count;
      if (count > 1) {
        const wider = sectorBeamAlphas(SECTOR_FILL_ALPHA, count - 1)[0] / (count - 1);
        assert.ok(
          light < wider + 1e-9 || near >= SECTOR_FILL_ALPHA[0] - 1e-9,
          `${count} items: a narrower wedge puts more light on the desktop than a wider one`,
        );
      }
    }
    assert.ok(
      Math.abs(sectorBeamAlphas(SECTOR_FILL_ALPHA, 20)[0] - SECTOR_FILL_ALPHA[0]) < 1e-9,
      "a crowded wheel is the wheel these alphas were calibrated on — it must get them unchanged",
    );
    assert.ok(
      sectorBeamAlphas(SECTOR_FILL_ALPHA, 3)[0] < SECTOR_FILL_ALPHA[0] * 0.8,
      "three items covers a third of the plane per wedge and has to be tempered for it",
    );
  });

  /**
   * A one-item ring is not a halo: its light is strongest through the icon, falls off smoothly both
   * ways round the wheel, and is gone on the far side — and it is centred on the icon's own bearing.
   */
  check(() => {
    const mask = sectorSoloFadeMask(sectorCentreDeg(0, 1));
    assert.ok(mask.startsWith("conic-gradient(from 0deg at 50% 50%"), `the fade is not aimed at the icon: ${mask}`);
    const stops = [...mask.matchAll(/rgba\(0, 0, 0, ([\d.]+)\) ([\d.]+)deg/g)].map((m) => ({
      alpha: Number(m[1]),
      deg: Number(m[2]),
    }));
    assert.ok(stops.length >= 25, `${stops.length} stops is too few for a fade round a whole turn`);
    assert.equal(stops[0].alpha, 1, "the icon's own direction has to be the brightest");
    assert.equal(stops.at(-1).alpha, 1, "the turn has to close where it started, or there is a seam at the icon");
    const back = stops.find((stop) => stop.deg === 180);
    assert.ok(back && back.alpha === 0, "the far side of a one-item wheel has to be dark");
    for (let i = 1; i < stops.length; i += 1) {
      const rising = stops[i].deg > 180;
      assert.ok(
        rising ? stops[i].alpha >= stops[i - 1].alpha : stops[i].alpha <= stops[i - 1].alpha,
        `the fade is not monotonic at ${stops[i].deg}deg`,
      );
    }
    assert.equal(
      sectorBeamAlphas(SECTOR_FILL_ALPHA, 1)[0],
      sectorBeamAlphas(SECTOR_FILL_ALPHA, 2)[0],
      "a faded one-item ring lights about half the plane, so it is tempered as a two-item wedge",
    );
  });

  /** The seams are furniture, not the highlight: shorter, and fainter than the fill. */
  check(() => {
    assert.ok(SECTOR_SEAM_REACH > 0 && SECTOR_SEAM_REACH < 1, "seams must stop short of the wedges");
    assert.ok(
      SECTOR_SEAM_ALPHA[0] < SECTOR_FILL_ALPHA[0],
      "a seam that outshines the lit wedge is drawing attention to the wrong thing",
    );
    assert.ok(
      SECTOR_EDGE_ALPHA[0] > SECTOR_FILL_ALPHA[0],
      "the wedge's sides carry its angle, so they have to read above its fill",
    );
  });

  console.log(`radial-sectors-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
