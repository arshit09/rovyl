/**
 * Glyphs for the tray context menu items, as PNG files under `public/`.
 *
 * Deliberately NOT part of `npm run build`. Writing into `public/` would have to happen *before*
 * `vite build` — it wipes `dist` and copies `publicDir` — which is the opposite of where the other
 * `generate-*` steps sit; appending it like them would silently leave the packaged app one build
 * behind. Writing into `dist/` instead would leave `npm run dev` glyphless on a fresh clone, since
 * `dist` is gitignored. So the PNGs are committed and this script is run by hand after touching a
 * glyph or a tint: `npm run icons:tray`.
 *
 * Windows has no template-image tinting for menu icons (`setTemplateImage` is a no-op off macOS),
 * so one file cannot serve both menu themes — each glyph is emitted twice and the main process
 * picks a set from `nativeTheme.shouldUseDarkColors`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
/**
 * The barrel, not `lucide-react/dist/esm/icons/settings.js`. Those files are ESM syntax in a
 * package with no `type` and no `exports` map, so importing them depends on Node's module-syntax
 * detection — unflagged only from 20.19 on, and this repo's `engines` says `>=20`. Pulling the
 * whole barrel costs nothing in a script that runs once by hand.
 */
import { Settings, Power, CircleDot, PauseCircle, Layers, RefreshCw } from "lucide-react";
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const ICONS = [
  { name: "tray-settings", Icon: Settings },
  { name: "tray-power", Icon: Power },
  /** The wheel itself: a ring around a centre, which is what the thing being opened looks like. */
  { name: "tray-wheel", Icon: CircleDot },
  { name: "tray-pause", Icon: PauseCircle },
  { name: "tray-spaces", Icon: Layers },
  { name: "tray-update", Icon: RefreshCw },
];

/**
 * A menu glyph should sit a step quieter than the label beside it, so neither tint goes all the way
 * to the menu's text colour: Windows 11 draws near-black on #F9F9F9 and white on #2C2C2C.
 */
const THEMES = [
  { suffix: "", tint: "#4A4A4A" },
  { suffix: "-dark", tint: "#C9C9C9" },
];

/**
 * Chromium does not resize menu-item icons — the image draws at its natural DIP size and the row
 * grows to fit — so 16 DIP is the only correct base, with `@2x`/`@3x` siblings for 200%/300%
 * displays. `nativeImage.createFromPath` finds those siblings on every platform, macOS included but
 * not exclusively; the main process must pass the un-suffixed name for the scan to happen.
 */
const SCALES = [
  { suffix: "", px: 16 },
  { suffix: "@2x", px: 32 },
  { suffix: "@3x", px: 48 },
];

for (const { name, Icon } of ICONS) {
  for (const theme of THEMES) {
    const svg = renderToStaticMarkup(
      createElement(Icon, { size: 24, strokeWidth: 2, color: theme.tint }),
    );
    for (const scale of SCALES) {
      /** Rasterize at 4x and downsample — a 1.3 px stroke needs the supersampling to survive 16 px. */
      const png = await sharp(Buffer.from(svg), { density: scale.px * 12 })
        .resize(scale.px, scale.px)
        .png({ compressionLevel: 9 })
        .toBuffer();
      const file = join(outDir, `${name}${theme.suffix}${scale.suffix}.png`);
      writeFileSync(file, png);
      console.log(`generate-tray-icons: wrote ${file} (${png.length} B)`);
    }
  }
}
