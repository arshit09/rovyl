"use strict";

/**
 * What a path dropped on the Shortcuts list actually is.
 *
 * Drag-and-drop gives the renderer nothing but a string. Whether `C:\Users\me\Reports` is a folder,
 * whether `Slack.lnk` points at a program or at a share, and what address is hiding inside a `.url`
 * file are all questions only the disk can answer — and the renderer cannot ask it. So main does,
 * once per dropped path, and hands back the `commandType` the shortcut should be built with.
 *
 * Deliberately NOT a guess from the extension alone. A folder called `notes.txt` is a folder, a
 * `.lnk` is whatever it points at, and getting either wrong means a shortcut that opens a console
 * window or nothing at all — with no dialog in the way to catch it, because a drop never asks.
 *
 * `shell.readShortcutLink` is injected rather than required: it is Electron-only, and keeping it out
 * lets `scripts/drop-shortcut-smoke.mjs` drive every branch from plain node.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Extensions Windows runs rather than opens. `.lnk` is not here — it is whatever it points at, and
 * has its own branch. `.msi` is not either: double-clicking one opens an installer, which is the
 * `file` behaviour, and calling it `app` would put it down the `<terminal> /c` ladder.
 */
const APP_EXTENSIONS = new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".appref-ms",
  ".msc",
]);

/** Internet shortcuts: a tiny INI whose `URL=` line is the whole point of the file. */
const URL_FILE_EXTENSIONS = new Set([".url", ".website"]);

/** How much of a `.url` file is worth reading before giving up on finding `URL=`. */
const URL_FILE_READ_LIMIT = 64 * 1024;

/** Explorer's "Copy as path" wraps the path in quotes; a drop of that text arrives the same way. */
function cleanDroppedPath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^"([\s\S]*)"$/, "$1").trim();
}

function extensionOf(target) {
  return path.extname(String(target ?? "")).toLowerCase();
}

/**
 * The name the shortcut is born with: the file's own, without the extension.
 *
 * A trailing separator is stripped first so `D:\Projects\` is named `Projects` and not the drive,
 * and a bare drive root keeps its letter rather than collapsing to an empty label.
 */
function labelFromPath(target) {
  const clean = cleanDroppedPath(target).replace(/[\\/]+$/, "");
  if (!clean) return "";
  const base = clean.split(/[\\/]/).filter(Boolean).pop() || clean;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem.trim() || base.trim();
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch (e) {
    return null;
  }
}

/**
 * The address inside an internet shortcut.
 *
 * `.url` files are written in several encodings and the `[InternetShortcut]` section is not always
 * first, so this scans every `URL=` line and takes the first that parses as an absolute address —
 * `.website` files also carry an `IconFile=` and a `URL=` under `[{000214A0-...}]`.
 */
function readUrlFile(target) {
  let text;
  try {
    const handle = fs.openSync(target, "r");
    try {
      const buffer = Buffer.alloc(URL_FILE_READ_LIMIT);
      const read = fs.readSync(handle, buffer, 0, URL_FILE_READ_LIMIT, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch (e) {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*URL\s*=\s*(\S.*?)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  }
  return null;
}

/**
 * One dropped path, classified. Never throws and never returns null for a non-empty path: a target
 * that cannot be read still becomes a shortcut, built from what its name says, because a drop has
 * no dialog in which to report that the disk did not answer.
 */
function inspectDroppedPath(rawPath, options = {}) {
  const target = cleanDroppedPath(rawPath);
  if (!target) return null;

  const readShortcutLink =
    typeof options.readShortcutLink === "function" ? options.readShortcutLink : null;
  const label = labelFromPath(target);
  const stat = statOrNull(target);

  if (stat && stat.isDirectory()) return { path: target, kind: "folder", label };

  const ext = extensionOf(target);

  if (URL_FILE_EXTENSIONS.has(ext)) {
    const url = readUrlFile(target);
    /** No readable address left in it — it is still a file Windows knows how to open. */
    if (url) return { path: target, kind: "url", url, label };
    return { path: target, kind: "file", label };
  }

  if (ext === ".lnk") return inspectShortcutLink(target, label, readShortcutLink);

  if (APP_EXTENSIONS.has(ext)) return { path: target, kind: "app", label };

  /**
   * No extension and nothing on disk to check — a path typed or copied from somewhere else. There
   * is nothing to distinguish it from a folder that is not mounted, and `file` is the safer of the
   * two: `shell.openPath` on a directory opens Explorer anyway.
   */
  return { path: target, kind: "file", label };
}

/**
 * A Windows shortcut, resolved through to whatever it really points at.
 *
 * The kind comes from the target; the COMMAND does not, and the split is deliberate. A folder or a
 * document keeps its resolved path, because that value is shown and edited in Settings and a `.lnk`
 * there says nothing. A program keeps the `.lnk` itself — that is what the Start menu hands out,
 * it carries the arguments and the working directory the vendor chose, and it is exactly what the
 * Application picker already stores when the same file is chosen by hand.
 */
function inspectShortcutLink(target, label, readShortcutLink) {
  let link = null;
  if (readShortcutLink) {
    try {
      link = readShortcutLink(target);
    } catch (e) {
      /* an unreadable .lnk is still a launchable one */
    }
  }

  const resolved = cleanDroppedPath(link && link.target);
  if (!resolved) return { path: target, kind: "app", label };

  const resolvedStat = statOrNull(resolved);
  if (resolvedStat && resolvedStat.isDirectory()) {
    return { path: resolved, kind: "folder", label };
  }

  const resolvedExt = extensionOf(resolved);
  if (URL_FILE_EXTENSIONS.has(resolvedExt)) {
    const url = readUrlFile(resolved);
    if (url) return { path: resolved, kind: "url", url, label };
  }

  /** An extensionless target is a program often enough (and never a document) to be launched as one. */
  if (!resolvedExt || APP_EXTENSIONS.has(resolvedExt)) {
    return { path: target, kind: "app", label };
  }

  return { path: resolved, kind: "file", label };
}

module.exports = {
  APP_EXTENSIONS,
  URL_FILE_EXTENSIONS,
  cleanDroppedPath,
  labelFromPath,
  readUrlFile,
  inspectDroppedPath,
};
