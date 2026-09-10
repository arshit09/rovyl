/**
 * The `portable` target emits an .exe separate from win-unpacked — that wrapper needs rcedit too,
 * or it keeps the Electron icon in search/shortcuts when the user only runs the portable.
 */
const fs = require("fs");
const path = require("path");
const rcedit = require("rcedit");

module.exports = async function afterAllArtifactWinIcon(buildResult) {
  if (process.platform !== "win32") return;

  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  if (!fs.existsSync(iconPath)) {
    console.warn("after-all-artifact-win-icon: skip — build/icon.ico missing");
    return;
  }

  const raw =
    buildResult?.artifactPaths ||
    buildResult?.artifactPathsResolved ||
    /** @type {any} */ (buildResult)?.artifacts;
  const fromHook = Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];

  const outDir = typeof buildResult?.outDir === "string" ? buildResult.outDir : null;
  const fromDir = [];
  if (outDir && fs.existsSync(outDir)) {
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (!f.endsWith(".exe")) continue;
        const lower = f.toLowerCase();
        if (lower.includes("setup")) continue;
        fromDir.push(path.join(outDir, f));
      }
    } catch {
      /* ignore */
    }
  }

  const toPatch = [...new Set([...fromHook, ...fromDir])];

  for (const artifactPath of toPatch) {
    if (!artifactPath.endsWith(".exe")) continue;
    const base = path.basename(artifactPath).toLowerCase();
    if (base.includes("setup") || base.includes("installer")) continue;
    /**
     * electron-builder's portable target is a PE stub followed by a 7z archive in the overlay.
     * `rcedit` rewrites only the PE and drops that overlay, shrinking ~86 MB to ~320 KB. The icon
     * configured in the builder itself is already applied at creation time; never post-process that
     * large artifact.
     */
    try {
      if (fs.statSync(artifactPath).size > 10 * 1024 * 1024) {
        console.log(`after-all-artifact-win-icon: preserved portable payload ${artifactPath}`);
        continue;
      }
    } catch {
      continue;
    }
    try {
      await rcedit(artifactPath, { icon: iconPath });
      console.log(`after-all-artifact-win-icon: patched ${artifactPath}`);
    } catch (e) {
      console.warn(`after-all-artifact-win-icon: ${artifactPath}: ${e.message}`);
    }
  }
};
