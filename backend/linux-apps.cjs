/**
 * Installed-application discovery for Linux — the XDG Desktop Entry spec, not a Start Menu.
 *
 * Windows hands us a folder of `.lnk` files and a shell that resolves them. Linux hands us a
 * *search path* of `applications/` directories and a small INI dialect, and almost every
 * interesting rule lives in the parts people skip:
 *
 *   - The search path is ordered and **first match wins**. `~/.local/share/applications/foo.desktop`
 *     is not "another Foo", it is an override that must completely hide `/usr/share/…/foo.desktop`.
 *     Scanning later directories last and letting them overwrite is the classic way to make a
 *     user's own launcher entry silently stop working.
 *   - `Exec` is not a command line. It is a quoted string with *field codes* (`%U`, `%f`, `%i`, …)
 *     that a launcher is required to substitute or drop. Handing `Exec` to a shell verbatim is how
 *     you get Firefox opening a tab for a file literally named `%U`.
 *   - The desktop file ID is the path relative to the `applications/` root with `/` turned into
 *     `-`, so `kde4/konsole.desktop` is `kde4-konsole`, not `konsole`. Deduping on the basename
 *     merges two genuinely different entries.
 *
 * No `electron` import on purpose — the module is drivable from plain node, which is what
 * `scripts/linux-apps-smoke.mjs` uses against this machine's real 100-odd installed apps.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

/** Field codes a launcher must substitute. We substitute them with nothing — see `expandFieldCodes`. */
const FIELD_CODE_LETTERS = "fFuUdDnNickvm";

/** Re-stat the scanned directories at most this often; repeated hot-path calls should cost ~nothing. */
const SIGNATURE_MIN_INTERVAL_MS = 2000;

function homeDir() {
  return process.env.HOME || os.homedir() || "";
}

/** Strip a trailing separator so `/usr/share/` and `/usr/share` dedupe against each other. */
function trimTrailingSlash(p) {
  const s = String(p || "");
  if (s.length > 1 && s.endsWith("/")) return s.replace(/\/+$/, "");
  return s;
}

/**
 * The ordered `applications/` search path. Earlier entries win.
 *
 * `$XDG_DATA_DIRS` on a Flatpak-aware session already contains the Flatpak exports, so the extra
 * Flatpak/Snap directories are appended and then deduped rather than prepended — appending keeps
 * a distro's own ordering authoritative, deduping keeps us from parsing the same tree twice.
 */
function applicationDirs() {
  const home = homeDir();
  const dataHome = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : "");
  const dataDirsRaw = process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share";

  const roots = [];
  if (dataHome) roots.push(dataHome);
  for (const d of dataDirsRaw.split(":")) {
    const t = trimTrailingSlash(d.trim());
    if (t) roots.push(t);
  }

  const dirs = roots.map((r) => path.join(trimTrailingSlash(r), "applications"));

  /** Sessions that never exported these still have the apps installed; look anyway. */
  dirs.push("/var/lib/flatpak/exports/share/applications");
  if (home) dirs.push(path.join(home, ".local/share/flatpak/exports/share/applications"));
  dirs.push("/var/lib/snapd/desktop/applications");

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

/**
 * The locale names to try for `Name[xx]`, most specific first.
 *
 * The spec's order is `lang_COUNTRY@MODIFIER`, `lang_COUNTRY`, `lang@MODIFIER`, `lang`. The
 * encoding (`.UTF-8`) is never part of a key and has to come off before any of that.
 */
function localeCandidates() {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const first = String(raw).split(":")[0].trim();
  if (!first || /^(C|POSIX|C\.UTF-8)$/i.test(first)) return [];

  let rest = first;
  let modifier = "";
  const at = rest.indexOf("@");
  if (at >= 0) {
    modifier = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const dot = rest.indexOf(".");
  if (dot >= 0) rest = rest.slice(0, dot);

  let lang = rest;
  let country = "";
  const us = rest.indexOf("_");
  if (us >= 0) {
    lang = rest.slice(0, us);
    country = rest.slice(us + 1);
  }
  if (!lang) return [];

  const out = [];
  if (country && modifier) out.push(`${lang}_${country}@${modifier}`);
  if (country) out.push(`${lang}_${country}`);
  if (modifier) out.push(`${lang}@${modifier}`);
  out.push(lang);
  return out;
}

/** Desktop-entry string escapes. Applied to values before anything else looks at them, as GLib does. */
function unescapeDesktopValue(value) {
  let out = "";
  const s = String(value || "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\" || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const n = s[i + 1];
    if (n === "s") out += " ";
    else if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "\\") out += "\\";
    else {
      out += s[i];
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Parse one `.desktop` file down to the `[Desktop Entry]` group.
 *
 * Everything after the first other group header is thrown away on purpose: `[Desktop Action New]`
 * has its own `Name` and `Exec`, and letting those leak into the main entry is how a launcher ends
 * up labelling Nautilus "New Window".
 */
function parseDesktopEntry(text) {
  const keys = Object.create(null);
  let inEntry = false;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inEntry = /^\[\s*Desktop Entry\s*\]$/.test(line);
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    /** First wins: a duplicated key in one group is malformed, and re-reading it is not a merge. */
    if (keys[key] === undefined) keys[key] = line.slice(eq + 1).trim();
  }
  return keys;
}

function localizedValue(keys, base, locales) {
  for (const loc of locales) {
    const v = keys[`${base}[${loc}]`];
    if (v != null && v !== "") return unescapeDesktopValue(v);
  }
  const plain = keys[base];
  return plain != null ? unescapeDesktopValue(plain) : "";
}

function booleanValue(keys, key) {
  return String(keys[key] || "").trim().toLowerCase() === "true";
}

function listValue(keys, key) {
  const v = unescapeDesktopValue(keys[key] || "");
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tokenize an `Exec` value with the spec's quoting rules.
 *
 * Only double quotes are specified; inside them a backslash escapes `"`, `` ` ``, `$` and `\`.
 * Single quotes are not legal but appear in real files often enough that treating them as literal
 * grouping is strictly better than splitting `'My App'` into two tokens.
 */
function splitExecTokens(value) {
  const s = String(value || "");
  const tokens = [];
  let cur = "";
  let open = false;
  let i = 0;

  const flush = () => {
    if (open) tokens.push(cur);
    cur = "";
    open = false;
  };

  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      i++;
      continue;
    }
    if (c === '"') {
      open = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "'") {
      open = true;
      i++;
      while (i < s.length && s[i] !== "'") {
        cur += s[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      open = true;
      i += 2;
      continue;
    }
    cur += c;
    open = true;
    i++;
  }
  flush();
  return tokens;
}

/**
 * Drop field codes, unescape `%%`.
 *
 * Done per character rather than with a global regex because `%%U` is a literal `%` followed by a
 * literal `U` — a regex for `/%[fFuU…]/g` matches the second `%U` in it and eats both.
 */
function expandFieldCodes(token) {
  const s = String(token || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "%" || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const n = s[i + 1];
    if (n === "%") {
      out += "%";
      i++;
      continue;
    }
    if (FIELD_CODE_LETTERS.includes(n)) {
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * `Exec=` → `{ command, args }` with every field code resolved.
 *
 * Three layers, in the order the spec mandates and *only* in that order: the generic string
 * unescaping (`\\` → `\`), then the quoting rules, then field codes. Skipping the first layer is
 * not academic — `scrcpy-console.desktop` on this machine ships
 * `Exec=/bin/sh -c "\\$SHELL -i -c '…'"`, which needs both passes to arrive at `$SHELL` for the
 * shell to expand. Stop after the quoting pass and it stays `\$SHELL`, a literal dollar sign, and
 * the app opens in `/bin/sh` instead of the user's shell.
 *
 * A token that was *only* a field code (`%U`) collapses to the empty string and is removed
 * entirely — passing `""` as argv[1] is not the same as passing nothing, and several apps read an
 * empty first argument as "open this file", which fails.
 */
function expandExec(execValue) {
  const tokens = splitExecTokens(unescapeDesktopValue(execValue));
  const expanded = [];
  for (const raw of tokens) {
    const wasOnlyCode = /^%[a-zA-Z]$/.test(raw);
    const t = expandFieldCodes(raw);
    if (t === "" && (wasOnlyCode || raw === "")) continue;
    expanded.push(t);
  }
  if (!expanded.length) return { command: "", args: [] };
  return { command: expanded[0], args: expanded.slice(1) };
}

/** The desktop file ID: path relative to the `applications/` root, `/` → `-`, minus the suffix. */
function desktopFileId(root, filePath) {
  const rel = path.relative(root, filePath);
  return rel.replace(/\.desktop$/i, "").split(path.sep).join("-");
}

let pathDirsCache = null;
let pathDirsKey = null;

function pathDirs() {
  const raw = process.env.PATH || "";
  if (pathDirsKey === raw && pathDirsCache) return pathDirsCache;
  pathDirsKey = raw;
  pathDirsCache = raw.split(":").filter(Boolean);
  return pathDirsCache;
}

/** `TryExec` is the spec's "is this actually installed?" probe — an absolute path or a PATH lookup. */
function tryExecSatisfied(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  const candidates = v.startsWith("/") ? [v] : pathDirs().map((d) => path.join(d, v));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch (_) {
      /* keep looking */
    }
  }
  return false;
}

function currentDesktops() {
  return String(process.env.XDG_CURRENT_DESKTOP || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `OnlyShowIn` / `NotShowIn` against `$XDG_CURRENT_DESKTOP`.
 *
 * With no `$XDG_CURRENT_DESKTOP` — a bare Xorg session, a TTY, CI — an `OnlyShowIn` entry is
 * hidden rather than shown. That is the spec's reading and it keeps GNOME's control-center panels
 * out of a KDE user's wheel.
 */
function showsInCurrentDesktop(keys) {
  const here = currentDesktops();
  const only = listValue(keys, "OnlyShowIn");
  const not = listValue(keys, "NotShowIn");
  if (only.length) return here.some((d) => only.includes(d));
  if (not.length) return !here.some((d) => not.includes(d));
  return true;
}

async function readDesktopFilesUnder(root) {
  /** Subdirectories are part of the ID, so the walk has to be recursive and remember its root. */
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".desktop")) {
        out.push(full);
      }
    }
  }
  return out;
}

function toEntry(root, filePath, keys, locales) {
  if (String(keys.Type || "").trim() !== "Application") return null;
  /** `Hidden=true` means *deleted*, not "do not draw" — it is the only flag that removes an entry. */
  if (booleanValue(keys, "Hidden")) return null;
  if (!showsInCurrentDesktop(keys)) return null;
  if (!tryExecSatisfied(keys.TryExec)) return null;

  const { command, args } = expandExec(keys.Exec);
  if (!command) return null;

  const id = desktopFileId(root, filePath);
  const name = localizedValue(keys, "Name", locales) || id;
  const iconRaw = unescapeDesktopValue(keys.Icon || "").trim();

  return {
    id,
    name,
    command,
    args,
    icon: iconRaw || null,
    categories: listValue(keys, "Categories"),
    noDisplay: booleanValue(keys, "NoDisplay"),
    terminal: booleanValue(keys, "Terminal"),
  };
}

let cachedEntries = null;
let cachedSignature = null;
let cachedSignatureAt = 0;
let inFlight = null;

/**
 * A cheap "did anything get installed or removed?" fingerprint.
 *
 * Directory mtimes only move when files are added or removed, which is exactly the event that
 * changes the app list. Editing a `.desktop` in place will not invalidate — a deliberate trade:
 * the alternative is stat'ing ~400 files on a path the wheel hits on every open.
 */
function scanSignature(dirs) {
  const parts = [];
  for (const d of dirs) {
    try {
      parts.push(`${d}:${fs.statSync(d).mtimeMs}`);
    } catch (_) {
      parts.push(`${d}:-`);
    }
  }
  return parts.join("|");
}

async function scanAll() {
  const dirs = applicationDirs();
  const locales = localeCandidates();
  const byId = new Map();

  for (const root of dirs) {
    const files = await readDesktopFilesUnder(root);
    /** Stable order inside one root so two runs on one machine produce the same list. */
    files.sort();
    for (const file of files) {
      const id = desktopFileId(root, file);
      /** First occurrence wins — `~/.local/share` shadows `/usr/share`, never the other way. */
      if (byId.has(id)) continue;
      let text;
      try {
        text = await fsp.readFile(file, "utf8");
      } catch (_) {
        continue;
      }
      const keys = parseDesktopEntry(text);
      /**
       * A shadowed-but-rejected entry still claims its ID. Otherwise a user's `Hidden=true`
       * override in `~/.local/share` would be ignored and the system copy would come back.
       */
      byId.set(id, null);
      const entry = toEntry(root, file, keys, locales);
      if (entry) byId.set(id, entry);
    }
  }

  const out = [];
  for (const v of byId.values()) if (v) out.push(v);
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/**
 * Every installed application, deduped and ordered by display name.
 *
 * Cached in memory. `NoDisplay` entries are *returned* rather than filtered so a caller can still
 * resolve a stored command back to them; the picker is the layer that decides what to draw.
 */
async function listInstalledApps(options) {
  const force = Boolean(options && options.force);
  const now = Date.now();

  if (!force && cachedEntries) {
    if (now - cachedSignatureAt < SIGNATURE_MIN_INTERVAL_MS) return cachedEntries;
    const sig = scanSignature(applicationDirs());
    cachedSignatureAt = now;
    if (sig === cachedSignature) return cachedEntries;
  }

  /** Concurrent wheel opens must not each trigger a full walk of four directory trees. */
  if (inFlight && !force) return inFlight;

  const dirs = applicationDirs();
  const signature = scanSignature(dirs);
  inFlight = scanAll()
    .then((entries) => {
      cachedEntries = entries;
      cachedSignature = signature;
      cachedSignatureAt = Date.now();
      return entries;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cache — for tests, and for an explicit "rescan apps" action. */
function invalidateAppCache() {
  cachedEntries = null;
  cachedSignature = null;
  cachedSignatureAt = 0;
}

/**
 * Resolve a stored command string back to the entry it came from.
 *
 * A shortcut on disk may hold any of: the desktop ID (`org.gnome.Nautilus`), the same with the
 * suffix, the expanded exec line (`/usr/bin/nautilus --new-window`), a bare binary name, or the
 * display name a user typed. All five have to land on the same entry, so the match is tried in
 * descending order of how much the string actually pins down, and visible entries always beat
 * `NoDisplay` ones at the same confidence.
 */
async function findAppByCommand(cmd) {
  const raw = String(cmd || "").trim();
  if (!raw) return null;

  const apps = await listInstalledApps();
  if (!apps.length) return null;

  const needle = raw.toLowerCase();
  const head = (splitExecTokens(raw)[0] || raw).toLowerCase();
  const headBase = path.basename(head);
  const stripDesktop = (s) => s.replace(/\.desktop$/i, "");
  const idNeedles = new Set([stripDesktop(needle), stripDesktop(headBase)]);

  const pick = (predicate) => {
    let fallback = null;
    for (const a of apps) {
      if (!predicate(a)) continue;
      if (!a.noDisplay) return a;
      if (!fallback) fallback = a;
    }
    return fallback;
  };

  return (
    pick((a) => idNeedles.has(a.id.toLowerCase())) ||
    pick((a) => a.command.toLowerCase() === head) ||
    pick((a) => path.basename(a.command).toLowerCase() === headBase) ||
    pick((a) => a.name.toLowerCase() === needle) ||
    null
  );
}

module.exports = {
  listInstalledApps,
  findAppByCommand,
  /** Exported for the smoke test and for `linux-launch.js`; not part of the main-process contract. */
  applicationDirs,
  parseDesktopEntry,
  splitExecTokens,
  expandFieldCodes,
  expandExec,
  desktopFileId,
  localeCandidates,
  invalidateAppCache,
};
