/**
 * Builds the Arch Linux package from the electron-builder output.
 *
 * electron-builder has a `pacman` target of its own, and it does not work here: it shells out to a
 * bundled fpm whose Ruby 2.3 links `libcrypt.so.1`, while Arch ships `libcrypt.so.2` (libxcrypt).
 * The miss does not raise - fpm blocks forever, so the build appears to be compressing when it has
 * in fact stalled. makepkg is Arch's own tool, needs no shim, and produces a better package.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const archDir = join(root, "packaging", "arch");
const unpacked = join(root, "build-out", "linux-unpacked");
const outDir = join(root, "build-out");

if (process.platform !== "linux") {
  console.log("[build-arch-package] Not Linux - skipping.");
  process.exit(0);
}

for (const [label, path] of [["PKGBUILD", join(archDir, "PKGBUILD")], ["linux-unpacked", unpacked]]) {
  if (!existsSync(path)) {
    console.error(`[build-arch-package] Missing ${label}: ${path}`);
    console.error("[build-arch-package] Run 'npm run dist:linux' first.");
    process.exit(1);
  }
}

if (spawnSync("makepkg", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("[build-arch-package] makepkg not found. Install base-devel: pacman -S base-devel");
  process.exit(1);
}

console.log("[build-arch-package] Running makepkg in", archDir);
const res = spawnSync("makepkg", ["-f", "--nodeps"], { cwd: archDir, stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

mkdirSync(outDir, { recursive: true });
const pkgs = readdirSync(archDir).filter((f) => f.endsWith(".pkg.tar.zst"));
for (const pkg of pkgs) {
  copyFileSync(join(archDir, pkg), join(outDir, pkg));
  console.log(`[build-arch-package] ${join(outDir, pkg)}`);
}
if (!pkgs.length) {
  console.error("[build-arch-package] makepkg reported success but produced no package.");
  process.exit(1);
}
