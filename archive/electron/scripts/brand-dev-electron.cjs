"use strict";
/**
 * Running from source launches Electron's prebuilt binary directly, and that binary introduces
 * itself to Windows as Electron: its PE version resource carries `FileDescription: "Electron"` and
 * its icon is Electron's. Task Manager reads that field, the taskbar and Alt-Tab read that icon,
 * and so the app the user started shows up under the runtime's identity.
 *
 * Neither knob in the app reaches this. `app.setName("Rovyl")` renames things Electron owns —
 * userData, the menu — not anything Win32 reads off the executable, and the `BrowserWindow`
 * `icon:` option dresses the window while the process keeps the old face.
 *
 * So this does two things, and both are needed:
 *
 *   1. Renames `electron.exe` to `Rovyl.exe`, rewriting `node_modules/electron/path.txt` so
 *      `require("electron")` still resolves. The name is what Task Manager's Details tab shows,
 *      but the bigger reason is the icon: Task Manager caches an executable's icon per path for
 *      the life of its own process, so a Task Manager opened before the stamp goes on keeps
 *      showing the Electron icon for every windowless child process no matter what the file now
 *      contains — only the one process with a window looks right, because that icon comes from
 *      the window. A path it has never seen has nothing to serve stale.
 *   2. Stamps Rovyl's icon and version strings onto it — the same stamp
 *      `scripts/after-pack-win-icon.cjs` applies to the packaged executable.
 *
 * It is idempotent: a marker beside the exe records what was written, so a repeat call is a couple
 * of `stat`s, and an `npm install` — which restores `electron.exe`, rewrites `path.txt` and takes
 * the marker with it — is undone by the next call.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const iconPath = path.join(projectRoot, "build", "icon.ico");
const markerName = ".rovyl-branding.json";
/** The name the process runs under, and the only name the launchers should look for. */
const EXE_NAME = "Rovyl.exe";
/** Bumped when the stamp's contents change, so existing markers stop matching. */
const stampFormat = 2;

/**
 * Where Electron's binaries live.
 *
 * `node_modules/electron` exports its exe path as a string under plain node (under Electron itself
 * it exports the API object, hence the typeof guard). It builds that path from `path.txt` without
 * checking that the file exists, so it locates the directory even mid-rename.
 */
function resolveDistDir() {
  try {
    const exported = require(path.join(projectRoot, "node_modules", "electron"));
    if (typeof exported === "string") return path.dirname(exported);
  } catch (_) {
    /* not installed, or exporting something else — fall through to the known layout */
  }
  return path.join(projectRoot, "node_modules", "electron", "dist");
}

/** `build/icon.ico` is generated, not committed. Build it here rather than fail on its absence. */
function ensureIcon() {
  if (fs.existsSync(iconPath)) return true;
  try {
    execFileSync(process.execPath, [path.join(__dirname, "generate-win-icon.mjs")], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  } catch (_) {
    /* reported by the existsSync below */
  }
  return fs.existsSync(iconPath);
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function readMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Puts `Rovyl.exe` in place and points `path.txt` at it.
 *
 * A fresh install restores `electron.exe` alongside a `Rovyl.exe` left over from last time; that
 * leftover is the older runtime, so it loses. Returns null when there is nothing to rename and no
 * previous rename to fall back on.
 */
function ensureRenamed(distDir, note) {
  const stockExe = path.join(distDir, "electron.exe");
  const brandedExe = path.join(distDir, EXE_NAME);

  if (fs.existsSync(stockExe)) {
    try {
      fs.rmSync(brandedExe, { force: true });
      fs.renameSync(stockExe, brandedExe);
    } catch (e) {
      /**
       * Windows holds a write lock on a running image. Renaming loses to an instance that is
       * already up, and that is not a reason to refuse to launch: where a previous rename is still
       * in place the app starts branded anyway, and otherwise it starts as Electron until a run
       * with nothing else up gets the chance.
       */
      note(`could not rename electron.exe (${e.message}) — retry with Rovyl closed`);
      if (!fs.existsSync(brandedExe)) return null;
    }
  } else if (!fs.existsSync(brandedExe)) {
    return null;
  }

  /**
   * `electron/index.js` joins this file's contents onto `dist/`, so it is what makes
   * `require("electron")` — every launcher here, and electron's own tooling — find the renamed
   * binary. npm rewrites it back to `electron.exe` on install.
   */
  const pathTxt = path.join(path.dirname(distDir), "path.txt");
  try {
    if (fs.readFileSync(pathTxt, "utf8").trim() !== EXE_NAME) fs.writeFileSync(pathTxt, EXE_NAME);
  } catch (_) {
    /* a path.txt we cannot read or write is electron's to own; the exe is renamed regardless */
  }
  return brandedExe;
}

async function brandDevElectron({ quiet = false } = {}) {
  const note = (message) => {
    if (!quiet) console.log(`brand-dev-electron: ${message}`);
  };
  /** PE version resources and per-path icon caches are Windows notions. */
  if (process.platform !== "win32") return { stamped: false, reason: "not win32" };

  const distDir = resolveDistDir();
  const exePath = fs.existsSync(distDir) ? ensureRenamed(distDir, note) : null;
  if (!exePath) return { stamped: false, reason: "electron is not installed" };
  if (!ensureIcon()) {
    note(`missing ${iconPath} and could not generate it — leaving the runtime's icon in place`);
    return { stamped: false, reason: "no icon", exePath };
  }

  const pkg = require(path.join(projectRoot, "package.json"));
  const signature = sha256(
    Buffer.concat([Buffer.from(`${stampFormat}|${pkg.version}|`), fs.readFileSync(iconPath)]),
  );

  const markerPath = path.join(distDir, markerName);
  const marker = readMarker(markerPath);
  const before = fs.statSync(exePath);
  /**
   * The exe's own stat is half the check: a marker alone would survive an Electron upgrade that
   * dropped a fresh, unstamped binary next to it.
   */
  if (
    marker &&
    marker.signature === signature &&
    marker.exeSize === before.size &&
    marker.exeMtimeMs === before.mtimeMs
  ) {
    return { stamped: false, reason: "already branded", exePath };
  }

  const rcedit = require("rcedit");
  const year = new Date().getFullYear();
  try {
    await rcedit(exePath, {
      icon: iconPath,
      "file-version": pkg.version,
      "product-version": pkg.version,
      "version-string": {
        FileDescription: "Rovyl",
        ProductName: "Rovyl",
        InternalName: "Rovyl",
        OriginalFilename: path.basename(exePath),
        CompanyName: "Henry Cauan",
        LegalCopyright: `Copyright © ${year} Henry Cauan`,
      },
    });
  } catch (e) {
    note(`could not write ${exePath} (${e.message}) — retry with Rovyl closed`);
    return { stamped: false, reason: "rcedit failed", exePath };
  }

  const after = fs.statSync(exePath);
  try {
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify(
        { signature, exeSize: after.size, exeMtimeMs: after.mtimeMs, version: pkg.version },
        null,
        2,
      )}\n`,
    );
  } catch (_) {
    /* Without the marker the next run re-stamps: slower, still correct. */
  }
  note(`stamped Rovyl's name and icon onto ${exePath}`);
  return { stamped: true, exePath };
}

module.exports = { brandDevElectron, EXE_NAME };

if (require.main === module) {
  brandDevElectron({ quiet: process.argv.includes("--quiet") }).catch((e) => {
    // Branding is cosmetic; never let it take down an install or a launch.
    console.warn(`brand-dev-electron: skipped (${e.message})`);
  });
}
