/**
 * Smoke test for the Linux backend trio (no Electron).
 * Run: node scripts/linux-apps-smoke.mjs
 *
 * Unlike the other smoke tests in here, this one is deliberately run against the *real* machine:
 * a hand-built fixture tree would only prove the parser agrees with the fixture, and every bug
 * worth catching in desktop-entry handling comes from a file some distro actually shipped.
 *
 * Nothing here launches a user application. `launchLinuxCommand` is exercised against `/bin/true`
 * only, which is observable (a real pid, an immediate exit) and cannot open a window.
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  listInstalledApps,
  findAppByCommand,
  applicationDirs,
  expandExec,
  parseDesktopEntry,
  localeCandidates,
} = require("../backend/linux-apps.cjs");
const {
  launchLinuxCommand,
  canonicalizeLinuxLaunchCommand,
  isAbsoluteLinuxTarget,
  normalizePersistedPayloadLinux,
  detectTerminal,
  expandUserPath,
} = require("../backend/linux-launch.js");
const { resolveIconPath, resolveIconToDataUrl, currentIconThemeName } = require("../backend/linux-icons.cjs");

if (process.platform !== "linux") {
  console.log("not linux — skipping");
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

/* ---------------------------------------------------------------- 1. discovery */

console.log("== application directories ==");
for (const dir of applicationDirs()) {
  let n = 0;
  try {
    n = fs.readdirSync(dir).filter((f) => f.endsWith(".desktop")).length;
  } catch (_) {
    n = -1;
  }
  console.log(`  ${n < 0 ? "  --" : String(n).padStart(4)}  ${dir}`);
}

const t0 = Date.now();
const apps = await listInstalledApps();
const coldMs = Date.now() - t0;
const t1 = Date.now();
await listInstalledApps();
const warmMs = Date.now() - t1;

/**
 * Ground truth: the `.desktop` files sitting in the system directory. The parsed count is lower by
 * design — `NoDisplay`, `Hidden`, `OnlyShowIn` and a failed `TryExec` all legitimately drop
 * entries — so the assertion is a plausibility band, not equality. Anything below half means the
 * parser is rejecting real files; anything above the raw count means dedupe stopped working.
 */
let systemFiles = 0;
try {
  systemFiles = fs.readdirSync("/usr/share/applications").filter((f) => f.endsWith(".desktop")).length;
} catch (_) {
  /* no system directory; the band below still holds against 0 */
}

console.log("\n== discovery ==");
console.log(`  /usr/share/applications/*.desktop : ${systemFiles}`);
console.log(`  parsed entries                    : ${apps.length}`);
console.log(`  of those NoDisplay                : ${apps.filter((a) => a.noDisplay).length}`);
console.log(`  of those Terminal=true            : ${apps.filter((a) => a.terminal).length}`);
console.log(`  cold scan / warm (cached)         : ${coldMs}ms / ${warmMs}ms`);

assert.ok(apps.length >= 20, `expected a populated desktop, found ${apps.length} apps`);
assert.ok(
  apps.length >= Math.floor(systemFiles * 0.5),
  `found ${apps.length} apps but /usr/share/applications holds ${systemFiles} files — parser is dropping real entries`,
);
assert.ok(warmMs <= Math.max(5, coldMs), "second call was not served from cache");

const ids = new Set();
for (const a of apps) {
  assert.equal(typeof a.id, "string");
  assert.ok(a.id.length > 0, "empty desktop id");
  assert.ok(!ids.has(a.id), `duplicate desktop id ${a.id} — first-wins dedupe is broken`);
  ids.add(a.id);
  assert.equal(typeof a.name, "string");
  assert.ok(a.name.length > 0, `entry ${a.id} has no name`);
  assert.equal(typeof a.command, "string");
  assert.ok(a.command.length > 0, `entry ${a.id} has an empty command`);
  assert.ok(Array.isArray(a.args), `entry ${a.id} args is not an array`);
  assert.ok(Array.isArray(a.categories));
  assert.equal(typeof a.noDisplay, "boolean");
  assert.equal(typeof a.terminal, "boolean");
  assert.ok(a.icon === null || typeof a.icon === "string");
}

/* ---------------------------------------------------------------- 2. eyeball sample */

console.log("\n== sample (10 entries, for eyeballing Exec parsing) ==");
const sample = apps.filter((a) => !a.noDisplay).slice(0, 10);
for (const a of sample) {
  console.log(`  ${pad(a.id, 34)} ${pad(a.name, 22)} ${a.command} ${JSON.stringify(a.args)}`);
}

/* ---------------------------------------------------------------- 3. field codes */

/**
 * The bug this exists to catch: `Exec=firefox %u` becoming `args: ["%u"]`, which makes Firefox open
 * a tab for a nonexistent file literally named `%u`. Every field code the spec defines is checked,
 * not just the two common ones.
 */
const FIELD_CODE = /%[fFuUdDnNickvm]/;
let codeOffenders = 0;
for (const a of apps) {
  if (FIELD_CODE.test(a.command)) {
    console.log(`  !! field code left in command: ${a.id} -> ${a.command}`);
    codeOffenders++;
  }
  for (const arg of a.args) {
    if (FIELD_CODE.test(arg)) {
      console.log(`  !! field code left in args: ${a.id} -> ${JSON.stringify(arg)}`);
      codeOffenders++;
    }
    assert.notEqual(arg, "", `entry ${a.id} kept an empty argv element`);
  }
}
console.log(`\n== field codes ==\n  offenders across ${apps.length} entries and ${apps.reduce((n, a) => n + a.args.length, 0)} args: ${codeOffenders}`);
assert.equal(codeOffenders, 0, "field codes survived Exec expansion");

/** Direct unit checks, including the cases a naive regex gets wrong. */
assert.deepEqual(expandExec("firefox %u"), { command: "firefox", args: [] });
assert.deepEqual(expandExec("env FOO=1 /usr/bin/app --file %f --name %c"), {
  command: "env",
  args: ["FOO=1", "/usr/bin/app", "--file", "--name"],
});
assert.deepEqual(expandExec('"/opt/My App/run" --flag %U'), {
  command: "/opt/My App/run",
  args: ["--flag"],
});
/** `%%U` is a literal percent then a literal U — a `/%[fFuU]/g` regex eats both and is wrong. */
assert.deepEqual(expandExec("app %%U"), { command: "app", args: ["%U"] });
assert.deepEqual(expandExec("app --path=%f --keep=100%%"), {
  command: "app",
  args: ["--path=", "--keep=100%"],
});
/**
 * Two escape layers, in order — verbatim from `scrcpy-console.desktop`. The string rule turns
 * `\\` into `\`, then the quoting rule turns `\$` into `$`; one pass alone leaves a literal
 * backslash and the app launches under `/bin/sh` instead of the user's shell.
 */
assert.deepEqual(expandExec(`/bin/sh -c "\\\\$SHELL -i -c 'scrcpy --pause-on-exit=if-error'"`), {
  command: "/bin/sh",
  args: ["-c", "$SHELL -i -c 'scrcpy --pause-on-exit=if-error'"],
});
console.log("  expandExec unit cases: ok");

/* ---------------------------------------------------------------- 3b. parser rules */

/**
 * The group, locale and visibility rules, against synthetic text rather than a shipped file —
 * these are the branches no single distro exercises all of at once.
 */
const SYNTHETIC = [
  "[Desktop Entry]",
  "Type=Application",
  "Name=Files",
  "Name[de]=Dateien",
  "Name[pt_BR]=Arquivos",
  "Exec=nautilus --new-window %U",
  "Icon=org.gnome.Nautilus",
  "Categories=GTK;Utility;FileManager;",
  "NoDisplay=false",
  "Terminal=false",
  "",
  "[Desktop Action new-window]",
  "Name=New Window",
  "Exec=nautilus --new-window",
].join("\n");
const parsed = parseDesktopEntry(SYNTHETIC);
console.log("\n== parser rules ==");
/** `[Desktop Action …]` must not leak: its Name is "New Window", the entry's is "Files". */
assert.equal(parsed.Name, "Files", "an action group leaked into [Desktop Entry]");
assert.equal(parsed["Name[de]"], "Dateien");
assert.equal(parsed["Name[pt_BR]"], "Arquivos");
assert.deepEqual(expandExec(parsed.Exec), { command: "nautilus", args: ["--new-window"] });
console.log(`  action group isolated, locale keys read: ok`);
console.log(`  locale preference order (${process.env.LANG || "unset"}): ${JSON.stringify(localeCandidates())}`);

/** `Name[xx]` really is preferred over `Name` when the session asks for `xx`. */
const savedLang = process.env.LANG;
const savedMessages = process.env.LC_MESSAGES;
const savedAll = process.env.LC_ALL;
try {
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
  process.env.LANG = "pt_BR.UTF-8";
  assert.deepEqual(localeCandidates(), ["pt_BR", "pt"]);
  process.env.LANG = "de_DE.UTF-8@euro";
  assert.deepEqual(localeCandidates(), ["de_DE@euro", "de_DE", "de@euro", "de"]);
  process.env.LANG = "C";
  assert.deepEqual(localeCandidates(), [], "the C locale must fall back to plain Name");
  console.log("  localized-name fallback chain: ok");
} finally {
  if (savedLang === undefined) delete process.env.LANG;
  else process.env.LANG = savedLang;
  if (savedMessages !== undefined) process.env.LC_MESSAGES = savedMessages;
  if (savedAll !== undefined) process.env.LC_ALL = savedAll;
}

/* ---------------------------------------------------------------- 4. findAppByCommand */

console.log("\n== findAppByCommand ==");
const probe = sample[0];
for (const [label, value] of [
  ["by id", probe.id],
  ["by id.desktop", `${probe.id}.desktop`],
  ["by exec basename", path.basename(probe.command)],
  ["by full command", probe.command],
  ["by name (cased)", probe.name.toUpperCase()],
]) {
  const hit = await findAppByCommand(value);
  console.log(`  ${pad(label, 18)} ${pad(value, 40)} -> ${hit ? hit.id : "(null)"}`);
  assert.ok(hit, `findAppByCommand(${value}) found nothing`);
}
assert.equal(await findAppByCommand("this-app-does-not-exist-zzz"), null);
assert.equal(await findAppByCommand(""), null);

/* ---------------------------------------------------------------- 5. icons */

console.log(`\n== icons (theme: ${currentIconThemeName()}) ==`);
const iconTargets = apps.filter((a) => !a.noDisplay).slice(0, 10);
let pathHits = 0;
let urlHits = 0;
for (const a of iconTargets) {
  const p = a.icon ? await resolveIconPath(a.icon, 64) : null;
  const url = a.icon ? await resolveIconToDataUrl(a.icon, 64) : null;
  if (p) pathHits++;
  if (url) urlHits++;
  const shown = p ? p.replace(process.env.HOME || "~", "~") : "(none)";
  console.log(`  ${pad(a.id, 34)} icon=${pad(a.icon || "-", 24)} ${pad(shown, 62)} ${url ? `${url.length}B data url` : "-"}`);
}
console.log(`  path hit rate     : ${pathHits}/${iconTargets.length}`);
console.log(`  data-url hit rate : ${urlHits}/${iconTargets.length}`);
assert.ok(pathHits >= Math.ceil(iconTargets.length * 0.5), "icon theme lookup resolved fewer than half");

for (const url of [await resolveIconToDataUrl(iconTargets.find((a) => a.icon)?.icon || "folder", 64)]) {
  if (url) assert.ok(url.startsWith("data:image/png;base64,"), "data url is not a PNG");
}
assert.equal(await resolveIconPath("definitely-not-an-icon-zzz", 64), null);
assert.equal(await resolveIconToDataUrl("definitely-not-an-icon-zzz", 64), null);
assert.equal(await resolveIconToDataUrl("", 64), null);
assert.equal(await resolveIconPath("/no/such/file.png", 64), null);
console.log("  misses return null rather than throwing: ok");

/* ---------------------------------------------------------------- 6. canonicalize / absolute */

console.log("\n== canonicalizeLinuxLaunchCommand ==");
const home = process.env.HOME;
const CANON = [
  ["  firefox  ", "firefox"],
  ["firefox    --new-window", "firefox --new-window"],
  ["/usr/bin/code --wait", "/usr/bin/code --wait"],
  ["~/bin/tool", `${home}/bin/tool`],
  ["~", home],
  ['"/opt/My App/run" --x', '"/opt/My App/run" --x'],
  /** Nothing on disk says where this path ends, so the plain reading stands. */
  ["/opt/My App/run", "/opt/My App/run"],
  ["https://example.com/a b", "https://example.com/a b"],
  ["internal:settings", "internal:settings"],
  ["sh -c 'foo | bar'", "sh -c 'foo | bar'"],
  ["", ""],
];
for (const [input, expected] of CANON) {
  const got = canonicalizeLinuxLaunchCommand(input);
  console.log(`  ${pad(JSON.stringify(input), 30)} -> ${JSON.stringify(got)}`);
  assert.equal(got, expected, `canonicalize(${JSON.stringify(input)})`);
}
/** Storing a canonical line then canonicalizing it again must not drift. */
for (const [, expected] of CANON) {
  assert.equal(canonicalizeLinuxLaunchCommand(expected), expected, `not idempotent: ${expected}`);
}
console.log("  idempotent: ok");

/**
 * When the path with a space *does* exist, the filesystem is what tells us where it ends — the
 * Linux twin of `splitWin32SpawnExeAndArgs` refusing to break `C:\Program Files\…` at the space.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rovyl-linux-smoke-"));
const spacedDir = path.join(tmpRoot, "My App");
fs.mkdirSync(spacedDir);
const spacedExe = path.join(spacedDir, "run");
fs.writeFileSync(spacedExe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
try {
  const spacedCanon = canonicalizeLinuxLaunchCommand(`${spacedExe} --flag`);
  console.log(`  real path with a space -> ${JSON.stringify(spacedCanon)}`);
  assert.equal(spacedCanon, `"${spacedExe}" --flag`, "did not probe the filesystem for the program");
  assert.equal(canonicalizeLinuxLaunchCommand(spacedCanon), spacedCanon, "quoted form not idempotent");
  assert.equal(isAbsoluteLinuxTarget(spacedCanon), true);

  const spacedRun = await launchLinuxCommand(`${spacedExe} --flag`);
  console.log(`  launching it           -> ${JSON.stringify(spacedRun)}`);
  assert.equal(spacedRun.ok, true, "a program whose path holds a space failed to launch");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("\n== isAbsoluteLinuxTarget ==");
const ABS = [
  ["/usr/bin/firefox", true],
  ['"/opt/My App/run"', true],
  ['"/opt/My App/run" --flag', true],
  ["~/bin/tool", true],
  ["~", true],
  ["firefox", false],
  ["./relative/thing", false],
  ["https://example.com", false],
  ["org.gnome.Nautilus", false],
  ["", false],
];
for (const [input, expected] of ABS) {
  const got = isAbsoluteLinuxTarget(input);
  console.log(`  ${pad(JSON.stringify(input), 22)} -> ${got}`);
  assert.equal(got, expected, `isAbsoluteLinuxTarget(${JSON.stringify(input)})`);
}

/* ---------------------------------------------------------------- 7. persisted payload */

const payload = {
  config: {
    workspaces: [
      {
        id: "w1",
        apps: [
          { id: "a1", command: "  firefox   --new-window ", commandType: "app" },
          { id: "a2", command: "https://example.com", commandType: "url", type: "url" },
          { id: "a3", command: "internal:settings", commandType: "app" },
          { id: "a4", command: "~/bin/tool", commandType: "app", children: [{ id: "a5", command: "  ~/bin/deep ", commandType: "app" }] },
        ],
      },
    ],
  },
  apps: [{ id: "flat", command: "  code    --wait ", commandType: "app" }],
};
const out = normalizePersistedPayloadLinux(payload);
assert.equal(out, payload, "must mutate and return the same object, like the win32 twin");
const ws = out.config.workspaces[0].apps;
assert.equal(ws[0].command, "firefox --new-window");
assert.equal(ws[1].command, "https://example.com");
assert.equal(ws[2].command, "internal:settings");
assert.equal(ws[3].command, `${home}/bin/tool`);
assert.equal(ws[3].children[0].command, `${home}/bin/deep`, "tree walk did not reach children");
assert.equal(out.apps[0].command, "code --wait");
assert.equal(normalizePersistedPayloadLinux(null), null);
console.log("\n== normalizePersistedPayloadLinux ==\n  tree-walk, url/internal skips, child recursion: ok");

/* ---------------------------------------------------------------- 8. launch (harmless only) */

console.log("\n== launchLinuxCommand (harmless targets only) ==");
const trueRes = await launchLinuxCommand("/bin/true");
console.log(`  /bin/true            -> ${JSON.stringify(trueRes)}`);
assert.equal(trueRes.ok, true, `expected ok, got ${JSON.stringify(trueRes)}`);
assert.equal(typeof trueRes.pid, "number");
assert.ok(trueRes.pid > 0, "no real pid");

const argRes = await launchLinuxCommand("/bin/true", { args: ["--version"], workingDir: "/tmp" });
console.log(`  /bin/true --version  -> ${JSON.stringify(argRes)}`);
assert.equal(argRes.ok, true);
assert.ok(argRes.pid > 0);

const bareRes = await launchLinuxCommand("true");
console.log(`  true (on $PATH)      -> ${JSON.stringify(bareRes)}`);
assert.equal(bareRes.ok, true);

const shellRes = await launchLinuxCommand("true && true");
console.log(`  true && true (sh -c) -> ${JSON.stringify(shellRes)}`);
assert.equal(shellRes.ok, true);

const missing = await launchLinuxCommand("rovyl-definitely-not-a-binary-zzz");
console.log(`  missing binary       -> ${JSON.stringify(missing)}`);
assert.equal(missing.ok, false);
assert.equal(typeof missing.error, "string");

const empty = await launchLinuxCommand("   ");
console.log(`  empty command        -> ${JSON.stringify(empty)}`);
assert.equal(empty.ok, false);

/** Detachment is the point of the module: the child must be in its own process group. */
const detached = await launchLinuxCommand("/bin/sh", { args: ["-c", "sleep 0.2"] });
assert.equal(detached.ok, true);
let pgid = null;
try {
  pgid = Number(fs.readFileSync(`/proc/${detached.pid}/stat`, "utf8").split(") ").pop().split(" ")[2]);
} catch (_) {
  /* already exited — the check below is skipped rather than failed */
}
if (pgid != null && Number.isFinite(pgid)) {
  console.log(`  detached pgid        -> ${pgid} (own group: ${pgid === detached.pid}, rovyl pgid: ${process.pid})`);
  assert.equal(pgid, detached.pid, "child is not its own process group leader — it would die with Rovyl");
} else {
  console.log("  detached pgid        -> child already exited, group check skipped");
}

/**
 * Terminal detection is *reported*, never exercised: spawning a terminal emulator opens a window
 * on the user's desktop, which is exactly what this test promises not to do.
 */
const term = detectTerminal();
console.log("\n== terminal detection (not spawned) ==");
console.log(`  $TERMINAL=${JSON.stringify(process.env.TERMINAL || "")}`);
console.log(`  chosen: ${term ? `${term.bin} ${term.flag ? `${term.flag} <argv>` : "<argv>"}` : "(none installed)"}`);
if (term) {
  assert.equal(typeof term.bin, "string");
  assert.ok(term.bin.startsWith("/"), "terminal was not resolved to an absolute path");
  assert.ok(term.flag === null || typeof term.flag === "string");
}
const terminalApps = apps.filter((a) => a.terminal).slice(0, 3);
for (const a of terminalApps) console.log(`  Terminal=true entry: ${pad(a.id, 28)} ${a.command} ${JSON.stringify(a.args)}`);

/**
 * Regressions, both of the same shape: a launch that reports success while nothing runs, or
 * reports failure while the target is sitting right there. Neither raises, so only an assertion
 * catches them coming back.
 */
console.log("\n== regressions ==");

/**
 * gtk-launch is spawned, and a spawn succeeds as soon as the binary forks - it says nothing about
 * whether the entry existed. Resolving the entry first is what makes this an honest error instead
 * of an `ok: true` over a wheel that visibly did nothing.
 */
const ghost = await launchLinuxCommand("rovyl-no-such-entry-zzz.desktop", {});
console.log(`  missing .desktop     -> ${JSON.stringify(ghost)}`);
assert.equal(ghost.ok, false, "a missing desktop entry reported success");
assert.match(ghost.error, /No desktop entry/);

/**
 * `$` is legal in a filename, so expanding it unconditionally turns a path that exists into one
 * that does not. Both spellings have to launch: the raw path, and the canonical form, where
 * `canonicalizeLinuxLaunchCommand` has escaped the `$`.
 */
const dollarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rovyl-dollar-"));
try {
  const dollarDir = path.join(dollarRoot, "a$b");
  fs.mkdirSync(dollarDir, { recursive: true });
  const dollarExe = path.join(dollarDir, "run");
  fs.writeFileSync(dollarExe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const dollarRaw = await launchLinuxCommand(dollarExe, {});
  const dollarCanon = canonicalizeLinuxLaunchCommand(dollarExe);
  const dollarStored = await launchLinuxCommand(dollarCanon, {});
  console.log(`  $ in path (raw)      -> ${JSON.stringify(dollarRaw)}`);
  console.log(`  $ in path (stored)   -> ${JSON.stringify(dollarStored)} from ${JSON.stringify(dollarCanon)}`);
  assert.equal(dollarRaw.ok, true, "a real path containing $ did not launch");
  assert.equal(dollarStored.ok, true, "the canonical form of a $ path did not launch");
} finally {
  fs.rmSync(dollarRoot, { recursive: true, force: true });
}

/** The expansion itself still has to work, or this fix traded one break for another. */
assert.equal(expandUserPath("$HOME"), process.env.HOME, "$VAR expansion regressed");
console.log(`  $HOME still expands  -> ok`);

/**
 * One table, asked once. These drifted apart before - kitty and foot were `-e` in one file and
 * bare in the other - and a wrong separator opens a shell with the user's command silently gone.
 */
if (term) {
  assert.ok(Array.isArray(term.exec), "detectTerminal lost its exec argv");
  assert.equal(term.flag, term.exec.length ? term.exec[0] : null, "flag/exec disagree");
}

console.log("\nlinux-apps smoke: OK");
