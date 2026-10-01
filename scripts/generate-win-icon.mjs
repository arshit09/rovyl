/**
 * Windows .exe / atalhos / barra de tarefas usam ICO embutido no PE; PNG em win.icon falha facilmente.
 * Gera build/icon.ico a partir de public/icon.png antes do electron-builder.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

/**
 * Windows-only asset. Off Windows this step has no consumer (build/icon.ico only ever feeds
 * win/nsis/appx and rcedit), so it is a no-op rather than a failure — the Linux pack takes its
 * icon from build/icons/, written by scripts/generate-linux-icons.mjs.
 */
if (process.platform !== "win32") {
  console.log("generate-win-icon: skip \u2014 not win32");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pngPath = join(root, "public", "icon.png");
const outDir = join(root, "build");
const icoPath = join(outDir, "icon.ico");

if (!existsSync(pngPath)) {
  console.error(`generate-win-icon: missing ${pngPath}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
await writeFile(icoPath, await pngToIco(pngPath));
console.log(`generate-win-icon: wrote ${icoPath}`);
