/**
 * Build the app, package it unpacked, and run that binary.
 *
 * `npm start` runs the production renderer under the dev Electron binary, which leaves
 * `app.isPackaged` false — so anything gated on being a real install (the updater, and every row
 * that only exists on the `direct` channel) stays invisible there. Packaging with `--dir` is the
 * cheapest way to get a genuine packaged build: it skips the NSIS step, installs nothing, and
 * registers nothing, but Windows and Electron both see an ordinary application.
 */
const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
/**
 * Outside the repository, and that is the whole point.
 *
 * VS Code's file watcher opens `app.asar` when the packaged build sits inside the open workspace,
 * and keeps the handle. electron-builder then cannot empty `win-unpacked` on the next run, aborts
 * mid-copy, and leaves a folder holding the exe but not `ffmpeg.dll` — which Windows refuses to
 * launch with STATUS_DLL_NOT_FOUND and no message, so it reads as "the app will not start".
 *
 * `npm run dist` is left alone: its artifacts are for shipping and are not written twice a minute.
 */
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const outDir = process.env.ZENITH_BUILD_OUTPUT || path.join(localAppData, "Rovyl", "devbuild");
const appDir = path.join(outDir, "win-unpacked");
const exePath = path.join(appDir, "Rovyl.exe");

const skipBuild = process.argv.includes("--no-build");

/**
 * Closing first is not politeness, it is the difference between a build and a broken folder.
 *
 * A running copy holds `Rovyl.exe` and its DLLs open, so electron-builder cannot replace them and
 * leaves `win-unpacked` half written — the exe there, `ffmpeg.dll` and `locales/` not. Windows then
 * fails the next launch with STATUS_DLL_NOT_FOUND and no message at all, which reads as "the app
 * does not start" rather than "the build did not finish".
 *
 * The second reason is the single-instance lock: a copy still up would swallow the new launch and
 * focus its own window, showing the old build.
 */
const closeRunningInstances = () => {
  const running = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process -Name Rovyl -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
    ],
    { encoding: "utf8" },
  );
  const pids = (running.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!pids.length) return;
  console.log(`[Rovyl] Closing ${pids.length} running instance(s)...`);
  spawnSync("taskkill", ["/F", ...pids.flatMap((pid) => ["/PID", pid])], { stdio: "ignore" });
  /** The lock outlives the process by a moment; give Windows time to release the file handles. */
  spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 800"], { stdio: "ignore" });
};

closeRunningInstances();

if (!skipBuild) {
  console.log("[Rovyl] Building...");
  execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
  console.log("[Rovyl] Packaging (unpacked)...");
  try {
    execSync("node scripts/run-electron-builder.mjs --dir --publish never", {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, ZENITH_BUILD_OUTPUT: outDir },
    });
  } catch (error) {
    /**
     * Nearly always one cause: a copy of the app still has the previous `app.asar` open, so
     * electron-builder cannot empty the folder. Say that, rather than re-printing a Go stack trace.
     */
    console.error(`[Rovyl] Packaging failed. If it says a file is in use, close every Rovyl and delete ${appDir}.`);
    process.exit(1);
  }

}

/**
 * The exe alone does not mean a usable build — an interrupted pack leaves exactly that. These are
 * the pieces Windows and Chromium load before any of our code runs, so a missing one is the silent
 * DLL failure above.
 */
const REQUIRED = ["Rovyl.exe", "ffmpeg.dll", "libGLESv2.dll", "icudtl.dat", "resources", "locales"];
const missing = REQUIRED.filter((name) => !fs.existsSync(path.join(appDir, name)));
if (missing.length) {
  console.error(`[Rovyl] Incomplete build in ${appDir} — missing: ${missing.join(", ")}`);
  console.error("[Rovyl] Close every running Rovyl and run again without --no-build.");
  process.exit(1);
}

/**
 * `--dir` skips the installer target, and with it the step that writes `app-update.yml`. Without
 * that file electron-updater throws ENOENT the moment anything asks it to check, so the updater row
 * — the reason this build reports the `direct` channel at all — could only ever show an error.
 * Written from the same `build.publish` block the real installer would use, on every run so a
 * `--no-build` relaunch gets it too.
 */
const publish = require("../package.json").build.publish;
fs.writeFileSync(
  path.join(appDir, "resources", "app-update.yml"),
  [
    `owner: ${publish.owner}`,
    `repo: ${publish.repo}`,
    `provider: ${publish.provider}`,
    `releaseType: ${publish.releaseType}`,
    "updaterCacheDirName: rovyl-updater",
    "",
  ].join("\n"),
  "utf8",
);

/**
 * A terminal inside an Electron host (VS Code, and Claude Code's own shell) exports
 * `ELECTRON_RUN_AS_NODE=1`. Any Electron binary started from there runs as bare Node instead of
 * as an app: no window, no main script, and an immediate exit 0 that looks exactly like the app
 * quitting on purpose. Strip it, or testing a packaged build from such a terminal is impossible.
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[Rovyl] Starting ${exePath}`);
const child = spawn(exePath, [], { cwd: appDir, env, stdio: "inherit", detached: false });
child.on("close", (code) => process.exit(code || 0));
