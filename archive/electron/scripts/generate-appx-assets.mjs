/**
 * MSIX package tiles. electron-builder ships default assets, but they are empty placeholders —
 * anyone who installed ended up with a white square in the Start Menu, and the Microsoft Store
 * page shows the icon taken FROM THE PACKAGE, not the listing images.
 *
 * Generates build/appx/* from public/icon.png before electron-builder runs.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "public", "icon.png");
const outDir = join(root, "build", "appx");

if (!existsSync(source)) {
  console.error(`generate-appx-assets: missing ${source}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/** Same as `backgroundColor` in build.appx — the wide tile has to fill what is left over. */
const BACKGROUND = { r: 0x10, g: 0x10, b: 0x14, alpha: 1 };

/** Squares: the icon already brings its own frame, so it goes edge to edge. */
const squares = [
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square150x150Logo.png", 150],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];

/**
 * Wide tiles: the icon is square, so it is centred over the background instead of stretched.
 * Margin is left so the icon does not touch the edges.
 */
const wides = [
  ["Wide310x150Logo.png", 310, 150],
];

for (const [name, size] of squares) {
  await sharp(source).resize(size, size, { fit: "contain", background: BACKGROUND }).png().toFile(join(outDir, name));
  console.log(`generate-appx-assets: ${name} (${size}x${size})`);
}

for (const [name, width, height] of wides) {
  const inner = Math.round(height * 0.72);
  const icon = await sharp(source).resize(inner, inner, { fit: "contain", background: BACKGROUND }).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
    .composite([{ input: icon, gravity: "centre" }])
    .png()
    .toFile(join(outDir, name));
  console.log(`generate-appx-assets: ${name} (${width}x${height}, icon ${inner}px centred)`);
}

console.log(`generate-appx-assets: wrote ${outDir}`);
