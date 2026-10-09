/**
 * With `signAndEditExecutable: false`, electron-builder skips PE icon embedding,
 * so shortcuts / Start menu show Electron's default. Apply build/icon.ico via rcedit after pack.
 */
const fs = require("fs");
const path = require("path");
const rcedit = require("rcedit");

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== "win32") return;

  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  const appOutDir = context.appOutDir;
  const info = context.packager?.appInfo;
  const primary =
    info?.productFilename &&
    path.join(appOutDir, `${info.productFilename}.exe`);

  const candidates = [];
  if (primary) candidates.push(primary);
  if (info?.sanitizedProductName && info.sanitizedProductName !== info.productFilename) {
    candidates.push(path.join(appOutDir, `${info.sanitizedProductName}.exe`));
  }

  let exePath = candidates.find((p) => p && fs.existsSync(p));

  if (!exePath && fs.existsSync(appOutDir)) {
    const exes = fs
      .readdirSync(appOutDir)
      .filter((f) => f.endsWith(".exe"))
      .map((f) => path.join(appOutDir, f));
    if (exes.length === 1) exePath = exes[0];
    else if (exes.length > 1) {
      const want = (info?.productFilename || info?.sanitizedProductName || "").toLowerCase();
      exePath =
        exes.find((p) => path.basename(p, ".exe").toLowerCase() === want) ||
        exes.find((p) => !path.basename(p).toLowerCase().startsWith("uninstall")) ||
        exes[0];
    }
  }

  if (!exePath || !fs.existsSync(exePath)) {
    throw new Error(
      `after-pack-win-icon: could not find main .exe under ${appOutDir} (productFilename=${info?.productFilename})`,
    );
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(
      `after-pack-win-icon: missing ${iconPath} — run "npm run build" so generate-win-icon runs before dist.`,
    );
  }

  /**
   * Beyond the icon, the executable's metadata.
   *
   * Task Manager shows the `FileDescription` field of the PE version resource. Electron's
   * prebuilt binary carries "Electron" there, and with `signAndEditExecutable: false` nobody
   * rewrote it — the app showed up to the user under the runtime's name instead of its own.
   * `rcedit` was already in use for the icon; writing the version in the same step costs nothing.
   */
  const pkg = require("../package.json");
  const year = new Date().getFullYear();

  await rcedit(exePath, {
    icon: iconPath,
    "file-version": pkg.version,
    "product-version": pkg.version,
    "version-string": {
      FileDescription: "Rovyl",
      ProductName: "Rovyl",
      InternalName: "Rovyl",
      OriginalFilename: `${path.basename(exePath)}`,
      CompanyName: "Henry Cauan",
      LegalCopyright: `Copyright © ${year} Henry Cauan`,
    },
  });
  console.log(`after-pack-win-icon: set icon and version info on ${exePath}`);
};
