/**
 * End-to-end check that the wheel and Settings really are two windows, and that the wheel opens.
 *
 * Every other test in this repo reads source or pure helpers. This one starts the app, fires the
 * real global shortcut at the real desktop, and reads what main logged — because the thing the
 * two-window split is meant to fix is a Windows compositor behaviour, and no amount of static
 * checking can tell you the overlay actually appeared.
 *
 * It runs against a THROWAWAY profile (`ROVYL_USER_DATA`) and never touches the real one.
 *
 * Two scenarios, and the second is the one that matters:
 *
 *   1. Tray-idle. Nothing on screen, the gesture opens the wheel, the gesture closes it.
 *   2. Settings on screen. This is the case that used to need an IPC handshake to get the panel off
 *      the compositor, a hide-before-resize, and a path that drew the wheel inside Settings' own
 *      frame in client coordinates — which is why the wheel could come up off-centre, on the wrong
 *      monitor, at the panel's size. Two windows make it the same open as any other, and that is
 *      exactly what this asserts: same square box, same geometry, whatever else is on screen.
 *
 * Deliberately not in `npm run build`: it needs an interactive desktop session, it briefly puts a
 * wheel on screen, and it is the kind of test that should be run on purpose.
 *
 *   node scripts/window-split-smoke.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Main computes this at module load, before any `ROVYL_USER_DATA` override can move it, so the
 * diagnostic log is in the same place whichever profile the run uses.
 */
const LOG_FILE = join(homedir(), ".rovyl", "diagnostic.log");

/** F13–F24 exist in the Windows keyboard map and no physical keyboard sends them by accident. */
const SHORTCUT = "Alt+Shift+F13";
const SENDKEYS = "%+{F13}";

const STARTUP_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;

if (process.platform !== "win32") {
  console.log("window-split-smoke: SKIP (needs Windows)");
  process.exit(0);
}
if (!existsSync(join(root, "dist", "radial.html"))) {
  console.error("window-split-smoke: no dist/radial.html — run 'npx vite build' first");
  process.exit(1);
}

const electron = (await import("electron")).default;

const failures = [];
const pass = (name) => console.log(`  ok    ${name}`);
const fail = (name, detail) => {
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sendShortcut = () =>
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${SENDKEYS}')`,
    ],
    { stdio: "ignore" },
  );

/**
 * A config that is already "set up": nothing to discover, nothing to onboard.
 *
 * `settingsOpenAtBoot` is the one lever. Leaving `hasSeenOnboarding` and the first-run marker out
 * is what makes the app decide this is a new profile and put Settings on screen — which is how the
 * second scenario gets a visible panel without anything having to click for it.
 */
const seedConfig = (profile, { settingsOpenAtBoot }) =>
  writeFileSync(
    join(profile, "config-v2.json"),
    JSON.stringify({
      config: {
        globalShortcut: SHORTCUT,
        ...(settingsOpenAtBoot ? {} : { hasSeenOnboarding: true }),
        mainStartMenuDiscoveryDone: true,
        activeWorkspaceIndex: 0,
        workspaces: [
          {
            id: "workspace-1",
            name: "Main",
            enabled: true,
            hotkey: 1,
            apps: [
              {
                id: "smoke-1",
                type: "app",
                label: "Notepad",
                command: "notepad.exe",
                commandType: "app",
                direction: "N",
              },
            ],
          },
        ],
        persistenceMeta: {
          version: 2,
          ...(settingsOpenAtBoot ? {} : { isFirstRunCompleted: true }),
        },
      },
    }),
    "utf8",
  );

async function runScenario(title, { settingsOpenAtBoot }) {
  console.log(`\n${title}`);
  const profile = mkdtempSync(join(tmpdir(), "rovyl-smoke-"));
  seedConfig(profile, { settingsOpenAtBoot });

  /** Where the log already ended, so nothing from an earlier run can satisfy a check. */
  const logOffset = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").length : 0;
  const newLog = () => {
    try {
      return readFileSync(LOG_FILE, "utf8").slice(logOffset);
    } catch {
      return "";
    }
  };

  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = newLog();
      if (predicate(log)) return log;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  };

  const env = { ...process.env, NODE_ENV: "production", ROVYL_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ["."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdio = "";
  child.stdout.on("data", (d) => (stdio += d));
  child.stderr.on("data", (d) => (stdio += d));

  try {
    await waitFor(
      (log) => log.includes("[Overlay] Stable idle"),
      STARTUP_TIMEOUT_MS,
      "the overlay window to be created and parked",
    );
    pass("the wheel gets its own window, painted and parked at idle");

    /**
     * And its renderer is actually running.
     *
     * `Stable idle` only says the window painted, which a document whose script died does too — a
     * broken overlay is transparent and silent, exactly like a healthy one, and the only symptom
     * would be a gesture that quietly does nothing. This line is sent from an effect in `RadialApp`
     * after the config arrives, so it cannot appear unless React mounted and hydrated.
     */
    try {
      const ready = await waitFor(
        (log) => log.includes("[Overlay] Renderer ready"),
        STARTUP_TIMEOUT_MS,
        "the wheel's renderer to mount and hydrate",
      );
      const geometry = ready.match(/\[Overlay\] Renderer ready; wheel geometry (\{[^}]*\})/);
      pass(`the wheel's renderer mounted and read the config ${geometry ? geometry[1] : ""}`);
    } catch (e) {
      fail("the wheel's renderer mounts", e.message);
    }

    const shortcutLog = await waitFor(
      (log) => /Global shortcut .* registered successfully|Fallback .* registered/.test(log),
      STARTUP_TIMEOUT_MS,
      "the global shortcut to be registered",
    );
    if (shortcutLog.includes(`Global shortcut '${SHORTCUT}' registered successfully`)) {
      pass(`global shortcut ${SHORTCUT} registered`);
    } else {
      fail("global shortcut registered", `${SHORTCUT} was taken; the open test cannot fire`);
      return { child, profile };
    }

    /** Let the renderer settle — a cold overlay is exactly what this should be testing. */
    await new Promise((r) => setTimeout(r, settingsOpenAtBoot ? 4000 : 2500));

    sendShortcut();

    const openLog = await waitFor(
      (log) => log.includes("[RadialOpen] reveal"),
      OPEN_TIMEOUT_MS,
      "the wheel to open and reveal",
    );
    const reveal = openLog.match(/\[RadialOpen\] reveal latency=(\d+)ms bounds=(\{[^}]*\})/);
    if (!reveal) {
      fail("reveal line is parseable", "no bounds in the [RadialOpen] line");
      return { child, profile };
    }
    pass(`the wheel opened (reveal ${reveal[1]}ms, bounds ${reveal[2]})`);

    /**
     * A box of its own, not Settings' 880x600 rect. That mismatch is the single-window bug this
     * split exists to remove, and on screen it looked exactly like this: the wheel drawn at the
     * panel's size, centred on the panel rather than the monitor.
     */
    const bounds = JSON.parse(reveal[2]);
    if (bounds.width === bounds.height && bounds.width !== 880) {
      pass(`the wheel opened in its own square box (${bounds.width}px)`);
    } else {
      fail("the wheel opens in its own box", `got ${bounds.width}x${bounds.height}`);
    }

    /** And the same gesture again closes it — the toggle, across the IPC boundary. */
    sendShortcut();
    try {
      await waitFor((log) => log.includes("[RadialClose]"), OPEN_TIMEOUT_MS, "the wheel to close");
      pass("a second trigger closes the wheel and returns the overlay to idle");
    } catch (e) {
      fail("second trigger closes the wheel", e.message);
    }

    return { child, profile, bounds };
  } catch (e) {
    fail(title, e.message);
    if (stdio.trim()) console.error(stdio.trim().split("\n").slice(-15).join("\n"));
    return { child, profile };
  }
}

const cleanup = async ({ child, profile }) => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 800));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* a locked Chromium cache file is not a test failure */
  }
};

const idle = await runScenario("Scenario 1 — nothing on screen (the app sits in the tray)", {
  settingsOpenAtBoot: false,
});
await cleanup(idle);

const overPanel = await runScenario("Scenario 2 — Settings on screen", {
  settingsOpenAtBoot: true,
});
await cleanup(overPanel);

if (idle.bounds && overPanel.bounds) {
  /**
   * The whole claim of the refactor, in one assertion: what else is on screen no longer changes
   * where the wheel is born. Before the split these two numbers could differ — the wheel took
   * Settings' frame when the panel happened to sit near the middle of the monitor.
   */
  const same =
    idle.bounds.x === overPanel.bounds.x &&
    idle.bounds.y === overPanel.bounds.y &&
    idle.bounds.width === overPanel.bounds.width &&
    idle.bounds.height === overPanel.bounds.height;
  console.log("");
  if (same) {
    pass("the wheel opens at identical bounds with and without Settings on screen");
  } else {
    fail(
      "the wheel's geometry is independent of Settings",
      `idle ${JSON.stringify(idle.bounds)} vs over-panel ${JSON.stringify(overPanel.bounds)}`,
    );
  }
}

if (failures.length) {
  console.error(`\nwindow-split-smoke: FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nwindow-split-smoke: OK");
