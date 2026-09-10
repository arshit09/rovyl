/**
 * Microsoft Store listing images (not the package's — those are `generate-appx-assets.mjs`).
 *
 * The Store takes each of these at exact sizes and rejects the rest. The background repeats the
 * warm gradient from the marketing material so the set reads as a family, rather than a lone icon
 * on black.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "public", "icon.png");
const outDir = process.argv[2] || join(root, "build", "store-listing");

if (!existsSync(source)) {
  console.error(`generate-store-listing-assets: missing ${source}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const FLAT = { r: 0x10, g: 0x10, b: 0x14, alpha: 1 };

/** Warm gradient, from the bottom-left corner to the top-right. */
const gradient = (width, height) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
     <defs>
       <radialGradient id="g" cx="12%" cy="88%" r="105%">
         <stop offset="0%"   stop-color="#ff9a00"/>
         <stop offset="26%"  stop-color="#f04a00"/>
         <stop offset="52%"  stop-color="#8f1200"/>
         <stop offset="76%"  stop-color="#2a0500"/>
         <stop offset="100%" stop-color="#050506"/>
       </radialGradient>
     </defs>
     <rect width="${width}" height="${height}" fill="url(#g)"/>
   </svg>`,
);

/** Icon on its own, with no composited background — for the small tiles. */
async function tile(name, size) {
  await sharp(source).resize(size, size, { fit: "contain", background: FLAT }).png()
    .toFile(join(outDir, name));
  console.log(`  ${name}  ${size}x${size}`);
}

/**
 * Mark centred over the gradient. `offsetY` lifts the icon when the Store darkens the bottom
 * third of the image to lay text there.
 */
async function poster(name, width, height, iconRatio, offsetY = 0) {
  const iconSize = Math.round(Math.min(width, height) * iconRatio);
  const icon = await sharp(source).resize(iconSize, iconSize, { fit: "contain" }).png().toBuffer();
  await sharp(gradient(width, height))
    .composite([{
      input: icon,
      left: Math.round((width - iconSize) / 2),
      top: Math.round((height - iconSize) / 2) - offsetY,
    }])
    .png()
    .toFile(join(outDir, name));
  console.log(`  ${name}  ${width}x${height}  (icon ${iconSize}px)`);
}

console.log("tiles:");
await tile("AppTileIcon-300x300.png", 300);
await tile("AppTile-150x150.png", 150);
await tile("AppTile-71x71.png", 71);

console.log("logos and art:");
await poster("PosterArt-720x1080.png", 720, 1080, 0.52, 90);
await poster("BoxArt-1080x1080.png", 1080, 1080, 0.46);
/** Super hero art: no title, no text, and nothing important in the bottom third. */
await poster("SuperHeroArt-1920x1080.png", 1920, 1080, 0.52, 70);

console.log(`\ngenerate-store-listing-assets: wrote ${outDir}`);
