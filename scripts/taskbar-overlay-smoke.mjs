/**
 * The taskbar overlay switches — `src/utils/taskbarOverlay.ts`.
 *
 * Three things have to hold, and each of them is a way this feature could quietly go wrong on
 * somebody's desktop:
 *
 * 1. Nobody's taskbar changes because they updated. The stored default is off, and a config
 *    written before any of these switches existed has to read as off rather than as "hide it".
 * 2. A configuration that would do nothing must be RECOGNISED as doing nothing, because that is
 *    what stops a helper process being started and a command being sent for no reason.
 * 3. The line handed to the helper is the contract with backend/taskbar-control.ps1. Its field
 *    ORDER is not guessable from either side alone — get it wrong and "hide the clock" hides the
 *    Start button instead, which is the single most confusing failure this feature can have.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-taskbar-overlay-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "taskbarOverlay.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const {
    DEFAULT_TASKBAR_OVERLAY,
    normalizeTaskbarOverlay,
    taskbarOverlayIsActive,
    taskbarApplyCommand,
  } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  /** The main-process twin. It is what actually talks to the helper. */
  const backend = (await import(pathToFileURL(join(root, "backend", "taskbar-overlay.cjs")).href)).default;

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  const on = (patch) => ({ ...DEFAULT_TASKBAR_OVERLAY, enabled: true, ...patch });

  // ── 1. Nobody's taskbar changes because they updated ──────────────────────
  check(() => {
    assert.equal(DEFAULT_TASKBAR_OVERLAY.enabled, false, "shipping this on would hide taskbars unasked");
    assert.equal(DEFAULT_TASKBAR_OVERLAY.transparent, false, "the one irreversible part is never a default");
  });
  check(() => {
    /** A config from before the feature existed. */
    assert.deepEqual(normalizeTaskbarOverlay(undefined), DEFAULT_TASKBAR_OVERLAY);
    assert.deepEqual(normalizeTaskbarOverlay(null), DEFAULT_TASKBAR_OVERLAY);
    assert.deepEqual(normalizeTaskbarOverlay({}), DEFAULT_TASKBAR_OVERLAY);
  });
  check(() => {
    /** Junk on disk must not switch anything on. */
    for (const junk of ["yes", 1, [], { enabled: "true" }, { enabled: 1 }]) {
      assert.equal(normalizeTaskbarOverlay(junk).enabled, false, `${JSON.stringify(junk)} enabled the feature`);
    }
  });
  check(() => {
    /** A key added later must take its default, not read as an explicit false. */
    const partial = normalizeTaskbarOverlay({ enabled: true, showClock: true });
    assert.equal(partial.enabled, true);
    assert.equal(partial.showClock, true);
    assert.equal(partial.transparent, DEFAULT_TASKBAR_OVERLAY.transparent);
  });

  // ── 2. A no-op configuration is recognised as one ─────────────────────────
  check(() => {
    assert.equal(taskbarOverlayIsActive(DEFAULT_TASKBAR_OVERLAY), false, "off is never active");
    assert.equal(
      taskbarOverlayIsActive({ ...DEFAULT_TASKBAR_OVERLAY, transparent: true, showClock: false }),
      false,
      "the master switch outranks every other flag",
    );
  });
  check(() => {
    /** Enabled, everything kept, plate untouched: there is literally nothing to do. */
    const nothing = on({ showStart: true, showApps: true, showTray: true, showClock: true });
    assert.equal(taskbarOverlayIsActive(nothing), false);
    /** ...and transparency alone is enough to make it worth doing. */
    assert.equal(taskbarOverlayIsActive({ ...nothing, transparent: true }), true);
  });
  check(() => {
    /** Any single element hidden is enough. */
    for (const key of ["showStart", "showApps", "showTray", "showClock"]) {
      const flags = on({ showStart: true, showApps: true, showTray: true, showClock: true, [key]: false });
      assert.equal(taskbarOverlayIsActive(flags), true, `hiding ${key} alone must count as active`);
    }
  });

  // ── 3. The wire contract with taskbar-control.ps1 ─────────────────────────
  check(() => {
    const line = taskbarApplyCommand(
      on({ transparent: true, showStart: false, showApps: true, showTray: false, showClock: true }),
      { x: -1920, y: 0, width: 1920, height: 1080 },
    );
    assert.equal(line, "APPLY -1920 0 1920 1080 1 0 1 0 1");
  });
  check(() => {
    /** Negative origins are ordinary: a second monitor to the left of the primary. */
    const line = taskbarApplyCommand(on({}), { x: -1920, y: -200, width: 1920, height: 1080 });
    assert.ok(line.startsWith("APPLY -1920 -200 1920 1080 "), line);
  });
  check(() => {
    /** Fractional DIP bounds must not reach a parser that reads integers. */
    const line = taskbarApplyCommand(on({}), { x: 0.4, y: 1439.6, width: 2560.2, height: 1440 });
    assert.equal(line, "APPLY 0 1440 2560 1440 0 0 0 0 0");
    assert.ok(!/\./.test(line), `no field may carry a decimal point: ${line}`);
  });
  check(() => {
    /** A display object that lost a field must still produce a parseable line. */
    const line = taskbarApplyCommand(on({}), { x: NaN, y: undefined, width: 1920, height: 1080 });
    assert.equal(line, "APPLY 0 0 1920 1080 0 0 0 0 0");
  });
  check(() => {
    /** Exactly ten fields, every time — the helper indexes them positionally. */
    for (const flags of [on({}), on({ transparent: true, showClock: true }), DEFAULT_TASKBAR_OVERLAY]) {
      const parts = taskbarApplyCommand(flags, { x: 0, y: 0, width: 1, height: 1 }).split(" ");
      assert.equal(parts.length, 10, `wrong field count: ${parts.join(" ")}`);
      for (const part of parts.slice(1)) assert.ok(/^-?\d+$/.test(part), `non-integer field ${part}`);
    }
  });

  // ── The helper on the other end must still read them in this order ────────
  check(() => {
    /**
     * Pinned to the source rather than described in prose. The command is built here and parsed
     * there, and nothing else would notice the two drifting apart until a user reported that the
     * wrong half of their taskbar disappeared.
     */
    const helper = readFileSync(join(root, "backend", "taskbar-control.ps1"), "utf8");
    const order = ["transparent", "showStart", "showApps", "showTray", "showClock"];
    const positions = order.map((name) => {
      const match = helper.match(new RegExp(`bool ${name} = Flag\\(parts, (\\d+)\\);`));
      assert.ok(match, `taskbar-control.ps1 no longer reads ${name} out of the APPLY line`);
      return Number(match[1]);
    });
    assert.deepEqual(positions, [5, 6, 7, 8, 9], `helper reads the APPLY fields in a different order: ${positions}`);
  });
  check(() => {
    /** And it must never learn to hide the bar itself — that is the work-area bug. */
    const helper = readFileSync(join(root, "backend", "taskbar-control.ps1"), "utf8");
    assert.ok(
      !/Hide\(bar\)|ShowWindow\(bar, SW_HIDE\)/.test(helper),
      "hiding Shell_TrayWnd hands its space back to the work area and SW_SHOW does not take it back",
    );
  });

  // ── The renderer's copy and the main process's copy must agree ────────────
  check(() => {
    /**
     * Two languages, one meaning. main is CommonJS and cannot import the .ts the settings panel
     * uses, so the rules exist twice — and this is the only thing standing between that and a
     * version where the panel writes a flag main reads differently.
     */
    assert.deepEqual(backend.DEFAULT_TASKBAR_OVERLAY, DEFAULT_TASKBAR_OVERLAY, "defaults drifted");
  });
  check(() => {
    for (const input of [undefined, null, {}, { enabled: true }, { enabled: "x" }, { showClock: true }, 7]) {
      assert.deepEqual(
        backend.normalizeTaskbarOverlay(input),
        normalizeTaskbarOverlay(input),
        `normalize drifted on ${JSON.stringify(input)}`,
      );
    }
  });
  check(() => {
    /** Every combination of the five booleans, both implementations, same verdict and same line. */
    const monitor = { x: -1920, y: 0, width: 1920, height: 1080 };
    for (let mask = 0; mask < 64; mask += 1) {
      const flags = {
        enabled: Boolean(mask & 1),
        transparent: Boolean(mask & 2),
        showStart: Boolean(mask & 4),
        showApps: Boolean(mask & 8),
        showTray: Boolean(mask & 16),
        showClock: Boolean(mask & 32),
      };
      assert.equal(
        backend.taskbarOverlayIsActive(flags),
        taskbarOverlayIsActive(flags),
        `isActive drifted at mask ${mask}`,
      );
      assert.equal(
        backend.taskbarApplyCommand(flags, monitor),
        taskbarApplyCommand(flags, monitor),
        `APPLY line drifted at mask ${mask}`,
      );
    }
  });

  console.log(`taskbar-overlay-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
