/**
 * Linux has no PE resource to embed an icon into: the desktop entry names an icon, and the
 * package installs PNGs into hicolor/<size>x<size>/apps/. electron-builder wants either one large
 * PNG or a directory of sized PNGs named `<size>x<size>.png`, and the directory is what produces a
 * crisp icon at every size a panel, launcher or Alt-Tab switcher might ask for.
 *
 * Generates build/icons/* from public/icon.png before electron-builder runs. Counterpart to
 * scripts/generate-win-icon.mjs, which builds the .ico Windows needs.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "public", "icon.png");
const outDir = join(root, "build", "icons");

if (!existsSync(source)) {
  console.error(`generate-linux-icons: missing ${source}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/**
 * The hicolor sizes freedesktop implementations actually look for. 1024 is deliberately left out:
 * electron-builder rejects icon sets containing sizes above 512.
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

for (const size of SIZES) {
  const out = join(outDir, `${size}x${size}.png`);
  await sharp(source)
    /** The source is square and already carries its own frame, so it goes edge to edge. */
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log(`generate-linux-icons: ${size}x${size}.png`);
}

console.log(`generate-linux-icons: wrote ${outDir}`);
