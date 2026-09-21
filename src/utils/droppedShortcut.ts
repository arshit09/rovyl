/**
 * Reading a drop.
 *
 * Everything that can be dragged onto the Shortcuts list arrives as one of three things: files with
 * real paths, a `text/uri-list` (a link dragged out of a browser), or plain text (an address typed
 * somewhere else, a path from "Copy as path", a command line out of a terminal). This module turns
 * any of them into a flat list of entries, and nothing more — what a PATH actually is can only be
 * answered by the disk, so that question goes to main (`backend/drop-inspect.cjs`).
 *
 * Kept apart from the settings component so `scripts/drop-shortcut-smoke.mjs` can drive it from
 * plain node: the rules below are the difference between a dropped `npm run dev` becoming a command
 * and becoming a web shortcut to a site that does not exist.
 */

/** What a drop turned out to be, before the disk has had its say about any of the paths. */
export type DroppedEntry =
  | { kind: "path"; path: string }
  | { kind: "url"; url: string }
  | { kind: "command"; line: string };

/** What main says a dropped path is. Mirrors `inspectDroppedPath` in `backend/drop-inspect.cjs`. */
export interface InspectedDropPath {
  path: string;
  kind: "app" | "folder" | "file" | "url";
  /** `.url` / `.website` files only: the address inside. */
  url?: string;
  /** The file's own name, without its extension. */
  label?: string;
}

/** The raw material of a drop, lifted off a `DataTransfer` so this file never touches the DOM. */
export interface DropPayload {
  /** Absolute paths, from `DataTransfer.files` — Electron 28 still puts the real one on a `File`. */
  paths?: readonly string[];
  /** `text/uri-list`: one URI per line, `#` comments allowed. */
  uriList?: string;
  /** `text/plain`, used only when there is nothing better. */
  text?: string;
}

/** Explorer's "Copy as path" wraps the path in quotes; so does a path pasted out of a terminal. */
function unquote(value: string): string {
  return value.trim().replace(/^"([\s\S]*)"$/, "$1").trim();
}

/**
 * A drive path (`C:\…`), a UNC share (`\\server\…`), or one that opens with an environment
 * variable (`%APPDATA%\…`). Anything else with a slash in it is far more likely to be an address
 * or a command line, and is left to the two tests below.
 */
export function looksLikeWindowsPath(value: string): boolean {
  const clean = unquote(value);
  if (!clean || /[\r\n]/.test(clean)) return false;
  return /^[A-Za-z]:[\\/]/.test(clean) || /^\\\\[^\\/]/.test(clean) || /^%[^%\s]+%[\\/]/.test(clean);
}

/**
 * An address, with or without the scheme the user left out.
 *
 * A bare host has to carry a dot and no whitespace, which is what keeps `npm run dev` and
 * `git status` out — and `localhost:3000` is allowed explicitly, because a dev server is the one
 * address anybody drops that has no dot in it at all.
 */
export function looksLikeWebAddress(value: string): boolean {
  const clean = unquote(value);
  if (!clean || /\s/.test(clean)) return false;
  if (looksLikeWindowsPath(clean)) return false;
  if (/^https?:\/\//i.test(clean)) return true;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#].*)?$/i.test(clean)) return true;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#][\s\S]*)?$/.test(clean);
}

/**
 * A scheme Windows hands to another program — `steam://`, `mailto:`, `ms-settings:`, `obsidian://`.
 *
 * These are shortcuts of type `url` like any web link, but nothing may be fetched from them: there
 * is no page behind `mailto:` to ask for a title, and prefixing `https://` onto one (which is what
 * `normalizeSiteUrl` does to anything schemeless) would break it outright.
 */
export function isNonWebScheme(value: string): boolean {
  const clean = unquote(value);
  if (!clean || /\s/.test(clean)) return false;
  if (/^(https?|file):/i.test(clean)) return false;
  return /^[a-z][a-z0-9+.-]*:[^\s]/i.test(clean);
}

/**
 * `file:///C:/Users/me/notes.txt` → `C:\Users\me\notes.txt`, and `file://server/share/x` → UNC.
 * Returns null for anything that is not a `file:` URI, so callers can fall through.
 */
export function fileUriToWindowsPath(value: string): string | null {
  const clean = unquote(value);
  if (!/^file:/i.test(clean)) return null;
  try {
    const url = new URL(clean);
    const decoded = decodeURIComponent(url.pathname).replace(/\//g, "\\");
    if (url.hostname) return `\\\\${url.hostname}${decoded}`;
    /** `/C:\Users\…` — the leading separator belongs to the URI, not to the path. */
    return decoded.replace(/^\\(?=[A-Za-z]:)/, "");
  } catch {
    return null;
  }
}

/** One line of dropped text, read as whichever of the three kinds it looks most like. */
export function classifyDropText(value: string): DroppedEntry | null {
  const clean = unquote(value);
  if (!clean) return null;

  const filePath = fileUriToWindowsPath(clean);
  if (filePath) return { kind: "path", path: filePath };

  if (looksLikeWindowsPath(clean)) return { kind: "path", path: clean };
  if (looksLikeWebAddress(clean) || isNonWebScheme(clean)) return { kind: "url", url: clean };

  /**
   * Everything left is a command line. Nothing is checked beyond that, exactly as the typed
   * Command form checks nothing: the shell is the only judge of what a line means, and a line that
   * turns out to be nonsense comes back as a launch card the user can edit.
   */
  return { kind: "command", line: clean };
}

/** `text/uri-list` is one URI per line with `#` comments — RFC 2483, and what every browser sends. */
export function parseUriList(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * Every entry a drop is worth, in the order they were dropped and with no repeats.
 *
 * The three sources are tried in order of how much they actually know. Files come first because a
 * path is unambiguous; a browser's `text/uri-list` second, because it is the link and not the
 * page's text; plain text last, and only when the drop carried nothing else — a link dragged out of
 * Chrome brings its title along in `text/plain` on some builds, and reading both would add the same
 * site twice.
 */
export function dropEntriesFrom(payload: DropPayload): DroppedEntry[] {
  const entries: DroppedEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: DroppedEntry | null) => {
    if (!entry) return;
    const key =
      entry.kind === "path"
        ? `path:${entry.path.toLowerCase()}`
        : entry.kind === "url"
          ? `url:${entry.url}`
          : `command:${entry.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const candidate of payload.paths ?? []) {
    const clean = unquote(String(candidate ?? ""));
    if (clean) push({ kind: "path", path: clean });
  }
  if (entries.length) return entries;

  for (const uri of parseUriList(payload.uriList ?? "")) push(classifyDropText(uri));
  if (entries.length) return entries;

  /**
   * Multi-line text is several shortcuts — a column of paths copied out of a spreadsheet, a few
   * addresses out of a note. A single line that happens to wrap is not: it has already been
   * trimmed to one entry by the time it gets here.
   */
  for (const line of String(payload.text ?? "").split(/\r?\n/)) push(classifyDropText(line));
  return entries;
}

/**
 * The kind a path looks like from its name alone.
 *
 * Only used when main is not there to ask — the browser build, and a dropped path main could not
 * stat. `folder` is never returned: a directory is not something a name can prove.
 */
export function guessPathKind(value: string): InspectedDropPath["kind"] {
  const clean = unquote(value);
  const match = /\.([^.\\/\s]+)$/.exec(clean);
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (ext === ".lnk" || [".exe", ".com", ".bat", ".cmd", ".appref-ms", ".msc"].includes(ext)) return "app";
  if (ext === ".url" || ext === ".website") return "url";
  return "file";
}

/** `Quarterly report.xlsx` → `Quarterly report`; `D:\Projects\` → `Projects`. */
export function labelFromDroppedPath(value: string): string {
  const clean = unquote(value).replace(/[\\/]+$/, "");
  if (!clean) return "";
  const base = clean.split(/[\\/]/).filter(Boolean).pop() || clean;
  return base.replace(/\.[^.\s]+$/, "").trim() || base.trim();
}
