/**
 * The contract behind "a shortcut can be a typed command line".
 *
 * The load-bearing claim is that the line reaches the shell the user picked exactly as typed:
 * quotes, `&` and `'` included, and in the folder they chose. Only hidden runs are exercised here
 * — an open run is `start` around the same text and would put windows on the desktop of whoever
 * runs the suite.
 *
 * Like its neighbours this reads source: `runTypedCommand` lives in `electron-main.js`, which cannot
 * be required outside Electron, so the function is lifted out and given the three helpers it uses.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = readFileSync(join(root, "backend", "electron-main.js"), "utf8");
const typesSource = readFileSync(join(root, "src", "types.ts"), "utf8");

// ── 1. It leaves before the preamble that rewrites launch lines ─────────────────────────────────
const early = mainSource.indexOf('if (commandType === "command") return await runTypedCommand(');
assert.notStrictEqual(early, -1, "runExecuteCommand must hand typed commands to runTypedCommand.");
assert.ok(
  early < mainSource.indexOf("let resolvedCommand = resolveShellPath(trimmedCommand);"),
  "A typed command must leave before GUID expansion, IDE flags and requoting touch it.",
);
assert.match(typesSource, /commandType\?: [^;]*"command"/, "AppItem must admit the command type.");

// ── 2. Hidden runs, for real ────────────────────────────────────────────────────────────────────
const start = mainSource.indexOf("const HIDDEN_COMMAND_WATCH_MS");
const end = mainSource.indexOf("// IPC: receives a command from React to run an app");
assert.ok(start !== -1 && end > start, "runTypedCommand moved: this smoke test needs updating");

const runTypedCommand = new Function(
  "os", "fs", "spawn", "launchOk", "launchFailed", "diagLog", "Buffer", "process",
  `${mainSource.slice(start, end)}\nreturn runTypedCommand;`,
)(
  os, fs, spawn,
  (method) => ({ ok: true, method }),
  (error, details) => ({ ok: false, error, details }),
  () => {},
  Buffer, process,
);

if (process.platform !== "win32") {
  console.log("command-shortcut-smoke: ok (source checks only, not on Windows)");
  process.exit(0);
}

const scratch = mkdtempSync(join(os.tmpdir(), "rovyl-command-smoke-"));
const out = join(scratch, "out.txt");
try {
  let result = await runTypedCommand(`echo "a & b" > "${out}" && cd >> "${out}"`, {
    commandShell: "cmd",
    commandWindow: "hidden",
    workingDirectory: root,
  });
  assert.deepEqual(result, { ok: true, method: "command-cmd" });
  assert.deepEqual(
    readFileSync(out, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    ['"a & b"', root],
    "cmd must see the line as typed and run it in the chosen folder.",
  );

  result = await runTypedCommand(
    `Set-Content -LiteralPath '${out}' -Value ((Get-Location).Path + '|it''s "ok" & fine')`,
    { commandWindow: "hidden" },
  );
  assert.deepEqual(result, { ok: true, method: "command-powershell" });
  assert.equal(
    readFileSync(out, "utf8").trim(),
    `${os.homedir()}|it's "ok" & fine`,
    "PowerShell is the default shell, the user folder the default place, and the text arrives intact.",
  );

  result = await runTypedCommand("rovyl-no-such-program-123", { commandShell: "cmd", commandWindow: "hidden" });
  assert.equal(result.ok, false, "A command that fails at once must come back as a failure.");
  assert.equal(result.details.commandType, "command");
  assert.equal(result.details.errorCode, 1);

  const gone = join(scratch, "gone");
  result = await runTypedCommand("echo hi", { workingDirectory: gone });
  assert.equal(result.ok, false);
  assert.equal(result.details.method, "command-cwd", "A missing working folder is its own failure.");
  assert.ok(!existsSync(gone));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("command-shortcut-smoke: ok");
