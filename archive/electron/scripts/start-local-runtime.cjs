const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

/**
 * Identifies the *installed tree*, not the lockfile's bytes.
 *
 * The old key was a sha256 of the whole `package-lock.json`, which includes the project's own
 * `"version"` field — so `chore: bump the version to 1.6.0`, a two-line diff npm never installs
 * anything for, invalidated the stamp and forced a full `npm ci`: delete and refetch 626MB, about
 * 32s, plus a cold Vite pre-bundle of 2,716 Lucide modules afterwards. Four of the last five
 * commits to touch the lockfile were exactly that shape, which is why the install line seemed to
 * appear on every start. Hashing `<path>|<version>|<resolved>|<integrity>` instead reacts to the
 * tree changing and to nothing else — not the app version, not reformatting, not a re-resolution
 * that moves lines around.
 */
function computeLockKey(lockPath) {
  const raw = fs.readFileSync(lockPath);
  try {
    const lock = JSON.parse(raw);
    const rows = [];
    for (const [entryPath, entry] of Object.entries(lock.packages || {})) {
      if (!entryPath) continue;
      rows.push(`${entryPath}|${entry.version || ''}|${entry.resolved || ''}|${entry.integrity || ''}`);
    }
    if (!rows.length) throw new Error('lockfile declares no packages');
    rows.sort();
    return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  } catch (_) {
    // A lockfile we cannot read is a lockfile we cannot reason about: fall back to the raw bytes,
    // which over-invalidates rather than under-invalidates.
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
}

const realPath = (target) => {
  try {
    return fs.realpathSync.native(target);
  } catch (_) {
    return path.resolve(target);
  }
};

/**
 * Is this checkout somewhere OneDrive will sync?
 *
 * The mirror below exists for exactly one reason: OneDrive's filter driver over `node_modules`
 * makes installs and Vite's file watching slow and flaky. Away from OneDrive it buys nothing and
 * costs a duplicated 626MB tree plus the whole reinstall risk surface. The environment variables
 * are the reliable signal, but they are absent under some shells and service accounts, so a
 * `\OneDrive` / `\OneDrive - <Tenant>` path segment is accepted as a fallback. Both sides are
 * resolved through `realpath` first — Known Folder Move and dev junctions make a raw string
 * prefix test wrong in both directions.
 */
function isUnderOneDrive(directory) {
  const target = realPath(directory).toLowerCase();
  const roots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
    .filter(Boolean)
    .map((root) => realPath(root).toLowerCase());

  for (const root of roots) {
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
  }

  return target
    .split(/[\\/]/)
    .some((segment) => segment === 'onedrive' || segment.startsWith('onedrive - '));
}

const forceMirror = process.env.ROVYL_FORCE_MIRROR === '1';
const skipMirror = process.env.ROVYL_NO_MIRROR === '1';
const useMirror = forceMirror || (!skipMirror && isUnderOneDrive(projectRoot));

const lockPath = path.join(projectRoot, 'package-lock.json');
const lockKey = computeLockKey(lockPath);

const watchers = [];
let runtimeRoot = projectRoot;

if (!useMirror) {
  /**
   * The repository is not under OneDrive, so it can serve the runtime directly: no copies, no
   * second `node_modules`, no `npm ci`, no watchers — and Vite reads the working tree itself, so
   * HMR sees a save the moment it lands instead of after a copy.
   */
  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    console.error('[Rovyl] node_modules looks incomplete. Run `npm install` first.');
    process.exit(1);
  }

  const installedStamp = path.join(projectRoot, 'node_modules', '.rovyl-lock-key');
  let stamped = '';
  try {
    stamped = fs.readFileSync(installedStamp, 'utf8').trim();
  } catch (_) {
    /* first run after this change, or a tree installed before it existed */
  }
  if (stamped !== lockKey) {
    // Deliberately a warning, not an install. Dropping the mirror also drops the one place that
    // used to notice dependency drift, and silently reinstalling 626MB under someone who has just
    // run `git pull` is the behaviour this whole change exists to remove.
    if (stamped) {
      console.warn('[Rovyl] package-lock.json changed since the last install — run `npm install` if something looks wrong.');
    }
    try {
      fs.writeFileSync(installedStamp, lockKey);
    } catch (_) {
      /* an unwritable node_modules is not worth failing the start over */
    }
  }
  console.log(`[Rovyl] Running from the repository: ${projectRoot}`);
} else {
  const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  runtimeRoot = path.join(localBase, 'ZenithRadialMenu', 'deps');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCommand = fs.existsSync(npmCli) ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const npmPrefixArgs = fs.existsSync(npmCli) ? [npmCli] : [];
  const stampPath = path.join(runtimeRoot, '.zenith-lock-hash');
  const markerPath = path.join(runtimeRoot, '.zenith-install-started');

  fs.mkdirSync(runtimeRoot, { recursive: true });

  const copyFile = (name) => {
    fs.copyFileSync(path.join(projectRoot, name), path.join(runtimeRoot, name));
  };

  /**
   * Copies what changed, and removes what no longer exists.
   *
   * The previous shape was `rmSync(dest, recursive)` then `cpSync(dest, recursive)` per directory,
   * on every start — a full delete and rewrite of all 128 files whether or not any of them had
   * moved. `copyFileSync` preserves the source mtime on Windows, so size plus mtime is a sound
   * "already current" test, and the retries matter because deleting a tree the previous session
   * may still hold a handle on is otherwise an outright throw.
   */
  const syncTree = (source, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    const present = new Set();
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      present.add(entry.name);
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        syncTree(from, to);
        continue;
      }
      if (!entry.isFile()) continue;
      const sourceStat = fs.statSync(from);
      let destinationStat = null;
      try {
        destinationStat = fs.statSync(to);
      } catch (_) {
        /* not mirrored yet */
      }
      if (
        destinationStat &&
        destinationStat.size === sourceStat.size &&
        destinationStat.mtimeMs === sourceStat.mtimeMs
      ) {
        continue;
      }
      fs.copyFileSync(from, to);
    }
    let existing = [];
    try {
      existing = fs.readdirSync(destination, { withFileTypes: true });
    } catch (_) {
      /* freshly created */
    }
    for (const entry of existing) {
      if (present.has(entry.name)) continue;
      fs.rmSync(path.join(destination, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  };

  // Root files the runtime needs a copy of. `src`/`public` stream in below; these three are also
  // kept live, because letting them drift behind the source tree is not merely stale. A `src` file
  // synced ahead of the `vite.config.mjs` that defines what it imports fails to resolve outright:
  // that is how adding the `virtual:lucide-icon-set` plugin killed a running session with a
  // "Failed to resolve import" overlay, from an edit that was correct in the repository.
  const RUNTIME_FILES = ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.mjs'];
  const LIVE_SYNCED_FILES = new Set(['index.html', 'tsconfig.json', 'vite.config.mjs']);

  for (const file of RUNTIME_FILES) {
    copyFile(file);
  }

  for (const directory of ['src', 'backend', 'public', 'resources', 'scripts']) {
    syncTree(path.join(projectRoot, directory), path.join(runtimeRoot, directory));
  }

  /**
   * Signal handling has to be armed *before* the install, not after it.
   *
   * `npm ci` deletes `node_modules` as its first act and the stamp is only written on success, so
   * a Ctrl+C part way through used to leave a wiped tree and no stamp — and the next start would
   * reinstall from scratch, again, indefinitely. The marker turns that state into something the
   * next run can name instead of silently repeating the generic line.
   */
  let installing = false;
  const abandonInstall = () => {
    if (installing) {
      console.error('\n[Zenith] Dependency install interrupted — the next start will resume it.');
    }
    process.exit(130);
  };
  process.on('SIGINT', abandonInstall);
  process.on('SIGTERM', abandonInstall);

  const installedVite = path.join(runtimeRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const installedKey = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  const interrupted = fs.existsSync(markerPath);
  if (!fs.existsSync(installedVite) || installedKey !== lockKey || interrupted) {
    console.log(
      interrupted
        ? '[Zenith] The previous dependency install did not finish — reinstalling outside OneDrive...'
        : '[Zenith] Installing dependencies outside OneDrive...',
    );
    installing = true;
    fs.writeFileSync(markerPath, lockKey);
    const install = spawnSync(npmCommand, [...npmPrefixArgs, 'ci', '--no-audit', '--no-fund'], {
      cwd: runtimeRoot,
      stdio: 'inherit',
      shell: false,
    });
    if (install.error) {
      console.error('[Zenith] Failed to start npm:', install.error.message);
      process.exit(1);
    }
    if (install.status !== 0) process.exit(install.status || 1);
    installing = false;
    fs.writeFileSync(stampPath, lockKey);
    fs.rmSync(markerPath, { force: true });
  }

  console.log(`[Zenith] Local runtime: ${runtimeRoot}`);

  // Keep frontend edits flowing to the local runtime so Vite HMR still works while the repository
  // itself remains inside OneDrive. Backend/config changes continue to require the usual restart.
  for (const directory of ['src', 'public']) {
    const sourceRoot = path.join(projectRoot, directory);
    const destinationRoot = path.join(runtimeRoot, directory);
    watchers.push(fs.watch(sourceRoot, { recursive: true }, (_event, relativeName) => {
      if (!relativeName) return;
      const relativePath = String(relativeName);
      const source = path.join(sourceRoot, relativePath);
      const destination = path.join(destinationRoot, relativePath);
      try {
        if (!fs.existsSync(source)) {
          fs.rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } else if (fs.statSync(source).isFile()) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(source, destination);
        }
      } catch (error) {
        console.warn(`[Zenith] Could not sync ${relativePath}: ${error.message}`);
      }
    }));
  }

  // Vite absorbs each of these on its own — it restarts for its own config file and reloads for the
  // rest — so copying is the whole job. The two package files are deliberately not live-synced: a
  // dependency change needs `npm ci`, which only the startup path above can run.
  const rootSyncTimers = new Map();
  const warnedDependencyDrift = new Set();
  watchers.push(fs.watch(projectRoot, (_event, relativeName) => {
    if (!relativeName) return;
    const name = String(relativeName);
    if (!LIVE_SYNCED_FILES.has(name)) {
      if (RUNTIME_FILES.includes(name) && !warnedDependencyDrift.has(name)) {
        warnedDependencyDrift.add(name);
        console.warn(`[Zenith] ${name} changed — restart \`npm start\` to reinstall the dependencies.`);
      }
      return;
    }
    // Editors save by rename, so one save arrives as a burst of events with the file briefly gone.
    clearTimeout(rootSyncTimers.get(name));
    rootSyncTimers.set(name, setTimeout(() => {
      rootSyncTimers.delete(name);
      if (!fs.existsSync(path.join(projectRoot, name))) return;
      try {
        copyFile(name);
        console.log(`[Zenith] ${name} synced.`);
      } catch (error) {
        console.warn(`[Zenith] Could not sync ${name}: ${error.message}`);
      }
    }, 100));
  }));
}

const child = spawn(process.execPath, [path.join(runtimeRoot, 'scripts', 'dev-runtime.cjs')], {
  cwd: runtimeRoot,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

let stopping = false;
const stopRuntimeTree = () => {
  if (stopping || child.exitCode !== null) return;
  stopping = true;

  // On Windows, killing only the supervisor can leave Vite/Electron descendants alive.
  // Those stale overlay processes stack up and can make the system pointer feel delayed.
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  child.kill('SIGTERM');
};
process.on('SIGINT', stopRuntimeTree);
process.on('SIGTERM', stopRuntimeTree);
child.on('exit', (code, signal) => {
  for (const watcher of watchers) watcher.close();
  process.exit(code ?? (signal ? 1 : 0));
});
