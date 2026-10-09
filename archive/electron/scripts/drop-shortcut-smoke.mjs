/**
 * The contract behind "drag it onto the list and it becomes a shortcut".
 *
 * A drop never asks a question, which is the whole point of it and also the reason it needs this
 * file: there is no dialog in which a wrong guess can be caught, so the guesses themselves are what
 * is pinned down here. Three claims, in the order a drop passes through them.
 *
 *   1. Reading the drop (`src/utils/droppedShortcut.ts`). A path, an address and a command line all
 *      arrive as the same bare string, and telling them apart is pure text work. The load-bearing
 *      case is `npm run dev`: read as an address it becomes a web shortcut to a host that does not
 *      exist, silently, with a favicon fetch to go with it.
 *
 *   2. Reading the disk (`backend/drop-inspect.cjs`). What a path IS cannot be guessed from its
 *      name — a directory called `notes.txt` is a directory, and a `.lnk` is whatever it points at.
 *      Getting this wrong is not cosmetic: `app` sends a `.pdf` down the `<terminal> /c` ladder.
 *
 *   3. The wiring, read out of the source the same way its neighbours do it: main answers ONE
 *      ENTRY PER INPUT (the renderer pairs them by position, so a skipped element would shift every
 *      answer after it onto the wrong file), and the list's own reorder drag is not read as an
 *      import.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error });
  }
};

const outDir = mkdtempSync(join(tmpdir(), "rovyl-drop-shortcut-"));
const scratch = mkdtempSync(join(tmpdir(), "rovyl-drop-inspect-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "droppedShortcut.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const {
    classifyDropText,
    dropEntriesFrom,
    fileUriToWindowsPath,
    guessPathKind,
    isNonWebScheme,
    labelFromDroppedPath,
    looksLikeWebAddress,
    looksLikeWindowsPath,
    parseUriList,
  } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  // ── 1. Reading the drop ──────────────────────────────────────────────────────────────────────

  check("a drive path, a UNC share and an environment path are paths", () => {
    for (const value of ["C:\\Program Files\\App\\app.exe", "\\\\nas\\media\\clip.mkv", "%APPDATA%\\Code"]) {
      assert.equal(looksLikeWindowsPath(value), true, value);
      assert.deepEqual(classifyDropText(value), { kind: "path", path: value }, value);
    }
  });

  check("Explorer's quoted Copy-as-path is unwrapped, not read as a command", () => {
    assert.deepEqual(classifyDropText('"D:\\Reports\\Q3 plan.xlsx"'), {
      kind: "path",
      path: "D:\\Reports\\Q3 plan.xlsx",
    });
  });

  check("addresses are addresses, with or without the scheme", () => {
    for (const value of ["https://github.com/anthropics", "github.com", "localhost:5173", "www.example.co.uk/a?b=1"]) {
      assert.equal(looksLikeWebAddress(value), true, value);
      assert.deepEqual(classifyDropText(value), { kind: "url", url: value }, value);
    }
  });

  check("a command line is never mistaken for an address", () => {
    /**
     * The regression this whole file exists for. `npm run dev` has a dot in nothing and a space in
     * the middle; the moment the address test stops requiring no whitespace, every dropped command
     * becomes a web shortcut to a host that was never there.
     */
    for (const value of ["npm run dev", "git status", "shutdown /s /t 0", "code ."]) {
      assert.equal(looksLikeWebAddress(value), false, value);
      assert.deepEqual(classifyDropText(value), { kind: "command", line: value }, value);
    }
  });

  check("a scheme of its own is a link, and is not prefixed with https", () => {
    for (const value of ["steam://rungameid/440", "mailto:team@example.com", "obsidian://open?vault=notes"]) {
      assert.equal(isNonWebScheme(value), true, value);
      assert.deepEqual(classifyDropText(value), { kind: "url", url: value }, value);
    }
    assert.equal(isNonWebScheme("https://example.com"), false);
  });

  check("a file: URI comes back as the Windows path it names", () => {
    assert.equal(fileUriToWindowsPath("file:///C:/Users/me/Q3%20plan.xlsx"), "C:\\Users\\me\\Q3 plan.xlsx");
    assert.equal(fileUriToWindowsPath("file://nas/media/clip.mkv"), "\\\\nas\\media\\clip.mkv");
    assert.equal(fileUriToWindowsPath("https://example.com"), null);
    assert.deepEqual(classifyDropText("file:///D:/Projects"), { kind: "path", path: "D:\\Projects" });
  });

  check("uri-list drops its comments", () => {
    assert.deepEqual(parseUriList("# comment\nhttps://a.example\n\nhttps://b.example\n"), [
      "https://a.example",
      "https://b.example",
    ]);
  });

  check("files win over the text a drag also carries", () => {
    /**
     * A link dragged out of a browser brings the page's TITLE along in `text/plain` on some builds,
     * and a file drag brings its own name. Reading both would add the same thing twice — once as
     * itself and once as a command line spelled like its title.
     */
    assert.deepEqual(
      dropEntriesFrom({
        paths: ["C:\\Tools\\app.exe"],
        uriList: "https://example.com",
        text: "Example Domain",
      }),
      [{ kind: "path", path: "C:\\Tools\\app.exe" }],
    );
    assert.deepEqual(
      dropEntriesFrom({ paths: [], uriList: "https://example.com", text: "Example Domain" }),
      [{ kind: "url", url: "https://example.com" }],
    );
  });

  check("the same thing dropped twice is added once", () => {
    assert.deepEqual(dropEntriesFrom({ paths: ["C:\\a.exe", "c:\\A.EXE", "C:\\b.exe"] }), [
      { kind: "path", path: "C:\\a.exe" },
      { kind: "path", path: "C:\\b.exe" },
    ]);
  });

  check("several lines of text are several shortcuts", () => {
    assert.deepEqual(dropEntriesFrom({ text: "https://a.example\r\nC:\\Tools\\b.exe\r\nnpm run dev" }), [
      { kind: "url", url: "https://a.example" },
      { kind: "path", path: "C:\\Tools\\b.exe" },
      { kind: "command", line: "npm run dev" },
    ]);
  });

  check("the name-only fallback never claims a folder", () => {
    /** A name cannot prove a directory, and `folder` guessed wrong is a shortcut that opens nothing. */
    assert.equal(guessPathKind("C:\\Tools\\app.exe"), "app");
    assert.equal(guessPathKind("C:\\Start\\Slack.lnk"), "app");
    assert.equal(guessPathKind("C:\\Docs\\report.pdf"), "file");
    assert.equal(guessPathKind("D:\\Projects"), "file");
  });

  check("a dropped path names itself", () => {
    assert.equal(labelFromDroppedPath("D:\\Reports\\Q3 plan.xlsx"), "Q3 plan");
    assert.equal(labelFromDroppedPath("D:\\Projects\\"), "Projects");
    assert.equal(labelFromDroppedPath("C:\\Start\\Visual Studio Code.lnk"), "Visual Studio Code");
  });

  // ── 2. Reading the disk ──────────────────────────────────────────────────────────────────────

  const { inspectDroppedPath, labelFromPath, readUrlFile } = require(
    join(root, "backend", "drop-inspect.cjs"),
  );

  const folder = join(scratch, "My Projects");
  mkdirSync(folder, { recursive: true });
  const namedLikeAFile = join(scratch, "notes.txt.d");
  mkdirSync(namedLikeAFile, { recursive: true });
  const program = join(scratch, "app.exe");
  writeFileSync(program, "MZ");
  const document = join(scratch, "Q3 plan.xlsx");
  writeFileSync(document, "x");
  const internetShortcut = join(scratch, "GitHub.url");
  writeFileSync(internetShortcut, "[InternetShortcut]\r\nIconIndex=0\r\nURL=https://github.com/\r\n");
  const emptyShortcut = join(scratch, "Broken.url");
  writeFileSync(emptyShortcut, "[InternetShortcut]\r\nIconIndex=0\r\n");

  check("a directory is a folder, whatever it is called", () => {
    assert.deepEqual(inspectDroppedPath(folder), { path: folder, kind: "folder", label: "My Projects" });
    assert.equal(inspectDroppedPath(namedLikeAFile).kind, "folder");
  });

  check("a program is an app and a document is a file", () => {
    assert.equal(inspectDroppedPath(program).kind, "app");
    assert.equal(inspectDroppedPath(document).kind, "file");
    assert.equal(inspectDroppedPath(document).label, "Q3 plan");
  });

  check("an internet shortcut hands over the address inside it", () => {
    assert.deepEqual(inspectDroppedPath(internetShortcut), {
      path: internetShortcut,
      kind: "url",
      url: "https://github.com/",
      label: "GitHub",
    });
    assert.equal(readUrlFile(emptyShortcut), null);
    /** No address left in it — still something Windows knows how to open, never a broken link. */
    assert.equal(inspectDroppedPath(emptyShortcut).kind, "file");
  });

  check("a .lnk is whatever it points at", () => {
    const link = join(scratch, "Visual Studio Code.lnk");
    writeFileSync(link, "L");
    const resolve = (target) => ({ target: { [link]: program }[target] });

    const asApp = inspectDroppedPath(link, { readShortcutLink: resolve });
    /**
     * The KIND comes from the target; the command does not. A program keeps the `.lnk` itself —
     * that is what the Start menu hands out, with the arguments and working directory the vendor
     * chose, and what the Application picker already stores when the same file is chosen by hand.
     */
    assert.deepEqual(asApp, { path: link, kind: "app", label: "Visual Studio Code" });

    /** A folder keeps the RESOLVED path: that value is shown and edited in Settings, and a .lnk there says nothing. */
    const toFolder = inspectDroppedPath(link, { readShortcutLink: () => ({ target: folder }) });
    assert.deepEqual(toFolder, { path: folder, kind: "folder", label: "Visual Studio Code" });

    const toDocument = inspectDroppedPath(link, { readShortcutLink: () => ({ target: document }) });
    assert.deepEqual(toDocument, { path: document, kind: "file", label: "Visual Studio Code" });

    /** An unreadable .lnk is still a launchable one; a drop has no dialog to report the failure in. */
    const unreadable = inspectDroppedPath(link, {
      readShortcutLink: () => {
        throw new Error("nope");
      },
    });
    assert.equal(unreadable.kind, "app");
    assert.equal(inspectDroppedPath(link).kind, "app");
  });

  check("a path that is not on disk still becomes a shortcut", () => {
    const gone = join(scratch, "not-here", "Missing.pdf");
    assert.deepEqual(inspectDroppedPath(gone), { path: gone, kind: "file", label: "Missing" });
    assert.equal(inspectDroppedPath("   "), null);
    assert.equal(labelFromPath("C:\\"), "C:");
  });

  // ── 3. The wiring ────────────────────────────────────────────────────────────────────────────

  const mainSource = read("backend", "electron-main.js");
  const preloadSource = read("backend", "electron-preload.js");
  const settingsSource = read("src", "components", "PrecisionSettings.tsx");
  const appSource = read("src", "App.tsx");

  check("the channel exists on both sides", () => {
    assert.match(preloadSource, /inspectDropPaths:\s*\(paths\)\s*=>\s*ipcRenderer\.invoke\("inspect-drop-paths", paths\)/);
    assert.match(mainSource, /ipcMain\.handle\("inspect-drop-paths"/);
  });

  check("main answers one entry per input", () => {
    /**
     * The renderer pairs answers with paths BY POSITION. Filtering the reply — pushing only the
     * paths that could be read — would shift every answer after the first failure onto the wrong
     * file, and a dropped folder would quietly arrive as the document next to it.
     */
    const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle("inspect-drop-paths"'));
    const body = handler.slice(0, handler.indexOf("\n});"));
    assert.match(body, /\.map\(/, "the handler must map over the inputs, not push onto a filtered list");
    assert.doesNotMatch(body, /\.push\(/);
    assert.match(body, /\|\|\s*null/, "an unreadable path must still occupy its position");
  });

  check("the list's own reorder drag is not read as an import", () => {
    /** Both of the row's own handlers bail out for a drag that started outside the list. */
    assert.match(settingsSource, /rowDragRef\.current = true;/);
    assert.match(settingsSource, /if \(!rowDragRef\.current\) return;\s*\n\s*event\.preventDefault\(\);/);
    assert.match(settingsSource, /if \(!transfer \|\| rowDragRef\.current\) return false;/);
  });

  check("a near miss is swallowed rather than navigated to", () => {
    /**
     * Chromium's default for a file dropped on the page is to NAVIGATE to it — the whole of
     * Settings replaced by a PDF. Settings invites dragging now, so the near miss is the ordinary
     * case and has to be nothing at all.
     */
    assert.match(appSource, /window\.addEventListener\("dragover", swallow\)|window\.addEventListener\('dragover', swallow\)/);
    assert.match(appSource, /window\.addEventListener\("drop", swallow\)|window\.addEventListener\('drop', swallow\)/);
  });

  check("the whole drop is one write", () => {
    /** Appended one at a time, each item would be added to a workspace the previous one replaced. */
    assert.match(
      settingsSource,
      /updateWorkspace\(workspaceIndex, \(current\) => \(\{ apps: \[\.\.\.current\.apps, \.\.\.items\] \}\)\);/,
    );
  });

  check("a drop can be undone without a dialog in front of it", () => {
    assert.match(settingsSource, /apps: current\.apps\.filter\(\(item\) => !added\.has\(item\.id\)\)/);
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of failed) {
  console.error(`✗ ${entry.name}\n  ${entry.error?.message || entry.error}`);
}
if (failed.length) {
  console.error(`drop-shortcut-smoke: ${failed.length} failed`);
  process.exit(1);
}
console.log(`drop-shortcut-smoke: OK (${checks.length} checks)`);
