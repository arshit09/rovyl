/**
 * The workspace-as-a-file contract.
 *
 * Four promises the text view makes and nothing else checks: a stored workspace survives the trip
 * to text and back unchanged; a mistake is reported on the line it was made on; applying a file
 * keeps what the text cannot carry — ids and extracted icons — for every shortcut it still names;
 * and custom icons follow `iconFile` and `icon` without the file ever naming a stored reference.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-workspace-file-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "workspaceFile.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { workspaceToFileText, parseWorkspaceFile, applyWorkspaceFile } = await import(
    pathToFileURL(join(outDir, "entry.mjs")).href
  );

  const stored = {
    id: "ws-1",
    name: "Dev",
    hotkey: 2,
    enabled: true,
    color: "#22c55e",
    pickerIconName: "Code",
    pickerIconUrl: "rovyl-icon://ws",
    pickerIconFile: "C:\\Icons\\dev.png",
    apps: [
      {
        id: "a1", type: "app", label: "VS Code", iconName: "AppWindow", iconSource: "native",
        customIconUrl: "rovyl-icon://abc", command: "C:\\Tools\\Code.exe", commandType: "app",
        description: "Application", hasRecents: true, terminalCommands: ["npm run dev"], launchMode: "reuse",
      },
      { id: "a2", type: "app", label: "GitHub", iconName: "Globe", command: "https://github.com", commandType: "url", description: "Web link" },
      { id: "a3", type: "app", label: "Repos", iconName: "FolderGit2", command: "%USERPROFILE%\\src", commandType: "folder", description: "Folder shortcut" },
      // A glyph chosen in place of the program's own icon.
      { id: "a4", type: "app", label: "Terminal", iconName: "Rocket", iconSource: "custom", command: "wt.exe", commandType: "app", description: "Application" },
      // A picture taken from one of a system library's icons.
      {
        id: "a5", type: "app", label: "Notes", iconName: "File", iconSource: "custom", customIconUrl: "rovyl-icon://notes",
        customIconFile: "%SystemRoot%\\System32\\imageres.dll,109", command: "D:\\notes.txt", commandType: "file", description: "File shortcut",
      },
      // A pasted picture: there is no file the text could name.
      { id: "a6", type: "app", label: "Pics", iconName: "Folder", iconSource: "custom", customIconUrl: "rovyl-icon://pasted", command: "D:\\Pics", commandType: "folder", description: "Folder shortcut" },
      // An automatic icon over a glyph name nobody chose, as older configs carry.
      { id: "a7", type: "app", label: "Legacy", iconName: "Chrome", iconSource: "native", customIconUrl: "rovyl-icon://legacy", command: "C:\\legacy.exe", commandType: "app", description: "Application" },
      {
        id: "g1", type: "folder", label: "Ops", iconName: "Server", command: "", description: "Group",
        children: [
          {
            id: "c1", type: "app", label: "Flush DNS", iconName: "TerminalSquare", command: 'ipconfig /flushdns && echo "done"',
            commandType: "command", commandShell: "cmd", commandWindow: "hidden", description: "Command",
          },
          { id: "f1", type: "app", label: "Plan", iconName: "File", command: "D:\\Docs\\Q3 plan.xlsx", commandType: "file", description: "File shortcut" },
        ],
      },
    ],
  };

  // ── 1. Round trip ────────────────────────────────────────────────────────────────────────────
  const text = workspaceToFileText(stored);
  assert.ok(!text.includes("rovyl-icon://"), "icon-store references are machine-local and stay out of the file");
  assert.ok(!text.includes('"id"'), "ids stay out of the file");
  const parsed = parseWorkspaceFile(text);
  assert.equal(parsed.ok, true, parsed.error?.message);
  const { workspace: applied, needsIcon, needsPicture } = applyWorkspaceFile(stored, parsed.workspace, { isActive: false });
  assert.deepEqual(needsIcon, [], "an unchanged file fetches nothing");
  assert.deepEqual(needsPicture, [], "and imports no picture it already has");
  const body = JSON.parse(text.slice(text.indexOf("\n") + 1));
  assert.equal(body.iconFile, "C:\\Icons\\dev.png", "the workspace names its picture's file");
  const byName = Object.fromEntries(body.shortcuts.map((entry) => [entry.name, entry]));
  assert.equal(byName.Notes.iconFile, "%SystemRoot%\\System32\\imageres.dll,109", "and so does a shortcut");
  assert.equal(byName.Terminal.icon, "Rocket", "a glyph chosen for an app is written");
  assert.equal(byName.Legacy.icon, undefined, "a glyph under an automatic icon is not");
  assert.equal(byName.Pics.iconFile, undefined, "a pasted picture has no file to write");
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), JSON.parse(JSON.stringify(stored)), "text → workspace is lossless");
  assert.equal(workspaceToFileText(applied), text, "and it writes back to the same text");

  // ── 2. JSONC: comments and trailing commas ───────────────────────────────────────────────────
  const jsonc = `// mine
{
  /* block */ "name": "Tools", // trailing
  "shortcuts": [
    { "type": "url", "name": "Docs", "target": "example.com/docs", },
  ],
}`;
  const loose = parseWorkspaceFile(jsonc);
  assert.equal(loose.ok, true, loose.error?.message);
  assert.equal(loose.workspace.shortcuts[0].target, "https://example.com/docs", "a bare host gets https://");
  assert.equal(loose.workspace.enabled, true, "enabled defaults to true");

  // ── 3. Errors point at their line ────────────────────────────────────────────────────────────
  const errorAt = (source) => {
    const result = parseWorkspaceFile(source);
    assert.equal(result.ok, false, `expected an error for:\n${source}`);
    return result.error;
  };
  let error = errorAt(`{\n  "name": "X",\n  "shortcuts": [\n    { "type": "ap", "name": "A", "target": "a.exe" }\n  ]\n}`);
  assert.equal(error.line, 4);
  assert.match(error.message, /Did you mean "app"/);

  error = errorAt(`{\n  "name": "X",\n  "shortcuts": [\n    { "type": "url", "name": "A", "target": "x.com", "lanch": "reuse" }\n  ]\n}`);
  assert.equal(error.line, 4);
  assert.match(error.message, /"lanch" is not a setting/);
  assert.match(error.message, /launch/);

  error = errorAt(`{\n  "name": "X"\n  "shortcuts": []\n}`);
  assert.equal(error.line, 3, "a missing comma is reported where the next key starts");

  error = errorAt(`{\n  "name": "X",\n  "shortcuts": [\n    { "type": "folder", "name": "A", "target": "C:\\Users" }\n  ]\n}`);
  assert.equal(error.line, 4);
  assert.match(error.message, /backslashes doubled/);

  error = errorAt(`{ "name": "X", "shortcuts": [ { "type": "url", "name": "A", "target": "ftp://x" } ] }`);
  assert.match(error.message, /http/);

  error = errorAt(`{ "name": "X", "shortcuts": [ { "type": "command", "name": "A", "target": "dir", "shell": "bash" } ] }`);
  assert.match(error.message, /"shell" must be one of/);

  error = errorAt(`{ "name": "X", "shortcuts": [ { "type": "url", "name": "A", "target": "x.com", "launch": "prewarm" } ] }`);
  assert.match(error.message, /"launch" must be one of: "normal", "reuse"/, "prewarm is for apps only");

  error = errorAt(`{ "name": "X" }`);
  assert.match(error.message, /"shortcuts"/);

  error = errorAt(`{ "name": "X", "shortcuts": [ { "type": "group", "name": "G" } ] }`);
  assert.match(error.message, /"items"/);

  // ── 4. Merge keeps ids and icons of what the file still names ───────────────────────────────
  const edited = parseWorkspaceFile(`{
    "name": "Dev 2",
    "enabled": false,
    "shortcuts": [
      { "type": "url", "name": "New site", "target": "https://example.org" },
      { "type": "app", "name": "Code (renamed)", "target": "C:\\\\Tools\\\\Code.exe" }
    ]
  }`);
  assert.equal(edited.ok, true, edited.error?.message);
  const merged = applyWorkspaceFile(stored, edited.workspace, { isActive: true });
  assert.equal(merged.workspace.id, "ws-1");
  assert.equal(merged.workspace.hotkey, 2, "the positional hotkey is not the file's to change");
  assert.equal(merged.workspace.enabled, true, "the current workspace cannot be hidden");
  assert.ok("pickerIconName" in merged.workspace && merged.workspace.pickerIconName === undefined, "a removed icon line clears the icon");
  assert.ok("pickerIconUrl" in merged.workspace && merged.workspace.pickerIconUrl === undefined, "and a removed iconFile line its picture");
  assert.equal(merged.workspace.color, undefined);
  const [site, code] = merged.workspace.apps;
  assert.equal(code.id, "a1", "a renamed shortcut with the same target keeps its id");
  assert.equal(code.customIconUrl, "rovyl-icon://abc", "and its extracted icon");
  assert.equal(code.hasRecents, undefined, "settings removed from the text are removed");
  assert.notEqual(site.id, "a2");
  assert.deepEqual(merged.needsIcon.map((item) => item.id), [site.id], "only the new shortcut needs an icon");

  // ── 5. Custom icons ──────────────────────────────────────────────────────────────────────────
  const reiconed = parseWorkspaceFile(JSON.stringify({
    name: "Dev",
    iconFile: "D:\\Art\\new.svg",
    shortcuts: [
      { type: "app", name: "Terminal", target: "wt.exe" },
      { type: "file", name: "Notes", iconFile: "C:\\Windows\\System32\\shell32.dll,4", target: "D:\\notes.txt" },
      { type: "folder", name: "Pics", target: "D:\\Pics" },
      { type: "app", name: "Legacy", icon: "Chrome", target: "C:\\legacy.exe" },
    ],
  }));
  assert.equal(reiconed.ok, true, reiconed.error?.message);
  const icons = applyWorkspaceFile(stored, reiconed.workspace, { isActive: false });
  const [terminal, notes, pics, legacy] = icons.workspace.apps;
  assert.equal(terminal.iconSource, "lucide", "dropping a chosen glyph hands the app back its own icon");
  assert.deepEqual(icons.needsIcon.map((item) => item.id), ["a4"], "which is fetched after applying");
  assert.equal(notes.customIconUrl, undefined, "a different iconFile does not keep the old picture");
  assert.equal(notes.customIconFile, "C:\\Windows\\System32\\shell32.dll,4");
  assert.equal(pics.customIconUrl, "rovyl-icon://pasted", "a pasted picture survives, having no line to remove");
  assert.equal(legacy.iconSource, "custom", "a glyph named for an app replaces its automatic icon");
  assert.equal(legacy.customIconUrl, undefined);
  assert.equal(icons.workspace.pickerIconUrl, undefined);
  assert.deepEqual(
    icons.needsPicture,
    [{ itemId: "a5", file: "C:\\Windows\\System32\\shell32.dll,4" }, { file: "D:\\Art\\new.svg" }],
    "every new iconFile is imported, the workspace's included",
  );

  const withIcon = (extra) =>
    JSON.stringify({ name: "X", shortcuts: [{ type: "app", name: "A", target: "a.exe", ...extra }] });
  error = errorAt(withIcon({ iconFile: "icons/a.png" }));
  assert.match(error.message, /"iconFile" is the full path/, "a relative iconFile is refused");
  error = errorAt(withIcon({ icon: "C:\\a.png" }));
  assert.match(error.message, /use "iconFile"/, "a path written as icon points at iconFile");
  assert.equal(parseWorkspaceFile(withIcon({ iconFile: "\\\\server\\share\\a.ico" })).ok, true, "a UNC path is a full path");

  console.log("workspace-file-smoke: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
