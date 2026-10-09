/**
 * Targeting, on the way off disk — `normalizeStoredConfig` in `src/configHydration.ts`.
 *
 * Targeting used to be three choices and is now two plus a switch, because Direction and Area
 * aimed identically and disagreed only about whether the shares were painted. Collapsing them is
 * the kind of change that cannot be checked by looking: it runs once, silently, on every profile
 * that already exists, and both ways of getting it wrong are invisible until somebody opens the
 * wheel and finds it repainted — the wedges taken from the person who chose them, or handed to the
 * person who never did.
 *
 * So the file asserts the mapping rather than the code: what was stored, and what the wheel draws
 * because of it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-targeting-mode-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "configHydration.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { normalizeStoredConfig } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  /** A stored config is never only the one key — everything else has to survive the rewrite. */
  const stored = (extra) => ({
    globalShortcut: "Alt+Z",
    workspaces: [{ id: "w1", name: "Main", hotkey: 1, enabled: true, apps: [] }],
    ...extra,
  });

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  check(() => {
    /** The value that no longer exists. It meant "these shares, unpainted" and still has to. */
    const c = normalizeStoredConfig(stored({ radialSelectionMode: "angle" }));
    assert.equal(c.radialSelectionMode, "area", "'angle' is rewritten to the mode it always was");
    assert.equal(c.radialAreaWedges, false, "and it never had the wedges");
  });

  check(() => {
    /** Someone who went and turned Area on keeps exactly what they turned on. */
    const c = normalizeStoredConfig(stored({ radialSelectionMode: "area" }));
    assert.equal(c.radialSelectionMode, "area");
    assert.equal(c.radialAreaWedges, true, "choosing Area was choosing the wedges");
  });

  check(() => {
    /** Pointer targets the icon: the switch is beside a mode it cannot apply to, and stays off. */
    const c = normalizeStoredConfig(stored({ radialSelectionMode: "cursor" }));
    assert.equal(c.radialSelectionMode, "cursor");
    assert.equal(c.radialAreaWedges, false);
  });

  check(() => {
    /**
     * A config old enough to predate the setting entirely. The default was Direction, so the
     * absence means the same as 'angle' — and must not fall through to the new default, which
     * would repaint a wheel nobody asked to have repainted.
     */
    const c = normalizeStoredConfig(stored({}));
    assert.equal(c.radialSelectionMode, "area");
    assert.equal(c.radialAreaWedges, false);
  });

  check(() => {
    /** A brand-new profile: same wheel as everyone else's, which is the point of the default. */
    const c = normalizeStoredConfig({});
    assert.equal(c.radialSelectionMode, "area");
    assert.equal(c.radialAreaWedges, false);
  });

  check(() => {
    /** Once the flag is written it is the user's, and the mode it sits under no longer decides it. */
    const on = normalizeStoredConfig(stored({ radialSelectionMode: "area", radialAreaWedges: false }));
    assert.equal(on.radialAreaWedges, false, "a stored 'off' under Area is a choice, not a default");
    const off = normalizeStoredConfig(stored({ radialSelectionMode: "cursor", radialAreaWedges: true }));
    assert.equal(off.radialAreaWedges, true, "kept through Pointer, so switching back restores it");
  });

  check(() => {
    /**
     * Idempotent. The rewrite runs on every read, not once per install — a second pass over its
     * own output has to be a no-op, or the wedges would flip on every launch.
     */
    const once = normalizeStoredConfig(stored({ radialSelectionMode: "angle" }));
    const twice = normalizeStoredConfig(once);
    assert.equal(twice.radialSelectionMode, once.radialSelectionMode);
    assert.equal(twice.radialAreaWedges, once.radialAreaWedges);
  });

  check(() => {
    /** The rewrite touches two keys and may not cost the file anything else. */
    const c = normalizeStoredConfig(stored({ radialSelectionMode: "angle", radialHoverColor: "#FF0000" }));
    assert.equal(c.globalShortcut, "Alt+Z");
    assert.equal(c.radialHoverColor, "#FF0000");
    assert.equal(c.workspaces.length, 1);
  });

  console.log(`targeting-mode-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
