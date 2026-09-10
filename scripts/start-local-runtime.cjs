const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const runtimeRoot = path.join(localBase, 'ZenithRadialMenu', 'deps');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCommand = fs.existsSync(npmCli) ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmPrefixArgs = fs.existsSync(npmCli) ? [npmCli] : [];
const lockPath = path.join(projectRoot, 'package-lock.json');
const lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
const stampPath = path.join(runtimeRoot, '.zenith-lock-hash');

fs.mkdirSync(runtimeRoot, { recursive: true });

const copyFile = (name) => {
  fs.copyFileSync(path.join(projectRoot, name), path.join(runtimeRoot, name));
};

const copyDirectory = (name) => {
  const source = path.join(projectRoot, name);
  const destination = path.join(runtimeRoot, name);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
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
  copyDirectory(directory);
}

const installedVite = path.join(runtimeRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const installedHash = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
if (!fs.existsSync(installedVite) || installedHash !== lockHash) {
  console.log('[Zenith] Installing dependencies outside OneDrive...');
  const install = spawnSync(npmCommand, [...npmPrefixArgs, 'ci'], {
    cwd: runtimeRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (install.error) {
    console.error('[Zenith] Failed to start npm:', install.error.message);
    process.exit(1);
  }
  if (install.status !== 0) process.exit(install.status || 1);
  fs.writeFileSync(stampPath, lockHash);
}

console.log(`[Zenith] Local runtime: ${runtimeRoot}`);

// Keep frontend edits flowing to the local runtime so Vite HMR still works while the repository
// itself remains inside OneDrive. Backend/config changes continue to require the usual restart.
const watchers = [];
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
        fs.rmSync(destination, { recursive: true, force: true });
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

const child = spawn(npmCommand, [...npmPrefixArgs, 'run', 'start:runtime'], {
  cwd: runtimeRoot,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

let stopping = false;
const stopRuntimeTree = () => {
  if (stopping || child.exitCode !== null) return;
  stopping = true;

  // On Windows, killing only the npm wrapper can leave Vite/Electron descendants alive.
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
