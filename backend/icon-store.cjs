/**
 * Content-addressed icon store: icon bytes live as files in userData, not as base64 in JSON.
 *
 * `config-v2.json` here is 456,139 bytes for fourteen shortcuts, and 445,362 of them — 97.6% —
 * are `data:image/png;base64,…` strings sitting in `AppItem.customIconUrl`. Twenty-three fields
 * carry them, but only nine are distinct: `sanitizeFullPersistenceForDisk` writes the workspace
 * tree more than once, and several shortcuts point at the same executable. That whole file is
 * rewritten, copied to `.bak`, and mirrored into three `localStorage` keys on every debounced
 * settings change.
 *
 * Naming a file by the SHA-256 of its own contents is what makes the duplication free: the same
 * icon reached by three paths is one file and one write, storing is idempotent, and a file that
 * gets collected by mistake is re-extracted under exactly the same name.
 *
 * No `electron` import on purpose — the whole module is drivable from plain node, which is what
 * `scripts/icon-store-smoke.mjs` uses to test the parts that would otherwise need a GUI.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** Serving markup from a privileged origin is how an icon becomes script; SVG is not in this list. */
const EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

const SCHEME = "rovyl-icon";
const HOST = "icon";

/**
 * Anchored, lowercase-only, fixed length. This is the string that becomes a filename inside
 * userData, so it is validated before it is ever joined to a path — not after.
 */
const REF_PATTERN = new RegExp(`^${SCHEME}://${HOST}/([0-9a-f]{64})\\.(png|jpg|gif|webp|bmp|ico)$`);

/** Same shape, unanchored, for scraping references out of raw text. */
const REF_SCAN_PATTERN = new RegExp(
  `${SCHEME}://${HOST}/([0-9a-f]{64}\\.(?:png|jpg|gif|webp|bmp|ico))`,
  "g",
);

const DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;[^,]*)?,/i;

function isIconRef(value) {
  return typeof value === "string" && REF_PATTERN.test(value.trim());
}

/** The filename a reference names, or null. Null means "do not touch the filesystem with this". */
function refToFilename(ref) {
  if (typeof ref !== "string") return null;
  const match = REF_PATTERN.exec(ref.trim());
  return match ? `${match[1]}.${match[2]}` : null;
}

function filenameToRef(filename) {
  return `${SCHEME}://${HOST}/${filename}`;
}

/** Every reference in a string, by filename. Deliberately text-based — see `sweep`. */
function collectRefFilenames(text, into = new Set()) {
  if (typeof text !== "string") return into;
  REF_SCAN_PATTERN.lastIndex = 0;
  let match;
  while ((match = REF_SCAN_PATTERN.exec(text))) into.add(match[1]);
  return into;
}

function parseDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const extension = EXTENSION_BY_MIME[mime];
  if (!extension) return null;
  if (!/;base64/i.test(match[2] || "")) return null;
  const base64 = value.slice(match[0].length);
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!buffer.length) return null;
  return { buffer, extension };
}

function createIconStore(directory) {
  const dir = path.resolve(directory);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function pathForFilename(filename) {
    return path.join(dir, filename);
  }

  /** Absolute path for a reference, or null when the reference is malformed. Does not stat. */
  function resolvePath(ref) {
    const filename = refToFilename(ref);
    return filename ? pathForFilename(filename) : null;
  }

  function exists(ref) {
    const filePath = resolvePath(ref);
    return Boolean(filePath) && fs.existsSync(filePath);
  }

  /**
   * Writes the bytes once and returns the reference.
   *
   * Temp file, flush, rename — in that order, and the flush is not optional. Rename makes the
   * *name* appear atomically, but without an fsync first the directory entry can outlive the data
   * across a power loss, leaving a truncated file under a name that asserts it is the SHA-256 of
   * its own contents. Nothing would ever repair that: the fast path below skips writing whenever
   * the name already exists, so a torn icon would be believed forever.
   *
   * An existing file is left alone because, by construction, it already holds these exact bytes.
   */
  function putBuffer(buffer, extension) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    const ext = MIME_BY_EXTENSION[extension] ? extension : "png";
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const filename = `${hash}.${ext}`;
    const filePath = pathForFilename(filename);
    ensureDir();
    if (fs.existsSync(filePath)) {
      /** Touch it: the sweep spares recent files, and re-storing is proof this one is in use. */
      try {
        const now = new Date();
        fs.utimesSync(filePath, now, now);
      } catch {
        /* mtime is an optimisation for the sweep, never a correctness requirement */
      }
      return filenameToRef(filename);
    }
    /** `.tmp-<pid>` so `sweep` can recognise and collect one left behind by a hard kill. */
    const tempPath = `${filePath}.tmp-${process.pid}`;
    try {
      const handle = fs.openSync(tempPath, "w");
      try {
        fs.writeSync(handle, buffer);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* the temp file is the only thing that could be left behind */
      }
      throw err;
    }
    return filenameToRef(filename);
  }

  /** `data:image/png;base64,…` in, reference out. Null for anything this store will not serve. */
  function putDataUrl(value) {
    const parsed = parseDataUrl(value);
    if (!parsed) return null;
    return putBuffer(parsed.buffer, parsed.extension);
  }

  /** Reference back to a `data:` URL, for the export format — null if the file is gone. */
  function readAsDataUrl(ref) {
    const filename = refToFilename(ref);
    if (!filename) return null;
    try {
      const buffer = fs.readFileSync(pathForFilename(filename));
      const extension = filename.slice(filename.lastIndexOf(".") + 1);
      const mime = MIME_BY_EXTENSION[extension] || "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }

  /**
   * Visits every `customIconUrl` anywhere in a parsed blob.
   *
   * Deliberately shape-agnostic. The persistence blob mirrors the workspace tree under
   * `workspaces`, `config.workspaces` and `apps`, and `stripStaleNativeIcons` in electron-main
   * already carries its own hand-written walker of that shape — a second one would be a second
   * thing to forget when the shape changes again. Walking whatever is there cannot miss a tree.
   */
  function walkIconFields(root, visit) {
    const seen = new WeakSet();
    let changed = false;
    const step = (node) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const entry of node) step(entry);
        return;
      }
      if (typeof node.customIconUrl === "string") {
        const next = visit(node.customIconUrl);
        if (next !== undefined && next !== node.customIconUrl) {
          if (next === null) delete node.customIconUrl;
          else node.customIconUrl = next;
          changed = true;
        }
      }
      for (const value of Object.values(node)) step(value);
    };
    step(root);
    return changed;
  }

  /**
   * `data:` URLs out to files, references left in their place. Mutates the blob.
   *
   * A reference whose file has gone is dropped rather than kept: a string that looks like an icon
   * but resolves to nothing reads as "has an icon" to the healing pass in `src/App.tsx`, and the
   * shortcut would sit there with a broken image forever instead of being re-extracted.
   */
  function externalizeBlob(blob) {
    let converted = 0;
    let dropped = 0;
    let failed = 0;
    /**
     * The workspace tree is mirrored three ways, so the same reference shows up several times —
     * twenty-three fields over nine icons in a real config. One stat each, not one per field.
     */
    const existsMemo = new Map();
    const existsOnce = (ref) => {
      let known = existsMemo.get(ref);
      if (known === undefined) {
        known = exists(ref);
        existsMemo.set(ref, known);
      }
      return known;
    };
    const changed = walkIconFields(blob, (value) => {
      if (isIconRef(value)) {
        if (existsOnce(value)) return undefined;
        dropped += 1;
        return null;
      }
      if (!DATA_URL_PATTERN.test(value)) return undefined; // https favicon, or something odd
      let ref = null;
      try {
        ref = putDataUrl(value);
      } catch {
        ref = null;
      }
      if (!ref) {
        /** Unreadable base64 stays as it is: shipping a broken icon beats deleting a good one. */
        failed += 1;
        return undefined;
      }
      converted += 1;
      return ref;
    });
    return { changed, converted, dropped, failed };
  }

  /** References back to `data:` URLs, so an exported backup stays self-contained and portable. */
  function inlineBlob(blob) {
    let inlined = 0;
    let missing = 0;
    const changed = walkIconFields(blob, (value) => {
      if (!isIconRef(value)) return undefined;
      const dataUrl = readAsDataUrl(value);
      if (!dataUrl) {
        missing += 1;
        return null;
      }
      inlined += 1;
      return dataUrl;
    });
    return { changed, inlined, missing };
  }

  /**
   * Deletes icons nothing points at any more.
   *
   * Three rules, and each exists because its absence deletes a live icon:
   *  - an empty root set never sweeps. One unreadable config would otherwise collect everything.
   *  - a file younger than `graceMs` is never touched. A blob written this session reaches disk
   *    ~450 ms of debounce plus one async write before the reference that names it does.
   *  - the roots are gathered by the caller from raw text, so a config too corrupt to parse still
   *    protects its icons — the quarantine files exist so a user can recover, and recovering
   *    without icons would be a hollow recovery.
   */
  async function sweep({ rootFilenames, graceMs = 7 * 24 * 60 * 60 * 1000, minFiles = 32 } = {}) {
    if (!(rootFilenames instanceof Set) || rootFilenames.size === 0) {
      return { skipped: "no-roots", deleted: 0, kept: 0 };
    }
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return { skipped: "no-store", deleted: 0, kept: 0 };
    }
    const icons = entries.filter((name) => REF_PATTERN.test(filenameToRef(name)));
    if (icons.length < minFiles) return { skipped: "small-store", deleted: 0, kept: icons.length };

    const cutoff = Date.now() - graceMs;
    let deleted = 0;
    let kept = 0;

    /**
     * Temp files a hard kill left mid-write. They can never be referenced — the reference only
     * exists once the rename has happened — so nothing else would ever collect them.
     */
    for (const name of entries) {
      if (!/\.tmp-\d+$/.test(name)) continue;
      try {
        const stat = await fsp.stat(pathForFilename(name));
        if (stat.mtimeMs > cutoff) continue;
        await fsp.unlink(pathForFilename(name));
        deleted += 1;
      } catch {
        /* another process may have cleaned it up first */
      }
    }
    for (const name of icons) {
      if (rootFilenames.has(name)) {
        kept += 1;
        continue;
      }
      try {
        const stat = await fsp.stat(pathForFilename(name));
        if (stat.mtimeMs > cutoff) {
          kept += 1;
          continue;
        }
        await fsp.unlink(pathForFilename(name));
        deleted += 1;
      } catch {
        kept += 1;
      }
    }
    return { deleted, kept };
  }

  return {
    dir,
    scheme: SCHEME,
    host: HOST,
    ensureDir,
    isIconRef,
    refToFilename,
    filenameToRef,
    collectRefFilenames,
    resolvePath,
    exists,
    putBuffer,
    putDataUrl,
    readAsDataUrl,
    externalizeBlob,
    inlineBlob,
    sweep,
    mimeForFilename: (filename) =>
      MIME_BY_EXTENSION[String(filename).slice(String(filename).lastIndexOf(".") + 1)] || "image/png",
  };
}

module.exports = {
  createIconStore,
  isIconRef,
  refToFilename,
  filenameToRef,
  collectRefFilenames,
  ICON_SCHEME: SCHEME,
  ICON_HOST: HOST,
};
