/**
 * Icon lookup for Linux — the XDG Icon Theme spec, in place of `extract-icon.ps1`.
 *
 * On Windows an icon is *inside* the thing you launch, so extraction is a matter of prying it out
 * of a PE resource section. On Linux a desktop entry only says `Icon=firefox`, and turning that
 * word into pixels is a search problem with four moving parts: a base-directory list, a *chain* of
 * themes (the current one, everything it inherits, then `hicolor`), a size-fit rule per
 * subdirectory, and three possible file formats.
 *
 * The parts that are easy to get subtly wrong, and that this module spends its length on:
 *
 *   - `Icon=` may also be an absolute path, and for Flatpak and Snap apps it very often is. Running
 *     a theme search on `/var/lib/…/foo.png` finds nothing and the tile comes back blank.
 *   - A theme is not one directory. `hicolor` exists in `/usr/share/icons` *and* in
 *     `~/.local/share/icons` on this very machine, and an app that installed into the second one is
 *     invisible to a lookup that stops at the first `index.theme` it can read.
 *   - "Closest size" is not `Math.abs(dirSize - size)`. Scaling a 16px icon up to 64 looks like
 *     mud; scaling 128 down to 64 looks fine. Bigger-is-better has to be encoded explicitly.
 *
 * Every answer is memoized, both the resolved path and the rasterized data URL: the wheel asks for
 * one icon per tile on every open, and the negative results (no icon anywhere) are the expensive
 * ones worth remembering.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** Order matters: PNG needs no rasterizer, SVG does, XPM needs one that can read XPM at all. */
const ICON_EXTENSIONS = ["png", "svg", "xpm"];

const DEFAULT_SIZE = 64;
const FALLBACK_THEME = "hicolor";

/** A blown cache costs a few hundred stat calls; an unbounded one costs memory forever. */
const MAX_CACHE_ENTRIES = 4096;

let sharpModule;
let sharpLoaded = false;

/**
 * `sharp` is a devDependency and a native module. Requiring it lazily keeps a packaged build that
 * shipped without it from failing at import time — `resolveIconPath` still works, and
 * `resolveIconToDataUrl` degrades to passing PNG bytes through unresized.
 */
function sharp() {
  if (!sharpLoaded) {
    sharpLoaded = true;
    try {
      sharpModule = require("sharp");
    } catch (_) {
      sharpModule = null;
    }
  }
  return sharpModule;
}

function homeDir() {
  return process.env.HOME || os.homedir() || "";
}

function trimTrailingSlash(p) {
  const s = String(p || "");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/**
 * The theme base directories, in spec order.
 *
 * `/usr/share/pixmaps` is deliberately *not* here: it is a flat dump with no theme structure, and
 * feeding it to the theme walker would make it look like a theme with no `index.theme`. It gets its
 * own final pass in `searchPixmaps`.
 */
function iconBaseDirs() {
  const home = homeDir();
  const dataHome = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : "");
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .map((d) => trimTrailingSlash(d.trim()))
    .filter(Boolean);

  const dirs = [];
  if (dataHome) dirs.push(path.join(trimTrailingSlash(dataHome), "icons"));
  if (home) dirs.push(path.join(home, ".icons"));
  for (const d of dataDirs) dirs.push(path.join(d, "icons"));
  dirs.push("/usr/local/share/icons", "/usr/share/icons");

  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const key = trimTrailingSlash(d);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function pixmapDirs() {
  return ["/usr/share/pixmaps", "/usr/local/share/pixmaps"];
}

/** Group-aware INI read of an `index.theme`: `{ "[Group]": { Key: value } }`. */
function parseIniGroups(text) {
  const groups = Object.create(null);
  let current = null;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1).trim();
      if (!groups[current]) groups[current] = Object.create(null);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (groups[current][key] === undefined) groups[current][key] = line.slice(eq + 1).trim();
  }
  return groups;
}

let cachedThemeName;

/**
 * The icon theme the desktop is actually using.
 *
 * GTK's own settings files are checked first because reading a file is free. `gsettings` is the
 * only source that is right on a stock GNOME — this machine's `gtk-3.0/settings.ini` says nothing
 * about icons while GSettings says `WhiteSur-dark` — so it is worth one subprocess, exactly once,
 * with a timeout so a wedged dconf cannot hang the launcher.
 */
function currentIconThemeName() {
  if (cachedThemeName !== undefined) return cachedThemeName;

  const fromEnv = String(process.env.ROVYL_ICON_THEME || "").trim();
  if (fromEnv) {
    cachedThemeName = fromEnv;
    return cachedThemeName;
  }

  const home = homeDir();
  const configHome = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : "");
  const settingsFiles = configHome
    ? [path.join(configHome, "gtk-4.0/settings.ini"), path.join(configHome, "gtk-3.0/settings.ini")]
    : [];
  for (const file of settingsFiles) {
    try {
      const groups = parseIniGroups(fs.readFileSync(file, "utf8"));
      const name = groups.Settings && groups.Settings["gtk-icon-theme-name"];
      if (name) {
        cachedThemeName = name.replace(/^["']|["']$/g, "");
        return cachedThemeName;
      }
    } catch (_) {
      /* next candidate */
    }
  }

  try {
    const out = execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "icon-theme"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const name = out.trim().replace(/^['"]|['"]$/g, "");
    if (name) {
      cachedThemeName = name;
      return cachedThemeName;
    }
  } catch (_) {
    /* no gsettings, no schema, or no session bus — fall through */
  }

  cachedThemeName = FALLBACK_THEME;
  return cachedThemeName;
}

const themeCache = new Map();

/**
 * Load a theme's `index.theme` into a searchable shape.
 *
 * `roots` is a list, not a path: a theme legitimately spans several base directories, and the
 * subdirectory metadata from the first `index.theme` we can read applies to all of them.
 */
function loadTheme(name) {
  if (themeCache.has(name)) return themeCache.get(name);

  const roots = [];
  let groups = null;
  for (const base of iconBaseDirs()) {
    const dir = path.join(base, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      continue;
    }
    if (!st.isDirectory()) continue;
    roots.push(dir);
    if (!groups) {
      try {
        groups = parseIniGroups(fs.readFileSync(path.join(dir, "index.theme"), "utf8"));
      } catch (_) {
        /* a theme directory with no index is still worth searching by brute force */
      }
    }
  }
  if (!roots.length) {
    themeCache.set(name, null);
    return null;
  }

  const header = (groups && groups["Icon Theme"]) || Object.create(null);
  const dirNames = String(header.Directories || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scaledNames = String(header.ScaledDirectories || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const subdirs = [];
  for (const sub of [...dirNames, ...scaledNames]) {
    const g = (groups && groups[sub]) || Object.create(null);
    const size = Number.parseInt(g.Size, 10) || 0;
    const type = String(g.Type || "Threshold");
    const scale = Number.parseInt(g.Scale, 10) || 1;
    const threshold = Number.parseInt(g.Threshold, 10) || 2;
    subdirs.push({
      sub,
      size,
      type,
      scale,
      threshold,
      minSize: Number.parseInt(g.MinSize, 10) || size,
      maxSize: Number.parseInt(g.MaxSize, 10) || size,
    });
  }

  const inherits = String(header.Inherits || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const theme = { name, roots, subdirs, inherits };
  themeCache.set(name, theme);
  return theme;
}

/**
 * How badly a subdirectory fits a requested size, lower is better.
 *
 * The tiers, in order: an exact raster match, a scalable directory whose range covers the size, a
 * *larger* raster (downscaling is lossless-looking), a scalable directory outside its own range,
 * and finally a smaller raster — which is the tier that produces visibly blurry tiles and so is
 * only ever reached when nothing else exists.
 */
function sizeRank(entry, size) {
  const scalePenalty = entry.scale > 1 ? 0.5 : 0;
  if (entry.type === "Scalable") {
    if (size >= entry.minSize && size <= entry.maxSize) return [1, 0, scalePenalty];
    return [3, Math.abs(entry.size - size), scalePenalty];
  }
  if (entry.type === "Fixed") {
    if (entry.size === size) return [0, 0, scalePenalty];
    if (entry.size > size) return [2, entry.size - size, scalePenalty];
    return [4, size - entry.size, scalePenalty];
  }
  /** Threshold: the spec's fuzzy band around `Size`. Inside it, treat as exact. */
  if (Math.abs(entry.size - size) <= entry.threshold) return [0, Math.abs(entry.size - size), scalePenalty];
  if (entry.size > size) return [2, entry.size - size, scalePenalty];
  return [4, size - entry.size, scalePenalty];
}

function compareRanks(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function firstExisting(dir, baseName) {
  for (const ext of ICON_EXTENSIONS) {
    const candidate = path.join(dir, `${baseName}.${ext}`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* next extension */
    }
  }
  return null;
}

/** One theme, no inheritance. Subdirectories are tried best-fit first. */
function searchTheme(themeName, baseName, size) {
  const theme = loadTheme(themeName);
  if (!theme) return null;

  const ordered = theme.subdirs
    .map((entry) => ({ entry, rank: sizeRank(entry, size) }))
    .sort((a, b) => compareRanks(a.rank, b.rank));

  for (const { entry } of ordered) {
    for (const root of theme.roots) {
      const hit = firstExisting(path.join(root, entry.sub), baseName);
      if (hit) return hit;
    }
  }

  /**
   * A theme with no usable `index.theme` (or one that forgot to list a directory it ships) still
   * has icons on disk. One shallow pass over `<root>/<anything>/<context>` is cheap insurance.
   */
  if (!theme.subdirs.length) {
    for (const root of theme.roots) {
      let level1;
      try {
        level1 = fs.readdirSync(root, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const d1 of level1) {
        if (!d1.isDirectory()) continue;
        const p1 = path.join(root, d1.name);
        const direct = firstExisting(p1, baseName);
        if (direct) return direct;
        let level2;
        try {
          level2 = fs.readdirSync(p1, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const d2 of level2) {
          if (!d2.isDirectory()) continue;
          const hit = firstExisting(path.join(p1, d2.name), baseName);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

/** The theme, everything it inherits (breadth-first, cycle-safe), then `hicolor`. */
function searchThemeChain(themeName, baseName, size) {
  const seen = new Set();
  const queue = [themeName, FALLBACK_THEME];
  while (queue.length) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const hit = searchTheme(name, baseName, size);
    if (hit) return hit;
    const theme = loadTheme(name);
    if (theme) for (const parent of theme.inherits) queue.push(parent);
  }
  return null;
}

function searchPixmaps(baseName) {
  for (const dir of pixmapDirs()) {
    const hit = firstExisting(dir, baseName);
    if (hit) return hit;
  }
  return null;
}

const pathCache = new Map();
const dataUrlCache = new Map();

function remember(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * `Icon=` → a file on disk, or `null`.
 *
 * The name is stripped of a trailing `.png`/`.svg`/`.xpm` before searching: desktop files written
 * by hand often say `Icon=foo.png`, and the spec's lookup wants the *name*, to which it appends
 * each extension itself. `foo.png.png` is not a file anyone has.
 */
async function resolveIconPath(iconNameOrPath, size) {
  const raw = String(iconNameOrPath || "").trim();
  if (!raw) return null;
  const want = Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_SIZE;
  const key = `${raw}|${want}`;
  if (pathCache.has(key)) return pathCache.get(key);

  /** An absolute path is an answer, not a query. Flatpak and Snap entries rely on this. */
  if (raw.startsWith("/")) {
    try {
      const st = await fsp.stat(raw);
      return remember(pathCache, key, st.isFile() ? raw : null);
    } catch (_) {
      return remember(pathCache, key, null);
    }
  }

  const baseName = raw.replace(/\.(png|svg|xpm)$/i, "");
  const found =
    searchThemeChain(currentIconThemeName(), baseName, want) ||
    searchPixmaps(baseName) ||
    /** Last chance for a literal `Icon=foo.png` that really is a file sitting in pixmaps. */
    (raw !== baseName ? firstExistingLiteral(raw) : null);

  return remember(pathCache, key, found || null);
}

function firstExistingLiteral(fileName) {
  for (const dir of pixmapDirs()) {
    const candidate = path.join(dir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* next */
    }
  }
  return null;
}

/**
 * `Icon=` → `data:image/png;base64,…`, or `null`.
 *
 * Always PNG on the way out, whatever went in. The renderer treats these as plain `img` sources on
 * a privileged origin, and SVG there is markup that can carry script — the same reason
 * `icon-store.cjs` refuses to store it. Rasterizing here is a security boundary, not a convenience.
 */
async function resolveIconToDataUrl(iconNameOrPath, size) {
  const raw = String(iconNameOrPath || "").trim();
  if (!raw) return null;
  const want = Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_SIZE;
  const key = `${raw}|${want}`;
  if (dataUrlCache.has(key)) return dataUrlCache.get(key);

  const file = await resolveIconPath(raw, want);
  if (!file) return remember(dataUrlCache, key, null);

  let bytes;
  try {
    bytes = await fsp.readFile(file);
  } catch (_) {
    return remember(dataUrlCache, key, null);
  }

  const ext = path.extname(file).toLowerCase();
  const lib = sharp();
  if (!lib) {
    /** No rasterizer: a PNG can still be served as-is; anything else would be a lie. */
    if (ext === ".png") {
      return remember(dataUrlCache, key, `data:image/png;base64,${bytes.toString("base64")}`);
    }
    return remember(dataUrlCache, key, null);
  }

  try {
    /**
     * SVG has no intrinsic pixel size, so it is rendered at a DPI that lands near the target
     * instead of at libvips' 72dpi default and then being upscaled from a 16px bitmap.
     */
    const input = ext === ".svg" ? lib(bytes, { density: Math.min(2400, Math.max(72, want * 6)) }) : lib(bytes);
    const png = await input
      .resize(want, want, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return remember(dataUrlCache, key, `data:image/png;base64,${png.toString("base64")}`);
  } catch (_) {
    /** XPM, a truncated PNG, an SVG libvips' rsvg cannot parse — a blank tile beats a crash. */
    return remember(dataUrlCache, key, null);
  }
}

/** Drop every memo — for tests, and for a "the theme changed" signal from the session. */
function invalidateIconCaches() {
  pathCache.clear();
  dataUrlCache.clear();
  themeCache.clear();
  cachedThemeName = undefined;
}

module.exports = {
  resolveIconToDataUrl,
  resolveIconPath,
  /** Exported for the smoke test; not part of the main-process contract. */
  currentIconThemeName,
  iconBaseDirs,
  invalidateIconCaches,
};
