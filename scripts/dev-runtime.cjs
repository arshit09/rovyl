const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { waitForPort, isPortOpen } = require('./wait-for-port.cjs');

/**
 * Runs the dev pair — Vite, then Electron once Vite is actually listening.
 *
 * This replaces `concurrently -k "npm run dev" "npm run electron"`, which reached Electron only
 * after `npm run start:runtime` -> concurrently -> two cmd.exe shells -> two more `npm run`s ->
 * `wait-on` -> `cross-env` -> one more node. Every one of those is a process boot on the critical
 * path and none of them does any work: measured together they cost ~2s before Vite is even asked
 * to start. Spawning the two children directly is the same supervision with none of the hops, and
 * it drops `concurrently`, `wait-on` and `cross-env` from the dependency tree with them.
 */
const DEV_PORT = 5173;
const root = process.cwd();

/** Who holds the port, for the reuse notice. Best-effort: a missing PID is not worth failing over. */
function findPortOwner(port) {
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch (_) {
    /* netstat is a nicety, not a requirement */
  }
  return null;
}

const children = new Set();
let shuttingDown = false;

/**
 * Kills a child and everything it started.
 *
 * On Windows killing the direct child is not enough — Vite and Electron both spawn descendants,
 * and orphaned overlay processes stack up and make the pointer feel delayed. `taskkill /T` is the
 * only thing that reliably takes the whole tree.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch (_) {
    /* already gone */
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code ?? 0);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function track(child, label) {
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    console.log(`[Rovyl] ${label} exited (${signal || code}). Stopping the dev runtime.`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  child.on('error', (error) => {
    console.error(`[Rovyl] ${label} failed to start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

(async () => {
  /**
   * Reuse a Vite that is already up rather than racing it.
   *
   * `vite.config.mjs` sets `strictPort: true`, so a second Vite on 5173 exits immediately — and
   * under `concurrently -k` that exit tore the Electron branch down too, turning "a dev server is
   * already running" into a failed start with a misleading error. Reusing the listener is both
   * faster and correct; the port is never taken by force, because the process holding it might not
   * be ours to kill.
   */
  let viteChild = null;
  if (await isPortOpen(DEV_PORT)) {
    const pid = findPortOwner(DEV_PORT);
    console.log(
      `[Rovyl] Port ${DEV_PORT} is already serving${pid ? ` (PID ${pid})` : ''} — reusing it instead of starting a second Vite.`,
    );
  } else {
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    viteChild = track(
      spawn(process.execPath, [viteBin], {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
      }),
      'Vite',
    );

    if (!(await waitForPort(DEV_PORT))) {
      console.error(`[Rovyl] Vite never started listening on ${DEV_PORT}.`);
      return shutdown(1);
    }
  }

  /**
   * `ELECTRON_RUN_AS_NODE` makes Electron behave as a plain Node process, and then `app` and
   * `BrowserWindow` are simply not there. It leaks in from whatever launched us, so it is cleared
   * here rather than trusted to be absent.
   */
  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronExe = require(path.join(root, 'node_modules', 'electron'));
  track(
    spawn(electronExe, ['.'], { cwd: root, stdio: 'inherit', env, windowsHide: false }),
    'Electron',
  );
})();
