/**
 * Linux launching & launch-line canonicalization — the counterpart to `win32-launch.js`.
 *
 * Windows has one universal front door (`ShellExecute`) that takes a path, a URL, a protocol or an
 * AUMID and works out the rest. Linux has none, so this module *is* that front door, and it has to
 * dispatch on the shape of the string itself:
 *
 *   /opt/foo/foo            an executable            → spawn it
 *   foo                     a name on $PATH          → spawn it
 *   org.gnome.Nautilus      a desktop entry ID       → gtk-launch, or its expanded Exec
 *   https://example.com     a URL                    → xdg-open
 *   ~/Documents             a directory              → xdg-open
 *   foo | tee log           a shell line             → sh -c
 *
 * Two rules are load-bearing everywhere below.
 *
 * **Detach or the app dies with us.** A plain `spawn` leaves the child in Rovyl's process group,
 * holding our stdio pipes. Quit Rovyl — or let the session kill it — and the app the user just
 * opened goes with it. `detached: true` + `stdio: "ignore"` + `unref()` is all three halves of the
 * fix: a new process group, no inherited descriptors, and no event-loop ref keeping us alive.
 *
 * **argv, never a shell string.** Every path below that can build an argv array does. A command is
 * only ever handed to `sh -c` when the *user* wrote shell syntax, and then it is handed over whole
 * and unedited — never assembled by concatenating a path someone else chose into a string.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { findAppByCommand, splitExecTokens } = require("./linux-apps.cjs");

/**
 * Terminal emulators and the argv each one wants in front of the program it should run.
 *
 * This table is the single source of truth for the question; `electron-main.js` asks for it
 * through `detectTerminal()` rather than keeping a second copy, because the two drifted apart
 * once already and a disagreement here fails silently in a way nobody reports.
 *
 * The conventions genuinely differ:
 *   - kitty and foot take the program directly, with no separator at all.
 *   - the xterm lineage takes `-e <program> <args…>`.
 *   - gnome-terminal wants `--`; its `-e` has been deprecated for years and mangles arguments.
 *   - xfce4-terminal, tilix and terminator read `-e` as ONE command *string* and silently drop
 *     everything after the program. `-x` is their argv form, and is what belongs here.
 *   - wezterm hides it behind a subcommand.
 *
 * `exec: []` means "append argv directly".
 */
const TERMINAL_CANDIDATES = [
  { bin: "kitty", exec: [] },
  { bin: "alacritty", exec: ["-e"] },
  { bin: "wezterm", exec: ["start", "--"] },
  { bin: "foot", exec: [] },
  { bin: "ghostty", exec: ["-e"] },
  { bin: "konsole", exec: ["-e"] },
  { bin: "gnome-terminal", exec: ["--"] },
  { bin: "xfce4-terminal", exec: ["-x"] },
  { bin: "tilix", exec: ["-x"] },
  { bin: "terminator", exec: ["-x"] },
  { bin: "x-terminal-emulator", exec: ["-e"] },
  { bin: "xterm", exec: ["-e"] },
];

/** Characters that mean the user wrote shell, not a command. `$` and `~` are handled before this. */
const SHELL_METACHARACTERS = /[|&;<>`()\n]/;

function homeDir() {
  return process.env.HOME || os.homedir() || "";
}

function stripOuterQuotes(s) {
  const t = String(s || "").trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * `~` only expands at the very start and only as `~` or `~/…`; `~foo` is another user's home and we
 * are not in the business of guessing it.
 */
function expandTilde(value) {
  const s = String(value || "");
  if (!s) return s;
  if (s === "~") return homeDir();
  if (s.startsWith("~/")) return path.join(homeDir(), s.slice(2));
  return s;
}

/**
 * Expand `~` and `$VAR` / `${VAR}` in a path-ish token. An unset variable expands to the empty
 * string, matching every shell, rather than being left as a literal `$FOO` where it would become
 * part of a filename.
 */
function expandUserPath(value) {
  const s = expandTilde(value);
  if (!s) return s;
  return s.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (m, braced, bare) => {
      const v = process.env[braced || bare];
      return v === undefined ? "" : v;
    },
  );
}

/**
 * The same expansion, but for a token that is about to be treated as a path.
 *
 * `$` is a legal character in a filename, and expanding it unconditionally turns a directory that
 * genuinely exists into one that does not — `/srv/a$b/run` becomes `/srv/a/run` and the launch
 * fails with "cannot launch" while the file is sitting right there. So the literal spelling is
 * tried against the filesystem first and only a miss falls through to variable expansion, which
 * keeps `$HOME/bin/foo` working. `~` always expands: a leading literal `~` is never a real path.
 *
 * `canonicalizeLinuxLaunchCommand` escapes such a path as `\$`, so the stored form arrives here
 * already unescaped by `splitExecTokens` — both spellings have to survive.
 */
function expandPathToken(value) {
  const literal = expandTilde(value);
  if (literal.includes("$") && statOrNull(literal)) return literal;
  return expandUserPath(value);
}

function pathDirs() {
  return String(process.env.PATH || "").split(":").filter(Boolean);
}

/** The absolute path of an executable named on `$PATH`, or null. */
function resolveOnPath(name) {
  const n = String(name || "");
  if (!n || n.includes("/")) return null;
  for (const dir of pathDirs()) {
    const full = path.join(dir, n);
    try {
      if (fs.statSync(full).isFile()) {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function isExecutableFile(p) {
  const st = statOrNull(p);
  if (!st || !st.isFile()) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * A command whose *target* is an absolute filesystem path.
 *
 * The test is on the program token, not the raw string, so `"/opt/My App/run" --flag` answers yes
 * the same way `/usr/bin/firefox` does — a caller asking this is deciding whether to stat the
 * thing, and the arguments are none of its business.
 */
function isAbsoluteLinuxTarget(cmd) {
  const t = stripOuterQuotes(cmd);
  if (!t) return false;
  const head = t.startsWith("/") || t.startsWith("~") ? t : splitExecTokens(String(cmd || ""))[0] || "";
  if (head.startsWith("/")) return true;
  if (head === "~" || head.startsWith("~/")) return expandUserPath(head).startsWith("/");
  return false;
}

function isUrlCommand(cmd) {
  const t = stripOuterQuotes(cmd);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^mailto:/i.test(t);
}

/** Quote a token for re-joining a canonical launch line — only when it would not survive bare. */
function quoteLinuxArgIfNeeded(token) {
  const s = String(token == null ? "" : token);
  if (s === "") return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Split an *unquoted* line into program + argv without breaking at the first space.
 *
 * The same trick `splitWin32SpawnExeAndArgs` plays on `C:\Program Files\…`, for the same reason:
 * `~/Documents/My App/run --flag` has no quoting to tell us where the path ends, so the filesystem
 * is asked instead. The longest space-joined prefix that is a real file wins; when nothing on disk
 * matches, the ordinary "first token is the program" reading stands.
 */
function splitLinuxSpawnExeAndArgs(tokens) {
  if (tokens.length < 2) return { exe: tokens[0] || "", args: [] };
  let bestEnd = 0;
  for (let i = 2; i <= tokens.length; i++) {
    const candidate = tokens.slice(0, i).join(" ");
    const st = statOrNull(candidate);
    if (st && st.isFile()) bestEnd = i;
  }
  if (!bestEnd) return { exe: tokens[0], args: tokens.slice(1) };
  return { exe: tokens.slice(0, bestEnd).join(" "), args: tokens.slice(bestEnd) };
}

/**
 * Normalize a user-entered command to the form we are willing to store.
 *
 * Deliberately conservative: it collapses whitespace *between* tokens (never inside a quoted one),
 * expands `~` so a stored line does not silently change meaning when `$HOME` does, quotes a program
 * path that really does contain a space, and stops there. A bare name stays bare — resolving
 * `firefox` to `/usr/bin/firefox` at save time would pin the shortcut to today's package layout and
 * break it on the next distro upgrade.
 *
 * Anything holding shell syntax keeps its tokens untouched. Re-quoting a pipeline is how you turn a
 * working command into `sh: foo | bar: command not found`.
 */
function canonicalizeLinuxLaunchCommand(cmd) {
  const t = String(cmd || "").trim();
  if (!t) return "";
  if (t.startsWith("internal:")) return t;
  if (isUrlCommand(t)) return t;
  if (SHELL_METACHARACTERS.test(t)) return t.replace(/[ \t]+/g, " ");

  const tokens = splitExecTokens(t).map((a) =>
    a === "~" || a.startsWith("~/") ? expandUserPath(a) : a,
  );
  if (!tokens.length) return t;

  const { exe, args } = splitLinuxSpawnExeAndArgs(tokens);
  return [exe, ...args].map(quoteLinuxArgIfNeeded).join(" ");
}

/**
 * `spawn` + the three-part detach, resolved once the OS has actually confirmed the fork.
 *
 * The `"spawn"` event is the only honest success signal: `child.pid` is set synchronously even for
 * a binary that does not exist, and the `ENOENT` arrives a tick later on `"error"`. Reporting `ok`
 * from the pid alone is why "nothing happened, but it said it launched" is such a common bug.
 */
function spawnDetached(file, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        cwd: (opts && opts.cwd) || undefined,
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
      return;
    }

    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: String((err && err.message) || err) });
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      const pid = child.pid;
      try {
        child.unref();
      } catch (_) {
        /* already reaped; the process is still detached */
      }
      resolve({ ok: true, pid });
    });
  });
}

/**
 * The first terminal emulator that exists, `$TERMINAL` first.
 *
 * Returns `{ bin, exec }`, plus `flag` as the first element of `exec` for callers that only ever
 * wanted the one token.
 */
function detectTerminal() {
  const describe = (bin, exec) => ({ bin, exec, flag: exec.length ? exec[0] : null });

  const preferred = String(process.env.TERMINAL || "").trim();
  if (preferred) {
    const known = TERMINAL_CANDIDATES.find((c) => c.bin === path.basename(preferred));
    const bin = preferred.includes("/")
      ? (isExecutableFile(preferred) ? preferred : null)
      : resolveOnPath(preferred);
    /** An emulator we have no entry for gets the xterm convention; it is the one most honour. */
    if (bin) return describe(bin, known ? known.exec : ["-e"]);
  }
  for (const cand of TERMINAL_CANDIDATES) {
    const bin = resolveOnPath(cand.bin);
    if (bin) return describe(bin, cand.exec);
  }
  return null;
}

/** Wrap an argv so it runs inside a terminal window, or return it unchanged if none is installed. */
function wrapInTerminal(file, args) {
  const term = detectTerminal();
  if (!term) return { file, args, wrapped: false };
  return { file: term.bin, args: [...term.exec, file, ...args], wrapped: true };
}

function runArgv(file, args, opts) {
  if (opts && opts.terminal) {
    const wrapped = wrapInTerminal(file, args);
    return spawnDetached(wrapped.file, wrapped.args, opts);
  }
  return spawnDetached(file, args, opts);
}

function openWith(target, opts) {
  const opener = resolveOnPath("xdg-open");
  if (!opener) return Promise.resolve({ ok: false, error: "xdg-open is not installed" });
  return spawnDetached(opener, [target], opts);
}

/** Launch a desktop entry: `gtk-launch` when it exists, otherwise the entry's own expanded `Exec`. */
async function launchDesktopEntry(id, opts) {
  const bare = String(id || "").replace(/\.desktop$/i, "");

  /**
   * The entry is resolved *before* `gtk-launch` is tried, and that order is the whole point.
   * `spawnDetached` reports `ok` when the fork succeeded, which for `gtk-launch` means the
   * launcher binary started — not that it found the entry. Ask it about a name that does not
   * exist and it exits 1 a moment later, long after we have already told the caller `ok: true`
   * and shown the user a wheel that appears to have worked. Establishing the entry first turns
   * that into an honest error, and leaves the fallback below reachable instead of dead.
   */
  const entry = await findAppByCommand(bare);
  if (!entry) return { ok: false, error: `No desktop entry named ${bare}` };

  const gtkLaunch = resolveOnPath("gtk-launch");
  if (gtkLaunch) {
    const res = await runArgv(gtkLaunch, [bare], opts);
    if (res.ok) return res;
  }
  const extra = Array.isArray(opts && opts.args) && opts.args.length ? opts.args : [];
  const program = entry.command.includes("/")
    ? entry.command
    : resolveOnPath(entry.command) || entry.command;
  return runArgv(program, [...entry.args, ...extra], {
    ...opts,
    terminal: Boolean((opts && opts.terminal) || entry.terminal),
  });
}

/**
 * Open whatever this string names, and outlive Rovyl doing it.
 *
 * `opts`: `{ args?: string[], workingDir?: string, terminal?: boolean }`. Returns
 * `{ ok, pid?, error? }` and never throws — the caller is an IPC handler, where a rejected promise
 * is an unhandled rejection in the main process.
 */
async function launchLinuxCommand(command, opts) {
  const options = opts || {};
  const raw = String(command || "").trim();
  if (!raw) return { ok: false, error: "Empty command" };

  let cwd;
  if (options.workingDir) {
    const dir = expandPathToken(stripOuterQuotes(options.workingDir));
    const st = statOrNull(dir);
    if (st && st.isDirectory()) cwd = dir;
  }
  const runOpts = { cwd, terminal: Boolean(options.terminal) };
  const explicitArgs = Array.isArray(options.args) ? options.args.map((a) => String(a)) : null;

  /** A URL is never a path, whatever else it looks like. Check it before touching the filesystem. */
  if (isUrlCommand(raw)) return openWith(stripOuterQuotes(raw), runOpts);

  const unquoted = stripOuterQuotes(raw);
  const expandedWhole = expandPathToken(unquoted);

  /**
   * When the caller supplies argv, the command string is a *program*, full stop — no tokenizing,
   * no shell fallback. This is the path a parsed desktop entry comes back through, and its program
   * may legitimately contain spaces.
   */
  if (explicitArgs) {
    if (expandedWhole.includes("/")) {
      if (isExecutableFile(expandedWhole)) return runArgv(expandedWhole, explicitArgs, runOpts);
      return { ok: false, error: `Not an executable: ${expandedWhole}` };
    }
    const onPath = resolveOnPath(expandedWhole);
    if (onPath) return runArgv(onPath, explicitArgs, runOpts);
    return { ok: false, error: `Not found on PATH: ${expandedWhole}` };
  }

  if (/\.desktop$/i.test(unquoted) && !unquoted.startsWith("/")) {
    return launchDesktopEntry(unquoted, runOpts);
  }

  /** The whole string as one path — this is what makes `/opt/My App/run` work without quoting. */
  const wholeStat = statOrNull(expandedWhole);
  if (wholeStat) {
    if (wholeStat.isDirectory()) return openWith(expandedWhole, runOpts);
    if (isExecutableFile(expandedWhole)) return runArgv(expandedWhole, [], runOpts);
    return openWith(expandedWhole, runOpts);
  }

  /**
   * Shell syntax goes to `sh -c` verbatim. Note the line is the user's own and travels as a single
   * argv element — there is no concatenation here for anything to break out of.
   */
  if (SHELL_METACHARACTERS.test(raw)) {
    const sh = resolveOnPath("sh") || "/bin/sh";
    return runArgv(sh, ["-c", raw], runOpts);
  }

  const tokens = splitExecTokens(raw).map((t) => expandPathToken(t));
  if (tokens.length) {
    const { exe: head, args: rest } = splitLinuxSpawnExeAndArgs(tokens);
    if (head.includes("/")) {
      if (isExecutableFile(head)) return runArgv(head, rest, runOpts);
      if (statOrNull(head)) return openWith(head, runOpts);
    } else {
      const onPath = resolveOnPath(head);
      if (onPath) return runArgv(onPath, rest, runOpts);
    }
  }

  /** Last resort: the string may be a desktop ID or a display name the user picked long ago. */
  const entry = await findAppByCommand(raw);
  if (entry) return launchDesktopEntry(entry.id, runOpts);

  return { ok: false, error: `Cannot launch: ${raw}` };
}

function walkAppTree(apps, visitor) {
  if (!Array.isArray(apps)) return;
  for (const app of apps) {
    if (!app || typeof app !== "object") continue;
    visitor(app);
    if (Array.isArray(app.children)) walkAppTree(app.children, visitor);
  }
}

/**
 * Normalize all workspace (and legacy flat) app commands before writing config to disk
 * or after reading — keeps stored lines stable across `$HOME` changes and stray whitespace.
 *
 * Mirrors `normalizePersistedPayloadWin32` exactly, down to mutating and returning the same object:
 * both are called inline around the same read/write sites in the main process.
 */
function normalizePersistedPayloadLinux(payload) {
  if (typeof process === "undefined" || process.platform !== "linux" || !payload) {
    return payload;
  }
  const touch = (app) => {
    const cmd = app.command;
    if (!cmd || typeof cmd !== "string") return;
    const ct = app.commandType || (app.type === "url" ? "url" : "app");
    if (ct !== "app") return;
    if (cmd.startsWith("internal:")) return;
    const next = canonicalizeLinuxLaunchCommand(cmd);
    if (next !== cmd) app.command = next;
  };

  if (payload.config && Array.isArray(payload.config.workspaces)) {
    for (const ws of payload.config.workspaces) {
      if (ws.apps) walkAppTree(ws.apps, touch);
    }
  }
  if (Array.isArray(payload.apps)) walkAppTree(payload.apps, touch);
  return payload;
}

module.exports = {
  launchLinuxCommand,
  canonicalizeLinuxLaunchCommand,
  isAbsoluteLinuxTarget,
  normalizePersistedPayloadLinux,
  /** Exported for the smoke test and for reuse in the main process; not part of the core contract. */
  expandUserPath,
  resolveOnPath,
  detectTerminal,
  quoteLinuxArgIfNeeded,
  splitLinuxSpawnExeAndArgs,
};
