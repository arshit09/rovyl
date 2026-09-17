/**
 * The workspace-as-a-file contract.
 *
 * Three promises the text view makes and nothing else checks: a stored workspace survives the trip
 * to text and back unchanged; a mistake is reported on the line it was made on; and applying a file
 * keeps what the text cannot carry — ids and extracted icons — for every shortcut it still names.
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
    apps: [
      {
        id: "a1", type: "app", label: "VS Code", iconName: "AppWindow", iconSource: "native",
        customIconUrl: "rovyl-icon://abc", command: "C:\\Tools\\Code.exe", commandType: "app",
        description: "Application", hasRecents: true, terminalCommands: ["npm run dev"], launchMode: "reuse",
      },
      { id: "a2", type: "app", label: "GitHub", iconName: "Globe", command: "https://github.com", commandType: "url", description: "Web link" },
      { id: "a3", type: "app", label: "Repos", iconName: "FolderGit2", command: "%USERPROFILE%\\src", commandType: "folder", description: "Folder shortcut" },
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
  const { workspace: applied, needsIcon } = applyWorkspaceFile(stored, parsed.workspace, { isActive: false });
  assert.deepEqual(needsIcon, [], "an unchanged file fetches nothing");
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
  assert.equal(merged.workspace.color, undefined);
  const [site, code] = merged.workspace.apps;
  assert.equal(code.id, "a1", "a renamed shortcut with the same target keeps its id");
  assert.equal(code.customIconUrl, "rovyl-icon://abc", "and its extracted icon");
  assert.equal(code.hasRecents, undefined, "settings removed from the text are removed");
  assert.notEqual(site.id, "a2");
  assert.deepEqual(merged.needsIcon.map((item) => item.id), [site.id], "only the new shortcut needs an icon");

  console.log("workspace-file-smoke: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
