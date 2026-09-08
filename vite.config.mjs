import fs from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const LUCIDE_ICON_SET_ID = "virtual:lucide-icon-set";
const RESOLVED_LUCIDE_ICON_SET_ID = "\0" + LUCIDE_ICON_SET_ID;

/**
 * Re-exports every Lucide glyph, but by deep path instead of through the package barrel.
 *
 * `src/iconMap.ts` needs two things at once: a handful of glyphs available synchronously for the
 * wheel, and the full set on demand for the icon picker. Doing both against `lucide-react` itself
 * does not work — the barrel is statically imported by the app, so rollup refuses to move it into
 * an async chunk (INEFFECTIVE_DYNAMIC_IMPORT) and all ~1,350 icons land in the critical chunk.
 * Importing `lucide-react/dist/esm/icons/*.js` directly keeps the async graph clear of the barrel,
 * so only the icons the app names statically stay in `index-*.js`.
 *
 * Generated from Lucide's own barrel so alias names (`GlobeIcon`, `LucideGlobe`, `TramFront`) keep
 * resolving and the list survives a package upgrade without hand-editing.
 */
function lucideIconSet() {
  let isBuild = false;
  return {
    name: "rovyl:lucide-icon-set",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    resolveId(id) {
      return id === LUCIDE_ICON_SET_ID ? RESOLVED_LUCIDE_ICON_SET_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_LUCIDE_ICON_SET_ID) return null;
      /**
       * Dev does not chunk anything, so the deep paths buy nothing there — and they would cost a
       * mid-session dep re-optimise plus a page reload the first time the icon picker is opened.
       * The barrel is already pre-bundled, and re-exporting it gives the same module shape.
       */
      if (!isBuild) return 'export * from "lucide-react";\n';
      const require = createRequire(import.meta.url);
      const barrelPath = require.resolve("lucide-react/dist/esm/lucide-react.js");
      const barrel = fs.readFileSync(barrelPath, "utf8");
      const lines = [];
      for (const match of barrel.matchAll(
        /export\s*\{([^}]*)\}\s*from\s*["'](\.\/icons\/[^"']+)["']/g,
      )) {
        const names = [...match[1].matchAll(/default\s+as\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
        if (!names.length) continue;
        const specifier = "lucide-react/dist/esm" + match[2].slice(1);
        lines.push(
          `export { ${names.map((n) => `default as ${n}`).join(", ")} } from ${JSON.stringify(specifier)};`,
        );
      }
      if (!lines.length) {
        throw new Error(`rovyl:lucide-icon-set found no icon exports in ${barrelPath}`);
      }
      return lines.join("\n") + "\n";
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), lucideIconSet()],
  base: "./", // Importante para Electron
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  build: {
    target: "es2022",
    // Smaller initial parse + cache-friendly chunks in production (slightly snappier cold start).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/framer-motion/")) {
            return "motion";
          }
        },
      },
    },
  },
});
