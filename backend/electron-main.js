const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  nativeImage,
  nativeTheme,
  Menu,
  Tray,
  shell,
  dialog,
  session,
  protocol,
} = require("electron");
/**
 * Loaded on first use, not at module scope.
 *
 * The destructure that used to live here fired `electron-updater`'s `autoUpdater` getter during
 * module evaluation — before `app.whenReady` — which constructs an `NsisUpdater` and eagerly pulls
 * in the package's whole closure: 80 modules, ~9.5 MB of RSS and ~86 ms, including four updaters
 * that can never run on Windows. `configureAutoUpdates` then declines to use any of it on
 * unpackaged and Store builds, having already paid in full.
 */
let electronUpdaterModule = null;
const getAutoUpdater = () => {
  if (!electronUpdaterModule) electronUpdaterModule = require("electron-updater");
  return electronUpdaterModule.autoUpdater;
};
const { createIconStore, ICON_SCHEME } = require("./icon-store.cjs");

/**
 * Icons are files in userData, served to `<img>` over this scheme — see `backend/icon-store.cjs`
 * for why they stopped being base64 in the config.
 *
 * `file://` URLs would not do. Production loads `dist/index.html` off disk and a `file://`
 * subresource works there, but dev loads `http://localhost:5173`, where Chromium refuses it — the
 * wheel would have icons in the packaged app and none while developing it. A registered scheme
 * behaves the same in both.
 *
 * Registration has to happen here, at module scope: `registerSchemesAsPrivileged` throws if it runs
 * after `app.whenReady`, and a throw here is a launch that never happens.
 */
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
} catch (e) {
  console.error("[IconStore] registerSchemesAsPrivileged failed:", e.message);
}
const path = require("path");
const { exec, spawn, execFile, execFileSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const win32Launch = require("./win32-launch");
const { buildTrayMenuTemplate } = require("./tray-menu.cjs");
const { normalizeFullPersistenceBlob } = require("./persistence-normalize.cjs");
const { detectGameExecutable } = require("./game-detection.cjs");
const { parseForegroundSnapshot, createLineSplitter } = require("./foreground-snapshot.cjs");
const { isPhysicalRectFullscreen } = require("./fullscreen-bounds.cjs");
const { fullBleedBounds } = require("./full-bleed-bounds.cjs");
const { titleFromHtmlBuffer } = require("./page-title.cjs");
const { decidePendingUpdate } = require("./pending-update.cjs");
const { createSystemStatusService } = require("./system-status.cjs");
const crypto = require("crypto");
const { GlobalKeyboardListener } = require("node-global-key-listener");
const http = require("http");
const https = require("https");
const url = require("url");

/**
 * Whether this is a real packaged build — the question `app.isPackaged` stopped answering.
 *
 * Electron derives `isPackaged` from the executable's file name: anything that is not
 * `electron.exe` counts as packaged. `scripts/brand-dev-electron.cjs` renames the dev runtime to
 * `Rovyl.exe` so Windows stops introducing the app as Electron — and from that rename on, every
 * run from source claimed to be packaged. The updater configured itself and went looking for
 * `node_modules/electron/dist/resources/app-update.yml`, the keyboard listener looked for its key
 * server inside an `app.asar.unpacked` that only exists in an installed build, and `isDev` could
 * never be true again.
 *
 * `process.defaultApp` does not depend on the name. Electron sets it when the runtime is handed an
 * app path to run — `electron .`, which is how every launcher in `scripts/` starts it — and leaves
 * it undefined in a packaged app. `app.isPackaged` is only ever wrong in the one direction, so the
 * two together are the honest answer.
 */
const isPackagedBuild = app.isPackaged && !process.defaultApp;

const isDev = !isPackagedBuild && process.env.NODE_ENV !== "production";

/**
 * Distribution channel. The Microsoft Store forbids self-updating mechanisms — the store is what
 * updates — and a submission with `electron-updater` live fails certification. The same code serves
 * both channels; this is where it decides which one is running.
 *
 * `process.windowsStore` is set by Electron when the process runs inside an MSIX package. The
 * environment variable exists only so the behaviour can be tested without packaging.
 */
const isStoreBuild = () =>
  process.windowsStore === true || process.env.ROVYL_STORE_BUILD === "1";
const logDir = isDev
  ? path.join(__dirname, "..")
  : path.join(os.homedir(), ".rovyl");
const logFile = path.join(logDir, "diagnostic.log");

/**
 * The log folder predates the rebrand. Move the Zenith one over once so existing users keep their
 * history under the new name; it runs before the first write, so a fresh install never sees it.
 */
if (!isDev) {
  const legacyLogDir = path.join(os.homedir(), ".zenith-radial-menu");
  try {
    if (fs.existsSync(legacyLogDir) && !fs.existsSync(logDir)) {
      fs.renameSync(legacyLogDir, logDir);
    }
  } catch (e) {
    console.error("Log folder rename failed:", e.message);
  }
}

const logQueue = [];
let isWriting = false;
let logFlushTimer = null;

/**
 * The log was pure append: it grew forever (and every open adds a line per resolved icon). Two
 * generations of 2 MB are enough to diagnose with, and the disk stops paying interest. The size is
 * counted in memory — a `statSync` on every write would trade one problem for another.
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
let logBytesWritten = null;

const rotateLogIfNeeded = (incomingBytes) => {
  try {
    if (logBytesWritten === null) {
      logBytesWritten = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    }
    if (logBytesWritten + incomingBytes <= LOG_MAX_BYTES) {
      logBytesWritten += incomingBytes;
      return;
    }
    /** `renameSync` over the previous `.1` drops the oldest generation with no extra step. */
    fs.renameSync(logFile, `${logFile}.1`);
    logBytesWritten = incomingBytes;
  } catch (e) {
    logBytesWritten = 0;
  }
};

const processLogQueue = () => {
  if (isWriting || logQueue.length === 0) return;
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  isWriting = true;

  const logsToWrite = logQueue.splice(0, logQueue.length).join("");

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    rotateLogIfNeeded(Buffer.byteLength(logsToWrite, "utf-8"));
    fs.appendFile(logFile, logsToWrite, (err) => {
      isWriting = false;
      if (err) {
        console.error("Async log write failed:", err);
      }
      // Process any new logs that arrived during writing
      if (logQueue.length > 0) processLogQueue();
    });
  } catch (e) {
    isWriting = false;
    console.error("Failed to ensure log directory exists:", e);
  }
};

/**
 * Flush only after a log actually arrives. The old permanent 5 s interval woke
 * the Electron main process all day even when the app was completely idle.
 */
const scheduleLogFlush = () => {
  if (logFlushTimer || logQueue.length === 0) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    processLogQueue();
  }, 1500);
  logFlushTimer.unref?.();
};

/**
 * The trigger binding, parsed by the grammar `backend/mouse-trigger.cjs` shares with the renderer:
 * a button plus the modifiers held with it. Left and right are accepted here — the parser refuses
 * them BARE, so watching one can never cost the system its primary click or its context menu.
 */
const {
  DEFAULT_MOUSE_TRIGGER,
  parseMouseTrigger,
  normalizeMouseTrigger,
  mouseTriggerAllowsHold,
} = require("./mouse-trigger.cjs");

/**
 * Parse a shortcut string to detect if it contains a mouse button trigger.
 * Supported buttons:
 *  - Middle (VK 0x04)
 *  - Mouse4 / X1 (VK 0x05)
 *  - Mouse5 / X2 (VK 0x06)
 *  - RightClick / Right (VK 0x02, only when combined with modifiers to protect system context menu)
 * Modifiers:
 *  - Ctrl (bit 1, 0x01)
 *  - Alt (bit 2, 0x02)
 *  - Shift (bit 4, 0x04)
 *  - Super / Win (bit 8, 0x08)
 */
function parseMouseShortcut(shortcutStr) {
  if (!shortcutStr || typeof shortcutStr !== "string") return null;
  const parts = shortcutStr
    .split("+")
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return null;

  let modMask = 0;
  let mouseBtn = null;
  let vk = 0;
  let cleanBtnName = "";

  for (const part of parts) {
    if (part === "ctrl" || part === "control") {
      modMask |= 1;
    } else if (part === "alt" || part === "option") {
      modMask |= 2;
    } else if (part === "shift") {
      modMask |= 4;
    } else if (
      part === "super" ||
      part === "win" ||
      part === "windows" ||
      part === "meta" ||
      part === "cmd"
    ) {
      modMask |= 8;
    } else if (part === "middle" || part === "mouse3" || part === "wheel") {
      mouseBtn = "middle";
      vk = 4;
      cleanBtnName = "Middle";
    } else if (part === "mouse4" || part === "x1" || part === "xbutton1") {
      mouseBtn = "x1";
      vk = 5;
      cleanBtnName = "Mouse4";
    } else if (part === "mouse5" || part === "x2" || part === "xbutton2") {
      mouseBtn = "x2";
      vk = 6;
      cleanBtnName = "Mouse5";
    } else if (part === "rightclick" || part === "right" || part === "mouse2") {
      mouseBtn = "right";
      vk = 2;
      cleanBtnName = "RightClick";
    }
  }

  if (!mouseBtn || !vk) return null;
  // Disallow plain RightClick without modifier to avoid hijacking normal context menus
  if (vk === 2 && modMask === 0) return null;

  const mods = [];
  if (modMask & 1) mods.push("Ctrl");
  if (modMask & 2) mods.push("Alt");
  if (modMask & 4) mods.push("Shift");
  if (modMask & 8) mods.push("Super");
  const normalized = [...mods, cleanBtnName].join("+");

  return {
    isMouse: true,
    vk,
    modMask,
    buttonName: cleanBtnName,
    normalized,
  };
}

function isMouseShortcut(shortcutStr) {
  return !!parseMouseShortcut(shortcutStr);
}

const diagLog = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logQueue.push(line);

  // Throttle writes: process immediately in dev, or when queue reaches 10 lines in prod
  if (isDev || logQueue.length >= 10) {
    processLogQueue();
  } else {
    scheduleLogFlush();
  }
};

/** Merge KEY=value lines into process.env (later files override). Supports values containing "=". */
function applyEnvFileContent(content) {
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val;
  });
}

/**
 * Rovyl keeps one profile for packaged and development builds. During the rebrand,
 * copy the former Zenith profile forward so existing workspaces and preferences survive.
 * `ZENITH_USER_DATA` remains supported as a backwards-compatible environment override.
 * Must run before any `app.getPath("userData")`.
 */
function ensureUnifiedUserDataDirectory() {
  const udOverride = (
    process.env.ROVYL_USER_DATA ||
    process.env.ZENITH_USER_DATA ||
    ""
  ).trim();
  if (udOverride) {
    try {
      app.setPath("userData", udOverride);
      diagLog(`[Persist] userData override=${app.getPath("userData")}`);
      return;
    } catch (e) {
      console.error("ROVYL_USER_DATA setPath failed:", e.message);
    }
  }

  try {
    const appData = app.getPath("appData");
    const unifiedDir = path.join(appData, "Rovyl");
    const unifiedCfg = path.join(unifiedDir, "config-v2.json");
    const legacyDirs = [
      path.join(appData, "Zenith OS"),
      path.join(appData, "zenith-radial-menu"),
    ];
    const legacyDir = legacyDirs.find((dir) =>
      fs.existsSync(path.join(dir, "config-v2.json")),
    );

    if (!fs.existsSync(unifiedCfg) && legacyDir) {
      if (!fs.existsSync(unifiedDir)) {
        fs.mkdirSync(unifiedDir, { recursive: true });
      }
      for (const f of [
        "config-v2.json",
        "config-v2.json.bak",
        "settings.json",
        "zenith-persistence.log",
        "rovyl-persistence.log",
        "icon-cache.json",
      ]) {
        const src = path.join(legacyDir, f);
        const dst = path.join(unifiedDir, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst);
            diagLog(`[Persist] Migrated legacy profile ${f} → Rovyl userData`);
          } catch (e) {
            diagLog(`[Persist] Migrate ${f} failed: ${e.message}`);
          }
        }
      }
    }

    app.setPath("userData", unifiedDir);
    diagLog(`[Persist] Rovyl userData: ${unifiedDir}`);
  } catch (e) {
    console.error("ensureUnifiedUserDataDirectory:", e.message);
  }
}

/**
 * Packaged apps don't ship the repo-root .env.local. Load from (in order, last wins per key):
 * - project / asar parent: `.env` then `.env.local` (last wins) — works with `npm start` without a build
 * - resources (extraResources / beside installer)
 * - userData (recommended for installed builds: copy .env.local here)
 */
function loadEnvLocalFiles() {
  const paths = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", ".env.local"),
  ];
  try {
    if (process.resourcesPath) {
      paths.push(path.join(process.resourcesPath, ".env.local"));
    }
  } catch (_) {}
  try {
    paths.push(path.join(app.getPath("userData"), ".env.local"));
  } catch (_) {}

  for (const envPath of paths) {
    try {
      if (!envPath || !fs.existsSync(envPath)) continue;
      const envContent = fs.readFileSync(envPath, "utf8");
      applyEnvFileContent(envContent);
      diagLog(`[Env] Loaded .env-style file: ${envPath}`);
    } catch (e) {
      diagLog(`[Env] Failed to read ${envPath}: ${e.message}`);
    }
  }
}

ensureUnifiedUserDataDirectory();
loadEnvLocalFiles();

// Software rendering makes the transparent radial and its blur contend with the UI thread, which
// presents as a slow-motion pointer. The idle HWND is now truly hidden, so GPU is the safe default.
if (process.env.ZENITH_DISABLE_HARDWARE_ACCELERATION === "1") {
  app.disableHardwareAcceleration();
  diagLog(
    "[GPU] ZENITH_DISABLE_HARDWARE_ACCELERATION=1 — software rendering.",
  );
} else {
  diagLog("[GPU] Hardware acceleration on for the transparent radial.");
}

// Helper function to detect preferred terminal emulator
let cachedTerminal = null;
const getPreferredTerminal = () => {
  if (cachedTerminal) return cachedTerminal;
  
  try {
    const { execSync } = require("child_process");
    // 1. Windows Terminal (wt.exe)
    try {
      execSync("where wt.exe", { stdio: "ignore" });
      cachedTerminal = "wt.exe";
      return cachedTerminal;
    } catch (e) {}
    // 2. PowerShell
    try {
      execSync("where powershell.exe", { stdio: "ignore" });
      cachedTerminal = "powershell.exe";
      return cachedTerminal;
    } catch (e) {}
  } catch (e) {}
  // 3. Fallback to CMD
  cachedTerminal = "cmd.exe";
  return cachedTerminal;
};

const getAssetPath = (...paths) => {
  if (isDev) return path.join(__dirname, ...paths);
  // In production, backend is inside app.asar/backend. We need to point to app.asar.unpacked/backend for script execution.
  return path.join(
    __dirname.replace("app.asar", "app.asar.unpacked"),
    ...paths,
  );
};

/* ── MRU for VS Code–family IDEs ─────────────────────────────────────────────────────────────
 *
 * The profile folder name is not the product name and changes across versions and vendors:
 * "Antigravity IDE" (and not "Antigravity", which is only the Chromium runtime), "Code - Insiders",
 * "Windsurf", "Trae"… A fixed table of paths fails silently — it returns an empty list with no
 * error, exactly what happened with Antigravity. Instead of guessing the path, discover it: any
 * folder with `User/globalStorage/{storage.json|state.vscdb}` IS a profile of this family, and the
 * one that best matches the app's name/executable wins. IDEs that do not exist yet start working
 * without a code change.
 */

/** Normalized names: comparison without spaces, hyphens, punctuation or case. */
function normalizeIdeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Labels that look nothing like the folder the product creates. */
const IDE_TOKEN_ALIASES = {
  visualstudiocode: "code",
  vscode: "code",
  vscodeinsiders: "codeinsiders",
};

/** Path and file-name fragments that never identify a product. */
const IDE_TOKEN_STOPLIST = new Set([
  "exe", "com", "app", "bin", "cmd", "lnk", "url",
  "users", "user", "appdata", "local", "locallow", "roaming",
  "program", "programs", "programfiles", "files", "windows", "system32",
  "start", "menu", "desktop", "microsoft", "google", "data",
  /** AUMID prefixes of Electron apps: `electron.app.Antigravity` identifies no product at all. */
  "electron", "electronapp", "shell", "launcher",
]);

/**
 * Identity clues in order of confidence. The EXECUTABLE comes first: `Antigravity IDE.exe` and
 * `Antigravity.exe` are different products that share a prefix, and the label — editable by the
 * user — does not tell them apart. Only then the visible name and, last, the path.
 */
function ideIdentityTokens(appName, appCommand) {
  const tokens = [];
  const push = (raw) => {
    const token = normalizeIdeToken(raw);
    if (!token || token.length < 3 || tokens.includes(token)) return;
    if (IDE_TOKEN_STOPLIST.has(token)) return;
    tokens.push(token);
    const alias = IDE_TOKEN_ALIASES[token];
    if (alias && !tokens.includes(alias)) tokens.push(alias);
  };

  const command = String(appCommand || "").trim().replace(/^"|"$/g, "");
  const segments = command.split(/[\\/]/).filter(Boolean);
  const executable = segments[segments.length - 1] || "";

  /** `Antigravity IDE.exe` → `antigravityide`. */
  push(executable.replace(/\.[a-z0-9]+$/i, ""));
  /** Install folder: `...\Programs\Antigravity IDE\...`. */
  if (segments.length >= 2) push(segments[segments.length - 2]);
  /** AUMID: `Google.Antigravity` → `antigravity`. */
  executable.split(".").forEach(push);

  push(appName);
  String(appName || "")
    .split(/[\s\-_]+/)
    .forEach(push);

  segments.forEach(push);

  return tokens;
}

/** Directories where apps of this family keep the profile. */
function ideProfileSearchRoots() {
  return [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
}

function readIdeProfileAt(dir, dirName) {
  const globalStorage = path.join(dir, "User", "globalStorage");
  const storageJson = path.join(globalStorage, "storage.json");
  const vscdb = path.join(globalStorage, "state.vscdb");
  let mtime = 0;
  let found = false;
  for (const file of [vscdb, storageJson]) {
    try {
      mtime = Math.max(mtime, fs.statSync(file).mtimeMs);
      found = true;
    } catch (e) {
      /* file missing — the other one may still exist */
    }
  }
  return found ? { name: dirName, normalized: normalizeIdeToken(dirName), globalStorage, mtime } : null;
}

/** The sweep hits disk: cached for moments so it does not run on every open of the wheel. */
let ideProfileCache = { at: 0, profiles: [] };
const IDE_PROFILE_CACHE_MS = 15000;

function listIdeProfiles() {
  const now = Date.now();
  if (now - ideProfileCache.at < IDE_PROFILE_CACHE_MS) return ideProfileCache.profiles;

  const profiles = [];
  const seen = new Set();
  for (const root of ideProfileSearchRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const profile = readIdeProfileAt(dir, entry.name);
      if (profile) {
        if (seen.has(profile.globalStorage)) continue;
        seen.add(profile.globalStorage);
        profiles.push(profile);
        continue;
      }
      /** One level down covers profiles under the vendor (`Google\Antigravity`). */
      let nested = [];
      try {
        nested = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const child of nested) {
        if (!child.isDirectory()) continue;
        const nestedProfile = readIdeProfileAt(path.join(dir, child.name), child.name);
        if (!nestedProfile || seen.has(nestedProfile.globalStorage)) continue;
        seen.add(nestedProfile.globalStorage);
        profiles.push(nestedProfile);
      }
    }
  }

  ideProfileCache = { at: now, profiles };
  diagLog(`[Recents] IDE profiles found: ${profiles.map((p) => p.name).join(", ") || "none"}`);
  return profiles;
}

/**
 * Match by degree, never by loose substring: `code` must not capture `VSCodium`, and `antigravity`
 * has to find `Antigravity IDE`. A tie is settled by the most recently written profile, which is
 * the one the user is actually using.
 */
function scoreIdeProfile(token, profile) {
  const name = profile.normalized;
  if (!token || !name) return 0;
  if (name === token) return 100;
  if (name.startsWith(token)) return 80;
  if (token.startsWith(name)) return 70;
  if (token.length >= 5 && name.includes(token)) return 50;
  return 0;
}

/**
 * True when the token names a data folder of its own that is NOT a profile of this family. It is
 * the decisive signal against mirroring: `Antigravity.exe` (the agent) has `%APPDATA%\Antigravity`
 * with no `globalStorage`, so it has no MRU at all — and it must not inherit `Antigravity IDE`'s
 * just because one name is a prefix of the other.
 */
function ideTokenHasOwnNonProfileDataDir(token) {
  for (const root of ideProfileSearchRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || normalizeIdeToken(entry.name) !== token) continue;
      const globalStorage = path.join(root, entry.name, "User", "globalStorage");
      if (!fs.existsSync(globalStorage)) return true;
    }
  }
  return false;
}

/** `globalStorage` of the named IDE, or "" when no profile matches. */
function resolveIdeGlobalStorage(appName, appCommand) {
  const tokens = ideIdentityTokens(appName, appCommand);
  if (tokens.length === 0) return "";
  const profiles = listIdeProfiles();
  if (profiles.length === 0) return "";

  /** 1) Exact match: a product identified to the millimetre never yields to a prefix. */
  for (const token of tokens) {
    const exact = profiles
      .filter((profile) => profile.normalized === token)
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (exact) {
      diagLog(`[Recents] "${appName}" → profile "${exact.name}" (exact via "${token}")`);
      return exact.globalStorage;
    }
    /** 2) The product has a home of its own and it is not a profile: there is no MRU to show. */
    if (ideTokenHasOwnNonProfileDataDir(token)) {
      diagLog(`[Recents] "${appName}" has its own data folder with no globalStorage ("${token}") — no MRU`);
      return "";
    }
  }

  /** 3) Only then accept a partial, for profiles whose name differs from the product. */
  let best = null;
  tokens.forEach((token, tokenIndex) => {
    for (const profile of profiles) {
      const score = scoreIdeProfile(token, profile);
      if (score === 0) continue;
      const candidate = { profile, score, tokenIndex };
      if (
        !best ||
        candidate.tokenIndex < best.tokenIndex ||
        (candidate.tokenIndex === best.tokenIndex &&
          (candidate.score > best.score ||
            (candidate.score === best.score && candidate.profile.mtime > best.profile.mtime)))
      ) {
        best = candidate;
      }
    }
  });

  if (!best) return "";
  diagLog(`[Recents] "${appName}" → profile "${best.profile.name}" (partial ${best.score})`);
  return best.profile.globalStorage;
}

/** VS Code–family IDEs store MRU as a raw array or { entries: [...] }; Cursor/Antigravity often keep history only in state.vscdb. */
function normalizeRecentlyOpenedPathsList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

/**
 * Reads one IDE's MRU list out of its `state.vscdb`.
 *
 * `new SQL.Database(buf)` hands the buffer to emscripten's MEMFS with `canOwn`, so the whole file
 * stays pinned in the WASM heap — which is process-lifetime — until the handle is closed. Cursor's
 * is 175 MB on a real install, and without the close below three drill-ins took the main process
 * from 35 MB to 545 MB of RSS with forced GC reclaiming none of it.
 *
 * The close has to sit in `finally`: the key-missing path returns early and the catch swallows
 * throws, so anything appended before the happy-path return would miss both. `db` is declared out
 * here because the ctor itself can throw on a truncated file.
 */
async function loadRecentlyOpenedPathsFromVscdb(vscdbPath) {
  let db = null;
  try {
    const initSqlJs = require("sql.js");
    const distDir = path.dirname(require.resolve("sql.js"));
    const unpackedDist = distDir.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    const wasmDir =
      unpackedDist !== distDir && fs.existsSync(path.join(unpackedDist, "sql-wasm.wasm"))
        ? unpackedDist
        : distDir;
    const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
    const buf = fs.readFileSync(vscdbPath);
    db = new SQL.Database(buf);
    const res = db.exec(
      "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
    );
    if (!res.length || !res[0].values?.length) return [];
    const parsed = JSON.parse(res[0].values[0][0]);
    return normalizeRecentlyOpenedPathsList(parsed);
  } catch (e) {
    diagLog(`[Recents] state.vscdb read failed (${vscdbPath}): ${e.message}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch (e) {
      diagLog(`[Recents] state.vscdb close failed (${vscdbPath}): ${e.message}`);
    }
  }
}

diagLog("Rovyl Main Process Started");

/**
 * Ctrl+C in the terminal sends SIGINT to the Node/Electron process. Without this handler the
 * process ends abruptly without firing `before-quit`, so the renderer's synchronous flush never
 * happens and the last changes are lost. Routing SIGINT through `app.quit()` lets the normal
 * shutdown flow (before-quit → renderer flush → exit) run.
 */
process.on("SIGINT", () => {
  diagLog("[Signal] SIGINT received — routing through app.quit() for clean persistence flush");
  app.quit();
});

process.on("uncaughtException", (error) => {
  diagLog(`[FATAL UNCAUGHT EXCEPTION] ${error?.stack || error?.message || error}`);
  console.error("[FATAL UNCAUGHT EXCEPTION]", error);
});

process.on("unhandledRejection", (reason) => {
  diagLog(`[UNHANDLED PROMISE REJECTION] ${reason?.stack || reason?.message || reason}`);
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

/** Sum bytes of config-v2.json.broken-*.json (after quarantine) so the renderer can block destructive saves. */
function sumQuarantinedConfigBytes(userDataDir) {
  let total = 0;
  try {
    if (!userDataDir || !fs.existsSync(userDataDir)) return 0;
    const files = fs.readdirSync(userDataDir);
    for (const f of files) {
      if (f.startsWith("config-v2.json.broken-") && f.endsWith(".json")) {
        try {
          const p = path.join(userDataDir, f);
          const st = fs.statSync(p);
          if (st.isFile()) total += st.size;
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return total;
}

/** Declared before single-instance lock so `second-instance` can safely reference it. */
let mainWindow;

// Chromium: avoid touching the GPU/DWM stack of the whole of Windows (Edge, Zen Browser, etc. “loading forever”).
// The old block (ignore-gpu-blocklist, etc.) could degrade shared drivers. Only enable with ZENITH_AGGRESSIVE_GPU=1.
if (process.env.ZENITH_AGGRESSIVE_GPU === "1") {
  diagLog("[GPU] ZENITH_AGGRESSIVE_GPU=1 — legacy Chromium switches on.");
  app.commandLine.appendSwitch("disable-gpu-cache");
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("enable-zero-copy-dxgi-video");
  app.commandLine.appendSwitch(
    "disable-features",
    "WindowOcclusionPrediction,CalculateNativeWinOcclusion",
  );
  app.commandLine.appendSwitch(
    "enable-features",
    "VaapiVideoDecoder,CanvasOopRasterization",
  );
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
} else {
  diagLog(
    "[GPU] Safe mode: no aggressive flags. If the radial looks off, try ZENITH_AGGRESSIVE_GPU=1 in .env.local",
  );
}

/**
 * Chromium throttles occluded/background renderers aggressively on Windows.
 * The transparent radial HUD must keep requestAnimationFrame + drag at full rate.
 *
 * `CalculateNativeWinOcclusion` is the critical one and it counts in dev TOO: on a transparent
 * layered window that is hidden/shown/resized on every gesture, Chromium marks it occluded, drops
 * the frames, and the next `show()` presents the old texture (dashboard/island) or a black frame.
 * This reproduces on ANY action (open, close, restore), not only on opening — that is why the
 * coverage handshakes were not enough.
 * Native detection stays off to avoid the stale texture, but the global timer throttling does NOT:
 * `webContents.setBackgroundThrottling(false/true)` already toggles it at the show/hide points,
 * letting the app sleep while it sits in the tray.
 */
if (process.env.ZENITH_AGGRESSIVE_GPU !== "1") {
  /** In aggressive mode `disable-features` already includes these (a repeated appendSwitch replaces the list). */
  app.commandLine.appendSwitch(
    "disable-features",
    "CalculateNativeWinOcclusion,WindowOcclusionPrediction,Translate,AutofillServerCommunication,OptimizationHints,AudioServiceOutOfProcess",
  );
}
diagLog("[Perf] Background throttling dynamically controlled by window visibility.");

// Memory optimization: prioritize low working set for an idle background launcher.
// --lite-mode reduces V8 memory footprint by ~40% (disables JIT tiering, optimizes memory).
// --optimize_for_size reduces V8 bytecode & code cache footprint.
// --max-old-space-size=32 ensures GC triggers well before heap grows.
// --expose-gc exposes global.gc() for cleanups when returning to idle.
app.commandLine.appendSwitch(
  "js-flags",
  "--lite-mode --optimize_for_size --max-old-space-size=32 --expose-gc",
);
// Disable shader disk cache, background networking, component updates to prevent persistent background buffers
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("renderer-process-limit", "1");
// Cap disk and media cache sizes so Chromium does not hold tens of megabytes of offline buffers
app.commandLine.appendSwitch("disk-cache-size", "10485760");
app.commandLine.appendSwitch("media-cache-size", "10485760");

// Fix Taskbar Icon Grouping
app.setName("Rovyl");
app.setAppUserModelId("com.henry.rovyl"); // AUMID explicitly set
// app.setPath("userData", path.join(os.tmpdir(), "zenith-radial-menu-cache")); // REMOVED: tmpdir is not persistent

/**
 * A downloaded update installs on the next LAUNCH, not on the exit that precedes it.
 *
 * `autoInstallOnAppQuit` did it the other way round: quitting spawned the silent NSIS installer
 * behind the app, and the user — who had just closed Rovyl in order to update it — reopened it a
 * couple of seconds later, straight into the middle of that install. The installer's own taskkill
 * killed the instance they had just started (flashing a console window on the way out), the
 * quit-time install relaunches nothing, and the launch looked like it had simply failed. Opening it
 * again once the install had finished worked, which is the whole shape of the bug.
 *
 * Moving the install here removes the race instead of narrowing it: the app is not running yet, the
 * installer has the folder to itself, and `--force-run` opens the new version when it is done. All
 * the running app leaves behind is a note saying which installer is waiting.
 */
const PENDING_UPDATE_FILE = "pending-update.json";

const pendingUpdatePath = () => path.join(app.getPath("userData"), PENDING_UPDATE_FILE);

const readPendingUpdate = () => {
  try {
    const data = JSON.parse(fs.readFileSync(pendingUpdatePath(), "utf8"));
    if (!data || typeof data.version !== "string" || typeof data.installerPath !== "string") {
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
};

const writePendingUpdate = (data) => {
  try {
    fs.writeFileSync(pendingUpdatePath(), JSON.stringify(data), "utf8");
  } catch (e) {
    diagLog(`[Update] Could not record the pending install: ${e.message}`);
  }
};

const clearPendingUpdate = () => {
  try {
    fs.rmSync(pendingUpdatePath(), { force: true });
  } catch (e) {
    /* ignore */
  }
};

/**
 * Is the installer we spawned earlier still working? Two NSIS installs running over the same folder
 * is how an install gets half-applied, and a double-click on the icon is all it takes.
 *
 * Only ever reached when a pending update exists, so the `tasklist` call never lands on a normal
 * startup. No answer counts as "not running": declining to install because `tasklist` did not
 * respond is the worse of the two mistakes.
 */
const isInstallerRunning = (installerPath) => {
  try {
    const name = path.basename(installerPath);
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    return out.toLowerCase().includes(name.toLowerCase());
  } catch (e) {
    return false;
  }
};

/**
 * The window the user looks at while the update installs — and the reason there is one at all.
 *
 * Installing before startup fixed the launch that did nothing, but it did not fix what the launch
 * LOOKED like: click the icon, and for ten seconds absolutely nothing happens. So the app hands the
 * screen over on its way out, to the `update-splash` verb of the native helper —
 * `backend/native-helper/rovyl-helper.cs`, where the class comment has the rest of the reasoning:
 * why the window cannot be a `BrowserWindow`, and how the bar is animated.
 *
 * Helper and logo are COPIED into the temp folder before anything runs. Left where they are, the
 * splash would be holding open two files in the directory being rewritten underneath it — the exact
 * class of lock that makes an update fail silently.
 */
const showUpdateSplash = ({ version, installerPath, installerPid }) => {
  try {
    const helperSource = getNativeHelperExePath();
    if (!helperSource) {
      diagLog("[Update] Native helper not found — installing without a splash");
      return;
    }

    const dir = path.join(os.tmpdir(), "rovyl-update-splash");
    fs.mkdirSync(dir, { recursive: true });

    /**
     * Read-then-write rather than `copyFileSync`: in a packaged build the helper may be read out
     * of `app.asar`, and reads through the archive are the supported way out of it. A splash from
     * a previous update still on screen holds the destination open — in which case the copy already
     * sitting there is the same build, and is exactly what we would have written.
     */
    const helperDest = path.join(dir, "rovyl-splash.exe");
    try {
      fs.writeFileSync(helperDest, fs.readFileSync(helperSource));
    } catch (error) {
      if (!fs.existsSync(helperDest)) throw error;
      diagLog(`[Update] Reusing the splash helper already in temp: ${error.code || error.message}`);
    }

    let logoArg = "";
    try {
      const logo = fs.readFileSync(
        path.join(__dirname, isDev ? "../public/icon.png" : "../dist/icon.png"),
      );
      logoArg = path.join(dir, "icon.png");
      fs.writeFileSync(logoArg, logo);
    } catch (e) {
      /** The wordmark carries the splash on its own. */
      logoArg = "";
    }

    const args = [
      "update-splash",
      "--pid",
      String(installerPid || 0),
      "--name",
      path.basename(installerPath),
    ];
    if (version) args.push("--version", String(version));
    if (logoArg) args.push("--logo", logoArg);

    /**
     * Detached, and this is the one place it works: the helper is a GUI-subsystem binary, so it
     * needs no console, and detaching is what lets it outlive the process that started it.
     */
    const child = spawn(helperDest, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    child.on("error", (error) => diagLog(`[Update] Splash failed: ${error.message}`));
  } catch (error) {
    /** A missing splash is a worse launch, not a failed one. The install does not depend on it. */
    diagLog(`[Update] Splash failed: ${error.message}`);
  }
};

/**
 * Set the moment this process commits to installing rather than starting. `app.whenReady` reads it
 * and builds nothing: no window, no tray, no helper holding open a file the installer is replacing.
 */
let pendingUpdateInstallStarted = false;

/** `true` when an installer now owns the machine and this process is on its way out. */
const installPendingUpdateAndExit = () => {
  if (!isPackagedBuild || process.platform !== "win32" || isStoreBuild()) return false;

  const pending = readPendingUpdate();
  if (!pending) return false;

  const decision = decidePendingUpdate({
    pending,
    currentVersion: app.getVersion(),
    installerExists: () => fs.existsSync(pending.installerPath),
    installerRunning: () => isInstallerRunning(pending.installerPath),
  });

  if (decision.action === "clear") {
    clearPendingUpdate();
    return false;
  }
  if (decision.action === "give-up") {
    diagLog(
      `[Update] ${pending.version} did not install (${decision.reason}) — starting on ${app.getVersion()}`,
    );
    writePendingUpdate({ ...pending, gaveUp: true });
    return false;
  }
  if (decision.action !== "install") {
    diagLog(`[Update] Not installing before startup: ${decision.reason}`);
    return false;
  }

  writePendingUpdate({
    ...pending,
    attempts: (Number(pending.attempts) || 0) + 1,
    lastAttemptAt: Date.now(),
  });

  /**
   * `--updated` tells the NSIS script this is an update and not a first install, `/S` keeps it
   * silent, and `--force-run` is the part the quit-time install was missing: it opens Rovyl again
   * once the files are replaced.
   */
  const installerArgs = ["--updated", "/S", "--force-run"];
  /** Nothing was started: give the launch back to the app. */
  const abortInstall = () => {
    pendingUpdateInstallStarted = false;
    if (app.isReady()) {
      app.relaunch();
      app.exit(0);
    }
  };
  const exitForInstaller = () => {
    try {
      app.exit(0);
    } catch (e) {
      process.exit(0);
    }
  };

  let child;
  try {
    child = spawn(pending.installerPath, installerArgs, { detached: true, stdio: "ignore" });
  } catch (error) {
    diagLog(`[Update] Could not start the installer: ${error.message}`);
    return false;
  }

  /**
   * The exit waits for the spawn to be confirmed. `spawn` reports failure on the next tick, and
   * exiting synchronously would throw away the one chance to retry through `elevate.exe`.
   */
  child.once("spawn", () => {
    showUpdateSplash({
      version: pending.version,
      installerPath: pending.installerPath,
      installerPid: child.pid,
    });
    exitForInstaller();
  });
  child.once("error", (error) => {
    diagLog(`[Update] Installer spawn failed (${error.code || "?"}): ${error.message}`);
    /**
     * A per-machine install needs elevation, and CreateProcess refuses outright instead of
     * prompting. `elevate.exe` ships beside the app for exactly this — it is what electron-updater
     * reaches for on the same two error codes.
     */
    if (error.code === "UNKNOWN" || error.code === "EACCES") {
      try {
        spawn(path.join(process.resourcesPath, "elevate.exe"), [pending.installerPath, ...installerArgs], {
          detached: true,
          stdio: "ignore",
        }).unref();
        /** No pid worth passing — elevate.exe is not the installer. The splash watches the name. */
        showUpdateSplash({ version: pending.version, installerPath: pending.installerPath });
        exitForInstaller();
      } catch (e) {
        diagLog(`[Update] elevate.exe failed too: ${e.message}`);
        abortInstall();
      }
      return;
    }
    /**
     * Nothing is installing, so exiting now would reproduce the bug this whole path exists to fix:
     * a click that opens nothing. Start the app instead — `whenReady` has not resolved yet at this
     * point, and if it somehow has, only a restart can still build a window.
     */
    abortInstall();
  });
  child.unref();

  diagLog(`[Update] Installing ${pending.version} before startup`);
  pendingUpdateInstallStarted = true;
  return true;
};

/**
 * Did Windows start this copy at login, or did a person open it?
 *
 * `getLoginItemSettings().wasOpenedAtLogin` is documented macOS-only — on Windows it never comes
 * back true, so the answer has to travel with the launch itself. `syncLoginItemSettings` registers
 * the Run entry WITH this argument, which is what makes reading it back here authoritative.
 */
const LOGIN_LAUNCH_ARG = "--opened-at-login";
const startedAtLogin = process.argv.includes(LOGIN_LAUNCH_ARG);

// Single instance: prevents two Zenith processes when login startup is slow and the user launches manually.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  diagLog("Second instance blocked — another Zenith is already running; exiting.");
  app.quit();
} else if (installPendingUpdateAndExit()) {
  /**
   * Deliberately empty. The installer is running and this process exits as soon as the spawn is
   * confirmed; registering `second-instance` would only hand it a window it is never going to have.
   *
   * After the lock, not before: when Rovyl is already open a launch is a second instance asking for
   * focus, and it must not start an installer over the running app.
   */
} else {
  app.on("second-instance", () => {
    diagLog("Second instance launch detected — focusing existing window.");
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        windowBuriedPassive = false;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.setOpacity(1);
        applyMousePolicyAfterReveal(mainWindow);
        mainWindow.setSkipTaskbar(false);
        mainWindow.show();
        mainWindow.focus();
      } catch (e) {
        console.error("second-instance focus failed:", e);
      }
    }
  });
}

// Remove default menus (File, Edit, etc.)
Menu.setApplicationMenu(null);

// Keep normal priority: PRIORITY_HIGH starves other apps and makes the whole OS feel sluggish.
try {
  os.setPriority(os.constants.priority.PRIORITY_NORMAL);
} catch (e) {
  console.error("Failed to set priority:", e);
}

let settingsWindow = null;

// Game Mode Configuration Storage (merged from renderer; keep defaults for missing keys)
let gameModeConfig = {
  enabled: false,
  mode: "list",
  blockedApps: "",
  autoDetectGames: false,
};

function mergeGameModeConfig(gm) {
  if (!gm || typeof gm !== "object") return;
  let blocked = "";
  if (typeof gm.blockedApps === "string") blocked = gm.blockedApps;
  else if (Array.isArray(gm.blockedApps)) {
    blocked = gm.blockedApps.map((s) => String(s).trim()).filter(Boolean).join(", ");
  }
  gameModeConfig = {
    enabled: !!gm.enabled,
    mode: gm.mode === "all" ? "all" : "list",
    blockedApps: blocked,
    autoDetectGames: !!gm.autoDetectGames,
  };
}

/** Full persistence blob is `{ config: UIConfig, ... }`; older saves may be flat. */
function extractUiConfigFromPersistenceBlob(blob) {
  if (!blob || typeof blob !== "object") return null;
  if (blob.config && typeof blob.config === "object") return blob.config;
  return blob;
}

// Window Management Persistence — compact desktop panel, not a full-screen dashboard.
/**
 * 720×540 left ~430px of content after the navigation and the padding: Settings looked like
 * thumbnails inside a big rect. 880×600 gives a content column of ~565px (236px of navigation +
 * padding) — the width the type scale (13px label / 11.5px description) was drawn for — without
 * turning into a dashboard.
 * It still fits at 175% Windows scaling on 1080p
 * thanks to the clamp in `windowedBoundsForWorkArea`.
 */
const DEFAULT_WINDOWED_WIDTH = 880;
const DEFAULT_WINDOWED_HEIGHT = 600;
let lastWindowedBounds = {
  width: DEFAULT_WINDOWED_WIDTH,
  height: DEFAULT_WINDOWED_HEIGHT,
  x: 100,
  y: 100,
};
let isUpdatingBounds = false;

/** The island (`small` mode + hit-shape) shrinks the HWND — do not save that as "normal window" or the dashboard opens in a tiny rect. */
const MIN_REASONABLE_WINDOWED_W = 480;
const MIN_REASONABLE_WINDOWED_H = 360;

/**
 * Default windowed rect, centred and always inside the work area.
 * `workArea` already comes in DIPs, so this covers 100/125/150/175% Windows scaling:
 * at 175% on 1080p the usable area is around 1097×583 DIPs and the rect shrinks instead of
 * running off the screen.
 */
function windowedBoundsForWorkArea() {
  try {
    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.min(DEFAULT_WINDOWED_WIDTH, Math.max(MIN_REASONABLE_WINDOWED_W, workArea.width - 80));
    const h = Math.min(DEFAULT_WINDOWED_HEIGHT, Math.max(MIN_REASONABLE_WINDOWED_H, workArea.height - 80));
    return {
      x: Math.round(workArea.x + (workArea.width - w) / 2),
      y: Math.round(workArea.y + (workArea.height - h) / 2),
      width: w,
      height: h,
    };
  } catch (e) {
    return {
      x: 100,
      y: 100,
      width: DEFAULT_WINDOWED_WIDTH,
      height: DEFAULT_WINDOWED_HEIGHT,
    };
  }
}

function resetLastWindowedBoundsIfIslandCorrupted() {
  const b = lastWindowedBounds;
  if (
    b &&
    b.width >= MIN_REASONABLE_WINDOWED_W &&
    b.height >= MIN_REASONABLE_WINDOWED_H
  ) {
    return;
  }
  lastWindowedBounds = windowedBoundsForWorkArea();
}
/**
 * Renderer "hide-window" leaves the window technically visible but opacity 0 + mouse passthrough.
 * If the user later focuses Zenith from the taskbar / Alt+Tab, no IPC runs — they see a blank / dead window.
 * We recover on focus/restore when this flag is set.
 */
let windowBuriedPassive = false;

/** Settings is always interactive when it is on screen; the wheel's window answers for itself. */
function applyMousePolicyAfterReveal(win) {
  const w = win || mainWindow;
  if (!w || w.isDestroyed()) return;
  try {
    w.setIgnoreMouseEvents(false);
  } catch (e) {
    /* ignore */
  }
}

let isAppQuitting = false;
/**
 * Stop the trigger on shutdown — and this is an UPDATE requirement, not hygiene.
 *
 * The trigger's PowerShell process lives inside the install folder. If it survives the app closing,
 * it keeps a handle open on `mouse-blocker.ps1`, the NSIS installer cannot replace the files, and
 * the update fails silently: on the next startup the app finds the same new version and offers it
 * again. Forever.
 *
 * The function lives inside `app.whenReady`; this reference is how `will-quit` reaches it.
 */
let stopMouseHookForShutdown = () => {};
/**
 * The trigger is off for as long as Settings is asking which button to bind to.
 *
 * It has to be: the hook SWALLOWS the bound button system-wide, so with it armed the recorder
 * could never be shown the button it is about to replace — pressing the wheel button over the
 * recorder would open the wheel instead of being recorded. Same shape as the keyboard side's
 * `pauseGlobalShortcut`, and the same guarantee: it is one flag, so the resume puts the trigger
 * back to whatever the config says rather than to whatever it happened to be.
 */
let mouseTriggerRecordingPaused = false;
/** One teardown guard per renderer, so a session of repeated recordings does not stack listeners. */
const mouseTriggerResumeGuards = new WeakSet();
let triggerRadialShortcut = () => {};
let releaseRadialShortcut = () => {};
let onNativeRecordMouse = null;
let lastRecordedKeyboardModifiers = {
  CTRL: false,
  ALT: false,
  SHIFT: false,
  META: false,
};

let updateInstallInProgress = false;
/** Ensures renderer runs saveFullConfigSync before exit (tray "Quit" / OS shutdown paths). */
let zenithQuitFlushStarted = false;
/**
 * Set to `true` immediately before calling `app.exit(0)` in the import handler. It stops
 * `before-quit` from sending `zenith-before-quit-flush` to the renderer — which still holds the
 * PRE-import state in memory and would overwrite the backup just written to disk.
 */
let skipQuitFlushForImport = false;

app.on("before-quit", (event) => {
  isAppQuitting = true;
  // `quitAndInstall` must not be delayed by the normal renderer persistence handshake.
  if (updateInstallInProgress) {
    return;
  }
  if (zenithQuitFlushStarted) {
    return;
  }
  const w = mainWindow;
  if (!w || w.isDestroyed()) {
    return;
  }
  // Import: the backup is already on disk — do not let the renderer overwrite it with old state.
  if (skipQuitFlushForImport) {
    diagLog("[Quit] Skipping renderer flush — import in progress, backup on disk is authoritative");
    return;
  }
  event.preventDefault();
  zenithQuitFlushStarted = true;

  let finished = false;
  let timeoutId = null;
  const finishExit = () => {
    if (finished) return;
    finished = true;
    if (timeoutId != null) clearTimeout(timeoutId);
    app.exit(0);
  };

  timeoutId = setTimeout(() => {
    diagLog("[Quit] Persistence flush timeout — exiting");
    finishExit();
  }, 12000);

  ipcMain.once("zenith-quit-flush-ack", finishExit);

  try {
    w.webContents.send("zenith-before-quit-flush");
  } catch (e) {
    diagLog(`[Quit] Flush IPC failed: ${e.message}`);
    finishExit();
  }
});

// Shortcut Recording State
let keyboardListener = null;
let recordingActive = false;

function startShortcutRecording() {
  lastRecordedKeyboardModifiers = { CTRL: false, ALT: false, SHIFT: false, META: false };
  ensureRadialMouseBlocker();
  writeRadialMouseBlocker("RECORD ON");

  onNativeRecordMouse = (buttonName, modMask) => {
    if (!recordingActive) return;
    const formattedModifiers = [];
    const ctrl = !!(modMask & 1) || lastRecordedKeyboardModifiers.CTRL;
    const alt = !!(modMask & 2) || lastRecordedKeyboardModifiers.ALT;
    const shift = !!(modMask & 4) || lastRecordedKeyboardModifiers.SHIFT;
    const meta = !!(modMask & 8) || lastRecordedKeyboardModifiers.META;

    if (ctrl) formattedModifiers.push("Ctrl");
    if (alt) formattedModifiers.push("Alt");
    if (shift) formattedModifiers.push("Shift");
    if (meta) formattedModifiers.push("Super");

    const shortcutString = [...formattedModifiers, buttonName].join("+");
    diagLog(`[ShortcutRecord] Mouse shortcut recorded: ${shortcutString}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToSettings("shortcut-recorded", shortcutString);
    }
  };

  if (keyboardListener) return;

  keyboardListener = new GlobalKeyboardListener();
  recordingActive = true;

  keyboardListener.addListener((e, down) => {
    if (!recordingActive) return;
    const modifiers = {
      CTRL: false,
      ALT: false,
      SHIFT: false,
      META: false,
    };
    if (down && typeof down === "object") {
      Object.keys(down).forEach((keyName) => {
        if (keyName.includes("CTRL")) modifiers.CTRL = true;
        if (keyName.includes("ALT")) modifiers.ALT = true;
        if (keyName.includes("SHIFT")) modifiers.SHIFT = true;
        if (keyName.includes("META") || keyName.includes("WINDOWS"))
          modifiers.META = true;
      });
    }
    lastRecordedKeyboardModifiers = modifiers;

    if (e.state === "DOWN") {
      // Extract the main key
      let key = e.name;

      // Ignore lone modifiers (don't record if ONLY Ctrl is pressed)
      if (
        [
          "LEFT CTRL",
          "RIGHT CTRL",
          "LEFT ALT",
          "RIGHT ALT",
          "LEFT SHIFT",
          "RIGHT SHIFT",
          "LEFT META",
          "RIGHT META",
          "WINDOWS",
        ].includes(key)
      ) {
        return;
      }

      const formattedModifiers = [];
      if (modifiers.CTRL) formattedModifiers.push("Ctrl");
      if (modifiers.ALT) formattedModifiers.push("Alt");
      if (modifiers.SHIFT) formattedModifiers.push("Shift");
      if (modifiers.META) formattedModifiers.push("Super"); // Map Win key to Super for Electron compatibility

      // Key name normalization for Zenith format
      if (key === "SPACE") key = "Space";
      if (key === "ESCAPE") key = "Escape";
      if (key.length === 1) key = key.toUpperCase();

      // Handle Function keys F1-F12 (they come in as F1, F2...)

      const shortcutString = [...formattedModifiers, key].join("+");

      if (mainWindow && !mainWindow.isDestroyed()) {
        sendToSettings("shortcut-recorded", shortcutString);
      }
    }
  });
}

function stopShortcutRecording() {
  recordingActive = false;
  onNativeRecordMouse = null;
  writeRadialMouseBlocker("RECORD OFF");
  if (keyboardListener) {
    keyboardListener.kill();
    keyboardListener = null;
  }
}

async function createWindow() {
  /** Centred and clamped to the work area — never larger than the screen at high Windows scaling. */
  const initialBounds = windowedBoundsForWorkArea();
  /** Settings only ever has this rect; line the tracker up with it before the first `resize`. */
  lastWindowedBounds = { ...initialBounds };
  const newWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    /**
     * Frameless but OPAQUE, with the standard resize frame (`thickFrame` defaults on). Windows only
     * gives Snap, drag-to-top maximize, Snap Layouts and a real maximize to a window that has that
     * frame, and Electron strips it from every transparent window — transparency here bought the
     * 12px CSS corners and cost all of that. Windows 11 rounds this window itself; Windows 10
     * draws it square, like every other window on Windows 10.
     */
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    show: false,
    fullscreen: false,
    hasShadow: true,
    icon: isDev
      ? path.join(__dirname, "../public/icon.png")
      : path.join(__dirname, "../dist/icon.png"),
    /** What shows in a strip the renderer has not painted yet while resizing; the renderer
     *  swaps it for the light theme's colour (`set-window-background`). */
    backgroundColor: "#151515",
    backgroundMaterial: "none",
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
      spellcheck: false,
      // Let Chromium fully suspend animation/timers while the transparent window is hidden.
      // Keeping an invisible renderer at full frame rate can contend with high-polling-rate mice.
      backgroundThrottling: true,
    },
  });

  // Close → hide to tray (unless app.quit() is in progress — then allow real close).
  // Without syncing React (window-hid-to-tray), the renderer still thinks the dashboard is open;
  // reopening from the tray skips showWindow and hit-testing stays broken in the old window rect.
  newWindow.on("close", (event) => {
    if (isAppQuitting) {
      return;
    }
    if (newWindow.isVisible()) {
      event.preventDefault();
      // Notify renderer before native hide so it can sync-save while webContents is still fully alive.
      try {
        if (
          !newWindow.isDestroyed() &&
          newWindow.webContents &&
          !newWindow.webContents.isDestroyed()
        ) {
          newWindow.webContents.send("window-hid-to-tray");
        }
      } catch (e) {
        /* ignore */
      }
      newWindow.hide();
      newWindow.setSkipTaskbar(true);
    }
  });

  // Setup window content immediately to trigger loading -> ready-to-show
  setupMainWindow(newWindow);

  return new Promise((resolve) => {
    newWindow.once("ready-to-show", () => {
      // Phase 1: Stabilization Delay (200ms)
      // Chromium on Windows often needs a few frames to stabilize the transparent compositor
      setTimeout(() => {
        console.log("Main window ready (stabilized)");
        scheduleIdleMemoryCleanup(3500);
        resolve(newWindow);
      }, 200);
    });

    /** Track bounds for persistence. Maximized is not a size the user chose to come back to. */
    newWindow.on("resize", () => {
      if (
        !newWindow.isFullScreen() &&
        !newWindow.isMaximized() &&
        !isUpdatingBounds
      ) {
        lastWindowedBounds = {
          ...lastWindowedBounds,
          ...newWindow.getBounds(),
        };
      }
    });

    newWindow.on("move", () => {
      if (
        !newWindow.isFullScreen() &&
        !newWindow.isMaximized() &&
        !isUpdatingBounds
      ) {
        lastWindowedBounds = {
          ...lastWindowedBounds,
          ...newWindow.getBounds(),
        };
      }
    });
  });
}

/**
 * Recover from passive overlay state when the OS brings the window forward without renderer IPC.
 * Also fixes transparent frameless windows on Windows after minimize → restore (hit-testing desync).
 */
function attachWindowUserRestoreGuards(window) {
  const recoverPassiveBurialOnly = () => {
    if (!window || window.isDestroyed() || !windowBuriedPassive) return;
    try {
      window.setOpacity(1);
      applyMousePolicyAfterReveal(window);
      window.setSkipTaskbar(false);
      windowBuriedPassive = false;
      diagLog("[Window] Recovered from passive hide (focus — taskbar or Alt+Tab).");
    } catch (e) {
      diagLog(`[Window] recoverPassiveBurialOnly: ${e.message}`);
    }
  };

  const onRestore = () => {
    if (!window || window.isDestroyed()) return;
    /** Restoring from tray/minimize with the renderer still throttled exposes the stale texture. */
    try {
      if (typeof window.webContents?.setBackgroundThrottling === "function") {
        window.webContents.setBackgroundThrottling(false);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (windowBuriedPassive) {
        window.setOpacity(1);
        applyMousePolicyAfterReveal(window);
        window.setSkipTaskbar(false);
        windowBuriedPassive = false;
        diagLog("[Window] Recovered from passive hide (restore).");
        return;
      }
      if (window.isVisible() && !window.isMinimized()) {
        window.setOpacity(1);
        window.setIgnoreMouseEvents(false);
        window.setSkipTaskbar(false);
      }
    } catch (e) {
      diagLog(`[Window] onRestore refresh: ${e.message}`);
    }
  };

  window.on("restore", onRestore);
  window.on("focus", recoverPassiveBurialOnly);
}

function setupMainWindow(window) {
  /**
   * Settings is an ordinary window and does not float.
   *
   * It used to be pinned at `screen-saver` level because the same HWND had to serve as the wheel's
   * always-on-top desktop overlay, and `updateWindowSize('windowed')` dropped it again on every
   * transition. The wheel has its own window now, so this one behaves like any other app window —
   * it goes behind what you click on, which is what every user already expects it to do.
   */
  window.setAlwaysOnTop(false);

  // Send windowing events to React
  window.on("maximize", () =>
    window.webContents.send("window-state", "maximized"),
  );
  window.on("unmaximize", () =>
    window.webContents.send("window-state", "windowed"),
  );

  if (isDev) {
    console.log("DEBUG: Loading URL http://localhost:5173");
    window.loadURL("http://localhost:5173");
  } else {
    console.log(
      "DEBUG: Loading file " + path.join(__dirname, "../dist/index.html"),
    );
    window.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Add error handling
  window.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      diagLog(
        `Renderer Failed to Load: Code ${errorCode} - ${errorDescription}`,
      );
      console.error(
        `DEBUG: Failed to load content: ${errorCode} - ${errorDescription}`,
      );
    },
  );

  window.webContents.on("crashed", (event, killed) => {
    diagLog(`Renderer process crashed. Killed: ${killed}`);
    console.error(`DEBUG: Renderer process crashed. Killed: ${killed}`);
  });

  window.webContents.on("render-process-gone", (event, details) => {
    diagLog(
      `Renderer process gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`,
    );
    console.error(
      `DEBUG: Renderer process gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`,
    );
    /**
     * Nothing downstream of here closes the wheel: the renderer owned that, and it is gone. Every
     * other global side effect of an open wheel is released on a close path the renderer drives,
     * so this is the only place left to release them.
     */
    clearRadialMouseBlocking();
    releaseRadialCursor();
  });

  window.webContents.on("did-finish-load", () => {
    diagLog("Renderer: Content finished loading successfully");
    console.log("DEBUG: Content finished loading successfully");
    // A reload starts React on "windowed"; tell it the truth so the maximized styling matches the window.
    if (window.isMaximized()) window.webContents.send("window-state", "maximized");
  });

  // IPC handler for renderer process logs
  ipcMain.on("renderer-log", (event, level, message, ...args) => {
    // In production, only log warnings and errors to save performance
    if (!isDev && level !== "warn" && level !== "error") return;
    diagLog(`RENDERER [${level.toUpperCase()}]: ${message} ${args.join(" ")}`);
  });

  // Open dev tools
  // window.webContents.openDevTools();

  // DISABLED FOR DEBUG: window.setIgnoreMouseEvents(true, { forward: true });

  attachWindowUserRestoreGuards(window);

  /** Syncs island/panel in the renderer: minimized ≠ panel “visible” (React keeps the dashboard open). */
  const sendMainWindowMinimizedState = () => {
    if (window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send("main-window-minimized", {
        minimized: window.isMinimized(),
      });
    } catch (e) {
      /* ignore */
    }
  };
  window.on("minimize", sendMainWindowMinimizedState);
  window.on("restore", () => {
    if (window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) return;
    const win = window;
    setImmediate(() => {
      if (win.isDestroyed()) return;
      sendMainWindowMinimizedState();
    });
  });

  /**
   * Get the wheel's idle box off Settings for as long as Settings is there. See
   * `overlayParkedBounds` — two topmost layered surfaces over the same pixels is a composition the
   * DWM is entitled to get wrong, and one of them has nothing to draw.
   *
   * These four events are the whole truth about whether the panel occupies screen space, including
   * the paths that never go through `openSettingsFromMainProcess`: the tray, Alt+Tab, the taskbar
   * button, and the close-to-tray in `createWindow`.
   */
  for (const event of ["show", "hide", "minimize", "restore"]) {
    window.on(event, () => syncOverlayParkedForSettings(window));
  }
}

let radialOpenPaintSequence = 0;

/* zenith-verify:radial-handshake-main — open-menu → radial-open-paint-done → show; see scripts/verify-radial-windowing.mjs */

/**
 * The wheel's window.
 *
 * Everything below used to be entangled with Settings because both drew into one HWND. What that
 * cost is worth writing down, because it is all gone: a `prepare-radial-show` /
 * `radial-prep-paint-done` handshake to get the panel off the compositor before the window could
 * move; a `nativeResizeRisk` test and a hide-before-resize; a `keepExistingPanelWindow` path that
 * drew the wheel in Settings' client coordinates and so quietly ignored the monitor the user asked
 * for; a panel rect shipped in `open-menu` and remapped in the renderer; and a three-mode
 * (`small`/`windowed`/`fullscreen`) state machine on a single window. None of it was ever about the
 * wheel. It was about sharing.
 *
 * This window has painted exactly one thing since it was created, so moving it, resizing it and
 * showing it expose nothing — there is no other texture for the DWM to present.
 */
let overlayWindow = null;
let overlayWindowCreation = null;
/** The wheel is on screen and taking the mouse. */
let radialOpen = false;

/**
 * Where the idle box waits while Settings is on screen: just past the right edge of the desktop.
 *
 * The idle overlay is a ~988px transparent square, topmost, parked over the middle of the display
 * for the whole life of the app. Over the bare desktop that is free and invisible, which is the
 * trade the comment above describes. Over ANOTHER of our own windows it is not: Settings opens
 * underneath it, and the DWM then has to compose an 880×600 layered panel through a 988×988
 * layered surface sitting on top of it. On some machines that reads as a dark square around the
 * panel — centred on it, wider than it on every side, click-through, and impossible to attribute
 * to Settings, because nothing Settings draws can paint outside its own window.
 *
 * Moving rather than hiding is the escape hatch "Stable idle" already names: the surface stays
 * composed and warm, so the open handshake and its first frame are untouched. It is parked
 * ADJACENT to the desktop union rather than far away for the same reason — far enough that no
 * monitor arrangement can see it, near enough that Windows has no new reason to call it occluded.
 */
function overlayParkedBounds(side) {
  let right = -Infinity;
  let top = Infinity;
  for (const display of screen.getAllDisplays()) {
    right = Math.max(right, display.bounds.x + display.bounds.width);
    top = Math.min(top, display.bounds.y);
  }
  if (!Number.isFinite(right) || !Number.isFinite(top)) {
    right = 0;
    top = 0;
  }
  return { x: Math.round(right) + 32, y: Math.round(top), width: side, height: side };
}

/** True while Settings occupies screen space the idle overlay would otherwise sit on top of. */
let overlayParkedForSettings = false;

/**
 * Idle geometry: the box the next wheel will use, on the monitor it will use, already in place —
 * unless Settings is on screen, in which case it waits off the desktop instead.
 *
 * Kept VISIBLE and click-through rather than hidden — the same trade the old `small` mode made, and
 * for the same reason: a hidden transparent window has no warm surface, so the first frame after
 * `show()` is whatever the DWM last held. Since the mouse is ignored, a transparent box over the
 * desktop blocks nothing.
 */
function applyOverlayIdleBounds(anchorScreenPoint, targetWindow) {
  /** `targetWindow` is for the one caller that runs before `overlayWindow` has been assigned. */
  const win = targetWindow || overlayWindow;
  if (!win || win.isDestroyed()) return;
  const targetDisplay = radialTargetDisplay(anchorScreenPoint);
  const onScreen = smallModeBounds(targetDisplay.bounds);
  const next = overlayParkedForSettings
    ? overlayParkedBounds(onScreen.width)
    : onScreen;
  try {
    if (!boundsApproxEqual(win.getBounds(), next)) win.setBounds(next);
  } catch (e) {
    /* ignore */
  }
}

/**
 * Settings came on screen, or left it. Driven by the window's own `show`/`hide`/`minimize`/
 * `restore` events rather than by each of the several call sites that open and close the panel —
 * there are four ways in and three ways out, and one of them forgetting to say so is a dark square
 * nobody can trace back to this.
 */
function syncOverlayParkedForSettings(settingsWindow) {
  /**
   * The event's own window, not the module's `mainWindow`.
   *
   * These listeners are attached inside `setupMainWindow`, which runs while `createWindow` is still
   * being awaited — `mainWindow` is not assigned until 200ms after `ready-to-show`, so an early
   * `show` reading the global would find `null` and conclude the panel is not on screen.
   */
  const win = settingsWindow || mainWindow;
  let onScreen = false;
  try {
    onScreen = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  } catch (e) {
    onScreen = false;
  }
  if (overlayParkedForSettings === onScreen) return;
  overlayParkedForSettings = onScreen;
  diagLog(
    onScreen
      ? "[Overlay] parked off-desktop (Settings on screen)"
      : "[Overlay] back to the idle box (Settings off screen)",
  );
  /**
   * An OPEN wheel owns its own bounds — it is the thing the user is looking at, and it is allowed
   * to be over Settings. `collapseOverlayToIdle` runs `applyOverlayIdleBounds` on the way back, so
   * the park lands the moment the wheel is done.
   */
  if (radialOpen) return;
  applyOverlayIdleBounds();
}

/** Back to an invisible, click-through box on the desktop. */
function collapseOverlayToIdle(anchorScreenPoint) {
  const wasOpen = radialOpen;
  radialOpen = false;
  clearRadialMouseBlocking();
  releaseRadialCursor();
  /** Nobody is reading the dock with no wheel on screen: the poll stops until the next open. */
  systemStatus.setWatching(false);
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayWindow.setIgnoreMouseEvents(true);
    applyOverlayIdleBounds(anchorScreenPoint);
    overlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
    overlayWindow.webContents.setBackgroundThrottling(true);
  } catch (e) {
    /* ignore */
  }
  if (wasOpen) diagLog("[RadialClose] wheel closed; overlay back to idle");
  scheduleIdleMemoryCleanup(2000);
}

async function createOverlayWindow() {
  const targetDisplay = radialTargetDisplay();
  const idle = smallModeBounds(targetDisplay.bounds);
  /**
   * Born parked when Settings is already up — which is the ordinary first run, where the panel is
   * on screen before this window is created at all. Without this the very first idle box lands on
   * top of it and stays there until the first wheel closes.
   */
  const initial = overlayParkedForSettings ? overlayParkedBounds(idle.width) : idle;
  const win = new BrowserWindow({
    ...initial,
    frame: false,
    transparent: true,
    /** Never in the taskbar or Alt+Tab: this window is a gesture, not a place you go back to. */
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: "#00000000",
    backgroundMaterial: "none",
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver", 1);
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    /* ignore */
  }
  /** Idle is click-through; the open sets this false and the close puts it back. */
  win.setIgnoreMouseEvents(true);

  if (isDev) {
    win.loadURL("http://localhost:5173/radial.html");
  } else {
    win.loadFile(path.join(__dirname, "../dist/radial.html"));
  }

  /**
   * The wheel's window has to say when it is broken.
   *
   * `ready-to-show` fires for a document that loaded and painted nothing, so a renderer that failed
   * to boot looks exactly like a healthy idle overlay: transparent, parked, silent. The only visible
   * symptom would be a gesture that does nothing at all, with nothing in the log to say why.
   */
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    diagLog(`[Overlay] Renderer failed to load: ${errorCode} — ${errorDescription}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    diagLog(`[Overlay] Renderer process gone: ${details?.reason}`);
    /** Whatever was drawing the dock is gone, so nothing is reading the poll it asked for. */
    systemStatus.setWatching(false);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    diagLog(`[Overlay] Preload error at ${preloadPath}: ${error?.message}`);
  });

  win.on("closed", () => {
    if (overlayWindow === win) {
      overlayWindow = null;
      radialOpen = false;
    }
  });

  await new Promise((resolve) => {
    win.once("ready-to-show", () => {
      /**
       * Show it once, immediately and transparent, so the surface is warm and composed before the
       * first gesture ever asks for it. This is the whole reason the idle window exists.
       */
      try {
        /**
         * Settings can have appeared or gone during the load — `overlayWindow` is not assigned yet,
         * so the `show`/`hide` sync above found nothing to move. Place the box for the state that
         * is true now, BEFORE the first `showInactive`: parked or not, it must never be seen
         * arriving over the panel.
         */
        applyOverlayIdleBounds(undefined, win);
        win.showInactive();
        win.webContents.setBackgroundThrottling(true);
      } catch (e) {
        /* ignore */
      }
      try {
        diagLog(
          `[Overlay] Stable idle: transparent wheel surface and mouse passthrough at ${JSON.stringify(
            win.getBounds(),
          )}`,
        );
      } catch (e) {
        /* diagnostic only */
      }
      resolve();
    });
  });

  return win;
}

async function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  if (!overlayWindowCreation) {
    overlayWindowCreation = createOverlayWindow().finally(() => {
      overlayWindowCreation = null;
    });
  }
  const win = await overlayWindowCreation;
  overlayWindow = win;
  return win;
}

/**
 * Settings' renderer, when it is alive.
 *
 * The counterpart of `sendToOverlay`. Every renderer-bound message now names the window it is for:
 * with one HWND that question did not exist, and with two, getting it wrong is a message delivered
 * to a document that does not listen for it — silent, and invisible until somebody uses the feature.
 */
function sendToSettings(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch (e) {
    return false;
  }
}

/** Whatever is alive to receive the wheel's own channels. */
function overlayWebContents() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  const wc = overlayWindow.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function sendToOverlay(channel, payload) {
  const wc = overlayWebContents();
  if (!wc) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Open the wheel.
 *
 * Position first (the window is transparent and click-through, so nobody can see or touch it
 * moving), then hand the renderer the geometry it needs, wait for it to confirm one painted frame,
 * and only then take the mouse and come to the front.
 *
 * This function owns the wheel's screen point — the centre of the target display, or the pointer
 * when `radialPlacement` is `cursor`. Everything downstream is derived from it: the window box
 * around it, the taskbar screen, the parked cursor, and the `clientPosition` the renderer draws at.
 */
function showMenuAtCursor(source = "shortcut") {
  void ensureOverlayWindow().then((win) => {
    if (!win || win.isDestroyed()) return;
    cancelIdleMemoryCleanup();
    const radialOpenStartedAt = Date.now();

    /**
     * One reading of the pointer, used for both answers. Asking twice would let the hand move
     * between them and put the wheel on a screen its own centre is not on.
     */
    const cursorPoint = radialOpensAtCursor ? currentCursorPoint() : null;
    const targetDisplay = radialTargetDisplay(cursorPoint ?? undefined);
    const radialCenter = radialOpenCenter(targetDisplay.bounds, cursorPoint);
    const bounds = radialOpenBounds(targetDisplay, radialCenter);

    try {
      if (!boundsApproxEqual(win.getBounds(), bounds)) win.setBounds(bounds);
    } catch (e) {
      /* ignore */
    }

    setRadialMouseBlocking(bounds, targetDisplay.bounds);
    /**
     * The system dock is about to be on screen, so its readouts start following the machine. With
     * the dock switched off there is no helper and this is a no-op — deliberately: it must never
     * be the thing that starts a process on the way into a gesture.
     */
    systemStatus.setWatching(true);

    /**
     * Park the pointer BEFORE `open-menu`: the first sample the renderer uses has to be the centre
     * one already, or the gesture is born pointing wherever the hand happened to be.
     *
     * MMB in hold mode is left out — that gesture executes on release and its aim comes from the
     * main-process polling, which starts at the point where the button was pressed.
     */
    if (source !== "mmb") captureRadialCursor(radialCenter);

    const wc = overlayWebContents();
    if (!wc) return;
    try {
      wc.setBackgroundThrottling(false);
    } catch (e) {
      /* ignore */
    }

    radialOpen = true;

    const paintToken = ++radialOpenPaintSequence;
    let revealStarted = false;
    let paintTimeout = null;
    let onRadialPaint = null;

    const reveal = () => {
      if (revealStarted) return;
      revealStarted = true;
      if (paintTimeout) clearTimeout(paintTimeout);
      if (onRadialPaint) ipcMain.removeListener("radial-open-paint-done", onRadialPaint);

      setImmediate(() => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;
        /** A close that landed inside the handshake must not be undone by its own reveal. */
        if (!radialOpen) return;
        try {
          overlayWindow.setIgnoreMouseEvents(false);
          overlayWindow.setOpacity(1);
          if (!overlayWindow.isVisible()) overlayWindow.showInactive();
          overlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
          overlayWindow.focus();
          overlayWindow.webContents.focus();
        } catch (e) {
          /* ignore */
        }

        /** `focus()` is a request Windows may refuse; this is what makes it stick. */
        stealForegroundForOverlay();

        /**
         * The renderer prepared the wheel at zero alpha. Releasing the bloom only after the window
         * is taking the mouse guarantees the first frame the DWM gets is transparent, never half an
         * animation.
         */
        const releaseAnimationTimer = setTimeout(() => {
          sendToOverlay("radial-native-revealed", paintToken);
        }, 16);
        releaseAnimationTimer.unref?.();

        try {
          diagLog(
            `[RadialOpen] reveal latency=${Date.now() - radialOpenStartedAt}ms bounds=${JSON.stringify(
              overlayWindow.getBounds(),
            )} centerScreen=${JSON.stringify(radialCenter)}`,
          );
        } catch (e) {
          /* diagnostic only */
        }
      });
    };

    onRadialPaint = (_event, acknowledgedToken) => {
      if (acknowledgedToken !== paintToken) return;
      reveal();
    };
    ipcMain.on("radial-open-paint-done", onRadialPaint);
    /** Fallback only: the normal path acknowledges after the next painted animation frame. */
    paintTimeout = setTimeout(reveal, 120);
    paintTimeout.unref?.();

    try {
      wc.send("open-menu", {
        source,
        /** Do not rely on window.screenX/Y on the first tick after setBounds. */
        clientPosition: {
          x: radialCenter.x - bounds.x,
          y: radialCenter.y - bounds.y,
        },
        windowOrigin: { x: bounds.x, y: bounds.y },
        clientSize: { width: bounds.width, height: bounds.height },
        paintToken,
      });
    } catch (e) {
      reveal();
    }
  });
}

/** Main took the wheel down without the renderer asking — game mode, quit, a gesture that never landed. */
function forceCloseRadial() {
  if (!radialOpen) return;
  sendToOverlay("radial-hidden");
  collapseOverlayToIdle();
}

/**
 * In `small` there is nothing to draw, but the HWND is NOT hidden or shrunk: `smallModeBounds`
 * keeps it at the radial's bounds (988×988, centred) and visible — see "Stable idle" further down,
 * which trades that for not needing hide/show or a resize on open. This comment described the old
 * behaviour and went on lying through several lag investigations; the previous wording was "the
 * HWND shrinks into the corner and is hidden".
 *
 * The risk the old text described is real but it is a COMPOSITION one (DWM/MPO), not input: a
 * topmost layered window the size of the monitor makes it compose on every frame. Measured on this
 * machine, the 988×988 box at idle does not move the `dwm` needle (4.5% -> 4.3%, inside the noise).
 * If it ever really has to go, parking the bounds outside the visible desktop preserves the warm
 * surface; hiding reintroduces the stale-texture flash the opening handshake exists to avoid.
 *
 * There used to be an `overlayHudActive` flag here for the case of a HUD (Pomodoro/Stopwatch strip).
 * Beyond the widgets no longer existing, the flag caused an artifact: on CLOSING the radial, the
 * renderer called `setWindowSize('small')` synchronously, before the React commit that set it false.
 * Main still saw `true`, expanded the HWND to the whole monitor (origin = LEFT edge) with the window
 * visible, and the radial was seen jumping left before disappearing.
 */
/**
 * Radial open: a square box around the menu instead of the whole monitor — less layered area for the DWM.
 * `size` comes from the renderer (radius + icon + label + gesture margin); the fallback covers the default config.
 * The margin matters: the angle and the selection click are read from WINDOW mouse events, so the box
 * has to be well bigger than the circle, or a wide gesture leaves the window and the selection never confirms.
 */
let radialViewportSize = 988;
/**
 * The box is off. Set by the renderer when "Background dimming" is high enough that the scrim still
 * has alpha where the box would end (`radialScrimNeedsFullBleed`): a dim that stops at an invisible
 * rectangle is not a dimmed screen, it is a dark rectangle with four hard edges on a bright desktop.
 *
 * Only the OPEN window grows — idle keeps the compact box through `smallModeBounds`, so the DWM
 * still has no monitor-sized layered surface to compose for the 99.9% of the time nothing is open.
 */
let radialFullBleed = false;
/**
 * Does the wheel follow the pointer's monitor, or is it always born on the primary one?
 *
 * It rides the same channel as the size and the full-bleed flag because it is the same kind of
 * fact: geometry main has to know BEFORE an open, never while one is running.
 */
let radialFollowsCursorMonitor = false;
/**
 * Only the two known values write. An absent one leaves the current setting alone — which is what
 * lets the value seeded from disk at boot survive a renderer that does not send it.
 */
function applyRadialMonitorSetting(value) {
  if (value === "cursor") radialFollowsCursorMonitor = true;
  else if (value === "primary") radialFollowsCursorMonitor = false;
}
/**
 * Does the wheel bloom under the pointer, or at the middle of its screen?
 *
 * The monitor setting above answers WHICH screen; this one answers where on it. They travel
 * together and for the same reason — main has to place the window before the renderer is told an
 * open is happening.
 *
 * This is not the old free positioning coming back: nothing is stored, dragged or remembered. The
 * pointer is read at the moment of the open and the wheel is drawn there.
 */
let radialOpensAtCursor = false;
/** Same contract as the monitor: an absent value leaves the seeded-from-disk setting alone. */
function applyRadialPlacementSetting(value) {
  if (value === "cursor") radialOpensAtCursor = true;
  else if (value === "center") radialOpensAtCursor = false;
}
/**
 * How far the drawn wheel reaches from its centre, in px — the renderer's radius plus one tile.
 *
 * Only `radialOpensAtCursor` reads it, and only to keep the ring on the screen when the pointer is
 * in a corner. The fallback matches the default radius (140) and icon size (64).
 */
let radialRingReach = 204;
ipcMain.on("set-radial-viewport", (_event, payload) => {
  if (!payload || typeof payload !== "object") return;
  /**
   * Also the only proof in the log that the wheel's RENDERER is alive.
   *
   * `[Overlay] Stable idle` says the window painted, which a blank document does too — a renderer
   * that failed to boot looks exactly like a healthy idle overlay. This line is sent from an effect
   * in `RadialApp`, so it cannot appear unless React mounted and the config arrived.
   */
  diagLog(`[Overlay] Renderer ready; wheel geometry ${JSON.stringify(payload)}`);
  const n = Number(payload.size);
  if (Number.isFinite(n) && n >= 320 && n <= 4096) {
    radialViewportSize = Math.round(n);
  }
  radialFullBleed = !!payload.fullBleed;
  applyRadialMonitorSetting(payload.monitor);
  applyRadialPlacementSetting(payload.placement);
  const ring = Number(payload.ring);
  if (Number.isFinite(ring) && ring >= 60 && ring <= 2048) radialRingReach = Math.round(ring);
});

/**
 * The wheel is being carried, and the box it was born in is too small a desk.
 *
 * `radialViewportSize` is a square around the ring (988 by default): on a 1920×1080 monitor that is
 * a quarter of the screen, and mouse events stop at the window's edge — drag past it and the wheel
 * would stick to an invisible frame a few hundred pixels from where it started. So the first
 * committed drag of an open grows the overlay to the whole display, once, and the renderer keeps
 * the wheel under the hand from there with no further help from main.
 *
 * It is the same rect a deep scrim or a screen dock already opens at (`fullBleedBounds`), for the
 * same reason and with the same taskbar left alone — so a wheel that was already full-bleed pays
 * for nothing here and no window is resized at all.
 *
 * THE ORDER MATTERS, and it is the whole reason this is a message and not an `invoke`. Growing the
 * window moves its top-left corner several hundred pixels, and client coordinates are measured from
 * that corner: a renderer told afterwards paints one frame with the new size and the old centre,
 * which on screen is the wheel jumping out from under the hand at the exact moment the hand is
 * holding it. Sending the geometry BEFORE `setBounds` puts the message in the renderer's queue
 * ahead of the resize, so it is already holding the new origin when the `resize` event arrives and
 * can apply both in one frame.
 */
ipcMain.on("radial-drag-space", (event) => {
  if (!radialOpen || !overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    const current = overlayWindow.getBounds();
    /** The display the wheel is ON, never the cursor's: a drag must not teleport it to another screen. */
    const display = screen.getDisplayMatching(current);
    const target = fullBleedBounds(display.bounds, display.workArea) || {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    };
    const bounds = {
      x: Math.round(target.x),
      y: Math.round(target.y),
      width: Math.round(target.width),
      height: Math.round(target.height),
    };
    event.sender.send("radial-drag-geometry", {
      windowOrigin: { x: bounds.x, y: bounds.y },
      clientSize: { width: bounds.width, height: bounds.height },
    });
    if (boundsApproxEqual(current, bounds)) return;
    overlayWindow.setBounds(bounds);
    /**
     * The blocker's rect is the ALLOWED one — everything else on the monitor is swallowed before it
     * reaches any window. Left at the old box, the release that ends a drag out in the new area
     * would never be delivered and the wheel would stay stuck to the pointer.
     */
    setRadialMouseBlocking(bounds, display.bounds);
    diagLog(`[RadialDrag] overlay grown for a drag: ${JSON.stringify(bounds)}`);
  } catch (e) {
    diagLog(`[RadialDrag] could not grow the overlay: ${e.message}`);
  }
});

/**
 * The monitor the wheel is born on.
 *
 * `primary` is what shipped and stays the default. `cursor` exists for the case that made this a
 * setting: a second monitor, the hand on it, and the wheel blooming on the primary one — behind the
 * window the user had just left, so the app they picked opened on a screen they were not looking at.
 *
 * It chooses a SCREEN, not a point — where on that screen is `radialPlacement`'s answer, applied
 * in `showMenuAtCursor`. `radialModeBounds` still centres the box on whatever point it is handed.
 *
 * Placement at the pointer overrides a `primary` monitor setting, because the two cannot both be
 * honoured: a wheel under a pointer that is on the second screen IS on the second screen. Asking
 * for the main screen and for the pointer is asking for two different places at once, and the
 * pointer is the one the hand can see.
 *
 * @param {{ x: number, y: number } | undefined} anchorScreenPoint — a point already known to be the
 *   one that matters (the collapse anchor). Absent, the live cursor is asked.
 */
function radialTargetDisplay(anchorScreenPoint) {
  if (!radialFollowsCursorMonitor && !radialOpensAtCursor) return screen.getPrimaryDisplay();
  try {
    const point =
      anchorScreenPoint &&
      Number.isFinite(anchorScreenPoint.x) &&
      Number.isFinite(anchorScreenPoint.y)
        ? anchorScreenPoint
        : screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point);
  } catch (e) {
    /** A display list that will not be read is not a reason to refuse to open. */
    return screen.getPrimaryDisplay();
  }
}

/** The live pointer, or null when Windows will not say — every caller has a centre to fall back to. */
function currentCursorPoint() {
  try {
    const point = screen.getCursorScreenPoint();
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
      return { x: point.x, y: point.y };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

/**
 * Where the wheel is born, in screen coordinates: the middle of the display, or the pointer.
 *
 * The pointer is pulled back from the edges by `radialRingReach` so the whole ring stays on the
 * screen — half a wheel hanging off the right edge is three shortcuts that cannot be aimed at. On a
 * display too small to hold the ring at all the clamp collapses to the centre, which is the only
 * point that keeps as much of it visible as there is room for.
 */
function radialOpenCenter(displayBounds, cursorPoint) {
  const center = {
    x: Math.round(displayBounds.x + displayBounds.width / 2),
    y: Math.round(displayBounds.y + displayBounds.height / 2),
  };
  if (!radialOpensAtCursor || !cursorPoint) return center;
  const reachX = Math.min(radialRingReach, displayBounds.width / 2);
  const reachY = Math.min(radialRingReach, displayBounds.height / 2);
  return {
    x: Math.round(
      Math.max(
        displayBounds.x + reachX,
        Math.min(cursorPoint.x, displayBounds.x + displayBounds.width - reachX),
      ),
    ),
    y: Math.round(
      Math.max(
        displayBounds.y + reachY,
        Math.min(cursorPoint.y, displayBounds.y + displayBounds.height - reachY),
      ),
    ),
  };
}

/**
 * A transparent window the size of the monitor makes Windows mark videos/apps underneath as hidden
 * and cut back their rendering. This hook lies dormant outside the radial and, during the modal,
 * eats only clicks/scroll outside our BrowserWindow's visual box.
 */
let radialMouseBlocker = null;
let radialMouseBlockerReady = false;
let pendingRadialMouseBlockCommand = null;
/**
 * Who receives TRIGGER_DOWN/TRIGGER_UP. The trigger button is now captured by the blocker's hook
 * instead of polled with GetAsyncKeyState: swallowing the event and still detecting it by polling
 * is impossible, because a hook that returns 1 hides the button from GetAsyncKeyState.
 */
let radialTriggerListener = null;

/** Drag slop: below this the press was a click, not an aim. */
const TRIGGER_PASSTHROUGH_SLOP_PX = 6;

/**
 * A path that only Node can read, never a path Windows can execute.
 *
 * `fs.existsSync` is asar-aware: it answers TRUE for a file listed inside `app.asar`, because the
 * archive's index says it is there. `spawn` is not — it hands the path to `CreateProcess`, which
 * sees a directory that does not exist on disk and fails with ENOENT. So in a packaged build the
 * first candidate below, `<app.asar>/backend/rovyl-helper.exe`, is found and is unusable, and
 * every helper started through here dies on the spawn.
 *
 * Nothing inside the archive is ever executable. `asarUnpack` is what puts a REAL copy next to it
 * in `app.asar.unpacked`, and that is the only kind of path worth returning.
 */
function isInsideAsarArchive(candidate) {
  return /\.asar([\\/]|$)/i.test(candidate) && !/\.asar\.unpacked/i.test(candidate);
}

function getNativeHelperExePath() {
  const candidates = [
    path.join(__dirname, "rovyl-helper.exe"),
    path.join(__dirname, "native-helper", "rovyl-helper.exe"),
    path.join(__dirname, "..", "resources", "bin", "rovyl-helper.exe"),
    path.join(__dirname.replace("app.asar", "app.asar.unpacked"), "rovyl-helper.exe"),
    path.join(__dirname.replace("app.asar", "app.asar.unpacked"), "native-helper", "rovyl-helper.exe"),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "bin", "rovyl-helper.exe"));
    candidates.push(path.join(process.resourcesPath, "bin", "rovyl-helper.exe"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", "rovyl-helper.exe"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "backend", "rovyl-helper.exe"));
  }
  for (const c of candidates) {
    /** Found-but-unspawnable is worse than not found: it stops the search at a dead path. */
    if (isInsideAsarArchive(c)) continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

function radialMouseBlockerAssetPath() {
  const p = path.join(__dirname, "mouse-blocker.ps1");
  return isDev ? p : p.replace("app.asar", "app.asar.unpacked");
}

function writeRadialMouseBlocker(command) {
  pendingRadialMouseBlockCommand = command;
  if (!radialMouseBlocker || !radialMouseBlockerReady || !radialMouseBlocker.stdin?.writable) return;
  try {
    radialMouseBlocker.stdin.write(`${command}\n`);
    pendingRadialMouseBlockCommand = null;
  } catch (e) {
    diagLog(`[RadialBlocker] command failed: ${e.message}`);
  }
}

/**
 * A slot of its own for the `WARP`s.
 *
 * `pendingRadialMouseBlockCommand` holds ONE command, and a session's first radial sends the
 * `BLOCK` while PowerShell is still starting: a warp sharing the slot erased it and the blocking of
 * clicks outside the wheel vanished for that open. Here the last warp winning is correct by nature
 * — parking and then putting it back only matters for the final destination.
 */
let pendingRadialCursorCommand = null;

/**
 * Does NOT call `ensureRadialMouseBlocker`: the helper is already up whenever this matters, because
 * `showMenuAtCursor` starts it before the wheel exists. If it died, or we are on the
 * way out, resurrecting it here left an orphan PowerShell — which is exactly what stops the
 * installer replacing the folder. With no process, the command waits in the slot and leaves on the
 * next READY.
 */
function writeRadialCursorCommand(command) {
  if (!radialMouseBlocker || !radialMouseBlockerReady || !radialMouseBlocker.stdin?.writable) {
    pendingRadialCursorCommand = command;
    return;
  }
  pendingRadialCursorCommand = null;
  try {
    radialMouseBlocker.stdin.write(`${command}\n`);
  } catch (e) {
    diagLog(`[RadialBlocker] cursor failed: ${e.message}`);
  }
}

/**
 * Clickless execution: the pointer is hidden and the gesture becomes a DIRECTION.
 *
 * Hiding is CSS, and CSS only paints over our window — the radial's box is ~988px, not the monitor.
 * That is why the cursor is parked at the wheel's centre on open: it stays inside the window (so
 * invisible, so generating `mousemove`) and the gesture starts from zero instead of already being
 * worth the slice on whichever side the hand happened to be. On close it goes back to exactly the
 * point it left — whoever opened the wheel over a text field finds it there.
 */
let radialCursorCaptureWanted = false;
let radialCursorParked = false;
let radialCursorRestorePoint = null;
let radialCursorParkPoint = null;

function captureRadialCursor(center) {
  if (process.platform !== "win32") return;
  if (!radialCursorCaptureWanted || !center) return;
  if (!radialCursorParked) {
    try {
      radialCursorRestorePoint = screen.getCursorScreenPoint();
    } catch (e) {
      radialCursorRestorePoint = null;
    }
    radialCursorParked = true;
  }
  radialCursorParkPoint = { x: Math.round(center.x), y: Math.round(center.y) };
  writeRadialCursorCommand(`WARP ${radialCursorParkPoint.x} ${radialCursorParkPoint.y}`);
}

/** Nudges back to the centre without ending the capture — the gesture accumulates deltas, so it does not feel the jump. */
function reparkRadialCursor() {
  if (!radialCursorParked || !radialCursorParkPoint) return;
  writeRadialCursorCommand(`WARP ${radialCursorParkPoint.x} ${radialCursorParkPoint.y}`);
}

/**
 * The one that knows whether clickless execution is on is the renderer, which holds the UIConfig.
 * Main only needs the yes/no, and gets it whenever the setting changes — never mid-open.
 */
ipcMain.on("set-radial-cursor-capture", (_event, enabled) => {
  radialCursorCaptureWanted = !!enabled;
  if (!radialCursorCaptureWanted) releaseRadialCursor();
});

/** The pointer drifted from the radial's box: nudge it back before it leaves and reappears. */
ipcMain.on("park-radial-cursor", () => {
  reparkRadialCursor();
});

function releaseRadialCursor() {
  if (!radialCursorParked) return;
  radialCursorParked = false;
  radialCursorParkPoint = null;
  const restore = radialCursorRestorePoint;
  radialCursorRestorePoint = null;
  if (!restore) return;
  writeRadialCursorCommand(`WARP ${Math.round(restore.x)} ${Math.round(restore.y)}`);
}

function ensureRadialMouseBlocker() {
  if (process.platform !== "win32" || radialMouseBlocker) return;
  radialMouseBlockerReady = false;
  const nativeHelper = getNativeHelperExePath();
  const child = nativeHelper
    ? (diagLog(`[RadialBlocker] Spawning native helper: ${nativeHelper}`),
       spawn(nativeHelper, ["mouse-blocker", String(process.pid)], { windowsHide: true }))
    : spawn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "RemoteSigned",
          "-File",
          radialMouseBlockerAssetPath(),
          String(process.pid),
        ],
        { windowsHide: true },
      );
  radialMouseBlocker = child;
  child.stdout.on("data", (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("RECORD_MOUSE ") && onNativeRecordMouse) {
        const parts = line.slice("RECORD_MOUSE ".length).trim().split(" ");
        const btnName = parts[0];
        const modMask = parseInt(parts[1] || "0", 10);
        try {
          onNativeRecordMouse(btnName, modMask);
        } catch (e) {
          diagLog(`[RadialBlocker] record mouse: ${e.message}`);
        }
      } else if (line === "SHORTCUT_DOWN") {
        try {
          triggerRadialShortcut();
        } catch (e) {
          diagLog(`[RadialBlocker] shortcut down: ${e.message}`);
        }
      } else if (line === "SHORTCUT_UP") {
        try {
          releaseRadialShortcut();
        } catch (e) {
          diagLog(`[RadialBlocker] shortcut up: ${e.message}`);
        }
      } else if (line === "BUTTONS_UP") {
        settleMouseButtonsUp();
      }
    }
    if (radialTriggerListener && text.includes("TRIGGER_")) {
      try {
        radialTriggerListener(text);
      } catch (e) {
        diagLog(`[RadialBlocker] trigger: ${e.message}`);
      }
    }
    /** A line on its own: "TRIGGER_READY" also contains READY and does not announce the startup. */
    if (!/^READY\s*$/m.test(text)) return;
    radialMouseBlockerReady = true;
    if (pendingRadialMouseBlockCommand) {
      const command = pendingRadialMouseBlockCommand;
      pendingRadialMouseBlockCommand = null;
      writeRadialMouseBlocker(command);
    }
    if (pendingRadialCursorCommand) {
      const command = pendingRadialCursorCommand;
      pendingRadialCursorCommand = null;
      writeRadialCursorCommand(command);
    }
  });
  child.stderr.on("data", (data) => {
    diagLog(`[RadialBlocker] ${data.toString().trim()}`);
  });
  child.on("exit", () => {
    if (radialMouseBlocker === child) {
      radialMouseBlocker = null;
      radialMouseBlockerReady = false;
      /** With no process there is no way to give the cursor back: do not keep a restore that never comes. */
      radialCursorParked = false;
      radialCursorParkPoint = null;
      radialCursorRestorePoint = null;
      pendingRadialCursorCommand = null;
    }
  });
}

/**
 * Everyone waiting on the helper's next `BUTTONS_UP`. One answer settles all of them: the question
 * is about the mouse, not about the asker.
 */
let mouseButtonsUpWaiters = [];

function settleMouseButtonsUp() {
  const waiters = mouseButtonsUpWaiters;
  mouseButtonsUpWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * Resolves once no mouse button is held — or after `timeoutMs`, whichever comes first.
 *
 * For whoever is about to take the foreground out from under a click that is still in progress.
 * Windows hands the notification area's right-click to us on the button DOWN, and Electron pops
 * the tray menu right there, which deactivates the taskbar mid-click; explorer then never gets to
 * finish its own click, and the release falls through to `Shell_TrayWnd` as a WM_CONTEXTMENU — the
 * taskbar's own menu, on top of ours. Waiting out the press costs ~20ms and the whole race with it.
 *
 * Deliberately does NOT start the helper: with no helper this resolves at once and the behaviour
 * is exactly what it was before, rather than a tray menu that will not open.
 */
function waitForMouseButtonsUp(timeoutMs = 400) {
  if (process.platform !== "win32") return Promise.resolve();
  if (!radialMouseBlocker || !radialMouseBlockerReady || !radialMouseBlocker.stdin?.writable) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve();
    };
    mouseButtonsUpWaiters.push(finish);
    /** The helper answers at its own deadline too; this only covers a helper that has gone quiet. */
    timer = setTimeout(finish, timeoutMs + 100);
    timer.unref?.();
    try {
      /** Straight to stdin: `writeRadialMouseBlocker`'s one pending slot belongs to BLOCK/TRIGGER. */
      radialMouseBlocker.stdin.write(`BUTTONS_UP ${timeoutMs}\n`);
    } catch (e) {
      diagLog(`[RadialBlocker] buttons-up failed: ${e.message}`);
      finish();
    }
  });
}

function setRadialMouseBlocking(bounds, monitorBounds) {
  if (process.platform !== "win32") return;
  ensureRadialMouseBlocker();
  writeRadialMouseBlocker(
    `BLOCK ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height} ${monitorBounds.x} ${monitorBounds.y} ${monitorBounds.width} ${monitorBounds.height}`,
  );
}

/**
 * Hands the trigger button's capture to the hook. `slop` decides what still counts as a plain click
 * and is given back to the window underneath; above that the gesture was an aim and nothing is
 * given back.
 *
 * `clickHoldMs` and `clickDragPx` are "click" mode's two proofs that the press stopped being ours:
 * it lasted too long, or the hand left the spot. Whichever comes first wins, and the hook gives the
 * button back to the window underneath while the press is still going. They travel in the command
 * instead of being written in both languages — main is what owns the numbers, as it already does
 * with `slop`.
 *
 * `modMask` is the modifiers the binding asks for (Ctrl 1, Alt 2, Shift 4, Win 8). Zero means the
 * button alone. With one set, a press without those modifiers is not ours and reaches the window
 * underneath untouched — which is what makes left and right bindable at all.
 */
function setRadialTriggerCapture(virtualKey, mode, slop, clickHoldMs, clickDragPx, modMask) {
  if (process.platform !== "win32") return;
  ensureRadialMouseBlocker();
  writeRadialMouseBlocker(
    `TRIGGER ${virtualKey} ${mode} ${slop} ${clickHoldMs} ${clickDragPx} ${modMask || 0}`,
  );
}

function clearRadialTriggerCapture() {
  if (process.platform !== "win32") return;
  if (!radialMouseBlocker) return;
  writeRadialMouseBlocker("TRIGGER OFF");
}

function clearRadialMouseBlocking() {
  pendingRadialMouseBlockCommand = null;
  if (!radialMouseBlocker || !radialMouseBlockerReady) return;
  writeRadialMouseBlocker("UNBLOCK");
}

function stopRadialMouseBlocker() {
  pendingRadialMouseBlockCommand = null;
  if (!radialMouseBlocker) return;
  const child = radialMouseBlocker;
  radialMouseBlocker = null;
  radialMouseBlockerReady = false;
  try {
    if (child.stdin?.writable) child.stdin.write("EXIT\n");
  } catch (e) {
    /* ignore */
  }
  setTimeout(() => {
    try { if (!child.killed) child.kill(); } catch (e) { /* ignore */ }
  }, 250);
}

/* -- The readings behind the system dock --------------------------------- */

/**
 * The dock's readouts, read by a helper that lives for as long as the dock is switched on.
 *
 * Whether there IS a dock — and whether it asks for anything a helper has to answer — is decided
 * by `statusDockNeedsHelper` in the renderer, which says so here on mount. Main deliberately does
 * NOT seed this from disk the way `radialMonitor` is seeded: the overlay window is created at
 * startup, so the wheel's renderer has reported long before any wheel opens, and a second copy of
 * those rules in CommonJS is how two copies of a rule drift.
 */
const systemStatus = createSystemStatusService({
  resolveHelperPath: getNativeHelperExePath,
  log: diagLog,
  /** Only the wheel's window draws them; Settings has no readouts to update. */
  onStatus: (status) => sendToOverlay("system-status", status),
});

ipcMain.on("set-status-dock-active", (_event, active) => {
  systemStatus.setActive(!!active);
});

ipcMain.handle("get-system-status", () => systemStatus.snapshot());

ipcMain.on("set-system-volume", (_event, percent) => {
  systemStatus.setVolume(percent);
});

ipcMain.on("set-system-muted", (_event, muted) => {
  systemStatus.setMuted(!!muted);
});

/**
 * The Windows panel behind a readout, named rather than spelled.
 *
 * The renderer sends `"network"`, not `"ms-availablenetworks:"`. A renderer that could hand main an
 * arbitrary URI to open is a renderer that can ask the shell to run anything, and the four entries
 * below are the whole of what the dock has any business opening.
 */
const SYSTEM_PANEL_URIS = {
  /** The classic volume mixer has no URI; this is the page with the same controls. */
  volume: "ms-settings:sound",
  /** The flyout with the list of networks, which is what clicking a Wi-Fi glyph means. */
  network: "ms-availablenetworks:",
  battery: "ms-settings:batterysaver",
  clock: "ms-settings:dateandtime",
};

ipcMain.on("open-system-panel", (_event, panel) => {
  const uri = SYSTEM_PANEL_URIS[panel];
  if (!uri) return;
  /**
   * The wheel is up and holding the mouse when this runs. The renderer takes it down first, the
   * same order the corner gear follows — a panel opening behind a wheel that still has the pointer
   * is a window the user cannot reach.
   */
  try {
    void shell.openExternal(uri);
  } catch (e) {
    diagLog(`[SystemStatus] could not open ${panel}: ${e.message}`);
  }
});

/**
 * Radial open ON TOP of the panel (Settings/Welcome): there is only one window, so shrinking to the
 * radial's square made the panel disappear — that was the "it blinks and only the radial is left".
 * Here the radial's box grows to take in the panel's rect too, and the renderer draws it at the
 * same screen position it had. `windowed` mode still keeps that rect in `lastWindowedBounds`, so
 * closing the radial puts the window back in the exact spot.
 */
/**
 * The radial's box is always centred on the display it is HANDED. WHICH display that is belongs to
 * the caller — `radialTargetDisplay`, driven by the `radialMonitor` setting — never to this function.
 * Free positioning at an arbitrary point is gone; `point` is still taken and still ignored.
 */
function radialModeBounds(displayBounds, point) {
  const side = Math.min(
    radialViewportSize,
    displayBounds.width,
    displayBounds.height,
  );
  const center = (point && typeof point.x === "number" && typeof point.y === "number")
    ? point
    : {
        x: displayBounds.x + displayBounds.width / 2,
        y: displayBounds.y + displayBounds.height / 2,
      };
  const half = side / 2;
  const maxX = displayBounds.x + displayBounds.width - side;
  const maxY = displayBounds.y + displayBounds.height - side;
  return {
    x: Math.round(Math.max(displayBounds.x, Math.min(center.x - half, maxX))),
    y: Math.round(Math.max(displayBounds.y, Math.min(center.y - half, maxY))),
    width: Math.round(side),
    height: Math.round(side),
  };
}

/**
 * Where the radial actually opens. The box above, unless the dimming reaches its edge — then the
 * screen, because that edge would otherwise be drawn on screen as a rectangle. The screen meaning
 * the WORK area: a wheel that takes the monitor takes the taskbar with it, and an almost-opaque
 * scrim over the taskbar is a taskbar the user cannot see. See `backend/full-bleed-bounds.cjs`.
 *
 * @param {Electron.Display} display the monitor the wheel is born on — bounds AND work area, since
 *   the work area is what says how much of it the wheel may have.
 *
 * Every caller that computes the open bounds has to go through here, including the one that only
 * compares them against the current bounds to decide whether to hide before resizing: two callers
 * disagreeing about the target is a visible DWM flash.
 */
function radialOpenBounds(display, point) {
  const displayBounds = display.bounds;
  if (!radialFullBleed) return radialModeBounds(displayBounds, point);
  /** A display Electron described oddly is still a display: the monitor rect is the last resort. */
  return fullBleedBounds(displayBounds, display.workArea) || {
    x: Math.round(displayBounds.x),
    y: Math.round(displayBounds.y),
    width: Math.round(displayBounds.width),
    height: Math.round(displayBounds.height),
  };
}

/**
 * The overlay's idle rect: exactly the bounds the wheel will open at, centred on the display.
 *
 * Opening then usually needs no resize at all — and on a transparent layered window every resize is
 * a flash risk. Since the idle window ignores the mouse, the box blocks nothing.
 */
function smallModeBounds(displayBounds) {
  return radialModeBounds(displayBounds, {
    x: displayBounds.x + displayBounds.width / 2,
    y: displayBounds.y + displayBounds.height / 2,
  });
}

function clampBoundsToWorkArea(bounds, workArea) {
  let { x, y, width, height } = bounds;
  const minW = 48;
  const minH = 28;
  width = Math.max(minW, Math.round(width));
  height = Math.max(minH, Math.round(height));
  if (width > workArea.width) width = workArea.width;
  if (height > workArea.height) height = workArea.height;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function boundsApproxEqual(a, b, eps = 2) {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

/**
 * Put Settings back at the rect it was last at, inside the work area.
 *
 * What replaced `updateWindowSize`. That function chose between a monitor-sized transparent overlay
 * for the wheel, this rect for the panel, and a collapsed click-through box for idle — on one
 * window, which is why it also had to manage `setShape`, `setIgnoreMouseEvents`, always-on-top and
 * the taskbar button as it went. Settings is an ordinary window now: it has one size, it is either
 * on screen or hidden, and the wheel is somebody else's HWND.
 */
function applySettingsWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) return;
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    resetLastWindowedBoundsIfIslandCorrupted();
    /**
     * Maximized counts as correct. `lastWindowedBounds` is frozen at the rect from BEFORE the
     * maximize — the `resize`/`move` trackers ignore a maximized window — so the two rects always
     * differ and `setBounds` would run for certain. And `setBounds` on a maximized window
     * unmaximizes it without emitting `unmaximize`, leaving the title button showing "Restore" on a
     * window that is no longer maximized. Reopening Settings is not a request to resize it.
     */
    if (mainWindow.isMaximized()) return;
    if (!boundsApproxEqual(mainWindow.getBounds(), lastWindowedBounds)) {
      isUpdatingBounds = true;
      mainWindow.setBounds(lastWindowedBounds);
      isUpdatingBounds = false;
    }
  } catch (e) {
    isUpdatingBounds = false;
    diagLog(`[Settings] applySettingsWindowBounds: ${e.message}`);
  }
}

let mainWindowCreation = null;
async function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (!mainWindowCreation) {
    mainWindowCreation = createWindow().finally(() => {
      mainWindowCreation = null;
    });
  }
  mainWindow = await mainWindowCreation;
  return mainWindow;
}

/**
 * The single entry point for every way of asking for Settings: tray menu, tray click,
 * `toggle-settings` and double-MMB.
 */
function openSettingsFromMainProcess() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  /**
   * Take the wheel down first.
   *
   * Double-MMB is "open Settings", and it can land with the wheel on screen. When both surfaces
   * shared a window the renderer did this for itself in the same commit that opened the panel;
   * across two windows nobody but main is in a position to know, so main says so — otherwise the
   * wheel stays up, always-on-top, over the Settings the gesture just asked for.
   */
  forceCloseRadial();
  /** Steers `onRestore` away from its passive-hide branch. */
  windowBuriedPassive = false;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
  } catch (e) {
    diagLog(`[Settings] restore: ${e.message}`);
  }
  /** Coming back from the tray with the renderer still throttled shows the old texture first. */
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch (e) {
    /* ignore */
  }
  mainWindow.setSkipTaskbar(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  applySettingsWindowBounds();
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setOpacity(1);
  mainWindow.show();
  try {
    mainWindow.moveTop();
  } catch (e) {
    /* ignore */
  }
  mainWindow.focus();
  mainWindow.webContents.focus();
  sendToSettings("open-settings");
  setImmediate(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setSkipTaskbar(false);
    } catch (e) {
      /* ignore */
    }
  });
  try {
    if (
      mainWindow.webContents &&
      typeof mainWindow.webContents.invalidate === "function"
    ) {
      mainWindow.webContents.invalidate();
    }
  } catch (e) {
    /* ignore */
  }
}

/**
 * `screen.screenToDipRect`, if this build has it.
 *
 * Both foreground helpers answer in physical pixels — `foreground-focus.ps1` goes out of its way
 * to stay per-monitor-aware so it does — and Electron describes every display in DIP. Chromium is
 * the only thing that knows where each monitor sits in physical space on a mixed-scale layout, so
 * ask it rather than divide, and keep the arithmetic in `fullscreen-bounds.cjs` for the platforms
 * (and the tests) that have no `screen`.
 */
function screenRectToDip(rect) {
  if (typeof screen.screenToDipRect !== "function") return null;
  return screen.screenToDipRect(null, rect);
}

/**
 * The window rect covers the whole monitor (real fullscreen), not the typical maximized (workArea).
 *
 * Ownership guards first, then geometry — see `backend/fullscreen-bounds.cjs`, where the geometry
 * lives so a scale factor this machine does not have can still be tested.
 */
function isBoundsFullscreenMonitor(bounds, ownerExePathLower) {
  if (!bounds || typeof bounds.width !== "number") return false;
  try {
    const myExe = path.resolve(app.getPath("exe")).toLowerCase();
    const op = (ownerExePathLower || "").trim();
    if (op) {
      const resolved = path.resolve(op).toLowerCase();
      if (myExe && resolved === myExe) return false;
    }
  } catch (_) {
    /* ignore */
  }

  const shellBase = path.basename(ownerExePathLower || "").toLowerCase();
  if (shellBase === "explorer.exe") return false;

  try {
    return isPhysicalRectFullscreen(bounds, screen.getAllDisplays(), screenRectToDip);
  } catch (_) {
    /* No display list means no verdict — fail open rather than block the wheel. */
    return false;
  }
}

function isForegroundWindowFullscreen(win) {
  if (!win || !win.bounds) return false;
  const op = (win.owner && win.owner.path) || "";
  return isBoundsFullscreenMonitor(win.bounds, op);
}

/**
 * Flat list of match specifications.
 * Each CSV segment can be: `token` or `alt1|alt2::label` (label is UI only; alts are OR).
 */
function parseBlockedAppTokens(csv) {
  const out = [];
  const segments = String(csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const matchPart = lower.includes("::")
      ? lower.split("::")[0].trim()
      : lower;
    for (const alt of matchPart.split("|")) {
      const a = alt.trim();
      if (a) out.push(a);
    }
  }
  return out;
}

/** Minimum characters in the "stem" to match against title/cmd (avoids noise). */
const GAME_MODE_TITLE_STEM_MIN = 5;

/** Whole word only (avoids "zen" inside "frozen"). */
function hayContainsTokenWord(hay, word) {
  if (!word || word.length < 3) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
}

/** Useful segments out of legacy tokens like "openai.chatgpt - desktop_xxx" or WindowsApps paths. */
function expandGameModeTokenFragments(tok) {
  const t = String(tok).toLowerCase().trim();
  const out = new Set();
  if (!t) return [];
  out.add(t);
  const noExe = t.replace(/\.exe$/i, "");
  out.add(noExe);
  const head = noExe.split(/\s+/)[0];
  for (const part of head.split(/[^a-z0-9]+/i)) {
    if (part.length >= 4) out.add(part);
  }
  const dotParts = head.split(".").filter((p) => /^[a-z0-9]+$/i.test(p));
  if (dotParts.length) {
    out.add(dotParts[dotParts.length - 1]);
  }
  return [...out];
}

/**
 * Foreground app matches the list — exe, title, CommandLine and token fragments (Store/PWA).
 */
function tokensMatchForeground(exePathLower, titleLower, cmdlineLower, tokens) {
  if (!tokens.length) return false;
  const normExe = String(exePathLower || "")
    .replace(/\//g, "\\")
    .toLowerCase();
  const title = String(titleLower || "").toLowerCase();
  const cmd = String(cmdlineLower || "").toLowerCase();
  const hay = `${title}\n${cmd}\n${normExe}`;
  for (const tok of tokens) {
    const frags = expandGameModeTokenFragments(tok);
    for (const frag of frags) {
      const withExe = frag.endsWith(".exe") ? frag : `${frag}.exe`;
      const stem = frag.replace(/\.exe$/i, "");
      if (normExe) {
        const base = path.basename(normExe).toLowerCase();
        if (base === withExe || base === frag || base === `${stem}.exe`) return true;
        if (normExe.endsWith("\\" + withExe)) return true;
        if (normExe.includes("\\" + withExe + "\\")) return true;
        if (stem.length >= 4 && normExe.includes(stem)) return true;
      }
      if (stem === "chatgpt") {
        if (
          hay.includes("chatgpt") ||
          hay.includes("openai.com") ||
          hay.includes("chat.openai")
        ) {
          return true;
        }
      }
      if (stem.length >= GAME_MODE_TITLE_STEM_MIN && hay.includes(stem)) return true;
      if (
        stem.length >= 3 &&
        stem.length < GAME_MODE_TITLE_STEM_MIN &&
        /^[a-z]+$/.test(stem) &&
        hayContainsTokenWord(hay, stem)
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseForegroundPsOutput(stdout) {
  let raw = String(stdout || "").replace(/^\uFEFF/, "").trimEnd();
  if (!raw) return { exe: null, title: "", cmdline: "", bounds: null };
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const exe = (lines[0] || "").toLowerCase() || null;
  const title = (lines[1] || "").toLowerCase();
  const cmdline = (lines[2] || "").toLowerCase();
  let bounds = null;
  if (lines[3]) {
    const parts = lines[3].split(",").map((x) => parseInt(x.trim(), 10));
    if (
      parts.length >= 4 &&
      parts.every((n) => typeof n === "number" && !Number.isNaN(n))
    ) {
      bounds = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }
  return { exe, title, cmdline, bounds };
}

function getWindowsPowerShellExe() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const full = path.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    try {
      if (fs.existsSync(full)) return full;
    } catch (_) {}
  }
  return "powershell.exe";
}

function getForegroundContextWindows() {
  return new Promise((resolve) => {
    const scriptPath = getAssetPath("get-foreground-exe.ps1");
    try {
      if (!fs.existsSync(scriptPath)) {
        diagLog(`[GameMode] missing script ${scriptPath}`);
        return resolve({ exe: null, title: "", cmdline: "", bounds: null });
      }
    } catch (e) {
      diagLog(`[GameMode] stat script: ${e.message}`);
      return resolve({ exe: null, title: "", cmdline: "", bounds: null });
    }

    const ps = getWindowsPowerShellExe();
    execFile(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        scriptPath,
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          diagLog(
            `[GameMode] get-foreground-exe.ps1 err=${err.message} stderr=${String(stderr || "").slice(0, 200)}`,
          );
          return resolve({ exe: null, title: "", cmdline: "", bounds: null });
        }
        resolve(parseForegroundPsOutput(stdout));
      },
    );
  });
}

function isZenithOwnExePath(exeLower) {
  if (!exeLower) return false;
  try {
    const my = path.resolve(app.getPath("exe")).toLowerCase();
    return path.resolve(exeLower).toLowerCase() === my;
  } catch (_) {
    return false;
  }
}

/** The fast snapshot: exe + title, no native command line. */
function foregroundMatchesBlockedList(win, tokens) {
  if (!win || !tokens.length) return false;
  const ownerPath = ((win.owner && win.owner.path) || "")
    .toLowerCase()
    .replace(/\//g, "\\");
  const wtitle = ((win.title && String(win.title)) || "").toLowerCase();
  return tokensMatchForeground(ownerPath, wtitle, "", tokens);
}

const autoDetectedGameCache = new Map();
const AUTO_GAME_CACHE_LIMIT = 256;

function foregroundLooksLikeGame(exePath, cmdline = "") {
  const exe = String(exePath || "").trim();
  if (!exe) return false;
  const commandSignal = /steam_appid|-epicapp=|-epicportal|-fromfl=eac/i.test(String(cmdline || ""));
  const cacheKey = exe.toLowerCase();
  if (!commandSignal && autoDetectedGameCache.has(cacheKey)) {
    return autoDetectedGameCache.get(cacheKey);
  }
  const result = detectGameExecutable({ exePath: exe, cmdline });
  if (!commandSignal) {
    autoDetectedGameCache.delete(cacheKey);
    autoDetectedGameCache.set(cacheKey, result);
    while (autoDetectedGameCache.size > AUTO_GAME_CACHE_LIMIT) {
      const oldest = autoDetectedGameCache.keys().next().value;
      if (!oldest) break;
      autoDetectedGameCache.delete(oldest);
    }
  }
  return result;
}

// Main function to decide if we should open (global shortcut + middle button)
/**
 * "Pause trigger" from the tray, as an instant in time rather than a flag.
 *
 * An instant needs no timer to stay honest: a machine that sleeps through the pause wakes with it
 * already over, where a `setTimeout` would still be holding the triggers down. The timer that does
 * exist only redraws the tray menu, so a stale one costs a wrong label, never a dead trigger.
 */
let triggersPausedUntil = 0;
const triggersArePaused = () => triggersPausedUntil > Date.now();
/** Set once the tray exists. Held at module scope because the config syncer above it has to call it. */
let refreshTrayMenuRef = () => {};

/**
 * Every trigger asks this before opening — the global shortcut, the click and the hold — so the
 * pause belongs here rather than in three places. The tray's own "Open wheel" does not ask: it is
 * a request, not a trigger, and refusing an explicit click because the triggers are paused is
 * refusing the one way out that is left.
 */
const shouldOpenMenu = async () => {
  const decisionStartedAt = Date.now();
  if (triggersArePaused()) {
    diagLog(`[Trigger] Paused for another ${Math.ceil((triggersPausedUntil - Date.now()) / 1000)}s`);
    return false;
  }
  if (!gameModeConfig.enabled) return true;

  const mode = gameModeConfig.mode === "all" ? "all" : "list";
  const tokens = parseBlockedAppTokens(gameModeConfig.blockedApps);
  const autoDetectGames = mode === "list" && !!gameModeConfig.autoDetectGames;

  let activeResult = null;
  try {
    activeResult = await getForegroundSnapshotFast();
  } catch (e) {
    diagLog(`[GameMode] foreground snapshot failed: ${e.message}`);
  }

  if (mode === "all") {
    if (activeResult && isForegroundWindowFullscreen(activeResult)) {
      diagLog("[GameMode] Blocked: foreground fullscreen (mode=all)");
      return false;
    }
    /**
     * Fast path for everyday productivity: the warm helper covers the normal fullscreen case.
     * Spawning a fresh PowerShell on every open cost 1-2s on Windows.
     */
    if (activeResult) return true;
  }

  /**
   * The snapshot already hands over the executable, title and bounds of the active
   * window. In list mode that is all we need to decide the normal case. Before, even
   * with that data valid, every trigger still started a new PowerShell; that process
   * creation happened before `showMenuAtCursor` and was felt as radial lag.
   */
  if (mode === "list" && activeResult) {
    const listed = foregroundMatchesBlockedList(activeResult, tokens);
    const fullscreen = isForegroundWindowFullscreen(activeResult);
    const activeOwnerPath = activeResult?.owner?.path || "";
    const autoGame =
      autoDetectGames &&
      !!activeOwnerPath &&
      !isZenithOwnExePath(activeOwnerPath) &&
      foregroundLooksLikeGame(activeOwnerPath);

    if (fullscreen && (listed || autoGame)) {
      diagLog(
        `[GameMode] Blocked: protected fullscreen app (native, decision=${Date.now() - decisionStartedAt}ms)`,
      );
      return false;
    }

    const decisionMs = Date.now() - decisionStartedAt;
    if (decisionMs >= 20) {
      diagLog(`[GameMode] Native decision latency=${decisionMs}ms`);
    }
    return true;
  }

  let fgCtx = { exe: null, title: "", cmdline: "", bounds: null };
  if (process.platform === "win32") {
    fgCtx = await getForegroundContextWindows();
  }

  if (mode === "all") {
    if (
      process.platform === "win32" &&
      fgCtx.bounds &&
      fgCtx.exe &&
      !isZenithOwnExePath(fgCtx.exe) &&
      isBoundsFullscreenMonitor(fgCtx.bounds, fgCtx.exe)
    ) {
      diagLog("[GameMode] Blocked: foreground fullscreen (mode=all, PS)");
      return false;
    }
    return true;
  }

  // mode === "list": chosen apps and, optionally, automatically detected games.
  if (tokens.length === 0 && !autoDetectGames) return true;

  const listedPs =
    process.platform === "win32" &&
    fgCtx.exe &&
    !isZenithOwnExePath(fgCtx.exe) &&
    tokensMatchForeground(fgCtx.exe, fgCtx.title, fgCtx.cmdline, tokens);
  const fullscreenPs =
    !!fgCtx.bounds &&
    !!fgCtx.exe &&
    isBoundsFullscreenMonitor(fgCtx.bounds, fgCtx.exe);

  const listedAw = !!(activeResult && foregroundMatchesBlockedList(activeResult, tokens));
  const fullscreenAw = !!(activeResult && isForegroundWindowFullscreen(activeResult));

  const autoGamePs =
    autoDetectGames &&
    !!fgCtx.exe &&
    !isZenithOwnExePath(fgCtx.exe) &&
    foregroundLooksLikeGame(fgCtx.exe, fgCtx.cmdline);
  const activeOwnerPath = (activeResult?.owner?.path || "").toLowerCase();
  const autoGameAw =
    autoDetectGames &&
    !!activeOwnerPath &&
    !isZenithOwnExePath(activeOwnerPath) &&
    foregroundLooksLikeGame(activeOwnerPath);

  if (
    (listedPs && fullscreenPs) ||
    (listedAw && fullscreenAw) ||
    (autoGamePs && fullscreenPs) ||
    (autoGameAw && fullscreenAw)
  ) {
    diagLog(
      `[GameMode] Blocked: protected fullscreen app (listPs=${!!(listedPs && fullscreenPs)} listAw=${!!(listedAw && fullscreenAw)} autoPs=${!!(autoGamePs && fullscreenPs)} autoAw=${!!(autoGameAw && fullscreenAw)})`,
    );
    return false;
  }

  return true;
};

let tray = null;

/**
 * Checks GitHub Releases for a newer NSIS build.  This is deliberately disabled
 * in development: `latest.yml` only exists beside a published installer.
 */
/**
 * The renderer needs to know there is an update so it can flag it on the wheel — a badge on the
 * hub, which the user sees when the menu opens, without anyone interrupting what they are doing.
 */
/**
 * Updater state, in ONE place.
 *
 * The panel and the tray used to read two different things: a "there is a version ready" coming
 * from the event, and a "Check for updates" button that was always there, even with the installer
 * already on disk. Pressing it downloaded again what was already downloaded and put the row back
 * into "downloading" — the UI moved backwards. Now there is a single state machine, and whoever
 * paints (`update-state`) and whoever acts (`check-for-updates`) both read it.
 *
 * `idle`        never checked in this session
 * `checking`    request in flight
 * `current`     checked, nothing new (`checkedAt` says when)
 * `downloading` transferring (`percent`, when the server gives a size)
 * `ready`       downloaded and verified — only a restart is missing. FINAL state: nothing goes back
 * `error`       the last check failed (network, server, signature)
 * @type {{ state: string, version: string|null, percent?: number, checkedAt?: number, error?: string }}
 */
let lastKnownUpdate = { state: "idle", version: null };

/** Check in flight — the second request joins the first instead of opening another. */
let pendingUpdateCheck = null;

function notifyRendererUpdateState(state, version, extra = {}) {
  /**
   * `ready` is terminal. The installer is already on disk and `quitAndInstall` still works; a later
   * network error (or a periodic check that fails) must not wipe from the UI the only button that
   * matters — nor make the row regress to "downloading".
   */
  if (lastKnownUpdate.state === "ready" && state !== "ready") return;

  const previous = lastKnownUpdate;
  lastKnownUpdate = { state, version: version ?? null, ...extra };
  /**
   * The tray shows the same state as the panel — but only when it CHANGES. The native menu is
   * rebuilt whole on every `setContextMenu`, and `download-progress` fires dozens of times:
   * rebuilding it on each percentage point is pure work, and it flickers if it is open.
   */
  if (previous.state !== state || previous.version !== lastKnownUpdate.version) refreshTrayMenuRef();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    sendToSettings("update-state", { ...lastKnownUpdate });
    sendToOverlay("update-state", { ...lastKnownUpdate });
  } catch (e) {
    /* ignore */
  }
}

/** The app lives in the tray for days: checking only once at startup is not enough. */
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

function configureAutoUpdates() {
  if (!isPackagedBuild || process.platform !== "win32") return;

  /**
   * Store build: we do not even register the listeners. Not calling `checkForUpdates` is not
   * enough — `autoInstallOnAppQuit` would leave the installer running on exit, which is exactly
   * the behaviour certification looks for.
   */
  if (isStoreBuild()) {
    diagLog("[Update] Store build — updater disabled");
    return;
  }

  /** Past the guards, so this is the first point the module is genuinely needed. */
  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = true;
  /**
   * OFF on purpose. This is the flag that installed the update in the background of the exit and
   * turned the very next launch into a race the user lost — see `installPendingUpdateAndExit`,
   * which now owns the install and runs it before any of the app exists.
   */
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("error", (error) => {
    diagLog(`[Update] ${error?.message || error}`);
    /** Already downloaded: `notify` protects the `ready` state, and a repaint is not even worth it. */
    notifyRendererUpdateState("error", lastKnownUpdate.version, {
      error: error?.message || String(error),
    });
  });

  autoUpdater.on("checking-for-update", () => {
    notifyRendererUpdateState("checking", lastKnownUpdate.version);
  });

  /** Nothing new: saying it was checked is worth more than staying silent on `idle`. */
  autoUpdater.on("update-not-available", () => {
    notifyRendererUpdateState("current", app.getVersion(), { checkedAt: Date.now() });
  });

  autoUpdater.on("update-available", (info) => {
    diagLog(`[Update] Downloading version ${info.version}`);
    notifyRendererUpdateState("downloading", info.version, { checkedAt: Date.now() });
  });

  autoUpdater.on("download-progress", (progress) => {
    const raw = Number(progress?.percent);
    if (!Number.isFinite(raw)) return;
    const percent = Math.max(0, Math.min(100, Math.round(raw)));
    /** To the percentage point: the event arrives dozens of times a second, the UI only shows integers. */
    if (lastKnownUpdate.percent === percent) return;
    /** Only the number changes; keep the rest of the state so `checkedAt` is not lost. */
    notifyRendererUpdateState("downloading", lastKnownUpdate.version, {
      checkedAt: lastKnownUpdate.checkedAt,
      percent,
    });
  });

  /**
   * No native box.
   *
   * The system dialog appeared on top of whatever the user was doing, with Windows' own look and
   * text in a different language from the rest of the app — and for something that is not urgent:
   * the update is ALREADY downloaded and installs itself on exit. The notice moved to where it does
   * not interrupt: the badge on the radial's hub, and a row in Settings with the action.
   */
  autoUpdater.on("update-downloaded", (info) => {
    diagLog(`[Update] Downloaded version ${info.version}`);
    /**
     * The note the next launch reads. Written here and not on quit, because a crash, a reboot and a
     * kill from Task Manager are all exits too — and every one of them should still come back on
     * the new version.
     *
     * A note for the SAME version keeps its attempt counter: electron-updater re-emits this event
     * from its cache in every later session, and a reset counter would hand a broken installer
     * unlimited retries.
     */
    const installerPath = info?.downloadedFile;
    if (typeof installerPath === "string" && installerPath) {
      const previous = readPendingUpdate();
      const sameFile = previous?.version === info.version && previous?.installerPath === installerPath;
      writePendingUpdate({
        version: info.version,
        installerPath,
        downloadedAt: Date.now(),
        attempts: sameFile ? Number(previous.attempts) || 0 : 0,
        lastAttemptAt: sameFile ? Number(previous.lastAttemptAt) || 0 : 0,
        gaveUp: sameFile ? previous.gaveUp === true : false,
      });
    }
    notifyRendererUpdateState("ready", info.version, { checkedAt: Date.now() });
  });

  // Let the UI finish starting before the network request begins.
  setTimeout(() => {
    void runUpdateCheck();
  }, 10_000).unref?.();

  /**
   * Periodic re-check. Stops once there is something on disk: from `ready` on there is nothing a
   * check could discover, and `runUpdateCheck` would refuse it anyway.
   */
  setInterval(() => {
    if (lastKnownUpdate.state === "ready" || lastKnownUpdate.state === "downloading") return;
    void runUpdateCheck();
  }, UPDATE_RECHECK_INTERVAL_MS).unref?.();
}

app.whenReady().then(async () => {
  if (!gotTheLock || pendingUpdateInstallStarted) return;

  /**
   * Compiles/initializes the helper while idle; when the radial opens the block lands with no delay.
   *
   * AFTER `gotTheLock`: a second instance is about to close itself, and starting the helper here
   * left a `powershell` with a global WH_MOUSE_LL hook hanging off a startup that was rejected.
   * `setRadialMouseBlocking` and `setRadialTriggerCapture` also guarantee it, so this call is only
   * a warm-up — never the only one.
   */
  ensureRadialMouseBlocker();

  configureAutoUpdates();

  /**
   * Starts the foreground helper during startup, for the same reason the mouse blocker starts
   * here: its first run compiles the P/Invoke types and takes about 750ms, which must not land on
   * the radial's very first trigger. It would have started within seconds anyway — the first open
   * asks it to steal the foreground — so this moves the cost rather than adding it.
   */
  ensureForegroundFocusHelper();

  try {
    const codeCacheDir = path.join(app.getPath("userData"), "v8-code-cache");
    fs.mkdirSync(codeCacheDir, { recursive: true });
    session.defaultSession.setCodeCachePath(codeCacheDir);
    diagLog(`[Perf] V8 code cache: ${codeCacheDir}`);
  } catch (e) {
    diagLog(`[Perf] V8 code cache setup failed: ${e.message}`);
  }

  try {
    diagLog(`[Persist] userData=${app.getPath("userData")}`);
  } catch (e) {
    diagLog(`[Persist] userData path unavailable: ${e.message}`);
  }


  // 1. Initialize Settings Management First (to avoid race conditions with renderer)
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  let currentSettings = {
    globalShortcut: "Alt+Z",
    shortcutTriggerMode: "toggle",
    enableKeyboardTrigger: true,
    enableMouseTrigger: true,
    mouseTriggerMode: "click",
    mouseTriggerButton: "middle",
    /**
     * On — for installs that begin with it.
     *
     * A launcher that has to be started by hand is not there when the wheel is reached for, so a
     * new install signs in ready. It costs nothing visible: a login start stays in the tray (see
     * `LOGIN_LAUNCH_ARG`) rather than opening Settings the way a manual launch does.
     *
     * Profiles that predate this default are deliberately left alone — see `loadSettings`.
     */
    openAtLogin: true,
  };

  const syncLoginItemSettings = (openAtLogin) => {
    try {
      /**
       * Never from an unpackaged run. The exe is the shared development Electron binary there, and
       * a Run entry pointing at it starts a checkout — or a throwaway smoke-test profile — with
       * Windows on the machine of whoever last launched one. Only an installed Rovyl owns a
       * startup entry; the setting itself is still stored and still shown.
       */
      if (!isPackagedBuild) {
        diagLog(`[Startup] Unpackaged run: login item untouched (openAtLogin = ${openAtLogin}).`);
        return;
      }
      if (typeof openAtLogin === "boolean") {
        /**
         * Asked WITH the path and the argument: on Windows that reports whether the registered
         * entry is this exact command line, so a Run key left by an older version — same exe, no
         * argument — reads as absent and is rewritten once. Without that, Rovyl would go on
         * starting at login with nothing to tell that login apart from a double-click.
         */
        const loginItem = {
          path: app.getPath("exe"),
          args: [LOGIN_LAUNCH_ARG],
        };
        const currentLoginSettings = app.getLoginItemSettings(loginItem);
        if (currentLoginSettings.openAtLogin !== openAtLogin) {
          app.setLoginItemSettings({
            ...loginItem,
            openAtLogin: openAtLogin,
          });
          console.log(
            `Login item settings synced: openAtLogin = ${openAtLogin}`,
          );
        }
      }
    } catch (e) {
      console.error("Failed to sync login item settings:", e);
    }
  };

  /** Set by `loadSettings`: no settings.json on disk, so this run is the install's first. */
  let isFirstRun = false;

  const loadSettings = () => {
    try {
      if (!fs.existsSync(settingsPath)) {
        isFirstRun = true;
        return;
      }
      const data = fs.readFileSync(settingsPath, "utf-8");
      const stored = JSON.parse(data);
      if (!stored || typeof stored !== "object") return;
      currentSettings = { ...currentSettings, ...stored };
      /**
       * "Start with Windows" is on by default, but only for installs that begin that way. A
       * settings file written before the default changed belongs to somebody who has been using
       * Rovyl without it, and nobody should find a new entry in their startup list because they
       * updated.
       *
       * The test is the ABSENT key, not the value: an explicit `false` is already carried over by
       * the spread, and every file this version writes names the key either way.
       */
      if (!("openAtLogin" in stored)) currentSettings.openAtLogin = false;
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  };

  /** Merge UI fields used by registerGlobalShortcut; workspaces stay in memory only (not written to settings.json). */
  const applyUiConfigToCurrentSettings = (ui) => {
    if (!ui || typeof ui !== "object") return;
    if (typeof ui.globalShortcut === "string" && ui.globalShortcut.trim()) {
      currentSettings.globalShortcut = ui.globalShortcut.trim();
    }
    if (ui.shortcutTriggerMode === "click" || ui.shortcutTriggerMode === "hold" || ui.shortcutTriggerMode === "toggle") {
      currentSettings.shortcutTriggerMode = ui.shortcutTriggerMode;
      if (cachedRadialFlags) cachedRadialFlags.shortcutTriggerMode = ui.shortcutTriggerMode;
    }
    if (typeof ui.enableKeyboardTrigger === "boolean") {
      currentSettings.enableKeyboardTrigger = ui.enableKeyboardTrigger;
    }
    if (typeof ui.enableMouseTrigger === "boolean") {
      currentSettings.enableMouseTrigger = ui.enableMouseTrigger;
    }
    if (ui.mouseTriggerMode === "click" || ui.mouseTriggerMode === "hold") {
      currentSettings.mouseTriggerMode = ui.mouseTriggerMode;
    }
    const uiTriggerButton = normalizeMouseTrigger(ui.mouseTriggerButton);
    if (uiTriggerButton) {
      currentSettings.mouseTriggerButton = uiTriggerButton;
    }
    if (typeof ui.openAtLogin === "boolean") {
      currentSettings.openAtLogin = ui.openAtLogin;
    }
    if (Array.isArray(ui.workspaces)) {
      currentSettings.workspaces = ui.workspaces;
    }
    if (Number.isInteger(ui.activeWorkspaceIndex)) {
      currentSettings.activeWorkspaceIndex = ui.activeWorkspaceIndex;
    }
    /**
     * The tray menu names the workspaces and ticks the current one, and a menu is a snapshot: it
     * has to be rebuilt or it goes on showing the set that existed when it was built. Cheap, and
     * this runs on config saves rather than on anything hot.
     */
    refreshTrayMenuRef();
  };

  const saveSettings = (newSettings) => {
    try {
      currentSettings = { ...currentSettings, ...newSettings };
      const slim = {
        globalShortcut: currentSettings.globalShortcut || "Alt+Z",
        enableKeyboardTrigger: currentSettings.enableKeyboardTrigger !== false,
        enableMouseTrigger: currentSettings.enableMouseTrigger !== false,
        mouseTriggerMode:
          currentSettings.mouseTriggerMode === "hold" ? "hold" : "click",
        mouseTriggerButton:
          normalizeMouseTrigger(currentSettings.mouseTriggerButton) || DEFAULT_MOUSE_TRIGGER,
        openAtLogin: !!currentSettings.openAtLogin,
      };
      fs.writeFileSync(settingsPath, JSON.stringify(slim, null, 2));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  /**
   * Serves `rovyl-icon://icon/<sha256>.<ext>` out of userData/icons. Registered on the default
   * session, which is the one the window uses — it sets no `partition`, and a partitioned session
   * would need its own registration.
   *
   * The filename is validated by `refToFilename` BEFORE it is joined to a path, so a crafted URL
   * cannot walk out of the store directory; anything that is not 64 lowercase hex plus a known
   * image extension is refused outright rather than sanitised.
   */
  try {
    protocol.handle(ICON_SCHEME, async (request) => {
      try {
        const parsed = new URL(request.url);
        if (parsed.host !== iconStore.host) return new Response(null, { status: 404 });
        const filename = iconStore.refToFilename(`${ICON_SCHEME}://${iconStore.host}${parsed.pathname}`);
        if (!filename) return new Response(null, { status: 400 });
        const bytes = await fs.promises.readFile(path.join(iconStore.dir, filename));
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": iconStore.mimeForFilename(filename),
            /** Honest only because the name IS the hash of the contents: it can never go stale. */
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        /** A missing file is a missing icon: 404 lets <img onError> fall back to the glyph. */
        return new Response(null, { status: 404 });
      }
    });
    iconStore.ensureDir();
  } catch (e) {
    diagLog(`[IconStore] protocol.handle failed: ${e.message}`);
  }

  loadSettings();
  loadIconCache();

  /**
   * Collect icon files nothing points at any more, once, a minute after launch.
   *
   * Roots are scraped from the RAW TEXT of every config file rather than from parsed objects, for
   * three reasons that each cost icons if ignored: the workspace tree is mirrored under
   * `workspaces`, `config.workspaces` and `apps`, so a shape-aware walker can miss a copy; a
   * quarantined `.broken-*.json` exists precisely so a user can recover from it, and recovering
   * without icons would be a hollow recovery, but it is by definition unparseable; and raw text
   * stays correct when the persistence shape changes again.
   *
   * Deliberately not scanned: the three `localStorage` mirrors, which live inside Chromium's
   * LevelDB. The seven-day grace inside `sweep` covers the window in which they could disagree
   * with disk, and the worst outcome is one glyph instead of one icon.
   */
  setTimeout(() => {
    void (async () => {
      try {
        const userData = app.getPath("userData");
        const roots = new Set();
        for (const name of fs.readdirSync(userData)) {
          if (!name.startsWith("config-v2.json")) continue;
          try {
            iconStore.collectRefFilenames(fs.readFileSync(path.join(userData, name), "utf-8"), roots);
          } catch (e) {
            /** Unreadable root file: bail out entirely rather than sweep against a partial set. */
            diagLog(`[IconStore] sweep aborted, could not read ${name}: ${e.message}`);
            return;
          }
        }
        for (const entry of iconCache.values()) {
          const value = entry && typeof entry === "object" ? entry.data : entry;
          const filename = iconStore.refToFilename(value);
          if (filename) roots.add(filename);
        }
        const result = await iconStore.sweep({ rootFilenames: roots });
        if (result.deleted) diagLog(`[IconStore] swept ${result.deleted} unreferenced icons`);
      } catch (e) {
        diagLog(`[IconStore] sweep failed: ${e.message}`);
      }
    })();
  }, 60_000).unref?.();

  /**
   * First run of a fresh install: write the defaults out now, so starting with Windows is a stored
   * choice from this moment on. Without it the default would be re-derived on every launch until
   * something else happened to save, and this file is also what tells the NEXT version that this
   * profile has already answered the question.
   */
  if (isFirstRun) saveSettings({});

  if (currentSettings.openAtLogin !== undefined) {
    syncLoginItemSettings(currentSettings.openAtLogin);
  }

  /** Used with the non-blocking middle-button state monitor. */
  const cachedRadialFlags = {
    enableMouseTrigger: currentSettings.enableMouseTrigger !== false,
    mouseTriggerMode:
      currentSettings.mouseTriggerMode === "hold" ? "hold" : "click",
    shortcutTriggerMode:
      currentSettings.shortcutTriggerMode === "hold" ? "hold" : "toggle",
    mouseTriggerButton:
      normalizeMouseTrigger(currentSettings.mouseTriggerButton) || DEFAULT_MOUSE_TRIGGER,
    performanceMode: false,
  };
  try {
    const cp = path.join(app.getPath("userData"), "config-v2.json");
    if (fs.existsSync(cp)) {
      const fc = JSON.parse(fs.readFileSync(cp, "utf-8"));
      if (typeof fc.performanceMode === "boolean") {
        cachedRadialFlags.performanceMode = fc.performanceMode;
      }
      if (typeof fc.enableMouseTrigger === "boolean") {
        cachedRadialFlags.enableMouseTrigger = fc.enableMouseTrigger;
      }
      if (fc.mouseTriggerMode === "click" || fc.mouseTriggerMode === "hold") {
        cachedRadialFlags.mouseTriggerMode = fc.mouseTriggerMode;
      }
      if (fc.shortcutTriggerMode === "click" || fc.shortcutTriggerMode === "hold" || fc.shortcutTriggerMode === "toggle") {
        cachedRadialFlags.shortcutTriggerMode = fc.shortcutTriggerMode;
      }
      const fileTriggerButton = normalizeMouseTrigger(fc.mouseTriggerButton);
      if (fileTriggerButton) {
        cachedRadialFlags.mouseTriggerButton = fileTriggerButton;
      }
      /**
       * Seeded from disk, not awaited from the renderer. The global shortcut is registered before
       * React has committed anything, and on a cold start pressing it is the FIRST thing that
       * happens — without this the first wheel of every session would open on the primary monitor
       * no matter what the user chose.
       */
      applyRadialMonitorSetting(fc.radialMonitor);
      applyRadialPlacementSetting(fc.radialPlacement);
      const ui = extractUiConfigFromPersistenceBlob(fc);
      if (ui) {
        // Authoritative UI state lives in config-v2.json — win over stale settings.json (fixes shortcut/sync races).
        applyUiConfigToCurrentSettings(ui);
        if (typeof ui.performanceMode === "boolean") {
          cachedRadialFlags.performanceMode = ui.performanceMode;
        }
        if (typeof ui.enableMouseTrigger === "boolean") {
          cachedRadialFlags.enableMouseTrigger = ui.enableMouseTrigger;
        }
        if (ui.mouseTriggerMode === "click" || ui.mouseTriggerMode === "hold") {
          cachedRadialFlags.mouseTriggerMode = ui.mouseTriggerMode;
        }
        applyRadialMonitorSetting(ui.radialMonitor);
        applyRadialPlacementSetting(ui.radialPlacement);
        if (ui.shortcutTriggerMode === "click" || ui.shortcutTriggerMode === "hold" || ui.shortcutTriggerMode === "toggle") {
          cachedRadialFlags.shortcutTriggerMode = ui.shortcutTriggerMode;
        }
        mergeGameModeConfig(ui.gameMode);
      }
    }
  } catch (_) {}

  let syncMouseHookState = () => {};

  /** Assigned after registerGlobalShortcut(); refreshes OS shortcuts when renderer saves config-v2. */
  let refreshShortcutsFromFullConfig = null;

  // Register essential IPC handlers BEFORE window creation
  ipcMain.handle("get-settings", () => currentSettings);

  /** Flush temp / final file to disk — reduces loss on crash/reboot right after save (Windows). */
  const fsyncFileBestEffort = (filePath) => {
    try {
      if (!fs.existsSync(filePath)) return;
      const fd = fs.openSync(filePath, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      diagLog(`[Persist] fsync ${path.basename(filePath)}: ${e.message}`);
    }
  };

  /** @returns {boolean} */
  const saveFullConfigToDisk = (config) => {
    const configPath = path.join(app.getPath("userData"), "config-v2.json");
    const tempPath = configPath + ".tmp";
    let toWrite = config;
    try {
      if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
      }

      if (process.platform === "win32" && config && typeof config === "object") {
        try {
          toWrite = JSON.parse(JSON.stringify(config));
          win32Launch.normalizePersistedPayloadWin32(toWrite);
        } catch (e) {
          diagLog(`[Persist] win32 command normalize (clone) failed: ${e.message}`);
        }
      }

      /** Same net as the async writer above, for the synchronous shutdown path. */
      try {
        iconStore.externalizeBlob(toWrite);
      } catch (e) {
        diagLog(`[IconStore] externalize before write (sync): ${e.message}`);
      }

      const json = JSON.stringify(toWrite, null, 2);
      fs.writeFileSync(tempPath, json, "utf-8");
      fsyncFileBestEffort(tempPath);

      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        try {
          if (fs.existsSync(configPath) && fs.statSync(configPath).size > 0) {
            fs.copyFileSync(configPath, `${configPath}.bak`);
          }
        } catch (e) {
          diagLog(`[Persist] config-v2.json backup: ${e.message}`);
        }
        fs.renameSync(tempPath, configPath);
        fsyncFileBestEffort(configPath);
        try {
          const sz = fs.statSync(configPath).size;
          diagLog(`[Persist] save-full-config ok path=${configPath} bytes=${sz}`);
        } catch (_) {
          diagLog(`[Persist] save-full-config ok path=${configPath}`);
        }
        return true;
      }
      throw new Error("Temp file is empty or missing after write");
    } catch (e) {
      console.error("Failed to save full config (Atomic):", e);
      diagLog(`[ERROR] Persistence Failure: ${e.message}`);
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        fsyncFileBestEffort(configPath);
        return fs.existsSync(configPath) && fs.statSync(configPath).size > 0;
      } catch (e2) {
        /* ignore */
      }
      return false;
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (e) {
        /* ignore */
      }
    }
  };

  /**
   * The normal save path: async, serialized and without rewriting identical content.
   *
   * The synchronous version above still exists — it is the right one for the exit flush, where
   * there is no event loop left to wait on. But using it for EVERY change put ~1.2 MB of
   * `JSON.stringify` + `writeFile` + two `fsync`s on the main process, which is the same process
   * that serves the IPC that opens the radial: that is where stutters with no visible cause came from.
   *
   * Three defences, in order of value:
   *   1. content hash — the renderer saves on every state change, and much of it is identical;
   *   2. serialization — without it two saves competed for the same `.tmp` file;
   *   3. coalescing — if several arrive during a save, only the last one matters.
   */
  const fsp = fs.promises;
  let configWritePending = null;
  let configWriteLoop = null;
  let lastConfigWriteOk = true;
  let lastConfigWriteHash = null;

  const fsyncFileBestEffortAsync = async (filePath) => {
    let handle = null;
    try {
      handle = await fsp.open(filePath, "r+");
      await handle.sync();
    } catch (e) {
      diagLog(`[Persist] fsync ${path.basename(filePath)}: ${e.message}`);
    } finally {
      try {
        await handle?.close();
      } catch (e) {
        /* ignore */
      }
    }
  };

  const writeFullConfigAsync = async (config) => {
    const configPath = path.join(app.getPath("userData"), "config-v2.json");
    const tempPath = configPath + ".tmp";
    let toWrite = config;
    try {
      await fsp.mkdir(path.dirname(configPath), { recursive: true });

      if (process.platform === "win32" && config && typeof config === "object") {
        try {
          toWrite = JSON.parse(JSON.stringify(config));
          win32Launch.normalizePersistedPayloadWin32(toWrite);
        } catch (e) {
          diagLog(`[Persist] win32 command normalize (clone) failed: ${e.message}`);
        }
      }

      /**
       * Net, not the main mechanism: the read path already hands the renderer references, so a
       * `data:` URL reaching here means something produced one that never went through the store.
       * Externalising is idempotent — identical bytes hash to the name they already have — so on
       * the normal path this walk changes nothing and writes nothing.
       */
      try {
        iconStore.externalizeBlob(toWrite);
      } catch (e) {
        diagLog(`[IconStore] externalize before write: ${e.message}`);
      }

      const json = JSON.stringify(toWrite, null, 2);
      const hash = crypto.createHash("sha1").update(json).digest("hex");
      const bytes = Buffer.byteLength(json, "utf-8");
      /**
       * Skipping the write takes two proofs: the content is the same as what we saved AND the file
       * on disk is still that one. Without the second, a primary replaced from outside (which is
       * what happened on Aug 12) would stay stale forever — the app would never rewrite it again.
       */
      if (hash === lastConfigWriteHash) {
        const current = await fsp.stat(configPath).catch(() => null);
        if (current && current.size === bytes) return true;
        diagLog("[Persist] Primary diverged from the last save — rewriting.");
      }

      await fsp.writeFile(tempPath, json, "utf-8");
      await fsyncFileBestEffortAsync(tempPath);

      const tempStat = await fsp.stat(tempPath).catch(() => null);
      if (!tempStat || tempStat.size === 0) {
        throw new Error("Temp file is empty or missing after write");
      }

      try {
        const primaryStat = await fsp.stat(configPath).catch(() => null);
        if (primaryStat && primaryStat.size > 0) {
          await fsp.copyFile(configPath, `${configPath}.bak`);
        }
      } catch (e) {
        diagLog(`[Persist] config-v2.json backup: ${e.message}`);
      }

      await fsp.rename(tempPath, configPath);
      await fsyncFileBestEffortAsync(configPath);
      lastConfigWriteHash = hash;
      diagLog(`[Persist] save-full-config ok (async) path=${configPath} bytes=${tempStat.size}`);
      return true;
    } catch (e) {
      console.error("Failed to save full config (async):", e);
      diagLog(`[ERROR] Persistence Failure (async): ${e.message}`);
      /** Last resort is the already proven synchronous path — losing the config is worse than a stutter. */
      lastConfigWriteHash = null;
      return saveFullConfigToDisk(config);
    } finally {
      try {
        if (fs.existsSync(tempPath)) await fsp.unlink(tempPath);
      } catch (e) {
        /* ignore */
      }
    }
  };

  const runConfigWriteLoop = async () => {
    try {
      while (configWritePending !== null) {
        const payload = configWritePending;
        configWritePending = null;
        lastConfigWriteOk = await writeFullConfigAsync(payload);
      }
    } finally {
      configWriteLoop = null;
    }
  };

  /** @returns {Promise<boolean>} */
  const saveFullConfigToDiskAsync = async (config) => {
    configWritePending = config;
    if (!configWriteLoop) configWriteLoop = runConfigWriteLoop();
    await configWriteLoop;
    return lastConfigWriteOk;
  };

  const applyPersistedFullConfigSideEffects = (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.performanceMode === "boolean") {
      cachedRadialFlags.performanceMode = payload.performanceMode;
    }
    if (typeof payload.enableMouseTrigger === "boolean") {
      cachedRadialFlags.enableMouseTrigger = payload.enableMouseTrigger;
    }
    if (payload.mouseTriggerMode === "click" || payload.mouseTriggerMode === "hold") {
      cachedRadialFlags.mouseTriggerMode = payload.mouseTriggerMode;
    }
    const payloadTriggerButton = normalizeMouseTrigger(payload.mouseTriggerButton);
    if (payloadTriggerButton) {
      cachedRadialFlags.mouseTriggerButton = payloadTriggerButton;
    }
    applyRadialMonitorSetting(payload.radialMonitor);
    applyRadialPlacementSetting(payload.radialPlacement);
    const ui = extractUiConfigFromPersistenceBlob(payload);
    if (ui) {
      applyUiConfigToCurrentSettings(ui);
      saveSettings({});
      if (typeof ui.openAtLogin === "boolean") {
        syncLoginItemSettings(ui.openAtLogin);
      }
      if (typeof ui.performanceMode === "boolean") {
        cachedRadialFlags.performanceMode = ui.performanceMode;
      }
      if (typeof ui.enableMouseTrigger === "boolean") {
        cachedRadialFlags.enableMouseTrigger = ui.enableMouseTrigger;
      }
      if (ui.mouseTriggerMode === "click" || ui.mouseTriggerMode === "hold") {
        cachedRadialFlags.mouseTriggerMode = ui.mouseTriggerMode;
      }
      const uiTriggerButton = normalizeMouseTrigger(ui.mouseTriggerButton);
      if (uiTriggerButton) {
        cachedRadialFlags.mouseTriggerButton = uiTriggerButton;
      }
      /**
       * Belt and braces with `set-radial-viewport`: that effect only fires on the keys it depends
       * on, and a save is the one event guaranteed to carry the whole config.
       */
      applyRadialMonitorSetting(ui.radialMonitor);
      applyRadialPlacementSetting(ui.radialPlacement);
      mergeGameModeConfig(ui.gameMode);
    }
    syncMouseHookState();
    try {
      refreshShortcutsFromFullConfig?.();
    } catch (e) {
      diagLog(`[Persist] refreshShortcutsFromFullConfig: ${e.message}`);
    }
  };

  /** Synchronous path — only for the exit flush. Invalidates the hash: the async one cannot assume state. */
  const persistFullConfigFromRenderer = (payload) => {
    const ok = saveFullConfigToDisk(payload);
    lastConfigWriteHash = null;
    applyPersistedFullConfigSideEffects(payload);
    return ok;
  };

  /** Normal path — the side effects apply right away; only the trip to disk waits. */
  const persistFullConfigFromRendererAsync = async (payload) => {
    applyPersistedFullConfigSideEffects(payload);
    return saveFullConfigToDiskAsync(payload);
  };

  /**
   * Moves legacy `data:` icons out of the config file on disk, before it is read.
   *
   * On the read path and not the write path on purpose. Converting on write would shrink the file
   * but leave the renderer holding the base64 in React state, still mirroring it into three
   * `localStorage` keys on every debounced save — which is most of what the backlog item measures.
   * Converting here means the very first hydration after upgrade hands the renderer references.
   *
   * It runs OUTSIDE the try below, whose catch renames `config-v2.json` to `.broken-<ts>.json`: a
   * throw in here would quarantine a perfectly healthy config. It catches everything itself, and
   * its worst outcome is "still fat", never "config gone".
   */
  const migrateConfigIconsToStore = (configPath) => {
    try {
      if (!fs.existsSync(configPath)) return 0;
      const raw = fs.readFileSync(configPath, "utf-8");
      const hasInline = raw.includes("data:image");
      /**
       * References are re-checked on every load, not just on the first migration. Dropping one
       * whose file has gone is the only thing that lets the renderer heal it: to the healing pass
       * any non-empty `customIconUrl` reads as "this one has an icon", so a dead reference would
       * sit there as a broken image forever. Costs one stat per distinct reference per launch.
       */
      if (!hasInline && !raw.includes(`${iconStore.scheme}://`)) return 0;
      const blob = JSON.parse(raw);
      const rollback = `${configPath}.pre-icons.bak`;
      /** Only worth keeping for the one-way conversion; a reference-only config is already small. */
      if (hasInline && !fs.existsSync(rollback)) fs.copyFileSync(configPath, rollback);
      const { changed, converted, dropped, failed } = iconStore.externalizeBlob(blob);
      if (!changed) return 0;
      /** Not `${configPath}.tmp` — that name belongs to the config writer and to import. */
      const temp = `${configPath}.icons.tmp`;
      fs.writeFileSync(temp, JSON.stringify(blob, null, 2), "utf-8");
      fs.renameSync(temp, configPath);
      diagLog(
        `[IconStore] config rewrite: ${converted} icons stored, ${dropped} dangling dropped, ${failed} unreadable kept — ${raw.length}B -> ${fs.statSync(configPath).size}B`,
      );
      return converted + dropped;
    } catch (e) {
      diagLog(`[IconStore] config migration skipped: ${e.message}`);
      return 0;
    }
  };

  ipcMain.handle("get-full-config", () => {
    try {
      const configPath = path.join(app.getPath("userData"), "config-v2.json");
      const bakPath = `${configPath}.bak`;

      migrateConfigIconsToStore(configPath);

      const quarantineUnreadablePrimary = (err) => {
        try {
          if (fs.existsSync(configPath)) {
            const bad = `${configPath}.broken-${Date.now()}.json`;
            fs.renameSync(configPath, bad);
            diagLog(
              `[Persist] Quarantined unreadable config-v2.json → ${path.basename(bad)} (${err.message})`,
            );
          }
        } catch (e) {
          diagLog(`[Persist] Quarantine primary failed: ${e.message}`);
        }
      };

      const loadShapeAndWin32 = (filePath, label) => {
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        const shaped = normalizeFullPersistenceBlob(parsed);
        if (!shaped) {
          diagLog(
            `[Persist] get-full-config ${label}: JSON ok but shape invalid (missing workspaces?) path=${filePath}`,
          );
          return null;
        }
        return shaped;
      };

      try {
        if (fs.existsSync(configPath)) {
          const st = fs.statSync(configPath);
          const loaded = loadShapeAndWin32(configPath, "primary");
          if (loaded) {
            diagLog(
              `[Persist] load ok source=primary path=${configPath} bytes=${st.size}`,
            );
            return loaded;
          }
        }
      } catch (e) {
        console.error("Failed to load primary config:", e);
        diagLog(
          `[Persist] get-full-config primary unreadable (${e.message}) — attempting quarantine`,
        );
        quarantineUnreadablePrimary(e);
      }
      try {
        if (fs.existsSync(bakPath)) {
          const st = fs.statSync(bakPath);
          const loaded = loadShapeAndWin32(bakPath, "bak");
          if (loaded) {
            diagLog(
              `[Persist] load ok source=bak path=${bakPath} bytes=${st.size}`,
            );
            return loaded;
          }
        }
      } catch (e2) {
        console.error("Failed to load backup config:", e2);
        diagLog(`[Persist] get-full-config bak failed: ${e2.message}`);
      }
      diagLog(
        `[Persist] load miss: no readable v2 config (primaryExists=${fs.existsSync(configPath)} bakExists=${fs.existsSync(bakPath)} quarantineBytes=${sumQuarantinedConfigBytes(path.dirname(configPath))})`,
      );
      return null;
    } catch (criticalErr) {
      diagLog(`[Persist] get-full-config critical error: ${criticalErr.message}`);
      return null;
    }
  });

  ipcMain.handle("get-config-persistence-meta", () => {
    const configPath = path.join(app.getPath("userData"), "config-v2.json");
    const bakPath = `${configPath}.bak`;
    const userDataDir = path.dirname(configPath);
    try {
      const primaryBytes =
        fs.existsSync(configPath) && fs.statSync(configPath).isFile()
          ? fs.statSync(configPath).size
          : 0;
      const backupBytes =
        fs.existsSync(bakPath) && fs.statSync(bakPath).isFile()
          ? fs.statSync(bakPath).size
          : 0;
      const quarantineBytes = sumQuarantinedConfigBytes(userDataDir);
      return { primaryBytes, backupBytes, quarantineBytes };
    } catch (e) {
      diagLog(`[Persist] get-config-persistence-meta: ${e.message}`);
      return { primaryBytes: 0, backupBytes: 0, quarantineBytes: 0 };
    }
  });

  /**
   * Tell the wheel the file it reads has changed.
   *
   * The overlay hydrates from `get-full-config` at boot and then follows this. It never writes, so
   * there is no merge to do and no race to lose: whatever the writer just saved is, by definition,
   * the truth. Sending the whole blob rather than a diff is deliberate — the wheel then runs it
   * through the same `normalizeStoredConfig` as a cold start, so the two windows cannot drift.
   */
  const broadcastConfigToOverlay = (payload) => {
    if (!payload || typeof payload !== "object") return;
    sendToOverlay("config-changed", payload);
  };

  /** invoke: main processes and writes before the renderer moves on — more reliable than `send` while the app is closing. */
  ipcMain.handle("save-full-config", async (_event, payload) => {
    try {
      if (!payload || typeof payload !== "object") {
        return { ok: false, error: "invalid payload" };
      }
      const ok = await persistFullConfigFromRendererAsync(payload);
      if (ok) broadcastConfigToOverlay(payload);
      return ok ? { ok: true } : { ok: false, error: "write failed" };
    } catch (e) {
      diagLog(`[Persist] save-full-config handle: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  /** Synchronous IPC so the renderer can flush to disk before process exit (notes, etc.). */
  ipcMain.on("save-full-config-sync", (event, payload) => {
    try {
      if (!payload || typeof payload !== "object") {
        event.returnValue = false;
        return;
      }
      const ok = persistFullConfigFromRenderer(payload);
      if (ok) broadcastConfigToOverlay(payload);
      event.returnValue = ok;
    } catch (e) {
      diagLog(`[Persist] save-full-config-sync: ${e.message}`);
      event.returnValue = false;
    }
  });

  /**
   * IPC: Persistence Debug Logger.
   * It used to be `appendFileSync` on every save — synchronous I/O on main for the same reason as
   * the config, and with no size cap. Now it is async and rotates into a previous generation past 1 MB.
   */
  const PERSIST_LOG_MAX_BYTES = 1024 * 1024;
  let persistLogBytes = null;
  ipcMain.on("save-persistence-log", (event, message) => {
    try {
      const logPath = path.join(app.getPath("userData"), "rovyl-persistence.log");
      const logEntry = `[${new Date().toISOString()}] ${message}\n`;
      const size = Buffer.byteLength(logEntry, "utf-8");
      if (persistLogBytes === null) {
        persistLogBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      }
      if (persistLogBytes + size > PERSIST_LOG_MAX_BYTES) {
        try {
          fs.renameSync(logPath, `${logPath}.1`);
        } catch (e) {
          /* ignore */
        }
        persistLogBytes = 0;
      }
      persistLogBytes += size;
      fs.appendFile(logPath, logEntry, "utf-8", (err) => {
        if (err) console.error("Failed to write persistence log:", err);
      });
    } catch (e) {
      console.error("Failed to write persistence log:", e);
    }
  });

  ipcMain.handle("export-config", async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: "Window is unavailable" };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Export Rovyl Backup",
        defaultPath: path.join(app.getPath("downloads"), "rovyl-backup.json"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (result.canceled || !result.filePath) return { success: false };

      const configPath = path.join(app.getPath("userData"), "config-v2.json");
      const settingsPath = path.join(app.getPath("userData"), "settings.json");
      const iconCachePath = path.join(app.getPath("userData"), "icon-cache.json");

      const backup = {
        version: "1.0",
        timestamp: new Date().toISOString(),
        config: fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : null,
        settings: fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf-8")) : null,
        iconCache: fs.existsSync(iconCachePath) ? JSON.parse(fs.readFileSync(iconCachePath, "utf-8")) : null,
      };

      /**
       * Put the bytes back inline before writing the backup.
       *
       * A backup is a file a user copies to another machine, so it has to be self-contained —
       * references to `userData/icons` on the machine it came from would import as a wheel with
       * no icons. Inlining also keeps the file byte-identical to the v1.0 format an older build
       * knows how to read, so `import-config` needs no change at all: an imported backup lands on
       * disk with `data:` URLs, and the read-path migration converts them on the next load.
       */
      let iconsMissing = 0;
      try {
        if (backup.config) iconsMissing += iconStore.inlineBlob(backup.config).missing;
        const cachedIcons = backup.iconCache && backup.iconCache.icons;
        if (cachedIcons) {
          for (const [key, entry] of Object.entries(cachedIcons)) {
            const value = entry && typeof entry === "object" ? entry.data : entry;
            if (!iconStore.isIconRef(value)) continue;
            const dataUrl = iconStore.readAsDataUrl(value);
            if (dataUrl) cachedIcons[key] = { ...(typeof entry === "object" ? entry : {}), data: dataUrl };
            else {
              delete cachedIcons[key];
              iconsMissing += 1;
            }
          }
        }
      } catch (e) {
        diagLog(`[Backup] inline icons: ${e.message}`);
      }

      fs.writeFileSync(result.filePath, JSON.stringify(backup, null, 2));
      /**
       * Say so when an icon could not be read back. This is the one artefact that leaves the
       * machine, so it is the one place a silently dropped icon is not self-healing — on the
       * machine it is restored to, the bytes simply are not there to re-inline from.
       */
      diagLog(
        `[Backup] Configuration exported to ${result.filePath}` +
          (iconsMissing ? ` (${iconsMissing} icon(s) unreadable, exported without them)` : ""),
      );
      return iconsMissing ? { success: true, iconsMissing } : { success: true };
    } catch (e) {
      console.error("Export failed:", e);
      diagLog(`[ERROR] Export failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("import-config", async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: "Window is unavailable" };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Import Rovyl Backup",
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["openFile"],
      });

      if (result.canceled || result.filePaths.length === 0) return { success: false };

      const data = JSON.parse(fs.readFileSync(result.filePaths[0], "utf-8"));
      
      if (!data.config && !data.settings) {
        throw new Error("Invalid backup file: no configuration data found.");
      }

      const configPath = path.join(app.getPath("userData"), "config-v2.json");
      const settingsPath = path.join(app.getPath("userData"), "settings.json");
      const iconCachePath = path.join(app.getPath("userData"), "icon-cache.json");

      if (data.config) {
        /**
         * Normalize before writing: make sure `config.workspaces` is a valid array and that the
         * top-level `workspaces` mirror that `normalizeFullPersistenceBlob` uses as a fallback
         * exists. Without this, a backup with a slightly different shape can make
         * `get-full-config` return `null` → LS migration → the backup gets overwritten.
         */
        const normalized = normalizeFullPersistenceBlob(data.config);
        if (!normalized) {
          throw new Error("Invalid backup file: workspace structure is missing or empty.");
        }
        // Make sure the workspaces mirror exists at the root level (the normalizer's fallback)
        if (!Array.isArray(normalized.workspaces) && Array.isArray(normalized.config?.workspaces)) {
          normalized.workspaces = normalized.config.workspaces;
        }
        /**
         * The licence does NOT come in the backup — and it must not leave with it either.
         *
         * The activated profile lives in `user` inside `config-v2.json`, and the import replaces
         * that whole file. A backup made before activation (or on another machine) carries
         * `user: null`, and the app asked for the key again right after restoring — even though
         * the device was still activated on the server side.
         *
         * Activation is a property of THIS install, not of the backup's content: if an activated
         * profile already exists, it survives the import. A backup that does carry an activated
         * profile can still bring it, for whoever restores on a new machine.
         */
        try {
          const currentRaw = fs.existsSync(configPath)
            ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
            : null;
          const currentUser = currentRaw && (currentRaw.user || (currentRaw.config && currentRaw.config.user));
          const importedUser = normalized.user || (normalized.config && normalized.config.user);
          if (currentUser && currentUser.isPremium === true && !(importedUser && importedUser.isPremium === true)) {
            normalized.user = currentUser;
            if (normalized.config) normalized.config.user = currentUser;
            diagLog("[Import] This install's licence preserved — the backup carried no activated profile");
          }
        } catch (e) {
          diagLog(`[Import] Could not preserve the licence: ${e.message}`);
        }

        const toWrite = JSON.stringify(normalized, null, 2);
        // Atomic write identical to saveFullConfigToDisk
        const tempPath = configPath + ".tmp";
        fs.writeFileSync(tempPath, toWrite, "utf-8");
        fs.renameSync(tempPath, configPath);
      }
      if (data.settings) fs.writeFileSync(settingsPath, JSON.stringify(data.settings, null, 2));

      /**
       * Icons from an old backup are not reusable.
       *
       * The backup keeps the `customIconUrl`s already resolved — base64 images — plus the icon
       * cache. If that material was produced by an earlier pipeline, restoring it puts back exactly
       * the defective icons the fix was made for: with a plate, with a halo, or simply from the
       * wrong product. And automatic healing never replaces them, because it only fills in what has
       * NO icon; a wrong icon, to it, is an icon that is there.
       *
       * When the provenance does not match the current pipeline we drop both: the icons embedded in
       * the config and the cache. They stay unresolved, and healing resolves them again — now by
       * the correct route. Favicons of web shortcuts are spared: they come from the net, not Windows.
       */
      const backupIconVersion = data.iconCache && data.iconCache.__pipelineVersion;
      const iconsAreCurrent = backupIconVersion === ICON_PIPELINE_VERSION;

      if (iconsAreCurrent) {
        fs.writeFileSync(iconCachePath, JSON.stringify(data.iconCache, null, 2));
      } else {
        try {
          if (fs.existsSync(iconCachePath)) fs.unlinkSync(iconCachePath);
        } catch (e) {
          /* non-fatal */
        }
        const stripped = stripStaleNativeIcons(configPath);
        diagLog(
          `[Import] Backup icons discarded (pipeline ${backupIconVersion ?? "unknown"} ` +
            `≠ ${ICON_PIPELINE_VERSION}); ${stripped} entries left for re-extraction`,
        );
      }

      // Create the .bak immediately — if before-quit fires anyway, the renderer's save would only
      // overwrite the primary (the .bak preserves the imported backup).
      try {
        if (data.config && fs.existsSync(configPath)) {
          fs.copyFileSync(configPath, `${configPath}.bak`);
        }
      } catch (_) { /* non-fatal */ }

      /**
       * Clear the renderer's localStorage before the relaunch.
       * If `get-full-config` fails on the next startup and LS still holds the old
       * `zenith_config` / `zenith_apps` keys, the LS migration would overwrite the backup.
       */
      try {
        const { session } = require("electron");
        await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
        diagLog("[Backup] Cleared renderer localStorage before import relaunch");
      } catch (lse) {
        diagLog(`[Backup] localStorage clear failed (non-fatal): ${lse.message}`);
      }

      diagLog(`[Backup] Configuration imported from ${result.filePaths[0]}. Relaunching...`);

      /**
       * Signal to the before-quit handler that it must not ask the renderer to flush
       * — the renderer holds PRE-import state in memory and would overwrite the backup.
       */
      skipQuitFlushForImport = true;
      app.relaunch();
      app.exit(0);
      return { success: true };
    } catch (e) {
      console.error("Import failed:", e);
      diagLog(`[ERROR] Import failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  /**
   * Single source of truth for "is this an IDE with recent projects?": the same resolution the MRU
   * uses. The renderer guessed by keyword, and `electron.app.Antigravity` (the agent) matched
   * "antigravity" — it passed as an IDE and offered recents that do not exist.
   */
  ipcMain.handle("app-supports-recents", (event, appName, appCommand) => {
    try {
      return Boolean(resolveIdeGlobalStorage(appName, appCommand));
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle("get-app-recents", async (event, appName, appCommand) => {
    try {
      diagLog(`[Recents] Fetching for appName: "${appName}", appCommand: "${appCommand}"`);

      /** Used further down, when turning each MRU entry into the command that opens the folder. */
      const lowerName = appName ? appName.toLowerCase() : "";
      const lowerCommand = appCommand ? appCommand.toLowerCase() : "";

      /** Discovery instead of a fixed path — see `resolveIdeGlobalStorage`. */
      const globalStorageDir = resolveIdeGlobalStorage(appName, appCommand);
      if (!globalStorageDir) {
        diagLog(`[Recents] No IDE profile matches "${appName}" / "${appCommand}"`);
        return [];
      }

      const storageJsonPath = path.join(globalStorageDir, "storage.json");
      const vscdbPath = path.join(globalStorageDir, "state.vscdb");
      const hasJson = fs.existsSync(storageJsonPath);
      const hasVscdb = fs.existsSync(vscdbPath);

      diagLog(
        `[Recents] globalStorage="${globalStorageDir}" storage.json=${hasJson} state.vscdb=${hasVscdb}`,
      );

      if (!hasJson && !hasVscdb) {
        return [];
      }

      let json = {};
      if (hasJson) {
        try {
          json = JSON.parse(fs.readFileSync(storageJsonPath, "utf-8"));
        } catch (parseErr) {
          diagLog(`[Recents] storage.json parse failed: ${parseErr.message}`);
          json = {};
        }
      }

      // MRU only from history.recentlyOpenedPathsList (JSON and/or SQLite). Never profileAssociations.workspaces.
      let recentlyOpened = normalizeRecentlyOpenedPathsList(json.history?.recentlyOpenedPathsList);
      if (recentlyOpened.length === 0 && hasVscdb) {
        recentlyOpened = await loadRecentlyOpenedPathsFromVscdb(vscdbPath);
      }

      const workspaceUris = [];
      const seenUri = new Set();
      for (const item of recentlyOpened) {
        if (!item || typeof item !== "object") continue;
        const uri = item.folderUri || item.workspace?.configPath || item.fileUri;
        if (!uri || typeof uri !== "string" || seenUri.has(uri)) continue;
        seenUri.add(uri);
        workspaceUris.push(uri);
      }

      if (workspaceUris.length === 0) {
        diagLog(`[Recents] No MRU entries for ${appName} (${globalStorageDir})`);
        return [];
      }
      
      const recents = workspaceUris.map(uri => {
        // Convert file:///c%3A/path to C:\path
        let decoded = decodeURIComponent(uri.replace("file:///", ""));
        if (process.platform === 'win32') {
          if (decoded.startsWith("/")) decoded = decoded.substring(1);
          decoded = decoded.replace(/\//g, "\\");
        }
        
        const label = path.basename(decoded);
        let command = decoded;
        
        // If it's an IDE, we want to open the folder WITH the IDE
        const itemLowerName = appName ? appName.toLowerCase() : "";
        // 2. Identify if it's an IDE that supports recent folders
        let appCommandString = normalizeAumidIdeCommands((appCommand || "").trim());

        /** Shortcuts discovered by Windows can be AUMIDs, which take no folder argument. */
        const ideIdentity = `${itemLowerName} ${lowerCommand}`;
        if (ideIdentity.includes("cursor")) {
          appCommandString = resolveCursorExePath();
        } else if (ideIdentity.includes("antigravity")) {
          appCommandString = resolveAntigravityExePath();
        } else if (
          ideIdentity.includes("visual studio code") ||
          ideIdentity.includes("visualstudiocode") ||
          itemLowerName === "code" ||
          itemLowerName === "vscode"
        ) {
          appCommandString = resolveVsCodeExePath();
        }
        
        // If we don't have a command passed, try to infer it from the name
        if (!appCommandString) {
          const ideNames = ["antigravity", "cursor", "code"];
          const foundName = ideNames.find(n => lowerName.includes(n));
          if (foundName) appCommandString = foundName;
        }

        let commandBase = "";
        const lowerAppCmd = appCommandString.toLowerCase();
        const isIDE = 
          lowerAppCmd.includes("antigravity") || 
          lowerAppCmd.includes("cursor") || 
          lowerAppCmd.includes("code") ||
          lowerAppCmd.includes("visual studio") ||
          lowerAppCmd.includes("intellij") ||
          lowerAppCmd.includes("webstorm") ||
          lowerAppCmd.includes("pycharm");

        if (isIDE) {
          // If it's a full path with spaces and not quoted, quote it
          if (appCommandString.includes(" ") && !appCommandString.startsWith('"')) {
             commandBase = `"${appCommandString}"`;
          } else {
             commandBase = appCommandString;
          }
        }

        if (commandBase) {
          command = `${commandBase} "${decoded}"`;
        } else {
          diagLog(`[Recents] App not recognized as IDE: ${appName}`);
        }

        let workingDirectory = decoded;
        try {
          if (fs.existsSync(decoded) && !fs.statSync(decoded).isDirectory()) {
            workingDirectory = path.dirname(decoded);
          }
        } catch (e) { /* keep the decoded path */ }

        return {
          id: `recent-${uri}`,
          label: label || decoded,
          iconName: "Folder",
          iconSource: "lucide",
          command: command,
          commandType: "app",
          description: decoded,
          workingDirectory,
        };
      });

      return recents.filter(r => r.label && r.label !== ".").slice(0, 6); // Top 6 MRU
    } catch (e) {
      diagLog(`Error fetching app recents for ${appName}: ${e.message}`);
      return [];
    }
  });

  // 2. Create Window
  mainWindow = await createWindow();

  /**
   * And the wheel's window, warm from the start.
   *
   * Deliberately not awaited: Settings is what the first run puts on screen, and a global shortcut
   * that arrives before this resolves goes through `ensureOverlayWindow` anyway. What this buys is
   * that the ordinary case — an app sitting in the tray for hours — has a composed, painted,
   * correctly-placed transparent surface long before anybody reaches for the middle button.
   */
  void ensureOverlayWindow().catch((e) => {
    diagLog(`[Overlay] initial create failed: ${e.message}`);
  });

  // Dashboard windowed: keep the taskbar button when the user switches to another app without using Minimize.
  // (Minimize uses skipTaskbar true — see minimize-window — so the icon only lives in the tray until restore.)
  mainWindow.on("blur", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (mainWindow.isMinimized()) return;
      /**
       * Settings is visible exactly when its panel is open — the window has no other state now —
       * so this no longer needs the renderer to tell it (`set-panel-surface-visible`, gone).
       */
      if (mainWindow.isVisible()) mainWindow.setSkipTaskbar(false);
    } catch (e) {
      /* ignore */
    }
  });

  // Set up the tray icon
  /**
   * `public/` in dev, `dist/` when packaged — Vite copies publicDir verbatim and `dist/**` is
   * already in electron-builder's `files`, so these read straight out of the asar. Both arms have
   * to move together, which is why this is a helper and not a ternary at each call site.
   */
  const uiAssetPath = (name) =>
    path.join(__dirname, isDev ? "../public" : "../dist", name);

  /**
   * `createFromPath` does not throw on a bad path — it hands back an empty image. But handing that
   * same path to a menu item as a plain `icon` STRING does throw, and the catch around the tray
   * would have swallowed it and left the user with no tray icon at all: strictly worse than a
   * missing glyph. Resolve to a NativeImage first, then omit the key when there is nothing to show.
   *
   * Always the un-suffixed name: that is what makes Electron scan for the `@2x`/`@3x` siblings.
   * Never `.resize()` the result either — it collapses the image to a single 1x representation and
   * throws the high-DPI ones away.
   */
  const menuIcon = (baseName) => {
    /**
     * Forced colors paints the menu from the High Contrast palette — black ground in three of the
     * four stock themes — while `shouldUseDarkColors` is hard-false there, so either file is a
     * guess and the light one is a near-invisible smudge beside a 21:1 label. No glyph beats the
     * wrong glyph; the `nativeTheme` rebuild below puts them back when the user leaves HC.
     */
    if (nativeTheme.shouldUseHighContrastColors) return null;
    /** Windows cannot tint a menu glyph for us, so the file has to match the menu's own theme. */
    const name = nativeTheme.shouldUseDarkColors
      ? `${baseName}-dark.png`
      : `${baseName}.png`;
    try {
      const image = nativeImage.createFromPath(uiAssetPath(name));
      if (image.isEmpty()) {
        console.warn("WARNING: tray menu icon is empty. Path:", uiAssetPath(name));
        return null;
      }
      return image;
    } catch (e) {
      console.warn("WARNING: tray menu icon failed:", name, e.message);
      return null;
    }
  };

  /**
   * Windows delivers `click` on WM_LBUTTONDOWN and `double-click` on WM_LBUTTONDBLCLK, so one
   * double-click arrives here twice and the second is an echo — Settings is the same destination
   * either way. Rejected on the leading edge, never trailing: opening has to feel immediate.
   *
   * The window covers the slowest the OS will accept a double-click at: `GetDoubleClickTime` is
   * 500 ms by default and reaches ~900 ms at the "Slow" end of the mouse slider, so anything
   * tighter lets the echo through on exactly the machines the guard exists for.
   *
   * What keeps a window that wide from eating a real second click is the visibility test rather
   * than the clock. The echo always finds a window the first event already showed; a deliberate
   * second click means the user dismissed Settings in between, so it finds one hidden and passes.
   */
  const TRAY_OPEN_SETTINGS_COOLDOWN_MS = 900;

  /**
   * How long the tray menu will sit out a right button that is still held. Past this it opens
   * anyway: a press that long is someone resting on the button, and a menu that never appears is
   * worse than the taskbar's own menu appearing beside it.
   */
  const TRAY_MENU_BUTTON_WAIT_MS = 400;
  let trayOpenSettingsAt = 0;
  const openSettingsFromTray = async () => {
    if (isAppQuitting) return;
    const now = Date.now();
    let alreadyShowing = false;
    try {
      alreadyShowing =
        !!mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized();
    } catch (e) {
      alreadyShowing = false;
    }
    if (alreadyShowing && now - trayOpenSettingsAt < TRAY_OPEN_SETTINGS_COOLDOWN_MS) return;
    trayOpenSettingsAt = now;
    try {
      await ensureMainWindow();
      if (isAppQuitting) return;
      openSettingsFromMainProcess();
    } catch (e) {
      diagLog(`[Tray] Open Settings: ${e.message}`);
    }
  };

  /** Explicit request, so it skips `shouldOpenMenu`: game mode and the pause both gate TRIGGERS. */
  const openWheelFromTray = async () => {
    if (isAppQuitting) return;
    try {
      await ensureMainWindow();
      if (isAppQuitting) return;
      showMenuAtCursor("tray");
    } catch (e) {
      diagLog(`[Tray] Open the wheel: ${e.message}`);
    }
  };

  const switchWorkspaceFromTray = async (index) => {
    if (isAppQuitting) return;
    try {
      await ensureMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      /**
       * To the WRITER, not the wheel. There is no wheel on screen when the tray is open, so this is
       * purely a config change: Settings applies it, saves, and main broadcasts the new file to the
       * overlay — which is how the wheel ends up on the right workspace next time it opens.
       */
      sendToSettings("radial-workspace-changed", index);
      /** The tick follows the renderer's save coming back round, not this send. */
      diagLog(`[Tray] switch-workspace -> ${index}`);
    } catch (e) {
      diagLog(`[Tray] Switch workspace: ${e.message}`);
    }
  };

  /** Redraws the label the pause is counting down, and nothing else depends on it firing. */
  let pauseExpiryTimer = null;
  const setTriggerPause = (minutes) => {
    triggersPausedUntil = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    if (pauseExpiryTimer) {
      clearTimeout(pauseExpiryTimer);
      pauseExpiryTimer = null;
    }
    if (minutes > 0) {
      pauseExpiryTimer = setTimeout(() => {
        pauseExpiryTimer = null;
        refreshTrayMenu();
      }, minutes * 60_000 + 500);
    }
    diagLog(`[Tray] Triggers ${minutes > 0 ? `paused for ${minutes} min` : "resumed"}`);
    refreshTrayMenu();
  };

  const buildTrayMenu = () =>
    Menu.buildFromTemplate(
      buildTrayMenuTemplate({
        workspaces: Array.isArray(currentSettings.workspaces) ? currentSettings.workspaces : [],
        activeWorkspaceIndex: Number.isInteger(currentSettings.activeWorkspaceIndex)
          ? currentSettings.activeWorkspaceIndex
          : 0,
        pausedUntil: triggersPausedUntil,
        now: Date.now(),
        version: app.getVersion(),
        /** The Store owns updates for an MSIX build, and an unpackaged one has no updater at all. */
        canCheckUpdates: buildChannel() === "direct",
        /**
         * The tray reads the same state machine the Settings row does. With an installer already
         * on disk the item is the restart, not another check — offering "Check for updates" there
         * only invites a second download of what is already downloaded.
         */
        updateState: lastKnownUpdate.state,
        updateVersion: lastKnownUpdate.version,
        icons: {
          brand: menuIcon("tray-brand"),
          wheel: menuIcon("tray-wheel"),
          spaces: menuIcon("tray-spaces"),
          pause: menuIcon("tray-pause"),
          settings: menuIcon("tray-settings"),
          update: menuIcon("tray-update"),
          power: menuIcon("tray-power"),
        },
        actions: {
          openWheel: () => { void openWheelFromTray(); },
          switchWorkspace: (index) => { void switchWorkspaceFromTray(index); },
          setPause: setTriggerPause,
          openSettings: () => { void openSettingsFromTray(); },
          checkForUpdates: () => { void runUpdateCheck(); },
          installUpdate: () => installUpdateNow(),
          quit: () => app.quit(),
        },
      }),
    );

  /**
   * The live menu, kept in a variable for exactly as long as it is on screen: Electron holds the
   * model behind a weak pointer, and a menu collected while the user is reading it is a crash.
   */
  let trayMenu = null;
  /** One popup in flight at a time — a second right-click during the wait is the same request. */
  let trayMenuOpening = false;

  /**
   * The tray menu pops on the RELEASE, not on the press, and that is the whole point.
   *
   * Windows forwards the notification area's right-click to us on WM_RBUTTONDOWN, and Electron's
   * own `setContextMenu` path shows the menu right there — inside the button-down — where
   * `SetForegroundWindow` deactivates the taskbar while explorer is still tracking the click.
   * Explorer never completes it, the release lands on `Shell_TrayWnd` instead, and the taskbar's
   * own context menu opens behind ours. Hence: no `setContextMenu`, so Electron emits `right-click`
   * and returns; we wait out the press, then pop the menu ourselves.
   *
   * Built here rather than kept around, so the pause countdown and the workspace tick are read at
   * the moment the menu opens instead of whenever something last thought to refresh it.
   */
  const popUpTrayMenu = async () => {
    if (trayMenuOpening) return;
    trayMenuOpening = true;
    try {
      await waitForMouseButtonsUp(TRAY_MENU_BUTTON_WAIT_MS);
      if (!tray || tray.isDestroyed() || isAppQuitting) return;
      trayMenu = buildTrayMenu();
      tray.popUpContextMenu(trayMenu);
    } catch (e) {
      diagLog(`[Tray] pop up menu: ${e.message}`);
    } finally {
      trayMenuOpening = false;
    }
  };

  /**
   * Only the tooltip now: the menu itself is built when it opens, so nothing about it can go stale.
   * The call sites stay — they are the places that know the state changed.
   */
  const refreshTrayMenu = () => {
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.setToolTip(triggersArePaused() ? "Rovyl — trigger paused" : "Rovyl");
    } catch (e) {
      diagLog(`[Tray] refresh: ${e.message}`);
    }
  };
  refreshTrayMenuRef = refreshTrayMenu;

  try {
    const iconPath = uiAssetPath("icon.png");
    const trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      console.warn("WARNING: Tray icon is empty. Path:", iconPath);
    }
    const resizedIcon = trayIcon.resize({ width: 16, height: 16 });
    tray = new Tray(resizedIcon);
    tray.setToolTip("Rovyl");

    /**
     * No `setContextMenu`: that is what makes Electron emit `right-click` instead of popping the
     * menu inside the button-down. See `popUpTrayMenu`.
     */
    tray.on("right-click", () => {
      void popUpTrayMenu();
    });

    /**
     * On Windows a context menu does NOT swallow the left button — that constraint is macOS's.
     * Both listeners below share one cooldown on purpose: whether a double-click really yields
     * click+double-click or click+click, the outcome is the same.
     */
    tray.on("click", () => {
      void openSettingsFromTray();
    });
    tray.on("double-click", () => {
      void openSettingsFromTray();
    });

    // Startup feedback
    console.log("Rovyl started successfully in the background.");
  } catch (err) {
    console.error("Failed to create tray icon:", err);
  }

  /**
   * Avoids a toast on every save/reopen of the radial when the shortcut is taken (e.g. NVIDIA's Alt+Z).
   * It notifies again if the user changes the shortcut and the new one also fails.
   */

  const shortcutCompactKey = (s) =>
    String(s || "")
      .replace(/\s+/g, "")
      .replace(/Win/gi, "Super")
      .toLowerCase();

  /** Alt+Z is common in the GeForce overlay / others — a more useful message than a generic "OS". */
  /**
   * The one combination whose owner we can usually name. Two phrasings of one fact: the log has to
   * say where to go, the card is already there.
   */
  const isAltZ = (shortcutStr) => {
    const k = shortcutCompactKey(shortcutStr);
    return k === "alt+z" || k === "option+z";
  };
  const ALT_Z_CULPRIT =
    "It is usually the NVIDIA GeForce Experience overlay — turn that off, or pick another combination.";
  const altZOverlayHint = (shortcutStr) =>
    isAltZ(shortcutStr)
      ? " Alt+Z is commonly reserved by the NVIDIA GeForce Experience overlay or another app. Disable it there or choose a different shortcut in Rovyl Settings."
      : "";

  let lastShortcutRegistrationSignature = null;
  let lastShortcutTriggerAt = 0;
  let shortcutHoldActive = false;
  let keyboardListener = null;

  function ensureKeyboardListener() {
    if (keyboardListener) return keyboardListener;
    try {
      const keyServerPath = isPackagedBuild
        ? path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "node-global-key-listener",
            "bin",
            "WinKeyServer.exe",
          )
        : path.join(
            __dirname,
            "..",
            "node_modules",
            "node-global-key-listener",
            "bin",
            "WinKeyServer.exe",
          );

      keyboardListener = new GlobalKeyboardListener({
        windows: { serverPath: keyServerPath },
      });

      keyboardListener.addListener((event) => {
        if (!shortcutHoldActive) return;
        if (event.state !== "UP") return;

        shortcutHoldActive = false;
        diagLog(`[ShortcutHold] Key released (${event.name}), sending shortcut-release`);
        sendToOverlay("shortcut-release");
      });
    } catch (e) {
      diagLog(`[ShortcutHold] Failed to initialize GlobalKeyboardListener: ${e.message}`);
    }
    return keyboardListener;
  }

  const shortcutRegistrationSignature = () => {
    const entries = [
      currentSettings.enableKeyboardTrigger === false ? "off" : "on",
      String(currentSettings.globalShortcut || "Alt+Z"),
    ];
    const visit = (apps) => {
      if (!Array.isArray(apps)) return;
      for (const item of apps) {
        if (item && item.shortcut && item.command) {
          entries.push(`${item.shortcut}\u0000${item.command}`);
        }
        visit(item?.children);
      }
    };
    for (const workspace of currentSettings.workspaces || []) visit(workspace?.apps);
    return entries.join("\u0001");
  };

  const registerGlobalShortcut = (force = false) => {
    const registrationSignature = shortcutRegistrationSignature();
    if (!force && registrationSignature === lastShortcutRegistrationSignature) {
      return;
    }
    lastShortcutRegistrationSignature = registrationSignature;
    globalShortcut.unregisterAll();
    let shortcut = currentSettings.globalShortcut || "Alt+Z";
    const openRadialFromShortcut = async (sourceShortcut) => {
      diagLog(`${sourceShortcut} shortcut triggered`);
      const isHoldMode = cachedRadialFlags.shortcutTriggerMode === "hold";
      const now = Date.now();

      if (workspaceShortcutsMenuOpen && mainWindow && !mainWindow.isDestroyed()) {
        if (isHoldMode) {
          // While in hold mode, OS auto-repeat events must NEVER close or toggle the menu!
          return;
        }
        // In toggle mode, debounce rapid repeat triggers (< 350ms) to avoid flickering
        if (now - lastShortcutTriggerAt < 350) {
          return;
        }
        lastShortcutTriggerAt = now;
        sendToOverlay("open-menu", { source: "shortcut", closeOnly: true });
        return;
      }

      lastShortcutTriggerAt = now;
      const allowed = await shouldOpenMenu();
      if (!allowed) return;

      if (isHoldMode) {
        shortcutHoldActive = true;
        ensureKeyboardListener();
      }

      showMenuAtCursor("shortcut");
    };

    triggerRadialShortcut = () => {
      openRadialFromShortcut(currentSettings.globalShortcut || "shortcut");
    };
    releaseRadialShortcut = () => {
      if (cachedRadialFlags.shortcutTriggerMode === "hold") {
        sendToOverlay("shortcut-release");
      }
    };

    /**
     * With the keyboard trigger off, the wheel's own shortcut is not claimed at all — the point is
     * to hand the combination back to whatever else wants it. App shortcuts below are a separate
     * feature and keep working; this switch is about the wheel.
     *
     * `triggerRadialShortcut` is left assigned on purpose: the tray and IPC call it directly, and
     * those are not the trigger being turned off.
     */
    if (currentSettings.enableKeyboardTrigger === false) {
      writeRadialMouseBlocker("SHORTCUT_TRIGGER OFF");
      diagLog("[Shortcut] Keyboard trigger disabled; the wheel's shortcut is not registered.");
    } else {
      const mouseSpec = parseMouseShortcut(shortcut);
      if (mouseSpec) {
        ensureRadialMouseBlocker();
        writeRadialMouseBlocker(`SHORTCUT_TRIGGER ${mouseSpec.vk} ${mouseSpec.modMask}`);
        diagLog(
          `[Shortcut] Registered mouse global shortcut '${shortcut}' (VK ${mouseSpec.vk}, ModMask ${mouseSpec.modMask})`,
        );
      } else {
        writeRadialMouseBlocker("SHORTCUT_TRIGGER OFF");

        // MIGRATION / NORMALIZATION: 'Win' is recorded as 'Super' now, but old settings might have 'Win'
        if (shortcut.includes("Win")) {
          shortcut = shortcut.replace(/Win/g, "Super");
          diagLog(
            `[Shortcut] Normalized 'Win' to 'Super' in shortcut: ${shortcut}`,
          );
        }

        try {
          const registered = globalShortcut.register(shortcut, () =>
            openRadialFromShortcut(shortcut),
          );

          if (registered) {
            diagLog(`Global shortcut '${shortcut}' registered successfully.`);
          } else {
            diagLog(
              `[Shortcut] Global shortcut '${shortcut}' not registered; it is likely already in use.${altZOverlayHint(shortcut)}`,
            );
            /** With no global mouse monitor, always guarantee a safe way to open the radial. */
            const fallbackShortcut = "Alt+Shift+F9";
            if (
              shortcutCompactKey(shortcut) !== shortcutCompactKey(fallbackShortcut) &&
              globalShortcut.register(fallbackShortcut, () =>
                openRadialFromShortcut(fallbackShortcut),
              )
            ) {
              diagLog(
                `[Shortcut] Fallback '${fallbackShortcut}' registered because '${shortcut}' is taken.`,
              );
            }
          }
        } catch (e) {
          diagLog(
            `[Shortcut] Global shortcut '${shortcut}' registration failed: ${e.message}${altZOverlayHint(shortcut)}`,
          );
        }
      }
    }

    // Register individual app shortcuts from workspaces
    if (
      currentSettings.workspaces &&
      Array.isArray(currentSettings.workspaces)
    ) {
      currentSettings.workspaces.forEach((ws) => {
        // Helper to recursively register shortcuts in app trees (folders)
        const registerAppShortcutsRecursive = (apps) => {
          if (!apps || !Array.isArray(apps)) return;

          apps.forEach((app) => {
            if (app.shortcut && app.command) {
              try {
                const appShortcut = app.shortcut.includes("Win")
                  ? app.shortcut.replace(/Win/g, "Super")
                  : app.shortcut;
                const success = globalShortcut.register(appShortcut, () => {
                  diagLog(
                    `[Shortcuts] App shortcut triggered: ${appShortcut} -> ${app.label}`,
                  );
                  executeCommand(app.command, app.commandType || "app");
                });
                if (success) {
                  diagLog(
                    `[Shortcuts] Successfully registered app shortcut: ${appShortcut} for ${app.label}`,
                  );
                } else {
                  diagLog(
                    `[Shortcuts] Failed to register app shortcut: ${appShortcut} for ${app.label} (Likely reserved by OS)`,
                  );
                  // Do not warn the UI: save-full-config re-registers shortcuts often and flooded it.
                }
              } catch (e) {
                diagLog(
                  `[Shortcuts] Exception registering shortcut for ${app.label}: ${e.message}`,
                );
              }
            }
            if (app.children) registerAppShortcutsRecursive(app.children);
          });
        };

        registerAppShortcutsRecursive(ws.apps);
      });
    }

    // Only re-register workspace shortcuts if menu is open and user uses numeric mode
    if (workspaceShortcutsMenuOpen && workspaceShortcutsUseNumeric) {
      registerWorkspaceShortcuts();
    }
  };

  const unregisterWorkspaceShortcuts = () => {
    if (workspaceShortcutBindings.length === 0) return;
    diagLog(
      `[Shortcuts] Unregistering global workspace keys: ${workspaceShortcutBindings
        .map((b) => b.key)
        .join(", ")}`,
    );
    workspaceShortcutBindings.forEach(({ key }) => {
      try {
        globalShortcut.unregister(key);
      } catch (e) {
        diagLog(`[Shortcuts] Exception unregistering workspace key ${key}: ${e.message}`);
      }
    });
  };

  // PERF: Workspace shortcuts registered via permanent listeners — flag gates IPC send
  // We extract this to a function so it can be re-called when main shortcuts are refreshed (unregisterAll)
  const registerWorkspaceShortcuts = () => {
    if (workspaceShortcutBindings.length === 0) return;
    diagLog(
      `[Shortcuts] Registering global workspace keys: ${workspaceShortcutBindings
        .map((b) => `${b.key}→${b.index}`)
        .join(", ")}`,
    );
    // RESTORED: Registration of these as global shortcuts is the ONLY reliable way
    // to capture keys when the Zenith window fails to take keyboard focus away
    // from a background text field.
    workspaceShortcutBindings.forEach(({ key, index }) => {
      try {
        // Unregister first if already registered to avoid double-registration errors (though Electron handles it gracefully)
        if (globalShortcut.isRegistered(key)) {
            globalShortcut.unregister(key);
        }

        const success = globalShortcut.register(key, () => {
          diagLog(`[Shortcuts] Global workspace key triggered: ${key}`);
          if (workspaceShortcutsMenuOpen) {
            diagLog(`[Shortcuts] Sending switch-workspace IPC: ${index}`);
            sendToOverlay("switch-workspace", index);
          }
        });
        /**
         * A recorded key Windows will not hand over is not fatal. The wheel keeps its own keydown
         * handler for exactly these bindings, so the key still works whenever the radial holds
         * focus — which is the common case. Only the focus-stolen case is lost, and losing it
         * quietly beats refusing a key the user chose.
         */
        if (!success) diagLog(`[Shortcuts] Failed to register workspace key ${key}`);
      } catch (e) {
        diagLog(`[Shortcuts] Exception registering workspace key ${key}: ${e.message}`);
      }
    });
  };

  let workspaceShortcutsMenuOpen = false;
  /**
   * False only for a renderer too old to send its key list while quick launch is claiming the
   * digits — back then the workspace keys WERE the digits, so the claim silenced all of them.
   * A current renderer sends the list with the claimed digits already removed, and this stays true.
   */
  let workspaceShortcutsUseNumeric = true;
  /**
   * Which key belongs to which workspace, as the renderer computed it (`workspaceKeyBindings`).
   * It used to be the hardcoded 1–9 against the position; a workspace key can now be any single
   * key, so the list has to come from the config rather than be assumed.
   *
   * Seeded with that old assumption so the wheel behaves exactly as it shipped until the first
   * `set-workspace-shortcuts` arrives — which it does before the wheel can open.
   */
  let workspaceShortcutBindings = Array.from({ length: 9 }, (_, i) => ({
    key: String(i + 1),
    index: i,
  }));

  /** The renderer's array, taken only if every entry is a single key pointing at a real index. */
  const sanitizeWorkspaceBindings = (keys, numberKeysClaimed) => {
    if (!Array.isArray(keys)) return null;
    const seen = new Set();
    const clean = [];
    for (const entry of keys) {
      if (!entry || typeof entry !== "object") continue;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      const index = Number(entry.index);
      /** One character, the same rule `normalizeWorkspaceKey` enforces on the way in. */
      if (Array.from(key).length !== 1) continue;
      if (!Number.isInteger(index) || index < 0) continue;
      /**
       * Quick launch owns the digits, and a registered global shortcut never reaches the renderer
       * — so registering one here would mean pressing 2 switches workspace while the wheel waits
       * for a keystroke that was eaten upstairs. The renderer strips them too; this is the same
       * rule stated where the registration happens, so nothing has to trust the send.
       */
      if (numberKeysClaimed === true && key >= "0" && key <= "9") continue;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ key, index });
    }
    return clean;
  };

  // Register initial shortcut
  registerGlobalShortcut();

  refreshShortcutsFromFullConfig = () => {
    registerGlobalShortcut();
  };

  ipcMain.on("set-settings", (event, settings) => {
    if (!settings || typeof settings !== "object") return;
    const patch = {};
    if (typeof settings.globalShortcut === "string") patch.globalShortcut = settings.globalShortcut;
    if (typeof settings.enableKeyboardTrigger === "boolean") patch.enableKeyboardTrigger = settings.enableKeyboardTrigger;
    if (typeof settings.enableMouseTrigger === "boolean") patch.enableMouseTrigger = settings.enableMouseTrigger;
    if (settings.mouseTriggerMode === "click" || settings.mouseTriggerMode === "hold") {
      patch.mouseTriggerMode = settings.mouseTriggerMode;
    }
    if (settings.shortcutTriggerMode === "click" || settings.shortcutTriggerMode === "hold" || settings.shortcutTriggerMode === "toggle") {
      patch.shortcutTriggerMode = settings.shortcutTriggerMode;
    }
    const settingsTriggerButton = normalizeMouseTrigger(settings.mouseTriggerButton);
    if (settingsTriggerButton) {
      patch.mouseTriggerButton = settingsTriggerButton;
    }
    if (typeof settings.openAtLogin === "boolean") patch.openAtLogin = settings.openAtLogin;
    if (Array.isArray(settings.workspaces)) patch.workspaces = settings.workspaces;
    if (Object.keys(patch).length === 0) return;

    saveSettings(patch);

    if (patch.enableMouseTrigger !== undefined) {
      cachedRadialFlags.enableMouseTrigger = patch.enableMouseTrigger;
    }
    if (patch.mouseTriggerMode !== undefined) {
      cachedRadialFlags.mouseTriggerMode = patch.mouseTriggerMode;
    }
    if (patch.shortcutTriggerMode !== undefined) {
      cachedRadialFlags.shortcutTriggerMode = patch.shortcutTriggerMode;
      currentSettings.shortcutTriggerMode = patch.shortcutTriggerMode;
    }
    if (patch.mouseTriggerButton !== undefined) {
      cachedRadialFlags.mouseTriggerButton = patch.mouseTriggerButton;
      syncMouseHookState();
    }

    if (patch.globalShortcut || patch.enableKeyboardTrigger !== undefined) {
      registerGlobalShortcut();
    }

    if (patch.openAtLogin !== undefined) {
      syncLoginItemSettings(patch.openAtLogin);
    }

    syncMouseHookState();
  });

  ipcMain.on("set-login-item-settings", (event, settings) => {
    if (settings && typeof settings.openAtLogin === "boolean") {
      syncLoginItemSettings(settings.openAtLogin);
      // We also update currentSettings so it persists
      currentSettings.openAtLogin = settings.openAtLogin;
      saveSettings(currentSettings);
    }
  });

  ipcMain.on("set-background-material", (event, material) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundMaterial(material);
    }
  });

  ipcMain.handle("open-external-url", async (event, url) => {
    try {
      if (typeof url !== "string") {
        return { ok: false, error: "Invalid URL" };
      }
      const trimmed = url.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        return { ok: false, error: "Only http(s) URLs are allowed" };
      }
      await shell.openExternal(trimmed);
      return { ok: true };
    } catch (e) {
      diagLog(`[open-external-url] ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  /** Windows: run NSIS uninstaller from registry, or open Apps settings; dev → Apps; macOS: reveal .app in Finder. */
  ipcMain.handle("open-system-uninstall", async () => {
    const displayName = "Rovyl";
    try {
      if (process.platform === "win32") {
        if (isDev) {
          await shell.openExternal("ms-settings:appsfeatures");
          return { ok: true, mode: "settings", dev: true };
        }
        const esc = (s) => String(s).replace(/'/g, "''");
        const ps = [
          "$ErrorActionPreference='SilentlyContinue'",
          `$n='${esc(displayName)}'`,
          "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')",
          "foreach($r in $roots){",
          "if(-not(Test-Path $r)){continue};",
          "$hit=Get-ChildItem $r -EA 0 | ForEach-Object { Get-ItemProperty $_.PSPath -EA 0 } | Where-Object { $_.DisplayName -eq $n -and $_.UninstallString } | Select-Object -First 1;",
          "if($hit){ [Console]::Out.Write($hit.UninstallString); exit 0 }",
          "}",
          "exit 1",
        ].join(" ");
        try {
          const out = execFileSync(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-Command", ps],
            {
              encoding: "utf8",
              windowsHide: true,
              timeout: 20000,
              maxBuffer: 4 * 1024 * 1024,
            },
          )
            .trim()
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)[0];
          if (out) {
            const child = spawn(out, { shell: true, detached: true, stdio: "ignore" });
            try {
              child.unref();
            } catch (_) {}
            return { ok: true, mode: "uninstaller" };
          }
        } catch (e) {
          diagLog(`[Uninstall] registry: ${e.message}`);
        }
        await shell.openExternal("ms-settings:appsfeatures");
        return { ok: true, mode: "settings" };
      }
      if (process.platform === "darwin") {
        shell.showItemInFolder(app.getPath("exe"));
        return { ok: true, mode: "finder" };
      }
      return { ok: false, error: "unsupported" };
    } catch (e) {
      diagLog(`[Uninstall] ${e.message}`);
      return { ok: false, error: e.message || "error" };
    }
  });

  ipcMain.on("toggle-settings", async () => {
    try {
      await ensureMainWindow();
      openSettingsFromMainProcess();
    } catch (e) {
      diagLog(`[toggle-settings] ${e.message}`);
    }
  });

  ipcMain.on("pause-global-shortcut", () => {
    console.log("[Shortcuts] Pausing global shortcuts for recording...");
    lastShortcutRegistrationSignature = null;
    writeRadialMouseBlocker("SHORTCUT_TRIGGER OFF");
    globalShortcut.unregisterAll();
  });

  ipcMain.on("resume-global-shortcut", () => {
    console.log("[Shortcuts] Resuming global shortcuts...");
    registerGlobalShortcut();
    // (though recording is usually done in settings where menu is not 'open-radial' but 'open-settings')
  });

  /**
   * Can Windows actually give us this combination?
   *
   * The only honest answer comes from asking Windows, and the only way to ask is to try:
   * `RegisterHotKey` fails when another process already holds the combination, and nothing else
   * — no list, no API — will tell you who has what. So this registers it, learns the answer, and
   * gives it straight back.
   *
   * Until now nobody asked at any point. A combination another app owned was accepted by the
   * settings panel, failed to register on the next `registerGlobalShortcut`, and left the user
   * with a shortcut that did nothing and a row that said it should. Main did notice: it recorded
   * the failure in a variable that no code has ever read, deleted with this change.
   *
   * Recording unregisters everything of ours first (`pause-global-shortcut`), so during a capture
   * this measures other applications and nothing else. The `isRegistered` guard is for every other
   * caller: registering over one of our own live shortcuts and then unregistering it would take
   * the real one away.
   */
  ipcMain.handle("probe-shortcut", (_event, accelerator) => {
    const accel = String(accelerator || "").trim();
    if (!accel) return { available: false, reason: "invalid" };
    const normalized = accel.includes("Win") ? accel.replace(/Win/g, "Super") : accel;

    if (isMouseShortcut(normalized)) {
      return { available: true };
    }

    try {
      if (globalShortcut.isRegistered(normalized)) {
        return { available: false, reason: "rovyl" };
      }
    } catch (e) {
      /** `isRegistered` throws on an accelerator Electron cannot parse — that is its own answer. */
      return { available: false, reason: "invalid" };
    }

    let claimed = false;
    try {
      claimed = globalShortcut.register(normalized, () => {});
    } catch (e) {
      diagLog(`[Shortcuts] Probe of '${normalized}' threw: ${e.message}`);
      return { available: false, reason: "invalid" };
    } finally {
      /** Never keep it. A probe that holds the key would make the next probe answer "taken". */
      if (claimed) {
        try { globalShortcut.unregister(normalized); } catch (e) { /* nothing left to undo */ }
      }
    }

    diagLog(`[Shortcuts] Probe '${normalized}' -> ${claimed ? "free" : "taken"}`);
    if (claimed) return { available: true };
    /**
     * `altZOverlayHint` has known since before this change who takes Alt+Z, and has only ever said
     * so to the diagnostic log — which is to say, to nobody. It is the one case where we can name
     * the other application, and naming it is the difference between "pick another" and a fix.
     */
    return {
      available: false,
      reason: "taken",
      ...(isAltZ(normalized) ? { hint: ALT_Z_CULPRIT } : {}),
    };
  });

  ipcMain.on("start-shortcut-recording", () => {
    diagLog("[Shortcuts] Starting global recording session.");
    startShortcutRecording();
  });

  ipcMain.on("stop-shortcut-recording", () => {
    diagLog("[Shortcuts] Stopping global recording session.");
    stopShortcutRecording();
  });

  /**
   * Settings is about to record a mouse button, so the trigger lets go of the one it holds.
   *
   * The recording itself happens in the renderer — the settings window is what the hand is over,
   * and a DOM `mousedown` names every button Windows reports, modifiers included. All main has to
   * do is stop eating the one button that would otherwise never arrive.
   */
  ipcMain.on("pause-mouse-trigger", (event) => {
    if (mouseTriggerRecordingPaused) return;
    mouseTriggerRecordingPaused = true;
    diagLog("[MouseHook] Trigger released for the settings recorder.");
    /**
     * The resume normally comes from the recorder's own cleanup. A renderer that is reloaded or
     * torn down mid-recording never sends it, and the cost of that is a mouse trigger that is
     * silently off until the next restart — so the window going away is a resume too.
     */
    if (!mouseTriggerResumeGuards.has(event.sender)) {
      mouseTriggerResumeGuards.add(event.sender);
      event.sender.once("destroyed", () => {
        if (!mouseTriggerRecordingPaused) return;
        mouseTriggerRecordingPaused = false;
        diagLog("[MouseHook] Trigger re-armed: the recorder's window went away.");
        syncMouseHookState();
      });
    }
    syncMouseHookState();
  });

  ipcMain.on("resume-mouse-trigger", () => {
    if (!mouseTriggerRecordingPaused) return;
    mouseTriggerRecordingPaused = false;
    diagLog("[MouseHook] Trigger re-armed after recording.");
    syncMouseHookState();
  });

  /** Verify Google ID token (Sign in with Google / zenithos.online auth page). */
  function verifyGoogleIdToken(idToken) {
    return new Promise((resolve, reject) => {
      const u = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
      https
        .get(u, (tokenRes) => {
          let body = "";
          tokenRes.on("data", (d) => {
            body += d;
          });
          tokenRes.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (data.error) {
                reject(new Error(data.error_description || String(data.error)));
                return;
              }
              resolve(data);
            } catch (e) {
              reject(e);
            }
          });
        })
        .on("error", reject);
    });
  }

  /**
   * STABLE machine fingerprint.
   *
   * `MachineGuid` is written by Windows when the system is installed and does not change with
   * application reinstalls, profile wipes or updates. The hardware UUID is the alternative when
   * the registry is not readable. Random is only reached if both fail — and then the file on disk
   * is what counts again.
   */
  function readStableMachineId() {
    if (process.platform !== "win32") return null;
    const attempts = [
      () =>
        execFileSync(
          "reg",
          ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
          { encoding: "utf8", windowsHide: true, timeout: 4000 },
        ),
      () =>
        execFileSync(
          "wmic",
          ["csproduct", "get", "uuid"],
          { encoding: "utf8", windowsHide: true, timeout: 4000 },
        ),
    ];
    for (const attempt of attempts) {
      try {
        const output = attempt();
        const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output);
        if (match) return match[0].toLowerCase();
      } catch (e) {
        /* try the next one */
      }
    }
    return null;
  }

  /**
   * Device identifier for the licence server.
   *
   * It used to be a RANDOM value kept in the app's data folder. Anything that deleted that folder
   * — reinstalling, wiping the profile, testing with `--user-data-dir` — produced a new identifier,
   * and the server counted the SAME machine as one more device. Three activations on the same
   * computer used up the limit of three.
   *
   * It is now derived from Windows' `MachineGuid`: the same computer always returns the same
   * identifier, data folder or not. The file becomes cache only.
   */
  function getOrCreateLicenseDeviceId() {
    const devicePath = path.join(app.getPath("userData"), "license-device.json");
    const machineId = readStableMachineId();

    if (machineId) {
      const deviceId = crypto
        .createHash("sha256")
        .update(`rovyl:${machineId}`)
        .digest("hex");
      try {
        const saved = JSON.parse(fs.readFileSync(devicePath, "utf8"));
        if (saved.deviceId !== deviceId) {
          diagLog("[License] deviceId migrated to the stable machine fingerprint");
        }
      } catch (e) {
        /* file missing or unreadable — write it again */
      }
      try {
        fs.writeFileSync(devicePath, JSON.stringify({ deviceId, source: "machine-guid" }), {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (e) {
        /* the identifier is derivable anyway; the file is only cache */
      }
      return deviceId;
    }

    /** No machine identifier: the old behaviour, with the file in charge. */
    try {
      const saved = JSON.parse(fs.readFileSync(devicePath, "utf8"));
      if (typeof saved.deviceId === "string" && saved.deviceId.length >= 32) return saved.deviceId;
    } catch (_) {}
    const deviceId = crypto.randomUUID() + crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(devicePath, JSON.stringify({ deviceId }), { encoding: "utf8", mode: 0o600 });
    return deviceId;
  }

  async function activateRovylLicense(idToken) {
    const endpoint = process.env.ROVYL_LICENSE_API_URL || "https://rovyl-red.vercel.app/api/license/activate";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `Rovyl/${app.getVersion()}` },
      body: JSON.stringify({
        idToken,
        deviceId: getOrCreateLicenseDeviceId(),
        deviceName: `${os.hostname()} · ${os.platform()} ${os.release()}`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.licensed !== true) {
      const error = new Error(result.error || "Rovyl purchase could not be verified.");
      error.code = result.code || "LICENSE_DENIED";
      throw error;
    }
    return result;
  }

  async function activateRovylLicenseKey(licenseKey) {
    const endpoint = process.env.ROVYL_LICENSE_KEY_API_URL || "https://rovyl-red.vercel.app/api/license/activate-key";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `Rovyl/${app.getVersion()}` },
      body: JSON.stringify({
        licenseKey,
        deviceId: getOrCreateLicenseDeviceId(),
        deviceName: `${os.hostname()} · ${os.platform()} ${os.release()}`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.licensed !== true) {
      const error = new Error(result.error || "This Rovyl license could not be activated.");
      error.code = result.code || "LICENSE_DENIED";
      throw error;
    }
    return result;
  }

  /**
   * Free the device's seat on the server.
   *
   * Without this, "Remove license" only wiped the local profile: the seat stayed taken and the user
   * had no way to get it back — that is how three seats were used up on a single machine. The call
   * is forgiving by design: if the route does not exist yet, or the network fails, it returns the
   * reason and the app removes the licence locally anyway, so it is never stuck.
   */
  async function deactivateRovylLicenseDevice() {
    const endpoint =
      process.env.ROVYL_LICENSE_DEACTIVATE_API_URL ||
      "https://rovyl-red.vercel.app/api/license/deactivate";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `Rovyl/${app.getVersion()}` },
      body: JSON.stringify({ deviceId: getOrCreateLicenseDeviceId() }),
    });
    if (response.status === 404) {
      const error = new Error("The license service does not expose deactivation yet.");
      error.code = "DEACTIVATE_UNAVAILABLE";
      throw error;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "This device could not be released.");
      error.code = result.code || "DEACTIVATE_FAILED";
      throw error;
    }
    return result;
  }

  ipcMain.handle("deactivate-rovyl-license", async () => {
    try {
      const result = await deactivateRovylLicenseDevice();
      diagLog("[License] Device released on the server");
      return { ok: true, result };
    } catch (error) {
      diagLog(`[License] Remote deactivation failed: ${error?.message}`);
      return {
        ok: false,
        error: error?.message || "This device could not be released.",
        code: error?.code || "DEACTIVATE_FAILED",
      };
    }
  });

  /**
   * Development key — local activation, no server and no device spent.
   *
   * Only the SHA-256 ends up in the binary; the key itself is never written in the code, so anyone
   * taking the executable apart finds a hash and not a key. It is still a door: whoever knows it
   * activates any install. Treat it as a credential — keep it out of screenshots, commits and videos.
   */
  const DEV_LICENSE_KEY_SHA256 =
    "b94dc0c453f99b63185c20e3fa538c7d89528328a5cf30fa92dd5fe358510972";

  function isDevLicenseKey(licenseKey) {
    if (typeof licenseKey !== "string" || !licenseKey.trim()) return false;
    const digest = crypto
      .createHash("sha256")
      .update(licenseKey.trim().toUpperCase())
      .digest("hex");
    /** Constant-time comparison: a normal one leaks the prefix through timing. */
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(DEV_LICENSE_KEY_SHA256, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  ipcMain.handle("activate-rovyl-license", async (_event, licenseKey) => {
    if (isDevLicenseKey(licenseKey)) {
      diagLog("[License] Development key accepted — local activation, no server");
      return {
        ok: true,
        license: {
          name: "Rovyl Dev",
          email: "dev@rovyl.app",
          isPremium: true,
          isAdmin: true,
          planTier: "pro",
        },
      };
    }

    try {
      const license = await activateRovylLicenseKey(licenseKey);
      return { ok: true, license };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not activate this license.", code: error?.code || "LICENSE_DENIED" };
    }
  });

  function emitGoogleAuthSuccess(license) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("google-auth-success", {
        email: license.email,
        name: license.name,
        avatarUrl: license.avatarUrl,
        isAdmin: license.isAdmin === true,
        isPremium: true,
        planTier: "pro",
      });
      mainWindow.show();
      mainWindow.focus();
    }
  }

  function sendZenithAuthSuccessHtml(res) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Rovyl — signed in</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e8e8e8;-webkit-font-smoothing:antialiased}
  .glow{pointer-events:none;position:fixed;inset:0;overflow:hidden}
  .glow::before{content:"";position:absolute;top:18%;left:50%;transform:translateX(-50%);width:min(92vw,520px);height:300px;border-radius:50%;background:radial-gradient(ellipse at center,hsla(265,45%,50%,.14) 0%,transparent 70%);filter:blur(48px)}
  .glow::after{content:"";position:absolute;bottom:8%;right:0;width:min(80vw,380px);height:220px;border-radius:50%;background:radial-gradient(ellipse at center,hsla(200,50%,45%,.08) 0%,transparent 72%);filter:blur(40px)}
  .card{position:relative;text-align:center;max-width:420px;margin:0 16px;padding:2px;border-radius:18px;background:linear-gradient(135deg,rgba(139,92,246,.45),rgba(217,70,239,.4),rgba(56,189,248,.42));box-shadow:0 24px 80px -32px rgba(0,0,0,.75),inset 0 1px 0 rgba(255,255,255,.08)}
  .card-inner{border-radius:16px;background:linear-gradient(180deg,hsla(265,50%,50%,.09),hsla(200,50%,45%,.05) 60%,hsla(0,0%,7%,.96));border:1px solid rgba(255,255,255,.08);padding:0 28px 30px;backdrop-filter:blur(12px)}
  .strip{height:3px;border-radius:16px 16px 0 0;margin:0 0 22px;background:linear-gradient(90deg,rgba(139,92,246,.85),rgba(217,70,239,.78),rgba(56,189,248,.75))}
  .icon-wrap{display:inline-flex;align-items:center;justify-content:center;width:76px;height:76px;border-radius:50%;margin:0 auto 18px;padding:2px;background:linear-gradient(135deg,rgba(139,92,246,.55),rgba(217,70,239,.5),rgba(56,189,248,.5));box-shadow:0 0 0 1px rgba(255,255,255,.08)}
  .icon-in{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:hsla(0,0%,7%,.96);border:1px solid rgba(255,255,255,.1)}
  .icon-in svg{width:40px;height:40px;stroke:#7dd3fc;stroke-width:1.35;fill:none;filter:drop-shadow(0 0 12px hsla(199,85%,58%,.35))}
  h1{font-size:1.35rem;font-weight:600;margin:0 0 10px;letter-spacing:-.03em;background:linear-gradient(90deg,#e9d5ff,#f5d0fe,#bae6fd);-webkit-background-clip:text;background-clip:text;color:transparent}
  p{font-size:14px;line-height:1.55;margin:0;opacity:.88}
  p.sub{margin-top:12px;font-size:13px;opacity:.65;line-height:1.45}
</style></head>
<body>
  <div class="glow" aria-hidden="true"></div>
  <div class="card">
    <div class="card-inner">
      <div class="strip" aria-hidden="true"></div>
      <div class="icon-wrap" aria-hidden="true"><div class="icon-in"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div></div>
      <h1>Signed in to Rovyl</h1>
      <p>This page finished linking your account. Return to the Rovyl window &mdash; it should already be signed in.</p>
      <p class="sub">You can close this tab.</p>
    </div>
  </div>
</body></html>`);
  }

  // GOOGLE AUTH: browser opens zenithos.online/auth; site redirects here with id_token (or legacy OAuth /callback).
  let authServer = null;
  ipcMain.on("start-google-auth", () => {
    if (authServer) {
      try {
        authServer.close();
      } catch (e) {}
    }

    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    /**
     * No default value: the ID identifies the publisher's Google Cloud project, and in a public
     * repository a fork would silently inherit the author's project.
     * Whoever builds sets their own in `.env.local` — see `.env.example`.
     */
    const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
    const allowedAuds = [GOOGLE_WEB_CLIENT_ID, GOOGLE_CLIENT_ID].filter(Boolean);

    if (allowedAuds.length === 0) {
      let userDataHint = "";
      try {
        userDataHint = app.getPath("userData");
      } catch (_) {}
      diagLog(
        "[Auth] Missing GOOGLE_CLIENT_ID or GOOGLE_WEB_CLIENT_ID (need at least one for web sign-in)."
      );
      const msg =
        "Google sign-in needs an OAuth client ID. Add GOOGLE_WEB_CLIENT_ID (same as the website / VITE_GOOGLE_CLIENT_ID) or GOOGLE_CLIENT_ID to .env.local in:\n\n" +
        (userDataHint || "AppData") +
        "\n\nThen restart Rovyl.";
      dialog.showErrorBox("Rovyl — Google sign-in", msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("google-auth-error", {
          code: "MISSING_OAUTH_CONFIG",
          userDataPath: userDataHint,
        });
      }
      return;
    }

    diagLog("[Auth] Starting local auth bridge (web sign-in → localhost)...");

    const REDIRECT_URI = "http://localhost:3892/callback";

    authServer = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url, true);
      const pathname = parsedUrl.pathname || "";

      if (pathname === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (pathname === "/desktop-complete") {
        const idToken = parsedUrl.query.id_token;
        if (!idToken || typeof idToken !== "string") {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing id_token.");
          return;
        }
        verifyGoogleIdToken(idToken)
          .then(async (data) => {
            if (!allowedAuds.includes(data.aud)) {
              diagLog(`[Auth] id_token aud rejected: ${data.aud}`);
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid sign-in token (audience). Use the same Google OAuth client as the app.");
              return;
            }
            const email = data.email;
            const name = data.name || (email ? String(email).split("@")[0] : "User");
            const picture = data.picture;
            diagLog(`[Auth] Web id_token OK: ${email}`);
            const license = await activateRovylLicense(idToken);
            emitGoogleAuthSuccess({ ...license, name: license.name || name, avatarUrl: license.avatarUrl || picture });
            sendZenithAuthSuccessHtml(res);
            if (authServer) {
              try {
                authServer.close();
              } catch (e) {}
              authServer = null;
            }
          })
          .catch((e) => {
            diagLog(`[Auth] Sign-in/license failed (${e.code || "AUTH_ERROR"}): ${e.message}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("google-auth-error", { code: e.code || "LICENSE_DENIED", message: e.message });
            }
            dialog.showErrorBox("Rovyl — license required", e.message);
            res.writeHead(e.code === "PURCHASE_REQUIRED" ? 403 : 400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(e.code === "PURCHASE_REQUIRED" ? "No Rovyl purchase was found for this Google account." : "Could not verify your Rovyl license.");
          });
        return;
      }

      if (pathname === "/callback") {
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Legacy OAuth redirect is not configured (missing client secret). Use the website sign-in flow.");
          return;
        }
        const { code } = parsedUrl.query;
        if (!code) {
            res.end("Error: No code received.");
            return;
        }

        diagLog(`[Auth] Received code, exchanging for tokens...`);
        
        // Exchange code for tokens
        const postData = new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString();

        const options = {
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': postData.length
            }
        };

        const tokenReq = https.request(options, (tokenRes) => {
            let body = '';
            tokenRes.on('data', (d) => body += d);
            tokenRes.on('end', () => {
                let tokenData;
                try {
                    tokenData = JSON.parse(body);
                } catch (e) {
                    diagLog("[Auth] Error parsing token response: " + body);
                    res.end("Authentication failed.");
                    return;
                }

                if (tokenData.access_token && tokenData.id_token) {
                    diagLog("[Auth] Access token received, fetching user info...");
                    
                    // Fetch user info
                    https.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokenData.access_token}`, (userRes) => {
                        let userBody = '';
                        userRes.on('data', (d) => userBody += d);
                        userRes.on('end', async () => {
                            const userInfo = JSON.parse(userBody);
                            const { email, name, picture } = userInfo;
                            
                            diagLog(`[Auth] Successfully authenticated as ${email}`);
                            try {
                              const license = await activateRovylLicense(tokenData.id_token);
                              emitGoogleAuthSuccess({ ...license, name: license.name || name, avatarUrl: license.avatarUrl || picture });
                              sendZenithAuthSuccessHtml(res);
                            } catch (e) {
                              diagLog(`[Auth] Legacy license failed (${e.code || "LICENSE_DENIED"}): ${e.message}`);
                              dialog.showErrorBox("Rovyl — license required", e.message);
                              res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
                              res.end("No active Rovyl license was found for this account.");
                            }
                            
                            if (authServer) {
                                authServer.close();
                                authServer = null;
                            }
                        });
                    });
                } else {
                    diagLog("[Auth] Error: Failed to exchange code for an ID token: " + body);
                    res.end("Authentication failed.");
                }
            });
        });

        tokenReq.on('error', (e) => {
            diagLog("[Auth] Request error: " + e.message);
            res.end("Network error.");
        });

        tokenReq.write(postData);
        tokenReq.end();

      } else {
        res.writeHead(404);
        res.end();
      }
    });

    authServer.on("error", (err) => {
      diagLog(`[Auth] HTTP server error: ${err.code || ""} ${err.message}`);
      const detail =
        err.code === "EADDRINUSE"
          ? "Port 3892 is already in use. Close another Rovyl instance or any app using that port, then try again."
          : err.message;
      dialog.showErrorBox("Rovyl — Google sign-in", detail);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("google-auth-error", {
          code: err.code,
          message: err.message,
        });
      }
      authServer = null;
    });

    authServer.listen(3892, () => {
      diagLog("[Auth] Local callback server listening on port 3892");
      const base =
        process.env.ZENITH_WEB_AUTH_URL || "https://rovyl-red.vercel.app/auth";
      const sep = base.includes("?") ? "&" : "?";
      const webAuthUrl = `${base}${sep}client=desktop`;
      diagLog(`[Auth] Opening browser (web sign-in): ${webAuthUrl}`);
      shell.openExternal(webAuthUrl);
    });

    setTimeout(() => {
        if (authServer) {
            authServer.close();
            authServer = null;
            diagLog("[Auth] Server timed out after 5 minutes");
        }
    }, 5 * 60 * 1000);
  });

  ipcMain.on("set-workspace-shortcuts", (event, isOpen, numberKeysClaimed, keys) => {
    const nextBindings = sanitizeWorkspaceBindings(keys, numberKeysClaimed);
    /**
     * Two features cannot own one key, and with a list in hand that is already settled: the digits
     * quick launch claims were dropped as the list was read. Without one — an older renderer, which
     * only ever meant the positional 1–9 — the claim still has to be applied to the whole set.
     */
    const useNumeric = nextBindings !== null || numberKeysClaimed !== true;
    /**
     * A send without the list is that older renderer: keep whatever is already held rather than
     * dropping to no bindings at all, which would leave the wheel with no keys.
     */
    const bindings = nextBindings || workspaceShortcutBindings;
    const sameBindings =
      bindings.length === workspaceShortcutBindings.length &&
      bindings.every((b, i) => b.key === workspaceShortcutBindings[i].key && b.index === workspaceShortcutBindings[i].index);
    if (
      workspaceShortcutsMenuOpen === isOpen &&
      workspaceShortcutsUseNumeric === useNumeric &&
      sameBindings
    ) {
      return;
    }
    /**
     * Release the OLD keys before adopting the new ones. A workspace re-keyed from 2 to K while
     * the wheel was open would otherwise leave 2 registered forever, swallowing that digit system
     * wide — `unregisterWorkspaceShortcuts` only knows the list it is holding.
     */
    if (!sameBindings) unregisterWorkspaceShortcuts();
    workspaceShortcutBindings = bindings;
    workspaceShortcutsMenuOpen = isOpen;
    workspaceShortcutsUseNumeric = useNumeric;
    if (!isOpen) {
      shortcutHoldActive = false;
    }
    if (isOpen && useNumeric) {
      registerWorkspaceShortcuts();
    } else {
      unregisterWorkspaceShortcuts();
    }
  });


  // Open Settings Window Handler

  // Helper to handle ASAR path for child processes
  const getAssetPath = (relative) => {
    const p = path.join(__dirname, relative);
    return isDev ? p : p.replace("app.asar", "app.asar.unpacked");
  };

  // 2. Middle-button capture by the global WH_MOUSE_LL hook in `backend/mouse-blocker.ps1`.
  //    It is NOT polling: the hook sees every mouse event in the system, movement included.
  let mouseHook = null;
  /** The button the current probe was started with — compared to know whether it has to be restarted. */
  let activeMouseHookButton = "middle";
  let activeMouseHookMode = null;
  /**
   * The real threshold of "hold" mode. A normal MMB click usually ends before this time: the
   * MIDDLE_UP cancels the timer and the browser gets the gesture as usual (to close a tab, for
   * instance). Only keeping the button down for 200 ms opens the radial.
   * "click" mode does not go through this timer.
   */
  const MMB_HOLD_OPEN_DELAY_MS = 200;
  /**
   * "click" mode's threshold: above this the press was a HOLD and the radial does not open.
   *
   * Without it, "click" mode opened on ANY release — the press was timed into `mmbClickDownAt` and
   * the value was never read. Someone holding the wheel to pan the page sees the hook swallow the
   * button (nothing scrolls) and, on release, the radial appeared; with clickless execution on, the
   * movement still left in the hand immediately confirmed a direction and launched an app nobody
   * chose.
   *
   * It is not the hook's 250 ms `PASSTHROUGH_MAX_MS`: that one decides whether the swallowed click
   * is given back to the window underneath, where failing costs one middle click that can be
   * repeated. Here failing costs the app's main gesture, with no sign at all that it was refused —
   * so the margin is wider. A deliberate middle-button click (stiff, it is the wheel pressed on its
   * axis) reaches 300 ms; holding to pan never drops below ~500 ms, because the movement itself
   * takes time.
   */
  const MMB_CLICK_MAX_MS = 400;
  /**
   * The other proof, and the one you feel: the hand left the spot, so the press is not a click and
   * the button can go to the window underneath NOW, without waiting the 400 ms.
   *
   * Panning is moving, so in practice the pan starts as soon as there is anything to pan — which is
   * the difference between "the pressed wheel does nothing for half a second" and "it works the way
   * it always worked".
   *
   * 30 px sits well above the tremor of a hand clicking (below 10 px, even at high DPI) and well
   * below any pan gesture. It is not the 6 px `TRIGGER_PASSTHROUGH_SLOP_PX`: that one decides
   * whether a short click is given back, and 6 px here would steal clicks from shaky hands.
   */
  const MMB_CLICK_DRAG_PX = 30;
  /**
   * Main's net, and nothing more.
   *
   * The one that classifies the press is the hook: it has the exact instant of both halves of the
   * button and sends `TRIGGER_HOLD` instead of `TRIGGER_UP` when it was a hold. Here we only
   * measure from the instant the DOWN LINE was read to the instant the UP one was read, which
   * includes stdout and Electron's event loop — tightening this to 400 ms put the two clocks
   * arguing over the boundary and refusing legitimate clicks because of a read delay. It stays
   * loose: it catches an absurd press that reached here anyway, and nothing else.
   */
  const MMB_CLICK_BACKSTOP_MS = 1000;
  let mmbHoldOpenTimer = null;
  let mmbIsDown = false;
  /** Invalidates an async check if the button is released or a newer gesture appears. */
  let mmbHoldGestureId = 0;
  let mmbFirstDownAt = 0;
  let mmbClickDownAt = 0;
  /** The MIDDLE_UP belonging to an MMB used only to close must not select the active slice. */
  let suppressNextMmbRelease = false;

  /**
   * "hold" mode: the radial opens with the middle button STILL down. On Windows the mouse capture
   * belongs to the window that received the WM_MBUTTONDOWN (the desktop / the app underneath), so
   * our window gets not A SINGLE `mousemove` until the button is released — the angle never updates
   * and nothing becomes selectable. We poll the cursor in main and forward it to the renderer,
   * which replays it as a real `mousemove`. It only runs between the MIDDLE_DOWN that opened the
   * radial and the MIDDLE_UP.
   */
  const MMB_CURSOR_POLL_MS = 8;
  /**
   * Safety net: the probe's normal end is the MIDDLE_UP, but if the hook process dies with the
   * button down that event never arrives. Without this cap an 8 ms interval was left sending IPC
   * forever — exactly the kind of leak that only shows after hours of use.
   * No real "hold" gesture lasts a minute.
   */
  const MMB_CURSOR_MAX_MS = 60000;
  let mmbCursorTimer = null;
  let mmbCursorStartedAt = 0;
  let mmbLastCursor = { x: NaN, y: NaN };

  const stopMmbCursorTracking = () => {
    if (!mmbCursorTimer) return;
    clearInterval(mmbCursorTimer);
    mmbCursorTimer = null;
    mmbCursorStartedAt = 0;
    mmbLastCursor = { x: NaN, y: NaN };
  };

  const startMmbCursorTracking = () => {
    stopMmbCursorTracking();
    mmbCursorStartedAt = Date.now();
    mmbCursorTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        stopMmbCursorTracking();
        return;
      }
      if (Date.now() - mmbCursorStartedAt > MMB_CURSOR_MAX_MS) {
        diagLog("[MouseHook] Cursor probe ended by timeout (MIDDLE_UP never arrived).");
        stopMmbCursorTracking();
        return;
      }
      let point;
      try {
        point = screen.getCursorScreenPoint();
      } catch (e) {
        return;
      }
      if (point.x === mmbLastCursor.x && point.y === mmbLastCursor.y) return;
      mmbLastCursor = point;
      try {
        sendToOverlay("mmb-cursor", { x: point.x, y: point.y });
      } catch (e) {
        /* ignore */
      }
    }, MMB_CURSOR_POLL_MS);
  };

  /** Defined further down; the blocker calls it with the TRIGGER_* lines. */
  let handleTriggerData = null;

  const startMouseHook = () => {
    if (mouseHook) return;
    activeMouseHookButton = cachedRadialFlags.mouseTriggerButton;
    activeMouseHookMode = cachedRadialFlags.mouseTriggerMode;
    /** A binding the parser refuses is a binding the hook must not arm: fall back to the default. */
    const binding =
      parseMouseTrigger(activeMouseHookButton) || parseMouseTrigger(DEFAULT_MOUSE_TRIGGER);
    /**
     * Left and right are click-only, and Settings hides the choice for them. The coercion is here
     * as well because a config can be hand edited, or carry a `hold` left behind by the button it
     * was set for — and arming hold on the primary button means holding it down for the length of
     * every gesture, which the rest of Windows reads as a drag.
     */
    const mode =
      mouseTriggerAllowsHold(binding.token) && cachedRadialFlags.mouseTriggerMode === "hold"
        ? "hold"
        : "click";
    diagLog(
      `Mouse trigger captured by the hook (${binding.token}, ${mode}, slop ${TRIGGER_PASSTHROUGH_SLOP_PX}px)`,
    );
    /** "Active" marker: there is no process of its own any more, but the rest of the code tests the truth of this. */
    mouseHook = { active: true };
    radialTriggerListener = (text) => {
      if (handleTriggerData) void handleTriggerData(text);
    };
    setRadialTriggerCapture(
      binding.vk,
      mode,
      TRIGGER_PASSTHROUGH_SLOP_PX,
      MMB_CLICK_MAX_MS,
      MMB_CLICK_DRAG_PX,
      binding.modMask,
    );

    handleTriggerData = async (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const line of lines) {
        const msg = line.trim();
        if (!msg) continue;

        if (msg === "TRIGGER_DOWN") {
          const now = Date.now();
          mmbIsDown = true;
          const holdGestureId = ++mmbHoldGestureId;
          /**
           * The renderer syncs `workspaceShortcutsMenuOpen` with the radial's real state.
           * When it is already open, close immediately on the DOWN and consume the matching UP;
           * that way an app/workspace under the cursor is never executed by the toggle gesture.
           */
          if (workspaceShortcutsMenuOpen && mainWindow && !mainWindow.isDestroyed()) {
            if (mmbHoldOpenTimer) {
              clearTimeout(mmbHoldOpenTimer);
              mmbHoldOpenTimer = null;
            }
            mmbFirstDownAt = 0;
            mmbClickDownAt = 0;
            suppressNextMmbRelease = true;
            stopMmbCursorTracking();
            sendToOverlay("open-menu", {
              source: cachedRadialFlags.mouseTriggerMode === "click" ? "mmb-click" : "mmb",
              closeOnly: true,
            });
            continue;
          }
          if (cachedRadialFlags.mouseTriggerMode === "click") {
            mmbClickDownAt = now;
            continue;
          }
          const sinceFirst = mmbFirstDownAt ? now - mmbFirstDownAt : 99999;

          // Second MMB while radial open is still deferred (timer pending): open settings only — no radial this gesture
          if (
            mmbFirstDownAt &&
            mmbHoldOpenTimer &&
            sinceFirst >= 8
          ) {
            if (mmbHoldOpenTimer) {
              clearTimeout(mmbHoldOpenTimer);
              mmbHoldOpenTimer = null;
            }
            mmbFirstDownAt = 0;
            (async () => {
              try {
                await ensureMainWindow();
                openSettingsFromMainProcess();
              } catch (e) {
                diagLog(`[MouseHook] open settings: ${e.message}`);
              }
            })();
          } else {
            // Start (or restart) a single-MMB gesture: defer radial so double-MMB can cancel
            if (mmbHoldOpenTimer) {
              clearTimeout(mmbHoldOpenTimer);
              mmbHoldOpenTimer = null;
            }
            mmbFirstDownAt = now;
            mmbHoldOpenTimer = setTimeout(async () => {
              mmbHoldOpenTimer = null;
              mmbFirstDownAt = 0;
              const allowed = await shouldOpenMenu();
              /** The click may have ended while the game-mode check was waiting. */
              if (
                !allowed ||
                !mmbIsDown ||
                mmbHoldGestureId !== holdGestureId ||
                cachedRadialFlags.mouseTriggerMode !== "hold"
              ) return;
              showMenuAtCursor("mmb");
              /** Button still down: without this probe the renderer gets no `mousemove` at all. */
              startMmbCursorTracking();
            }, MMB_HOLD_OPEN_DELAY_MS);
          }
        } else if (msg === "TRIGGER_UP" || msg === "TRIGGER_HOLD") {
          /**
           * `TRIGGER_HOLD` is the release of a press the hook has already classified as a HOLD and
           * already handed to the window underneath. It has to go through all this cleanup — in
           * particular the consumption of `suppressNextMmbRelease`, which would otherwise stay stuck
           * eating the next gesture's release — but it must not open or select anything.
           */
          const wasHold = msg === "TRIGGER_HOLD";
          mmbIsDown = false;
          mmbHoldGestureId += 1;
          stopMmbCursorTracking();
          if (suppressNextMmbRelease) {
            suppressNextMmbRelease = false;
            continue;
          }
          if (wasHold) {
            mmbClickDownAt = 0;
            continue;
          }
          if (cachedRadialFlags.mouseTriggerMode === "click") {
            /**
             * A snapshot BEFORE the `await`: `shouldOpenMenu()` can cost more than a second because
             * of the PowerShell fallback, and `handleTriggerData` is fired without waiting — by the
             * time it resolves, another pass has already rewritten these fields.
             */
            const downAt = mmbClickDownAt;
            const gestureId = mmbHoldGestureId;
            mmbClickDownAt = 0;
            /**
             * With no paired DOWN the duration is UNKNOWN, and unknown resolves to a hold, never to
             * a click. That is the case of re-arming the hook with the button already down —
             * changing button or mode in settings with the mouse in hand: `stopMouseHook` zeroes
             * `mmbClickDownAt`, so that orphan release no longer opens anything.
             */
            const heldMs = downAt ? Date.now() - downAt : Number.POSITIVE_INFINITY;
            if (heldMs > MMB_CLICK_BACKSTOP_MS) {
              /** This one's only failure mode is a click refused in silence: it goes in the log. */
              diagLog(
                `[MouseHook] Release ignored (${
                  Number.isFinite(heldMs) ? `${heldMs}ms` : "no DOWN"
                } > ${MMB_CLICK_BACKSTOP_MS}ms): it was a hold, not a click.`,
              );
              continue;
            }
            const allowed = await shouldOpenMenu();
            /**
             * The gesture may have been replaced while game mode was being checked: a new DOWN
             * closes the radial through the `closeOnly` branch and arms `suppressNextMmbRelease`.
             * Reopening here gave back the wheel the user had just closed and left that flag stuck,
             * eating the next gesture's release.
             */
            if (!allowed || mmbHoldGestureId !== gestureId) continue;
            showMenuAtCursor("mmb-click");
            continue;
          }
          if (mmbHoldOpenTimer) {
            clearTimeout(mmbHoldOpenTimer);
            mmbHoldOpenTimer = null;
            mmbFirstDownAt = 0;
            continue;
          }
          sendToOverlay("mmb-release");
        }
      }
    };
  };

  const stopMouseHook = () => {
    if (!mouseHook) return;
    mmbIsDown = false;
    mmbHoldGestureId += 1;
    stopMmbCursorTracking();
    if (mmbHoldOpenTimer) {
      clearTimeout(mmbHoldOpenTimer);
      mmbHoldOpenTimer = null;
    }
    mmbFirstDownAt = 0;
    mmbClickDownAt = 0;
    /**
     * This was missing here. A hook restarted mid-press left the flag stuck and it ate the next
     * gesture's release — the same "my click did nothing" the threshold above now makes suspect, so
     * a second cause of it cannot be left standing.
     */
    suppressNextMmbRelease = false;
    diagLog("Stopping Mouse Hook");
    radialTriggerListener = null;
    clearRadialTriggerCapture();
    mouseHook = null;
  };

  stopMouseHookForShutdown = stopMouseHook;

  syncMouseHookState = () => {
    /**
     * The trigger IS a global WH_MOUSE_LL hook (`backend/mouse-blocker.ps1`), not polling — this
     * comment claimed the opposite and that is why a global lag regression survived several
     * investigations. The hook has to both detect AND swallow: a `GetAsyncKeyState` poller only
     * watched, the click went on to the window underneath and Windows entered autoscroll.
     *
     * INVARIANT: nothing that blocks, allocates or enumerates may run on the thread serving that
     * hook — every mouse event in the system goes through it, serialized. A 15 ms watchdog that
     * called `Process.GetProcessById` cost 12 ms per tick and stuttered the whole screen.
     */
    const wantHook = cachedRadialFlags.enableMouseTrigger && !mouseTriggerRecordingPaused;
    /** Changing button requires restarting the probe: the VK is passed at process startup. */
    /** Button OR mode: both travel in the TRIGGER command, so either one requires re-arming the capture. */
    if (
      mouseHook &&
      (activeMouseHookButton !== cachedRadialFlags.mouseTriggerButton ||
        activeMouseHookMode !== cachedRadialFlags.mouseTriggerMode)
    ) {
      stopMouseHook();
    }
    if (wantHook) startMouseHook();
    else stopMouseHook();
  };
  const mouseHookDelayMs = Number.parseInt(
    process.env.ZENITH_MOUSE_HOOK_DELAY_MS ?? "0",
    10,
  );
  if (mouseHookDelayMs > 0) {
    diagLog(
      `[MouseHook] First activation of the global hook delayed ${mouseHookDelayMs}ms (ZENITH_MOUSE_HOOK_DELAY_MS=0 for immediate).`,
    );
    setTimeout(() => syncMouseHookState(), mouseHookDelayMs);
  } else {
    syncMouseHookState();
  }
});

// IPC: renderer updates game mode (we also hydrate from config-v2.json at startup / save-full-config)
ipcMain.on("set-game-mode", (_event, gm) => {
  mergeGameModeConfig(gm);
});

// Helper function to escape command strings for Windows
// Helper to resolve Shell Folder GUIDs (like {7C5A40EF...}) to real paths
const resolveShellPath = (cmd) => {
  if (!cmd || typeof cmd !== "string") return cmd;

  /**
   * An AppsFolder id is an identifier, not a path, even when it is spelled like one.
   *
   * `Get-StartApps` reports VLC as `{7C5A40EF-…}\VideoLAN\VLC\vlc.exe`, and expanding that GUID to
   * `C:\Program Files (x86)` inside the moniker produces an id the shell has never heard of. The
   * substitution below is right for a launch line and wrong for an id, so ids skip it.
   */
  if (win32Launch.isAppsFolderCommand(cmd)) return cmd;

  // Common Windows Known Folder GUIDs
  const guidMap = {
    "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}":
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "{6D809371-213E-4545-97F7-7977F5C0D49C}":
      process.env["ProgramFiles"] || "C:\\Program Files",
    "{F38BF404-1D43-42F2-9305-67DE0B28FC23}":
      process.env["SystemRoot"] || "C:\\Windows",
    "{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}": path.join(
      process.env["SystemRoot"] || "C:\\Windows",
      "System32",
    ),
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}": path.join(
      process.env["SystemRoot"] || "C:\\Windows",
      "System32",
    ),
  };

  let resolved = cmd;
  for (const [guid, p] of Object.entries(guidMap)) {
    // Escape and create a case-insensitive global regex for the GUID
    const escapedGuid = guid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedGuid, "gi");
    if (regex.test(resolved)) {
      resolved = resolved.replace(regex, p);
    }
  }

  // Also handle environment variables if they slipped in (e.g. %SystemRoot%)
  resolved = resolved.replace(/%([^%]+)%/g, (_, n) => process.env[n] || _);

  return resolved;
};

/** Cursor from Windows Start Menu is often stored as AUMID "Anysphere.Cursor" — not a valid CMD executable. */
function resolveCursorExePath() {
  if (process.platform !== "win32") return "cursor";
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "cursor", "Cursor.exe"),
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Cursor", "Cursor.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Cursor", "Cursor.exe"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return "cursor";
}

function resolveVsCodeExePath() {
  if (process.platform !== "win32") return "code";
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "Code.exe"),
  ];
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch (e) { /* ignore */ }
  }
  return "code";
}

/**
 * "Antigravity" is two products: the IDE (`Antigravity IDE.exe`, with an MRU) and the agent
 * (`Antigravity.exe`, no MRU and no folder argument). Opening a recent project has to use the IDE,
 * so it always comes first — the agent is the last resort for old installs where the IDE was still
 * called just "Antigravity".
 */
function resolveAntigravityExePath() {
  if (process.platform !== "win32") return "antigravity";
  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const candidates = [
    path.join(local, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
    path.join(local, "Programs", "Google", "Antigravity IDE", "Antigravity IDE.exe"),
    path.join(programFiles, "Antigravity IDE", "Antigravity IDE.exe"),
    path.join(local, "Programs", "Antigravity", "Antigravity.exe"),
    path.join(local, "Programs", "Google", "Antigravity", "Antigravity.exe"),
    path.join(programFiles, "Antigravity", "Antigravity.exe"),
  ];
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch (e) { /* ignore */ }
  }
  return "antigravity";
}

/**
 * Rewrites Cursor/VS Code–style AUMID tokens to a real .exe or PATH shim so spawn/cmd succeed.
 */
/**
 * An id like `electron.app.Antigravity` is NOT a Windows AUMID: it is the AppUserModelID an Electron
 * app sets to group windows in the taskbar. It does not exist in `shell:AppsFolder`, so launching
 * through there fails and the error shown to the user is the id itself. The name after
 * `electron.app.` is, however, the product's — and that is enough to find the installed executable.
 *
 * Real AUMIDs (MSIX) always carry a `!` (`Microsoft.WindowsTerminal_8wekyb3d8bbwe!App`) and pass
 * through here untouched.
 */
function resolveElectronAumidExe(rawCommand) {
  if (process.platform !== "win32" || !rawCommand || typeof rawCommand !== "string") return null;
  const command = rawCommand.trim().replace(/^"|"$/g, "");
  const match = /^electron\.app\.([^\s"!\\/]+)$/i.exec(command);
  if (!match) return null;

  const product = match[1];
  const wanted = product.toLowerCase().replace(/[^a-z0-9]/g, "");
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "Programs"),
    process.env.PROGRAMFILES || "C:\\Program Files",
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
  ].filter(Boolean);

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase().replace(/[^a-z0-9]/g, "") !== wanted) continue;
      const dir = path.join(root, entry.name);
      /** The executable usually repeats the folder name; otherwise, the first .exe at the top. */
      const candidates = [path.join(dir, `${entry.name}.exe`), path.join(dir, `${product}.exe`)];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch (e) {
          /* carry on */
        }
      }
      try {
        const exe = fs
          .readdirSync(dir, { withFileTypes: true })
          .find((file) => file.isFile() && /\.exe$/i.test(file.name) && !/^unins/i.test(file.name));
        if (exe) return path.join(dir, exe.name);
      } catch (e) {
        /* carry on */
      }
    }
  }
  return null;
}

function normalizeAumidIdeCommands(cmd) {
  if (!cmd || typeof cmd !== "string") return cmd;
  let s = cmd;
  const cursorExe = resolveCursorExePath();
  const token = /\s/.test(cursorExe) ? `"${cursorExe}"` : cursorExe;

  s = s.replace(/"Anysphere\.Cursor(?:![^"]*)?"/gi, `"${cursorExe}"`);
  s = s.replace(/shell:AppsFolder\\Anysphere\.Cursor(?:![^\s"]*)?/gi, `"${cursorExe}"`);
  s = s.replace(/^(shell:AppsFolder\\)?Anysphere\.Cursor(?:![^\s"]*)?(?=\s|$)/i, token);

  /** `electron.app.X` does not exist in AppsFolder: swap for the real executable before launching. */
  const head = s.trim().split(/\s+/)[0];
  const electronExe = resolveElectronAumidExe(head);
  if (electronExe) {
    const quoted = /\s/.test(electronExe) ? `"${electronExe}"` : electronExe;
    s = `${quoted}${s.trim().slice(head.length)}`;
    diagLog(`[Exec] Electron AppUserModelID "${head}" resolved to ${electronExe}`);
  }
  return s;
}

/**
 * VS Code / Cursor / Antigravity: open folder in a new window when the IDE is already running (-n).
 * Only adds the flag when there is a path argument after the executable.
 */
function addIdeNewWindowFlag(cmd) {
  if (!cmd || typeof cmd !== "string") return cmd;
  const t = cmd.trim();
  if (/\s(-n|--new-window)(\s|$)/i.test(t)) return cmd;

  const lower = t.toLowerCase();
  const looksLikeVsFamily =
    lower.includes("cursor.exe") ||
    lower.includes("\\cursor\\") ||
    /^cursor\s/i.test(t) ||
    lower.includes("code.exe") ||
    lower.includes("microsoft vs code\\") ||
    /^code\s/i.test(t) ||
    lower.includes("antigravity.exe") ||
    /^antigravity\s/i.test(t);
  if (!looksLikeVsFamily) return cmd;

  if (t.startsWith('"')) {
    let i = 1;
    while (i < t.length) {
      if (t[i] === '"') break;
      i++;
    }
    if (i < t.length && t[i] === '"') {
      const first = t.slice(0, i + 1);
      const after = t.slice(i + 1).trim();
      if (after) return `${first} -n ${after}`;
    }
    return cmd;
  }

  const sp = t.indexOf(" ");
  if (sp > 0) {
    const head = t.slice(0, sp);
    const rest = t.slice(sp + 1).trim();
    if (!rest) return cmd;
    if (/\.exe$/i.test(head) || /^(cursor|code|antigravity)$/i.test(head)) {
      return `${head} -n ${rest}`;
    }
  }
  return cmd;
}

function removeIdeNewWindowFlag(cmd) {
  if (!cmd || typeof cmd !== "string") return cmd;
  return cmd.replace(/\s+(?:-n|--new-window)(?=\s|$)/i, "");
}

/**
 * Scratch space for the prewarm read below, reused across every app and every pass.
 *
 * This used to be a Map holding up to 8 x 8 MB of executable bytes for the life of the session —
 * and nothing ever read from it. It could not have helped: `CreateProcess` maps the image from a
 * section object on the file, never from a copy sitting in our heap, so the only thing warming the
 * launch is the OS file cache the read itself populates. Retaining the bytes was worse than
 * useless, since 64 MB of extra commit makes Windows likelier to evict the standby pages the
 * feature exists to keep warm.
 */
const PREWARM_SCRATCH_BYTES = 512 * 1024;
let prewarmScratch = null;
let prewarmAppsSignature = "";
ipcMain.on("prewarm-apps", async (_event, rawCommands) => {
  const commands = Array.isArray(rawCommands)
    ? [...new Set(rawCommands.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    : [];
  const signature = commands.slice().sort().join("\u0000");
  if (signature === prewarmAppsSignature) return;
  prewarmAppsSignature = signature;

  const MAX_APPS = 8;
  for (const original of commands.slice(0, MAX_APPS)) {
    try {
      let launch = normalizeAumidIdeCommands(resolveShellPath(original));
      const lower = launch.toLowerCase();
      if (lower.includes("cursor") && (lower.includes("!") || !/\.exe(?:"|\s|$)/i.test(lower))) {
        launch = resolveCursorExePath();
      } else if (lower.includes("antigravity") && (lower.includes("!") || !/\.exe(?:"|\s|$)/i.test(lower))) {
        launch = resolveAntigravityExePath();
      } else if ((lower.includes("visualstudiocode") || lower.includes("visual studio code")) && !/\.exe(?:"|\s|$)/i.test(lower)) {
        launch = resolveVsCodeExePath();
      }
      const { exe } = win32Launch.splitWin32SpawnExeAndArgs(launch);
      const stat = await fs.promises.stat(exe);
      if (!stat.isFile()) continue;
      const handle = await fs.promises.open(exe, "r");
      try {
        if (!prewarmScratch) prewarmScratch = Buffer.allocUnsafe(PREWARM_SCRATCH_BYTES);
        /**
         * Looped through the scratch buffer rather than read whole: touching the pages is the
         * entire point, and holding them afterwards is what this used to get wrong.
         */
        let total = 0;
        while (total < length) {
          const want = Math.min(prewarmScratch.length, length - total);
          const { bytesRead } = await handle.read(prewarmScratch, 0, want, total);
          if (bytesRead <= 0) break;
          total += bytesRead;
        }
        diagLog(`[Prewarm] Touched ${(total / 1024 / 1024).toFixed(1)} MB of ${exe}`);
      } finally {
        await handle.close();
      }
    } catch (e) {
      diagLog(`[Prewarm] Skipped "${original}": ${e.message}`);
    }
  }
});

// Helper function to escape command strings for Windows
const escapeCommand = (cmd) => {
  // If it's a GUID/AUMID (contains ! or is wrapped in {}), don't escape for common paths
  // but we might need quotes if it contains spaces
  if (cmd.includes("!") || (cmd.startsWith("{ ") && cmd.includes("}"))) {
    if (cmd.includes(" ") && !cmd.startsWith('"')) {
      return `"${cmd}"`;
    }
    return cmd;
  }
  // If it's a URL, don't escape
  if (cmd.match(/^https?:\/\//i) || cmd.match(/^(steam|discord|spotify):/i)) {
    return cmd;
  }
  // If it already has quotes, don't add more (likely complex command)
  if (cmd.includes('"')) {
    return cmd;
  }
  // For file paths with spaces, ensure they're properly quoted
  if (cmd.includes(" ") && !cmd.startsWith('"')) {
    return `"${cmd}"`;
  }
  return cmd;
};

/**
 * The facts that travel with the error string in `execute-command`'s result.
 *
 * The string is still the same one — anything that only reads it does not change behaviour. What
 * goes here was already in memory at this point, and without it the renderer would have to guess
 * from Windows prose, which is localized: in Portuguese the same error says "Acesso negado".
 *
 * `exeExists` is the signal no prose gives. `exec_direct` builds `<terminal> /c <line>`, so a badly
 * escaped file that is right there prints exactly the same "is not recognized" as a file that has
 * gone — and telling someone to reinstall an app that never broke is worse than saying nothing.
 * See `src/launchFailure.ts`.
 *
 * No raw `stderr` in the sentence the user reads: that goes in `raw`, and the card puts it behind
 * "Details", in a box that scrolls.
 */
const describeExecutionFailure = (
  trimmedCommand,
  resolvedCommand,
  commandType,
  lastMethod,
  lastError,
) => {
  let exeExists = null;
  try {
    const { exe } = win32Launch.splitWin32SpawnExeAndArgs(String(resolvedCommand || "").trim());
    /**
     * Only a drive letter counts. An unanchored alternative (`[\\/]`) would match anything with a
     * slash in it — `https://…`, `steam://…`, `shell:AppsFolder\…!App` — and the disk would answer
     * "does not exist" for a shortcut that never had a file at all.
     *
     * UNC (`\\server\…`) is deliberately out: this runs in the main process and an `existsSync` on
     * a dead share waits for the SMB timeout with the UI frozen. With no probe the classifier falls
     * back to the text signals, which is what it did before the probe existed.
     */
    if (exe && /^[A-Za-z]:[\\/]/.test(exe)) exeExists = fs.existsSync(exe);
  } catch (e) {
    /* the probe is a bonus: without it the classifier falls back to the text signals */
  }
  return {
    command: trimmedCommand,
    resolvedCommand,
    commandType,
    method: lastMethod,
    /** Node's `err.code`: a string on `spawn` (`ENOENT`), a number (exit code) on `exec`. */
    errorCode: lastError?.code ?? null,
    exeExists,
    raw: String(lastError?.message || "").slice(0, 4000),
  };
};

/**
 * The result the renderer gets back. `ok: false` is the only way a launch failure reaches the UI —
 * the `execution-error` channel, which broadcast the failure to anyone listening, is gone. The
 * renderer used to pair that notice with the item it had just dispatched by comparing commands
 * inside a 15 s window; now the failure comes back through the same `invoke` that asked for it and
 * the item is known without guessing.
 */
const launchOk = (method) => ({ ok: true, method: method || null });
const launchFailed = (error, details) => ({ ok: false, error, details });

/**
 * A target that no longer exists never reaches the shell — and that is why the error card appears.
 *
 * `shell.openPath` and `start ""` answer a deleted file with a Windows DIALOG BOX ("Windows cannot
 * find…"), owned by our window. The promise does not resolve, `exec` does not call back, and the
 * ladder hangs until someone presses OK — with the rest of the app stuck behind it. Measured with a
 * nonexistent `.exe`: `shell.openPath` did not resolve in 8 s, and the `start` after it did not
 * either. While `execute-command` was a fire-and-forget send this passed for "nothing happened";
 * now it was the answer that never came, in exactly the case the card exists to explain.
 *
 * It only probes what is safe to probe: a drive letter. UNC (`\\server\...`) waits for the SMB
 * timeout in the main process, and AUMIDs, aliases and URLs are not files — for those it returns
 * `null` and the ladder runs as always.
 *
 * A "does not exist" from here is trustworthy. `splitWin32SpawnExeAndArgs` only falls back to the
 * first space after finding NO prefix that is a real file, so a path with spaces that is there is
 * always recognized whole.
 */
const missingTargetFailure = (trimmedCommand, resolvedCommand, commandType) => {
  if (process.platform !== "win32" || commandType === "url") return null;
  const line = String(resolvedCommand || "").trim();
  if (!line) return null;

  let target;
  try {
    /**
     * Folders and files are stored as a bare path, so they are only unquoted. Only `app` carries a
     * command LINE, where the executable has to be split off the arguments — and running that
     * splitter over `C:\Reports\Q3 plan.xlsx` would probe `C:\Reports\Q3` and report a document
     * that is sitting right there as missing.
     */
    target =
      commandType === "folder" || commandType === "file"
        ? line.replace(/^"([\s\S]*)"$/, "$1")
        : win32Launch.splitWin32SpawnExeAndArgs(line).exe;
  } catch (e) {
    return null;
  }
  if (!target || !/^[A-Za-z]:[\\/]/.test(target)) return null;

  try {
    if (fs.existsSync(target)) return null;
  } catch (e) {
    /** A disk that does not answer is not a broken shortcut: let the ladder try. */
    return null;
  }

  const shown = line.length > 50 ? `${line.substring(0, 50)}...` : line;
  const what = commandType === "folder" ? "folder" : "file";
  diagLog(`[Exec] Target missing on disk, not handing it to the shell: ${target}`);
  return launchFailed(`Failed to run "${shown}". Error: Windows cannot find the ${what} specified: ${target}`, {
    command: trimmedCommand,
    resolvedCommand: line,
    commandType,
    method: "exists-probe",
    errorCode: "ENOENT",
    exeExists: false,
    raw: `Rovyl checked the path before launching it and Windows reports no such ${what}:
${target}`,
  });
};

let installedAppsCache = null;
/**
 * Lowercased AppIDs from the last scan, so a launch can ask "is this still a Start menu entry?"
 * without paying for PowerShell on the hot path.
 *
 * It exists because `explorer.exe shell:AppsFolder\<id>` cannot report failure: handed an id that
 * no longer resolves it opens a stray Explorer window and exits 0. CapCut's id pins a version
 * (`…apps.9.5.0.4045.capcut.exe`), so an app update alone is enough to strand a shortcut — and
 * "nothing happened" is not an answer. When this set is warm, a dead entry gets a real error card
 * instead; when it is cold the launch still goes ahead, because a cold cache is not evidence.
 */
let installedAppIds = null;

const rememberInstalledApps = (list) => {
  installedAppsCache = list;
  installedAppIds = new Set(
    list
      .map((a) => String(a?.Path || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return list;
};

/** `null` — no opinion (never scanned). `true`/`false` — the last scan did/did not see this id. */
const startAppIdIsKnown = (appId) => {
  if (!installedAppIds) return null;
  const id = String(appId || "").trim().toLowerCase();
  return id ? installedAppIds.has(id) : null;
};

let installedAppsWarming = null;
/**
 * Fills the AppID set in the background after the first AppsFolder launch of a session.
 *
 * Deliberately not awaited by anything: the point of the launcher is that it opens now, and a
 * Start menu sweep costs seconds. The launch that triggers this one runs unverified; every one
 * after it is checked.
 */
const warmInstalledAppsCache = () => {
  if (installedAppIds || installedAppsWarming) return installedAppsWarming;
  installedAppsWarming = scanInstalledApps()
    .then(rememberInstalledApps)
    .catch(() => null)
    .finally(() => { installedAppsWarming = null; });
  return installedAppsWarming;
};

/**
 * A command line the user typed, run by the shell they picked.
 *
 * The line never becomes part of a `cmd` line that `cmd` itself parses. PowerShell gets it as
 * `-EncodedCommand`, which no quoting rule can reach; `cmd` gets it through an environment
 * variable read with delayed expansion (`!VAR!`), which is substituted AFTER the outer `cmd` has
 * finished looking for `&`, `|` and quotes. Only the shell the user picked ever parses the text.
 *
 * An open window goes through `start`, and has to: Node's `detached` sets `DETACHED_PROCESS`, which
 * leaves the child with no console at all (PowerShell then exits 0 having done nothing), and a
 * plain child of a GUI process writes to the `stdio` it was handed rather than to its window.
 * `start` gives it a console of its own — Windows Terminal, when that is the default — and it stays
 * open (`-NoExit`, `/k`) so the output can be read.
 *
 * A hidden run is a plain child with no window, watched for a moment: a typo exits at once with a
 * non-zero code, and that is worth a card, whereas a long-running job is simply left to run.
 */
const HIDDEN_COMMAND_WATCH_MS = 1500;
const COMMAND_LINE_ENV = "ROVYL_COMMAND_LINE";

const runTypedCommand = async (line, options = {}) => {
  const shellKind = options?.commandShell === "cmd" ? "cmd" : "powershell";
  const hidden = options?.commandWindow === "hidden";
  const method = `command-${shellKind}`;
  const shown = line.length > 50 ? `${line.substring(0, 50)}...` : line;
  const failure = (message, extra) =>
    launchFailed(`Failed to run "${shown}". Error: ${message}`, {
      command: line,
      resolvedCommand: line,
      commandType: "command",
      method,
      errorCode: null,
      exeExists: null,
      raw: String(message || "").slice(0, 4000),
      ...extra,
    });

  let cwd = os.homedir();
  const wanted = String(options?.workingDirectory || "").trim().replace(/^"([\s\S]*)"$/, "$1");
  if (wanted) {
    let isDir = false;
    try {
      /** Same rule as `describeExecutionFailure`: a dead UNC share would freeze main on the probe. */
      isDir = /^[A-Za-z]:[\\/]/.test(wanted) ? fs.statSync(wanted).isDirectory() : true;
    } catch (e) {
      isDir = false;
    }
    if (!isDir) {
      return failure(`Working folder not found: ${wanted}`, {
        method: "command-cwd",
        errorCode: "ENOENT",
        exeExists: false,
      });
    }
    cwd = wanted;
  }

  const comspec = process.env.ComSpec || "cmd.exe";
  const psArgs = (keepOpen) => [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    ...(keepOpen ? ["-NoExit"] : []),
    "-EncodedCommand",
    Buffer.from(line, "utf16le").toString("base64"),
  ];

  let exe;
  let args;
  let verbatim = false;
  let env = process.env;
  if (hidden && shellKind === "cmd") {
    exe = comspec;
    args = ["/d", "/s", "/c", `"${line}"`];
    verbatim = true;
  } else if (hidden) {
    exe = "powershell.exe";
    args = psArgs(false);
  } else {
    /** Base64 and fixed switches only, so the PowerShell tail is safe to write inline. */
    const inner = shellKind === "cmd"
      ? `"${comspec}" /d /s /k !${COMMAND_LINE_ENV}!`
      : `powershell.exe ${psArgs(true).join(" ")}`;
    exe = comspec;
    args = ["/d", "/v:on", "/s", "/c", `"start "" ${inner}"`];
    verbatim = true;
    env = { ...process.env, [COMMAND_LINE_ENV]: `"${line}"` };
  }

  diagLog(`[Command] ${shellKind}${hidden ? " (hidden)" : ""} in ${cwd}: ${line}`);

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(exe, args, {
        cwd,
        env,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
    } catch (err) {
      settle({ error: err });
      return;
    }
    child.on("error", (err) => settle({ error: err }));
    /** `start` returns as soon as the window exists; its own exit code is the only one there is. */
    const timer = hidden
      ? setTimeout(() => {
          child.unref();
          settle({ ok: true });
        }, HIDDEN_COMMAND_WATCH_MS)
      : null;
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      settle(code === 0 || code === null ? { ok: true } : { exitCode: code });
    });
  });

  if (outcome.error) {
    diagLog(`[Command] ✗ Failed to start: ${outcome.error.message}`);
    return failure(outcome.error.message, { errorCode: outcome.error.code ?? null });
  }
  if (outcome.exitCode !== undefined) {
    diagLog(`[Command] ✗ Exited with code ${outcome.exitCode}`);
    return failure(`The command exited with code ${outcome.exitCode}.`, { errorCode: outcome.exitCode });
  }
  diagLog("[Command] ✓ Started");
  return launchOk(method);
};

// IPC: receives a command from React to run an app
const runExecuteCommand = async (command, commandType, options = {}) => {
  if (!command || typeof command !== "string" || command.trim() === "") {
    console.warn("EXEC_ERROR: Received empty or invalid command");
    return launchFailed("Empty or invalid command", undefined);
  }

  const trimmedCommand = command.trim();

  /**
   * A typed command line is the user's own text, and everything below rewrites text: GUID
   * expansion, IDE flags, requoting. It leaves before any of that.
   */
  if (commandType === "command") return await runTypedCommand(trimmedCommand, options);

  // CRITICAL: Resolve GUIDs to real paths FIRST, before any detection logic
  let resolvedCommand = resolveShellPath(trimmedCommand);

  /**
   * A bare path is not a launch LINE, and everything below rewrites lines.
   *
   * `canonicalizeWin32LaunchCommand` exists so a command survives `cmd`/`spawn`, and it delivers
   * that by quoting any token holding a space. Over a file target it fires: measured,
   * `D:\Reports\Q3 plan.xlsx` comes back as `"D:\Reports\Q3 plan.xlsx"`, quotes and all. That
   * string does still open — `ShellExecuteEx`, under `shell.openPath`, tolerates a quoted `lpFile`,
   * checked against Electron 28 — so this is not a repair of a broken launch. It is the removal of
   * a rewrite that has no addressee: a file never touches `cmd`, the only rung it gets takes a
   * PATH, and what the quotes buy instead is a dependency on that tolerance, a `[Exec]
   * Canonicalized launch line` entry in the log for every single file launch, and two probes
   * downstream (`missingTargetFailure` and the one in the branch) that have to unquote before they
   * can stat anything.
   *
   * Folders come along because the same reasoning covers them. They were never quoted, but only
   * because the splitter demands `isFile()` before it claims a token whole — a directory has been
   * safe by accident, which is not a property worth continuing to rely on.
   */
  const isBarePathTarget = commandType === "file" || commandType === "folder";
  if (!isBarePathTarget) {
    resolvedCommand = normalizeAumidIdeCommands(resolvedCommand);
  }
  const prefersProcessReuse = options?.launchMode === "reuse" || options?.launchMode === "prewarm";
  if (!isBarePathTarget) {
    resolvedCommand = prefersProcessReuse
      ? removeIdeNewWindowFlag(resolvedCommand)
      : addIdeNewWindowFlag(resolvedCommand);
  }
  if (process.platform === "win32" && !isBarePathTarget) {
    try {
      const canon = win32Launch.canonicalizeWin32LaunchCommand(resolvedCommand);
      if (canon !== resolvedCommand) {
        diagLog(`[Exec] Canonicalized launch line: "${resolvedCommand}" → "${canon}"`);
        resolvedCommand = canon;
      }
    } catch (e) {
      diagLog(`[Exec] Canonicalize skipped: ${e.message}`);
    }
  }

  console.log(`\n========================================`);
  console.log(`EXEC_START: Attempting to launch`);
  console.log(`Command: "${trimmedCommand}"`);
  if (resolvedCommand !== trimmedCommand) {
    console.log(`Resolved to: "${resolvedCommand}"`);
  }
  console.log(`Length: ${trimmedCommand.length} chars`);
  console.log(`Command Type: ${commandType}`);
  console.log(`========================================\n`);

  if (trimmedCommand.startsWith("shortcut:")) {
    const keys = trimmedCommand.replace("shortcut:", "");
    console.log(`  → [shortcut] Simulating keys: ${keys}`);

    // Map common key names to Virtual Key Codes (Windows)
    const vkMap = {
      Ctrl: 0x11,
      Alt: 0x12,
      Shift: 0x10,
      Super: 0x5b, // Windows Key
      Win: 0x5b,
      Space: 0x20,
      Escape: 0x1b,
      Enter: 0x0d,
      Backspace: 0x08,
      Tab: 0x09,
      Delete: 0x2e,
      Insert: 0x2d,
      Home: 0x24,
      End: 0x23,
      PageUp: 0x21,
      PageDown: 0x22,
      ArrowLeft: 0x25,
      ArrowUp: 0x26,
      ArrowRight: 0x27,
      ArrowDown: 0x28,
      Left: 0x25,
      Up: 0x26,
      Right: 0x27,
      Down: 0x28,
    };

    // Add A-Z and 0-9 to map
    for (let i = 0; i < 26; i++) {
      vkMap[String.fromCharCode(65 + i)] = 0x41 + i;
    }
    for (let i = 0; i < 10; i++) {
      vkMap[i.toString()] = 0x30 + i;
    }

    const parts = keys.split("+");
    const vks = parts
      .map((p) => {
        const pClean = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); // Normalize case like "ctrl" -> "Ctrl"
        // Try normalized and then raw
        const vk = vkMap[p] || vkMap[pClean];
        if (!vk) console.warn(`[Shortcut Simulation] Unknown key: ${p}`);
        return vk;
      })
      .filter((vk) => vk !== undefined);

    if (vks.length === 0) {
      console.error("  ✗ [shortcut] No valid keys found for simulation.");
      return launchFailed(`Failed to start key simulator: no usable keys in "${keys}"`, {
        command: trimmedCommand,
        resolvedCommand: trimmedCommand,
        commandType,
        method: "simulate-keys",
        errorCode: null,
        exeExists: null,
        raw: `No virtual-key code matches any of: ${keys}`,
      });
    }

    // PowerShell script using keybd_event from user32.dll
    // keybd_event flags: 0 = Down, 2 = Up

    const scriptPath = getAssetPath("simulate-keys.ps1");
    const vksString = vks.join(",");

    diagLog(
      `[Shortcut Simulation] Calling script: ${scriptPath} with VKS: ${vksString}`,
    );

    /**
     * Wait for the process's `spawn`/`error` instead of returning right after the request.
     *
     * While this was a fire-and-forget send, the `spawn` error — which Node emits a tick later —
     * always arrived AFTER the handler had finished, and went out on a separate channel. Now the
     * failure has to fit in the return value, and `ChildProcess` emits `spawn` as soon as the
     * process actually starts: that is the race waited on here, not just any one.
     */
    const spawnOutcome = await new Promise((resolve) => {
      let settled = false;
      const child = spawn("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        scriptPath,
        "-vks",
        vksString,
      ]);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        console.error("  ✗ [shortcut] Failed to spawn simulation script:", err);
        resolve(err);
      });
      child.on("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(null);
      });
    });

    if (spawnOutcome) {
      return launchFailed(`Failed to start key simulator. Error: ${spawnOutcome.message}`, {
        command: trimmedCommand,
        resolvedCommand: trimmedCommand,
        commandType,
        method: "simulate-keys",
        errorCode: spawnOutcome.code ?? null,
        exeExists: null,
        raw: String(spawnOutcome.message || "").slice(0, 4000),
      });
    }

    console.log("  ✓ [shortcut] Simulation script spawned.");
    return launchOk("simulate-keys");
  }

  const isShellApp = (cmd) => {
    if (!cmd) return false;
    const cleanCmd = cmd.trim().replace(/['"]/g, "");
    const lower = cleanCmd.toLowerCase();
    const base = lower.split(" ")[0];

    // Explicit common AppIDs that are known to work with shell:AppsFolder but might be short
    const commonAppIds = ["msedge", "edge", "chrome", "spotify", "calculator", "notepad"];
    if (commonAppIds.includes(lower)) return true;

    // Common Win32 apps that should NOT be treated as shell apps even if they lack an extension
    const win32Aliases = ["explorer", "calc", "notepad", "cmd", "powershell", "taskmgr", "regedit", "control"];
    if (win32Aliases.includes(base)) return false;

    // Identify Windows Store apps, AUMIDs, and Shell/GUID namespaces
    return (
      lower.startsWith("shell:") ||
      lower.includes("!") || // Standard AUMID indicator (e.g. App!ID)
      /**
       * Any bare `Get-StartApps` AppID, by its shape rather than by name.
       *
       * This used to be a list — `google.antigravity`, `microsoft.`, `discord` — and the list is
       * why Discord launched while Figma did not: both register the same kind of id
       * (`com.squirrel.Discord.Discord`, `com.squirrel.Figma.Figma`) and only one of them was
       * spelled out here. On a live host 151 of the installed entries have this shape, so the list
       * was never going to reach the end of it. See `looksLikeBareStartAppId`.
       */
      win32Launch.looksLikeBareStartAppId(cleanCmd) ||
      /^[A-F0-9]{8,64}$/i.test(base) || // Hex identifier
      // If it looks like a simple name without extension/path, treat as potential AUMID
      (base.length > 2 && !base.match(/\.(exe|lnk|bat|cmd|com|vbs|ps1|txt|pdf|png|jpg|mp3|mp4)$/i) && !base.includes("\\") && !base.includes("/") && !base.includes("."))
    );
  };

  const tryExecution = (method, cmd) => {
    return new Promise((resolve, reject) => {
      diagLog(`  → [${method}] Trying...`);
      let execCmd;
      switch (method) {
        case "shell.openExternal":
          shell
            .openExternal(cmd)
            .then(() => {
              diagLog(`  ✓ [${method}] Success!`);
              resolve(true);
            })
            .catch((err) => {
              diagLog(`  ✗ [${method}] Failed: ${err.message}`);
              reject(err);
            });
          break;
        case "shell.openPath":
          shell.openPath(cmd).then((errMsg) => {
            if (errMsg) {
              diagLog(`  ✗ [${method}] Failed: ${errMsg}`);
              reject(new Error(errMsg));
            } else {
              diagLog(`  ✓ [${method}] Success!`);
              resolve(true);
            }
          });
          break;
        case "exec_start":
          execCmd = `start "" ${escapeCommand(cmd)}`;
          diagLog(`  → [${method}] Running: ${execCmd}`);
          exec(execCmd, (err, stdout, stderr) => {
            if (err) {
              diagLog(`  ✗ [${method}] Failed: ${err.message}`);
              reject(err);
            } else {
              diagLog(`  ✓ [${method}] Success!`);
              resolve(true);
            }
          });
          break;
        /**
         * The Start menu's route, through `explorer.exe` and argv — not `cmd /c start`.
         *
         * `start "" "shell:AppsFolder\<id>"` handed an id the shell cannot resolve does not fail:
         * it raises a MODAL "Windows cannot find…" dialog owned by our window, `exec` never calls
         * back, and the ladder hangs behind it until someone presses OK. Reproduced on a live host
         * with `com.squirrel.Figma.Figma` — that hang, not a missing feature, is what the error
         * card was reporting for every app added from the picker. `explorer.exe` returns at once.
         *
         * argv, so nothing has to survive `cmd` quoting. And the id is taken WHOLE: ids contain
         * spaces (`zoom.us.Zoom Video Meetings`), so the old split-at-first-space turned one
         * identifier into an id plus two bogus arguments. AppsFolder activation passes no arguments
         * anyway, which is why there is nothing to split off.
         */
        case "exec_explorer_shell": {
          const appId = win32Launch.appsFolderAppId(cmd) || String(cmd || "").trim();
          const moniker = `${win32Launch.APPS_FOLDER_PREFIX}${appId}`;
          diagLog(`  → [${method}] explorer.exe ${moniker}`);
          const child = spawn("explorer.exe", [moniker], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.on("error", (err) => {
            diagLog(`  ✗ [${method}] Failed: ${err.message}`);
            reject(err);
          });
          child.on("spawn", () => {
            child.unref();
            diagLog(`  ✓ [${method}] Success!`);
            resolve(true);
          });
          break;
        }

        case "exec_direct": {
          const terminal = getPreferredTerminal();
          if (process.platform === "win32") {
            const { exe, args } = win32Launch.splitWin32SpawnExeAndArgs(String(cmd).trim());
            const tail =
              args.length > 0
                ? `${win32Launch.quoteWin32CmdToken(exe)} ${args.map(win32Launch.quoteWin32CmdToken).join(" ")}`
                : win32Launch.quoteWin32CmdToken(exe);
            if (terminal === "wt.exe") {
              execCmd = `wt.exe -d . cmd /c ${tail}`;
            } else {
              execCmd = `${terminal} /c ${tail}`;
            }
          } else if (terminal === "wt.exe") {
            execCmd = `wt.exe -d . cmd /c ${cmd}`;
          } else {
            execCmd = `${terminal} /c ${cmd}`;
          }

          diagLog(`  → [${method}] Running: ${execCmd}`);
          exec(execCmd, (err, stdout, stderr) => {
            if (err) {
              diagLog(`  ✗ [${method}] Failed: ${err.message}`);
              reject(err);
            } else {
              diagLog(`  ✓ [${method}] Success!`);
              resolve(true);
            }
          });
          break;
        }
        case "exec_silent_spawn":
          return new Promise((resolve, reject) => {
            try {
              const { exe: spawnPath, args: spawnArgs } = win32Launch.splitWin32SpawnExeAndArgs(
                String(cmd || "").trim(),
              );

              diagLog(`  → [${method}] Spawning: ${spawnPath} ${spawnArgs.join(" ")}`);
              const looksLikeWinExe =
                /\.(exe|cmd|bat)$/i.test(spawnPath) || /^[a-zA-Z]:[\\/]/.test(spawnPath);
              const child = spawn(spawnPath, spawnArgs, {
                detached: true,
                stdio: "ignore",
                shell: !looksLikeWinExe,
              });
              
              child.on('error', (err) => {
                diagLog(`  ✗ [${method}] Failed to start: ${err.message}`);
                reject(err);
              });

              // Give it a tiny bit of time to see if it immediately errors
              setTimeout(() => {
                child.unref();
                diagLog(`  ✓ [${method}] Success (Process unrefed)`);
                resolve(true);
              }, 100);
            } catch (e) {
              reject(e);
            }
          });
          break;
        default:
          reject(new Error(`Unknown method: ${method}`));
      }
    });
  };

  /**
   * Resolves cwd for external terminal windows. IDE launch lines look like
   * `"Cursor.exe" "D:\project"` — the first quoted segment is the binary; the last is the folder.
   * Using only the first match wrongly cwd's to Program Files or falls through to process.cwd() (Zenith).
   */
  const extractTerminalWorkingDir = (targetPath) => {
    if (!targetPath || typeof targetPath !== "string") return null;
    const t = targetPath.trim();
    if (!t) return null;

    try {
      if (fs.existsSync(t)) {
        const st = fs.statSync(t);
        return st.isDirectory() ? t : path.dirname(t);
      }
    } catch (_) {}

    const quoted = [...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (let i = quoted.length - 1; i >= 0; i--) {
      const p = quoted[i];
      try {
        if (!fs.existsSync(p)) continue;
        const st = fs.statSync(p);
        if (st.isDirectory()) return p;
        return path.dirname(p);
      } catch (_) {}
    }

    // Unquoted arg after first token, e.g. cursor D:\path
    const sp = t.indexOf(" ");
    if (sp > 0) {
      const tail = t.slice(sp + 1).trim().replace(/^["']|["']$/g, "");
      if (tail && tail !== t) {
        try {
          if (fs.existsSync(tail)) {
            const st = fs.statSync(tail);
            return st.isDirectory() ? tail : path.dirname(tail);
          }
        } catch (_) {}
      }
    }

    return null;
  };

  // Helper to run terminal commands in a specific directory
  const runAutoCommands = async (cmds, targetPath, openEmptyIfNoCmds = false, explicitWorkingDirectory) => {
    const commandsToRun = (cmds && Array.isArray(cmds) && cmds.length > 0) 
      ? cmds.filter(c => c && c.trim() !== "") 
      : [];
    
    // If we have no specific commands but openTerminal was requested, open one empty terminal
    const finalCmds = (commandsToRun.length === 0 && openEmptyIfNoCmds) ? [""] : commandsToRun;
    
    if (finalCmds.length === 0) return;
    
    const terminal = getPreferredTerminal();
    let workingDir = process.cwd();
    const resolvedWd = extractTerminalWorkingDir(explicitWorkingDirectory) || extractTerminalWorkingDir(targetPath);
    if (resolvedWd) workingDir = resolvedWd;

    diagLog(`  → [AutoCommands] Starting execution of ${finalCmds.length} command(s) in ${workingDir}`);

    for (const cmd of finalCmds) {
      let shellCmd;
      const safeWorkingDir = workingDir.replace(/"/g, '""'); // Double quotes for CMD escape

      if (terminal === "wt.exe") {
        // Windows Terminal: Use PowerShell instead of CMD as the default shell for running commands
        shellCmd = cmd 
          ? `wt.exe -d "${workingDir}" powershell.exe -NoExit -Command "${cmd}"` 
          : `wt.exe -d "${workingDir}"`;
      } else if (terminal === "powershell.exe") {
        // PowerShell: cd first, then run command if present. Use -NoExit to keep window open.
        shellCmd = cmd 
          ? `start powershell.exe -NoExit -Command "Set-Location '${workingDir}'; ${cmd}"` 
          : `start powershell.exe -NoExit -Command "Set-Location '${workingDir}'"`;
      } else {
        // CMD: Use "" as a blank title so 'start' doesn't think the quoted path is the title
        shellCmd = cmd 
          ? `start "" cmd.exe /k "cd /d "${workingDir}" && ${cmd}"` 
          : `start "" cmd.exe /k "cd /d "${workingDir}""`;
      }
      
      diagLog(`  → [AutoCommands] Spawning window: ${shellCmd}`);
      // Use spawn with shell: true for faster, more reliable execution on Windows
      spawn(shellCmd, { shell: true, detached: true, stdio: 'ignore' }).unref();
    }
  };

  /** When IDE branch already spawned wt/cmd for openTerminal, skip duplicate in success loop. */
  let skipTerminalAfterLaunchLoop = false;

  try {
    if (commandType === "url") {
      diagLog("  → Detected: Explicit URL (from commandType)");
      await tryExecution("shell.openExternal", resolvedCommand);
      runAutoCommands(options.terminalCommands, resolvedCommand, options?.openTerminal, options?.workingDirectory);
      diagLog(
        `\n✓✓✓ EXEC_SUCCESS: Launched URL with 'shell.openExternal' ✓✓✓\n`,
      );
      return launchOk("shell.openExternal");
    }

    if (commandType === "folder") {
      diagLog("  → Detected: Explicit Folder (from commandType)");

      const gone = missingTargetFailure(trimmedCommand, resolvedCommand, commandType);
      if (gone) return gone;

      
      if (options?.openTerminal || (options?.terminalCommands && options.terminalCommands.length > 0)) {
        diagLog("  → Folder + Open Terminal (or AutoCommands) requested");
        try {
          await runAutoCommands(options.terminalCommands, resolvedCommand, options?.openTerminal, options?.workingDirectory);
          diagLog(`\n✓✓✓ EXEC_SUCCESS: Terminal(s) spawned for folder ✓✓✓\n`);
          return launchOk("runAutoCommands");
        } catch (err) {
          diagLog(`[Exec] Failed to run auto-commands, falling back to basic folder open: ${err.message}`);
          await tryExecution("shell.openPath", resolvedCommand);
          return launchOk("shell.openPath");
        }
      }

      await tryExecution("shell.openPath", resolvedCommand);
      diagLog(
        `\n✓✓✓ EXEC_SUCCESS: Opened Folder with 'shell.openPath' ✓✓✓\n`,
      );
      return launchOk("shell.openPath");
    }

    /**
     * A document, opened the way a double-click in Explorer opens it.
     *
     * `shell.openPath` and nothing else: it asks Windows which program owns the extension, which is
     * the entire point of the type. The app ladder below is not a fallback here — `exec_direct`
     * wraps the line in `<terminal> /c`, so a `.pdf` down that route either flashes a console or,
     * for a `.ps1`/`.bat` the user only meant to OPEN, runs it. A file shortcut must never become
     * an execution, so this branch answers with its own failure instead of falling through.
     */
    if (commandType === "file") {
      diagLog("  → Detected: Explicit File (from commandType)");

      const gone = missingTargetFailure(trimmedCommand, resolvedCommand, commandType);
      if (gone) return gone;

      try {
        await tryExecution("shell.openPath", resolvedCommand);
      } catch (err) {
        /**
         * Honest, not convenient: the probe above only has an opinion about a drive-letter path, so
         * a UNC target stays `null` rather than claiming the file is there. `src/launchFailure.ts`
         * reads this to tell "the file moved" apart from "nothing opens this kind of file".
         */
        let onDisk = null;
        try {
          const target = String(resolvedCommand || "").trim().replace(/^"([\s\S]*)"$/, "$1");
          if (/^[A-Za-z]:[\\/]/.test(target)) onDisk = fs.existsSync(target);
        } catch (e) {
          /* no opinion */
        }
        const shown =
          resolvedCommand.length > 50
            ? `${resolvedCommand.substring(0, 50)}...`
            : resolvedCommand;
        return launchFailed(
          `Failed to run "${shown}". Error: ${err?.message || "Unknown"}`,
          {
            command: trimmedCommand,
            resolvedCommand,
            commandType,
            method: "shell.openPath",
            errorCode: err?.code ?? null,
            exeExists: onDisk,
            raw: String(err?.message || "").slice(0, 4000),
          },
        );
      }

      /** Legacy configs can still carry these; `extractTerminalWorkingDir` turns a file into its folder. */
      await runAutoCommands(
        options.terminalCommands,
        resolvedCommand,
        options?.openTerminal,
        options?.workingDirectory,
      );
      diagLog(
        `\n✓✓✓ EXEC_SUCCESS: Opened File with 'shell.openPath' ✓✓✓\n`,
      );
      return launchOk("shell.openPath");
    }

    let methodsToTry = [];

    if (commandType === "app") {
      let finalCommand = resolvedCommand.trim();
      const originalAumidCommand = finalCommand; // Keep original in case mapping fails
      const lowerCmd = finalCommand.toLowerCase();
      const hasArgs = finalCommand.includes(" ") && !finalCommand.startsWith('"'); // Simple heuristic for args

      let wasMapped = false;
      // IDE MAPPING: Auto-convert AUMIDs to CLI for folder opening
      // If the command contains an AUMID and looks like it's trying to open a folder
      if (lowerCmd.includes("google.antigravity") && lowerCmd.includes(":\\")) {
        finalCommand = finalCommand.replace(/google\.antigravity/i, "antigravity");
        diagLog(`[Exec] Auto-mapped Antigravity AUMID to CLI for folder opening.`);
        wasMapped = true;
      } else if (lowerCmd.includes("cursor") && lowerCmd.includes("!")) {
        // Many cursor installs use AUMIDs that fail with args
        if (lowerCmd.includes(":\\")) {
           const firstSpace = finalCommand.indexOf(" ");
           if (firstSpace > 0) {
             const pathArg = finalCommand.substring(firstSpace).trim();
             finalCommand = `cursor ${pathArg}`;
             diagLog(`[Exec] Auto-mapped Cursor AUMID to CLI.`);
             wasMapped = true;
           }
        }
      }

      const isShell = isShellApp(finalCommand);
      const isIDE = 
        finalCommand.toLowerCase().includes("antigravity") ||
        finalCommand.toLowerCase().includes("cursor") ||
        finalCommand.toLowerCase().includes("code");

      // Update resolved command for execution methods
      resolvedCommand = finalCommand;

      /**
       * A Start menu entry, launched the way the Start menu launches it.
       *
       * `explicitMoniker` is provenance: the picker wrote it, so there is nothing to infer. A bare
       * id is the same entry stored before the picker started writing monikers, recognised by shape
       * — that is what makes shortcuts already sitting in a workspace start working, with no
       * migration and no rewrite of anyone's config.
       *
       * IDEs are left to the branch below when the id is bare, because opening a recent project
       * needs a real executable and an argument, and `normalizeAumidIdeCommands` has already
       * rewritten the ones we know. An id carrying a drive path is such a line, so it is not
       * claimed here either: AppsFolder activation has nowhere to put an argument.
       */
      const explicitMoniker = win32Launch.appsFolderAppId(finalCommand);
      const bareStartAppId = win32Launch.looksLikeBareStartAppId(finalCommand) ? finalCommand : null;
      const startAppId = explicitMoniker || bareStartAppId;
      const startAppCarriesPathArg = !!startAppId && /[a-zA-Z]:[\\/]/.test(startAppId);

      if (startAppId && !startAppCarriesPathArg && (explicitMoniker || !isIDE)) {
        const known = startAppIdIsKnown(startAppId);
        if (known === false) {
          diagLog(`[Exec] Not a Start menu entry any more, not handing it to the shell: ${startAppId}`);
          return launchFailed(
            `Failed to run "${startAppId}". Error: Windows no longer lists this app in the Start menu.`,
            {
              command: trimmedCommand,
              resolvedCommand: finalCommand,
              commandType,
              method: "start-apps-probe",
              errorCode: "ENOENT",
              exeExists: false,
              raw: `Rovyl checked the Start menu before launching and no installed app has this id:
${startAppId}

Apps that pin a version into their id (CapCut is one) get a new id when they update. Remove this
shortcut and add the app again to pick up the current one.`,
            },
          );
        }
        /** Nothing has scanned yet: launch on the shape and fill the set in for the next one. */
        if (known === null) warmInstalledAppsCache();

        resolvedCommand = `${win32Launch.APPS_FOLDER_PREFIX}${startAppId}`;
        methodsToTry = ["exec_explorer_shell", "exec_start", "exec_direct"];
        diagLog(`[Exec] Start menu entry (${known ? "verified" : "unverified"}): ${resolvedCommand}`);
      } else if (isIDE && finalCommand.includes(" ")) {
        diagLog(`[Exec] IDE with args detected: prioritizing silent spawn for no flashes.`);
        
        if (wasMapped) {
          try {
            await tryExecution("exec_silent_spawn", finalCommand);
            diagLog(`\n✓✓✓ EXEC_SUCCESS: Launched with 'exec_silent_spawn' (Mapped CLI) ✓✓✓\n`);
            
            if (options?.openTerminal || (options?.terminalCommands && options.terminalCommands.length > 0)) {
              diagLog(`[Exec] Launching IDE Folder with AutoCommands: ${finalCommand}`);
              await runAutoCommands(options?.terminalCommands, finalCommand, options?.openTerminal, options?.workingDirectory);
            }

            return launchOk("exec_silent_spawn");
          } catch (e) {
            diagLog(`[Exec] Mapped CLI silent spawn failed: ${e.message}. Falling back to original AUMID sequence.`);
          }
        }
        
        // Terminal cwd is derived from the full launch line (last quoted path = project folder).
        if (options?.openTerminal || (options?.terminalCommands && options.terminalCommands.length > 0)) {
          diagLog(`[Exec] IDE + terminal: resolving cwd from launch command`);
          await runAutoCommands(options.terminalCommands, finalCommand, options.openTerminal, options?.workingDirectory);
          skipTerminalAfterLaunchLoop = true;
        }
        
        resolvedCommand = originalAumidCommand;
        methodsToTry = ["exec_silent_spawn", "exec_start", "exec_direct", "shell.openPath", "exec_explorer_shell"];
      } else if (isShell && !finalCommand.includes(" ")) {
        methodsToTry = ["exec_explorer_shell", "exec_start", "exec_direct"];
        diagLog(`[Exec] Shell app (AUMID) detected: prioritizing explorer shell.`);
      } else if (isShell && finalCommand.includes(" ")) {
        methodsToTry = ["exec_start", "exec_direct", "exec_explorer_shell"];
        diagLog(`[Exec] Shell app with args: trying start / quoted paths first.`);
      } else {
        /** `exec_direct` passed the whole path to cmd without splitting properly on spaces — prefer start/openPath. */
        methodsToTry = ["exec_start", "shell.openPath", "exec_direct"];
      }
    }
    // GUID/AUMID detection (Shell Namespace / UWP apps)
    else if (
      resolvedCommand.startsWith("{") ||
      resolvedCommand.includes("!") ||
      /^[A-F0-9]{8,64}$/i.test(resolvedCommand) ||
      (resolvedCommand.includes(".") &&
        !resolvedCommand.match(/\.(exe|lnk|bat|cmd)$/i) &&
        !resolvedCommand.includes("\\") &&
        !resolvedCommand.includes("/"))
    ) {
      console.log("  → Detected: Shell App (GUID or AUMID)");
      methodsToTry = [
        "exec_explorer_shell",
        "shell.openExternal",
        "exec_start",
      ];
    }
    // URL detection
    else if (
      resolvedCommand.match(/^https?:\/\//i) ||
      resolvedCommand.match(/^(steam|discord|spotify):/i)
    ) {
      console.log("  → Detected: URL/Protocol");
      methodsToTry = ["shell.openExternal", "exec_start"];
    }
    // Commands starting with "start " (Windows shell commands)
    else if (resolvedCommand.toLowerCase().startsWith("start ")) {
      console.log("  → Detected: Windows 'start' command");
      methodsToTry = ["exec_direct", "exec_start"];
    }
    // Executable file detection
    else if (resolvedCommand.match(/\.(exe|lnk|bat|cmd)$/i) || (resolvedCommand.includes("\\") || resolvedCommand.includes("/"))) {
      console.log("  → Detected: Executable file");
      methodsToTry = ["shell.openPath", "exec_start", "exec_direct"];
    }
    // Simple command / Alias (like "notepad", "calc", "MSEdge", "chrome")
    else {
      console.log("  → Detected: Simple command or Alias");
      methodsToTry = [
        "exec_start",           // try 'start' which handles many aliases well
        "exec_explorer_shell",  // try as AUMID
        "shell.openPath",       // try as path
        "exec_direct",          // last resort: terminal (shows error window if fails)
      ];
    }

    /**
     * The last stop before the shell, and the only one after `resolvedCommand` is settled: the IDE
     * branch rewrites it halfway through, and probing before that probed a path that is no longer
     * the one about to be launched.
     */
    const gone = missingTargetFailure(trimmedCommand, resolvedCommand, commandType);
    if (gone) return gone;

    // Try each method in order
    let lastError = null;
    /** Which rung of the ladder produced the error that was left — the renderer classifies better with it. */
    let lastMethod = null;
    for (const method of methodsToTry) {
      try {
        await tryExecution(method, resolvedCommand);
        if (!skipTerminalAfterLaunchLoop) {
          await runAutoCommands(options.terminalCommands, resolvedCommand, options?.openTerminal, options?.workingDirectory);
        }
        console.log(`\n✓✓✓ EXEC_SUCCESS: Launched with '${method}' ✓✓✓\n`);
        return launchOk(method); // Success! Exit early
      } catch (err) {
        lastError = err;
        lastMethod = method;
        // Continue to next method
      }
    }

    // If we get here, all methods failed
    const finalError = `Failed to run "${resolvedCommand.substring(0, 50)}${resolvedCommand.length > 50 ? "..." : ""}". Error: ${lastError?.message || "Unknown"}`;
    console.error(`\n✗✗✗ EXEC_ABORT: ${finalError} ✗✗✗\n`);
    return launchFailed(
      finalError,
      describeExecutionFailure(trimmedCommand, resolvedCommand, commandType, lastMethod, lastError),
    );
  } catch (err) {
    const finalError = `Unexpected error while running command: ${err.message}`;
    console.error(`\n✗✗✗ EXEC_ABORT: ${finalError} ✗✗✗\n`);
    return launchFailed(
      finalError,
      describeExecutionFailure(trimmedCommand, resolvedCommand, commandType, null, err),
    );
  }
};

/**
 * `handle`, not `on`: whoever launched gets to know whether it launched.
 *
 * The renderer never knew that a shortcut pointed at a file that no longer exists — the send had no
 * reply and the failure went out on a broadcast channel that carried only the command. It is this
 * reply that gives the error card its "Fix shortcut" button: the item that failed is this
 * `invoke`'s item.
 */
ipcMain.handle("execute-command", async (_event, command, commandType, options = {}) => {
  try {
    return await runExecuteCommand(command, commandType, options);
  } catch (err) {
    /** An exception outside the inner `try` (resolveShellPath, canonicalize) must not become a rejection. */
    console.error("EXEC_ABORT: execute-command threw outside the ladder:", err);
    return launchFailed(`Unexpected error while running command: ${err?.message || err}`, {
      command: typeof command === "string" ? command : "",
      commandType,
      method: null,
      errorCode: err?.code ?? null,
      exeExists: null,
      raw: String(err?.stack || err?.message || err).slice(0, 4000),
    });
  }
});

/**
 * Settings is done: take the window off screen.
 *
 * This used to have to ask which of three geometries it was in, because in `small` "hiding" meant
 * collapsing into the idle overlay rather than actually hiding. The overlay is its own window now,
 * so hiding Settings means hiding Settings.
 */
ipcMain.on("hide-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  windowBuriedPassive = true;

  // Remove the native transparent surface completely. Opacity 0 + mouse forwarding still keeps
  // a layered HWND in the Windows input/composition path and can delay high-rate pointers.
  mainWindow.setIgnoreMouseEvents(true);
  mainWindow.hide();
  try {
    mainWindow.webContents.setBackgroundThrottling(true);
  } catch (e) {
    /* ignore */
  }
  scheduleIdleMemoryCleanup(1500);
});

// IPC: Show Window explicitly
/** Persistent helper: starting one powershell per request would cost more than the user takes to type. */
let foregroundFocusHelper = null;
let foregroundFocusHelperReady = false;
let pendingForegroundHwnd = null;
let foregroundStealBusyUntil = 0;
/** One resolver per outstanding `FG`, answered in the order the replies arrive. */
const foregroundSnapshotWaiters = [];

function foregroundFocusAssetPath() {
  const p = path.join(__dirname, "foreground-focus.ps1");
  return isDev ? p : p.replace("app.asar", "app.asar.unpacked");
}

function ensureForegroundFocusHelper() {
  if (process.platform !== "win32" || foregroundFocusHelper) return;
  foregroundFocusHelperReady = false;
  const nativeHelper = getNativeHelperExePath();
  const child = nativeHelper
    ? (diagLog(`[Foreground] Spawning native helper: ${nativeHelper}`),
       spawn(nativeHelper, ["foreground-focus"], { windowsHide: true }))
    : spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", foregroundFocusAssetPath()],
        { windowsHide: true },
      );
  foregroundFocusHelper = child;
  /**
   * Framed by line, and matched by exact text rather than by `includes`.
   *
   * Both matter now that `FG` replies share this pipe. A chunk is not a message — one `data` event
   * can carry two replies or half of one — and the old readiness test was a substring search for
   * "READY" against the whole chunk, so any window whose *title* contained that word would have
   * been read as the helper announcing itself and swallowed the snapshot with it.
   */
  const readHelperLine = createLineSplitter((text) => {
    if (text === "READY") {
      foregroundFocusHelperReady = true;
      if (pendingForegroundHwnd) {
        const hwnd = pendingForegroundHwnd;
        pendingForegroundHwnd = null;
        writeForegroundFocus(hwnd);
      }
      return;
    }
    if (text.startsWith("TRIM|")) {
      diagLog(`[Memory] ${text}`);
      return;
    }
    if (text.startsWith("FG|")) {
      const waiter = foregroundSnapshotWaiters.shift();
      if (waiter) waiter(parseForegroundSnapshot(text.slice(3)));
      return;
    }
    diagLog(`[Foreground] ${text}`);
  });
  child.stdout.on("data", (data) => readHelperLine(data.toString()));
  child.stderr.on("data", (data) => diagLog(`[Foreground] ${data.toString().trim()}`));
  child.on("exit", () => {
    if (foregroundFocusHelper === child) {
      foregroundFocusHelper = null;
      foregroundFocusHelperReady = false;
    }
    // A reply that will never arrive still has a trigger waiting behind it.
    while (foregroundSnapshotWaiters.length) foregroundSnapshotWaiters.shift()(null);
  });
  child.on("error", (err) => diagLog(`[Foreground] failed: ${err.message}`));
}

function writeForegroundFocus(hwnd) {
  if (!foregroundFocusHelper || !foregroundFocusHelperReady || !foregroundFocusHelper.stdin?.writable) {
    pendingForegroundHwnd = hwnd;
    return;
  }
  try {
    foregroundFocusHelper.stdin.write(`FOCUS ${hwnd}\n`);
  } catch (e) {
    diagLog(`[Foreground] write failed: ${e.message}`);
  }
}

let idleMemoryCleanupTimer = null;

function cancelIdleMemoryCleanup() {
  if (idleMemoryCleanupTimer) {
    clearTimeout(idleMemoryCleanupTimer);
    idleMemoryCleanupTimer = null;
  }
}

function scheduleIdleMemoryCleanup(delayMs = 2500) {
  cancelIdleMemoryCleanup();
  idleMemoryCleanupTimer = setTimeout(() => {
    idleMemoryCleanupTimer = null;
    performIdleMemoryCleanup();
  }, delayMs);
  idleMemoryCleanupTimer.unref?.();
}

function performIdleMemoryCleanup() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    diagLog("[Memory] Cleanup skipped: mainWindow not ready or destroyed");
    return;
  }
  // Never perform cleanup while settings or the wheel is visibly active
  if (radialOpen) {
    diagLog("[Memory] Cleanup skipped: the wheel is open");
    return;
  }
  if (!mainWindow.isMinimized() && mainWindow.isVisible()) {
    diagLog("[Memory] Cleanup skipped: Settings is on screen");
    return;
  }

  diagLog("[Memory] Executing idle memory cleanup & working set trim");

  // 1. Force V8 garbage collection in Main Process
  if (typeof global.gc === "function") {
    try {
      global.gc();
    } catch (_) {
      /* ignore */
    }
  }

  // 2. Clear Chromium caches
  try {
    session.defaultSession.clearCache();
    session.defaultSession.clearHostResolverCache();
  } catch (_) {
    /* ignore */
  }

  // 3. Notify renderer to run GC & clear unnecessary transient allocations
  try {
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      sendToSettings("zenith-clean-memory");
      sendToOverlay("zenith-clean-memory");
    }
  } catch (_) {
    /* ignore */
  }

  // 4. Release heavy installedAppsCache array if lingering in memory
  if (installedAppsCache && installedAppsCache.length > 0) {
    installedAppsCache = null;
    diagLog("[Memory] Released installedAppsCache array from RAM");
  }

  // 4b. Trim metadata caches (favicons, titles, detected games) to a lean idle footprint
  try {
    if (typeof faviconDataUrlCache !== "undefined" && faviconDataUrlCache.size > 16) {
      while (faviconDataUrlCache.size > 16) {
        const oldest = faviconDataUrlCache.keys().next().value;
        if (!oldest) break;
        faviconDataUrlCache.delete(oldest);
      }
      diagLog(`[Memory] Trimmed faviconDataUrlCache to ${faviconDataUrlCache.size} entries`);
    }
    if (typeof pageTitleCache !== "undefined" && pageTitleCache.size > 16) {
      while (pageTitleCache.size > 16) {
        const oldest = pageTitleCache.keys().next().value;
        if (oldest === undefined) break;
        pageTitleCache.delete(oldest);
      }
      diagLog(`[Memory] Trimmed pageTitleCache to ${pageTitleCache.size} entries`);
    }
    if (typeof autoDetectedGameCache !== "undefined" && autoDetectedGameCache.size > 32) {
      while (autoDetectedGameCache.size > 32) {
        const oldest = autoDetectedGameCache.keys().next().value;
        if (!oldest) break;
        autoDetectedGameCache.delete(oldest);
      }
    }
  } catch (_) {
    /* ignore */
  }

  // 5. Trim Win32 working set across all Rovyl processes
  try {
    ensureForegroundFocusHelper();
    if (foregroundFocusHelper && foregroundFocusHelperReady && foregroundFocusHelper.stdin?.writable) {
      const pids = new Set();
      pids.add(process.pid);
      if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        try {
          const rPid = mainWindow.webContents.getOSProcessId();
          if (rPid) pids.add(rPid);
        } catch (_) {}
      }
      if (typeof app.getAppMetrics === "function") {
        try {
          const metrics = app.getAppMetrics();
          for (const m of metrics) {
            if (m && m.pid) pids.add(m.pid);
          }
        } catch (_) {}
      }
      if (radialMouseBlocker && radialMouseBlocker.pid) {
        pids.add(radialMouseBlocker.pid);
      }
      if (foregroundFocusHelper && foregroundFocusHelper.pid) {
        pids.add(foregroundFocusHelper.pid);
      }
      if (process.ppid) {
        pids.add(process.ppid);
      }

      const pidList = Array.from(pids).join(",");
      foregroundFocusHelper.stdin.write(`TRIM ${pidList}\n`);
    }
  } catch (e) {
    diagLog(`[Memory] Working set trim error: ${e.message}`);
  }

  // 6. Native Electron working set trim for all processes (Windows-only)
  if (typeof app.trimWorkingSet === "function") {
    try {
      app.trimWorkingSet();
      diagLog("[Memory] Executed app.trimWorkingSet() successfully");
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Asks the warm helper what is in the foreground, in the shape `active-win` used to return.
 *
 * Resolves `null` only when the helper is unavailable or silent, which is the caller's signal to
 * fall back to spawning `get-foreground-exe.ps1`. Measured round-trip on a live host is 0.3-3ms,
 * so the timeout is set well above the noise: it exists to keep a wedged helper from holding the
 * wheel closed, not to bound normal operation.
 */
function getForegroundSnapshotFast() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    ensureForegroundFocusHelper();
    if (!foregroundFocusHelper || !foregroundFocusHelperReady || !foregroundFocusHelper.stdin?.writable) {
      return resolve(null);
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const drop = () => {
      const index = foregroundSnapshotWaiters.indexOf(finish);
      if (index >= 0) foregroundSnapshotWaiters.splice(index, 1);
    };
    const timer = setTimeout(() => {
      drop();
      diagLog("[Foreground] FG timed out");
      finish(null);
    }, 150);
    timer.unref?.();

    foregroundSnapshotWaiters.push(finish);
    try {
      foregroundFocusHelper.stdin.write("FG\n");
    } catch (e) {
      drop();
      diagLog(`[Foreground] FG write failed: ${e.message}`);
      finish(null);
    }
  });
}

function stopForegroundFocusHelper() {
  pendingForegroundHwnd = null;
  while (foregroundSnapshotWaiters.length) foregroundSnapshotWaiters.shift()(null);
  if (!foregroundFocusHelper) return;
  const child = foregroundFocusHelper;
  foregroundFocusHelper = null;
  foregroundFocusHelperReady = false;
  try {
    if (child.stdin?.writable) child.stdin.write("EXIT\n");
  } catch (e) {
    /* ignore */
  }
  setTimeout(() => {
    try { if (!child.killed) child.kill(); } catch (e) { /* ignore */ }
  }, 200).unref?.();
}

/**
 * Windows applies the foreground lock to anyone who did not receive the last input: the wheel is
 * shown with `showInactive()` and neither `focus()` nor `app.focus({ steal: true })` gives it the
 * keyboard — the keys keep landing in the app underneath. Only by sharing the input queue with the
 * foreground thread (in the helper) does `SetForegroundWindow` go through.
 *
 * That comment was written for the wheel and now finally addresses it. While one HWND served both
 * surfaces this was reachable only from a licence-gate text field, and the wheel made do with a
 * plain `focus()` on a window Windows had every right to refuse — which is the sort of thing that
 * works on the machine it was written on. The overlay is the window that needs it: Escape and the
 * workspace number keys are read from the document, so if the keyboard never arrives they do
 * nothing at all.
 */
function stealForegroundForOverlay() {
  if (process.platform !== "win32") return;
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  const now = Date.now();
  if (now < foregroundStealBusyUntil) return;
  foregroundStealBusyUntil = now + 250;

  let hwnd;
  try {
    hwnd = overlayWindow.getNativeWindowHandle().readBigUInt64LE(0).toString();
  } catch (e) {
    diagLog(`[Foreground] HWND unavailable: ${e.message}`);
    return;
  }
  ensureForegroundFocusHelper();
  writeForegroundFocus(hwnd);
}

/** The executable's real version — the settings footer shows it. */
/**
 * Was the app opened by Windows startup?
 *
 * The Start Menu sweep is deferred 20 s so it does not compete with login — at that point the disk
 * and CPU are saturated and a PowerShell probe leaves the system sluggish. Except that deferral
 * applied ALWAYS, even when the user opens the app by hand in the middle of the day, and then they
 * wait 20 s for shortcuts for no reason at all. Knowing where the launch came from separates the
 * two cases.
 */
ipcMain.handle("was-opened-at-login", () => {
  /** The argument first: `wasOpenedAtLogin` is macOS-only and answers false here whatever happened. */
  if (startedAtLogin) return true;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch (e) {
    return false;
  }
});

/**
 * Read once by the preload, before the renderer's first paint.
 *
 * Synchronous on purpose: Settings decides whether to open itself in its very first render, and an
 * answer that arrives a tick later is a window that appears at every Windows login and then takes
 * itself away again.
 */
ipcMain.on("get-launch-flags", (event) => {
  event.returnValue = { openedAtLogin: startedAtLogin };
});

ipcMain.handle("get-app-version", () => app.getVersion());

/**
 * Distribution channel, from the point of view of WHO updates:
 *
 * `store`       the store handles it — the update rows leave the UI
 * `unsupported` unpackaged build (or off Windows): there is no updater to call at all
 * `direct`      NSIS installer — this is where the "Check for updates" row makes sense
 *
 * There used to be only `store`/`direct`, and in development a "Check now" button was left that
 * only knew how to return an error. A button that can never work is worse than no button.
 */
const buildChannel = () => {
  if (isStoreBuild()) return "store";
  if (!isPackagedBuild || process.platform !== "win32") return "unsupported";
  return "direct";
};

ipcMain.handle("get-build-channel", () => buildChannel());

/** Current state, so the panel can paint itself even if it opened after the event. */
ipcMain.handle("get-update-state", () => ({ ...lastKnownUpdate, channel: buildChannel() }));

/**
 * One check, three callers: startup, the timer and the button (panel or tray).
 *
 * What it refuses matters as much as what it does. With the installer already on disk (`ready`)
 * there is nothing to discover: checking again only downloaded the same file over and made the UI
 * regress from "Restart now" to "downloading". With a download in flight, the request joins the one
 * that exists instead of opening another.
 */
const runUpdateCheck = async () => {
  const channel = buildChannel();
  if (channel !== "direct") {
    return {
      ok: false,
      code: channel === "store" ? "STORE_BUILD" : "UNSUPPORTED",
      state: "unsupported",
    };
  }

  if (lastKnownUpdate.state === "ready") {
    return { ok: true, state: "ready", version: lastKnownUpdate.version };
  }
  if (lastKnownUpdate.state === "downloading") {
    return {
      ok: true,
      state: "downloading",
      version: lastKnownUpdate.version,
      percent: lastKnownUpdate.percent,
    };
  }
  if (pendingUpdateCheck) return pendingUpdateCheck;

  pendingUpdateCheck = (async () => {
    try {
      const result = await getAutoUpdater().checkForUpdates();
      const version = result?.updateInfo?.version;
      if (version && version !== app.getVersion()) {
        /** `update-available` has already set the state; return what it became, not what was expected. */
        return { ok: true, state: lastKnownUpdate.state === "ready" ? "ready" : "downloading", version };
      }
      /** Safety net: if `update-not-available` did not arrive, mark the moment anyway. */
      if (lastKnownUpdate.state !== "current") {
        notifyRendererUpdateState("current", app.getVersion(), { checkedAt: Date.now() });
      }
      return { ok: true, state: "current", version: app.getVersion() };
    } catch (error) {
      const message = error?.message || String(error);
      diagLog(`[Update] Check failed: ${message}`);
      notifyRendererUpdateState("error", lastKnownUpdate.version, { error: message });
      return { ok: false, code: "CHECK_FAILED", state: lastKnownUpdate.state, error: message };
    } finally {
      pendingUpdateCheck = null;
    }
  })();

  return pendingUpdateCheck;
};

ipcMain.handle("check-for-updates", () => runUpdateCheck());

/** Restart to install — the user picks the moment, in the Settings row. */
const installUpdateNow = () => {
  if (isStoreBuild()) return;
  /** There is only something to install after `update-downloaded`; before that there is no file. */
  if (lastKnownUpdate.state !== "ready") return;
  if (updateInstallInProgress) return;
  diagLog("[Update] Install requested by the user");
  updateInstallInProgress = true;

  /** The pointer may be parked at the wheel's centre: give it back while the helper is alive. */
  releaseRadialCursor();
  /**
   * Stop the helpers BEFORE exiting. `will-quit` stops them too, but `quitAndInstall` runs the
   * installer as soon as the process ends, and one orphan PowerShell with a file from the install
   * folder open is enough for the replacement to fail.
   */
  stopMouseHookForShutdown();
  stopRadialMouseBlocker();
  stopForegroundFocusHelper();
  systemStatus.stop();

  /**
   * `isForceRunAfter: true` — without this NSIS installs and does NOT relaunch the app, forcing the
   * user to open it by hand. An app that lives in the tray simply vanished after updating.
   */
  getAutoUpdater().quitAndInstall(false, true);
};

ipcMain.on("install-update-now", installUpdateNow);

ipcMain.on("show-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  windowBuriedPassive = false;

  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch (e) {
    /* ignore */
  }
  mainWindow.show();
  mainWindow.focus();
  try {
    mainWindow.webContents.focus();
  } catch (e) {
    /* ignore */
  }
  // hide-window forces opacity 0 — restore immediately so the user never interacts with a "dead" layer
  mainWindow.setOpacity(1);
  try {
    if (typeof mainWindow.webContents.invalidate === "function") {
      mainWindow.webContents.invalidate();
    }
  } catch (e) {
    /* ignore */
  }
  applyMousePolicyAfterReveal(mainWindow);
});

/** Force Chromium to schedule a full repaint — helps transparent/frameless windows on Windows after resize/show. */
ipcMain.handle("invalidate-paint", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMinimized()) return false;
  } catch (e) {
    return false;
  }
  try {
    if (typeof mainWindow.webContents.invalidate === "function") {
      mainWindow.webContents.invalidate();
      return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
});

/** Web content area in screen coordinates — `window.screenX/Y` in the renderer can lag after windowed→small (island shifted). */
ipcMain.handle("get-main-window-content-bounds", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return mainWindow.getContentBounds();
  } catch (e) {
    return null;
  }
});

ipcMain.on("set-window-opacity", (event, opacity) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const v = typeof opacity === "number" && !Number.isNaN(opacity)
    ? Math.max(0, Math.min(1, opacity))
    : 1;
  mainWindow.setOpacity(v);
});


ipcMain.handle("get-onboarding-apps", async () => {
  return new Promise((resolve) => {
    const targetApps = ["Chrome", "Edge", "Discord", "Spotify", "Steam", "VS Code", "Visual Studio Code", "Notepad", "Calculadora", "Calculator"];
    const psScriptContent = `
      $ErrorActionPreference = 'SilentlyContinue'
      $targets = @(${targetApps.map((a) => `'${a}'`).join(", ")})
      $apps = Get-StartApps | Where-Object {
        $name = $_.Name
        $match = $targets | Where-Object { $name -like "*$_*" }
        $match -and ($_.AppID -notmatch 'Help|Feedback|Contact|Support|Manual|Desinstalar|Ajuda')
      } | Select-Object Name, AppID | Select-Object -First 5

      $results = @()
      foreach ($app in $apps) {
        $results += [PSCustomObject]@{
          Name = [string]$app.Name
          Path = [string]$app.AppID
        }
      }
      $results | ConvertTo-Json -Compress
    `;

    const tempPath = path.join(app.getPath("userData"), "temp-onboarding.ps1");
    try {
      fs.writeFileSync(tempPath, psScriptContent, "utf8");
      exec(`powershell -NoProfile -ExecutionPolicy RemoteSigned -File "${tempPath}"`, (error, stdout) => {
        try { fs.unlinkSync(tempPath); } catch (e) {}
        if (error || !stdout) { resolve([]); return; }
        try {
          const apps = JSON.parse(stdout);
          resolve(Array.isArray(apps) ? apps : [apps]);
        } catch (e) { resolve([]); }
      });
    } catch (e) { resolve([]); }
  });
});

// IPC: Get recommended apps for initial workspace (Discovery)
ipcMain.handle("get-startup-apps", async () => {
  return new Promise((resolve) => {
    diagLog("[Discovery] Running Smart Discovery for initial apps...");

    const psScriptContent = `
      $ErrorActionPreference = 'SilentlyContinue'
      $ProgressPreference = 'SilentlyContinue'

      try {
        # 1. Gather all start apps and define aggressive exclusion
        $excludePattern = 'Help|Feedback|Contact|Support|Manual|Setting|Uninstall|Remover|Windows PowerShell|Windows Terminal|Terminal|Welcome|Store|Optional Features|Drivers|Games|Diagnostic|Documentation|AMD |NVIDIA|Intel|Realtek|Update|Setup|Service|Helper|System|Framework|Microsoft |Ajuda|Suporte|Desinstalar|Instalador'
        $startApps = Get-StartApps | Where-Object { $_.Name -and $_.AppID -and $_.Name -notmatch $excludePattern }

        $results = New-Object System.Collections.ArrayList
        $seenAppIds = New-Object System.Collections.ArrayList

        # STEP A: High-Value Priority Search (Common Productivity/Social Apps)
        $priorityTerms = @('Chrome', 'Visual Studio Code', 'VS Code', 'Discord', 'Spotify', 'Telegram', 'WhatsApp', 'Steam', 'Edge', 'Firefox', 'Cursor', 'Obsidian', 'Figma', 'Slack', 'Teams', 'Zoom', 'Notepad', 'Calculadora', 'Calculator')
        foreach ($term in $priorityTerms) {
          $match = $startApps | Where-Object { $_.Name -like "*$term*" } | Select-Object -First 1
          if ($null -ne $match -and $seenAppIds -notcontains $match.AppID) {
            $null = $results.Add([PSCustomObject]@{
              Name = [string]$match.Name
              Path = [string]$match.AppID
              Command = [string]$match.AppID
              TargetPath = ""
            })
            $null = $seenAppIds.Add($match.AppID)
            if ($results.Count -ge 5) { break }
          }
        }

        # STEP B: Search USER START MENU (APPDATA)
        if ($results.Count -lt 5) {
          $userPrograms = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
          if (Test-Path $userPrograms) {
            $shell = New-Object -ComObject WScript.Shell
            $userLnks = Get-ChildItem -Path $userPrograms -Filter *.lnk -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 50
            foreach ($lnk in $userLnks) {
              try {
                $target = $shell.CreateShortcut($lnk.FullName).TargetPath
                if ($target -and (Test-Path $target)) {
                    $item = Get-Item $target
                    if (-not $item.PSIsContainer -and $target -match '\\.(exe|lnk|bat|cmd|msi)$') {
                        $baseName = $lnk.BaseName
                        $match = $startApps | Where-Object { $_.Name -eq $baseName -or $_.AppID -match [regex]::Escape($baseName) } | Select-Object -First 1
                        $appId = if ($null -ne $match) { $match.AppID } else { $lnk.FullName }
                        $appName = if ($null -ne $match) { $match.Name } else { $baseName }
                        if ($seenAppIds -notcontains $appId) {
                            $null = $results.Add([PSCustomObject]@{ Name = [string]$appName; Path = [string]$appId; Command = [string]$appId; TargetPath = [string]$lnk.FullName })
                            $null = $seenAppIds.Add($appId)
                            if ($results.Count -ge 5) { break }
                        }
                    }
                }
              } catch {}
            }
          }
        }

        # STEP C: Final Fallback
        if ($results.Count -lt 5) {
          foreach ($app in $startApps) {
            if ($seenAppIds -notcontains $app.AppID) {
              $null = $results.Add([PSCustomObject]@{ Name = [string]$app.Name; Path = [string]$app.AppID; Command = [string]$app.AppID; TargetPath = "" })
              $null = $seenAppIds.Add($app.AppID)
              if ($results.Count -ge 5) { break }
            }
          }
        }

        if ($results.Count -eq 0) { Write-Output "[]" } else { $results | ConvertTo-Json -Compress }
      } catch { Write-Output "[]" }
    `;

    const tempScriptPath = path.join(app.getPath("userData"), "temp-discovery.ps1");
    try {
      fs.writeFileSync(tempScriptPath, psScriptContent, "utf8");
      exec(`powershell -NoProfile -ExecutionPolicy RemoteSigned -File "${tempScriptPath}"`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        try { fs.unlinkSync(tempScriptPath); } catch (e) {}
        if (error) { diagLog(`[Discovery] PowerShell error: ${error.message}`); resolve([]); return; }
        if (!stdout || stdout.trim() === "" || stdout.trim() === "[]") { diagLog("[Discovery] No apps found"); resolve([]); return; }
        try {
          const apps = JSON.parse(stdout.trim());
          const result = Array.isArray(apps) ? apps : [apps];
          diagLog(`[Discovery] Success: Found ${result.length} apps`);
          resolve(result);
        } catch (e) { resolve([]); }
      });
    } catch (err) { resolve([]); }
  });
});

/**
 * The wheel is finished: put the overlay back to an invisible, click-through box.
 *
 * Deliberately NOT `hide-window`, which is Settings'. Two windows, two lifecycles — conflating them
 * is what made one HWND serve two jobs in the first place.
 */
ipcMain.on("close-radial", () => {
  collapseOverlayToIdle();
});

/**
 * Wheel → writer. The overlay reads the config and never writes it; the settings renderer is the
 * only thing that touches disk, so anything the wheel changes is forwarded there to be saved.
 */
ipcMain.on("radial-workspace-changed", (_event, index) => {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return;
  sendToSettings("radial-workspace-changed", n);
});

ipcMain.on("radial-direction-hint-seen", () => {
  sendToSettings("radial-direction-hint-seen");
});

ipcMain.on("radial-launch-fault", (_event, fault) => {
  if (!fault || typeof fault !== "object") return;
  sendToSettings("radial-launch-fault", fault);
});

/** Writer → wheel: how far the Start Menu scan has got, so an empty wheel can say why. */
ipcMain.on("publish-discovery-phase", (_event, phase) => {
  if (phase !== "idle" && phase !== "waiting" && phase !== "scanning") return;
  sendToOverlay("discovery-phase", phase);
});

// IPC: Minimize — hide from taskbar (tray-only), same idea as old “close” that stayed in the tray.
ipcMain.on("minimize-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setSkipTaskbar(true);
    mainWindow.minimize();
  } catch (e) {
    console.error("minimize-window failed:", e);
  }
});

ipcMain.on("set-window-background", (event, color) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return;
  mainWindow.setBackgroundColor(color);
});

ipcMain.on("toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on("quit-app", () => {
  globalShortcut.unregisterAll();
  app.quit();
});

  ipcMain.on("reset-config", async (event, options = {}) => {
  try {
    diagLog("[Reset] Starting full configuration reset...");
    const configPath = path.join(app.getPath("userData"), "config-v2.json");
    const oldConfigPath = path.join(app.getPath("userData"), "config.json");
    const settingsPath = path.join(app.getPath("userData"), "settings.json");

    // Delete config files
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      diagLog("[Reset] Deleted config-v2.json");
    }
    if (fs.existsSync(oldConfigPath)) {
      fs.unlinkSync(oldConfigPath);
      diagLog("[Reset] Deleted config.json");
    }
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
      diagLog("[Reset] Deleted settings.json");
    }

    // Clear icon cache
    const iconCachePath = path.join(app.getPath("userData"), "icon-cache.json");
    if (fs.existsSync(iconCachePath)) {
      fs.unlinkSync(iconCachePath);
      diagLog("[Reset] Deleted icon-cache.json");
    }

    /**
     * The icon bytes themselves, and the one-shot rollback copy the migration leaves behind.
     * `custom-icons/` is deliberately untouched: those are files the user chose, not extracted
     * ones, and nothing in this change writes there.
     */
    try {
      fs.rmSync(iconStore.dir, { recursive: true, force: true });
      /**
       * And every config that could point back into it. Leaving `config-v2.json.bak` behind meant
       * a factory reset destroyed the icon files while keeping the file that names them: the next
       * launch would fall back to that `.bak` and restore a wheel of broken images.
       */
      for (const name of ["config-v2.json.bak", "config-v2.json.pre-icons.bak", "config-v2.json.icons.tmp"]) {
        fs.rmSync(path.join(app.getPath("userData"), name), { force: true });
      }
      diagLog("[Reset] Deleted the icon store and every config that referenced it");
    } catch (e) {
      diagLog(`[Reset] icon store: ${e.message}`);
    }

    // Clear both pre-rebrand profiles so a factory reset cannot migrate stale data back.
    try {
      const appData = app.getPath("appData");
      for (const legacyName of ["Zenith OS", "zenith-radial-menu"]) {
        const legacyDir = path.join(appData, legacyName);
        for (const f of ["config-v2.json", "config-v2.json.bak", "settings.json"]) {
          const legacy = path.join(legacyDir, f);
          if (fs.existsSync(legacy)) {
            fs.unlinkSync(legacy);
            diagLog(`[Reset] Deleted legacy ${f} from ${legacyName}`);
          }
        }
      }
    } catch (le) {
      diagLog(`[Reset] Legacy cleanup error (non-fatal): ${le.message}`);
    }

    // Clear Electron session storage (Local Storage, IndexedDB, Cache, etc.)
    const { session } = require('electron');
    await session.defaultSession.clearStorageData();
    diagLog("[Reset] Cleared browser session data (Local Storage, etc.)");

    // Clear internal caches
    iconCache.clear();
    markIconCacheDirty();
    gameModeConfig = {
      enabled: false,
      mode: "list",
      blockedApps: "",
      autoDetectGames: false,
    };

    diagLog("[Reset] Configuration reset completed. Restarting...");

    // Relaunch logic handles dev vs prod
    if (isDev) {
      console.log("Dev mode: Reloading window instead of relaunching app...");
      if (mainWindow) {
        await mainWindow.webContents.session.clearStorageData();
        mainWindow.reload();
        mainWindow.show();
      }
    } else {
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    console.error("Failed to reset config:", err);
    diagLog(`[Reset] Error: ${err.message}`);
  }
});

/**
 * IPC: Select File.
 *
 * Two callers, two filters. The Application picker wants a program, so the executable filter comes
 * first and the dialog opens on `.exe`/`.lnk`/`.bat`/`.cmd`. The File picker wants a document, and
 * there the executable filter is actively wrong — it hides every `.pdf` and `.xlsx` in the folder
 * behind a dropdown. `{ mode: "any" }` flips the order; no argument keeps the old behaviour, which
 * is what every existing call site sends.
 */
ipcMain.handle("select-file", async (_event, options = {}) => {
  try {
    const targetWin = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const anyFile = options && options.mode === "any";
    const result = await dialog.showOpenDialog(targetWin, {
      properties: ["openFile"],
      filters: anyFile
        ? [{ name: "All Files", extensions: ["*"] }]
        : [
            { name: "Executables", extensions: ["exe", "lnk", "bat", "cmd"] },
            { name: "All Files", extensions: ["*"] },
          ],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  } catch (e) {
    diagLog(`[select-file] ${e.message}`);
    return null;
  }
});

// IPC: Select Folder (Directory)
ipcMain.handle("select-folder", async () => {
  try {
    const targetWin = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const result = await dialog.showOpenDialog(targetWin, {
      properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  } catch (e) {
    diagLog(`[select-folder] ${e.message}`);
    return null;
  }
});

/* ── Custom icons ─────────────────────────────────────────────────────────────────────────────
 *
 * A picture, an icon file, or one of the icons inside a program, chosen by the user for a
 * workspace or a shortcut. Main reads and extracts; the renderer normalizes every result to the
 * same 256px canvas the automatic icons use (Chromium decodes WebP, SVG and AVIF, GDI+ does not)
 * and hands the PNG back to be stored. The result lives in the same content-addressed store as the
 * extracted icons, so export, import and the sweep treat both alike.
 *
 * The replaced `select-image` copied the original into `userData/custom-icons` under a random name
 * and returned a bare path — which the renderer cannot load from the dev server — and nothing ever
 * called it.
 */

/** Pictures the renderer can decode. SVG is safe here: it only ever reaches an `<img>`. */
const CUSTOM_ICON_IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

/** Files that carry icon resources of their own, possibly hundreds (shell32.dll, imageres.dll). */
const CUSTOM_ICON_LIBRARY_EXTENSIONS = new Set(["exe", "dll", "icl", "cpl", "ocx", "scr", "mun"]);

/** A photo straight off a phone is ~10 MB; nothing an icon needs is larger than this. */
const CUSTOM_ICON_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** 256×256 RGBA is 256 kB raw; this only has to refuse garbage, not police compression. */
const CUSTOM_ICON_MAX_PNG_CHARS = 4 * 1024 * 1024;
/** One run lists every icon in the file. shell32.dll's 329 take under a second. */
const LIBRARY_ICONS_TIMEOUT_MS = 20000;

/**
 * `C:\Windows\System32\shell32.dll,4` → the file and the icon number, the way Windows writes an
 * icon location. `%SystemRoot%` and friends are expanded, so a workspace file stays portable.
 */
function parseCustomIconSource(source) {
  let text = String(source ?? "").trim().replace(/^"([\s\S]*)"$/, "$1").trim();
  if (!text) return null;
  text = text.replace(/%([^%\\/]+)%/g, (whole, name) => process.env[name] ?? whole);
  let index = 0;
  const match = /^([\s\S]*?)\s*,\s*(-?\d+)$/.exec(text);
  /** A file really named `icons,2.png` exists; only split what is not itself a file. */
  if (match && !fs.existsSync(text)) {
    text = match[1].replace(/^"([\s\S]*)"$/, "$1");
    index = Number(match[2]);
  }
  return { filePath: path.normalize(text), index };
}

/**
 * Runs `library-icons.ps1`. Resolves `null` on any failure — a file the picker cannot read is an
 * answer for the renderer to show, not an exception.
 */
function runLibraryIcons(filePath, index, list) {
  return new Promise((resolve) => {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      getAssetPath("library-icons.ps1"),
      "-Path",
      filePath,
      "-Index",
      String(index),
    ];
    if (list) args.push("-List");
    const psExe = getPowerShellExePath();
    const child = spawn(fs.existsSync(psExe) ? psExe : "powershell.exe", args, { windowsHide: true });
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(value);
    };
    const watchdog = setTimeout(() => {
      diagLog(`[CustomIcon] library-icons timed out for ${filePath}`);
      try {
        child.kill();
      } catch {}
      finish(null);
    }, LIBRARY_ICONS_TIMEOUT_MS);
    watchdog.unref?.();
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => diagLog(`[CustomIcon] library-icons stderr: ${String(d).trim()}`));
    child.on("error", (err) => {
      diagLog(`[CustomIcon] library-icons spawn error: ${err.message}`);
      finish(null);
    });
    child.on("close", () => {
      const result = { count: 0, full: null, thumbnails: [] };
      for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
        if (line.startsWith("count ")) {
          result.count = Math.max(0, Number(line.slice(6)) || 0);
          result.thumbnails = Array.from({ length: result.count }, () => "");
        } else if (line.startsWith("full data:image/png;base64,")) {
          result.full = line.slice(5);
        } else if (line.startsWith("thumb ")) {
          const space = line.indexOf(" ", 6);
          const at = Number(line.slice(6, space));
          const data = line.slice(space + 1);
          if (Number.isInteger(at) && at >= 0 && at < result.count && data.startsWith("data:image/png;base64,")) {
            result.thumbnails[at] = data;
          }
        }
      }
      finish(result);
    });
  });
}

ipcMain.handle("choose-custom-icon-file", async () => {
  try {
    const targetWin = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const pictures = Object.keys(CUSTOM_ICON_IMAGE_MIME);
    const libraries = [...CUSTOM_ICON_LIBRARY_EXTENSIONS, "lnk", "url"];
    const result = await dialog.showOpenDialog(targetWin, {
      title: "Choose an icon",
      properties: ["openFile"],
      filters: [
        { name: "Pictures, icons and programs", extensions: [...pictures, ...libraries] },
        { name: "Pictures and icon files", extensions: pictures },
        { name: "Programs and icon libraries", extensions: libraries },
        { name: "All files (uses the file's own icon)", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  } catch (e) {
    diagLog(`[CustomIcon] choose: ${e.message}`);
    return null;
  }
});

/**
 * What a file offers as a custom icon:
 *  - a picture: its bytes, for the renderer to decode and normalize;
 *  - a program or icon library: every icon it holds as a thumbnail, plus the requested one full size;
 *  - anything else: the icon Windows shows for it, already stored.
 */
ipcMain.handle("read-custom-icon-source", async (_event, source) => {
  try {
    const parsed = parseCustomIconSource(source);
    if (!parsed) return { ok: false, error: "No file was given." };
    const { filePath, index } = parsed;
    if (!path.isAbsolute(filePath)) {
      return { ok: false, error: "Use the full path to the file, such as C:\\Icons\\app.png." };
    }
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return { ok: false, error: `${path.basename(filePath)} was not found.` };
    }
    const extension = path.extname(filePath).slice(1).toLowerCase();

    const mime = stat.isFile() ? CUSTOM_ICON_IMAGE_MIME[extension] : undefined;
    if (mime) {
      if (stat.size > CUSTOM_ICON_MAX_IMAGE_BYTES) {
        return { ok: false, error: "That picture is larger than 16 MB." };
      }
      const bytes = await fs.promises.readFile(filePath);
      return { ok: true, kind: "image", path: filePath, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    }

    if (stat.isFile() && CUSTOM_ICON_LIBRARY_EXTENSIONS.has(extension)) {
      const listed = await runLibraryIcons(filePath, index, true);
      if (listed && listed.count > 0) {
        return {
          ok: true,
          kind: "library",
          path: filePath,
          index,
          count: listed.count,
          thumbnails: listed.thumbnails,
          dataUrl: listed.full,
        };
      }
      /** No icon resources of its own: Windows draws the generic program icon, and so do we. */
    }

    const ref = await getFileIconCached(filePath);
    if (!ref) return { ok: false, error: `Windows has no icon for ${path.basename(filePath)}.` };
    return { ok: true, kind: "shell", path: filePath, ref };
  } catch (e) {
    diagLog(`[CustomIcon] read: ${e.message}`);
    return { ok: false, error: "That file could not be read." };
  }
});

/** One icon out of a program or library, at the largest size it carries. */
ipcMain.handle("extract-library-icon", async (_event, filePath, index) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || !Number.isInteger(index)) return null;
  const result = await runLibraryIcons(filePath, index, false);
  return result?.full ?? null;
});

/** A finished, normalized PNG from the renderer, into the icon store. */
ipcMain.handle("store-custom-icon", (_event, dataUrl) => {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/png;base64,") ||
    dataUrl.length > CUSTOM_ICON_MAX_PNG_CHARS
  ) {
    return null;
  }
  try {
    return iconStore.putDataUrl(dataUrl);
  } catch (e) {
    diagLog(`[CustomIcon] store: ${e.message}`);
    return null;
  }
});

// IPC: Get File Icon
const iconCachePath = path.join(app.getPath("userData"), "icon-cache.json");
let iconCache = new Map();

/**
 * Where icon bytes actually live. `icon-cache.json` keeps its name and its job — remembering which
 * icon belongs to which target, keyed by things no filename encodes (an AUMID like
 * `Microsoft.VisualStudioCode` is a key, not a path) — but its values become ~85-byte references
 * instead of ~21 kB of base64 each, so it stops being a multi-megabyte string blob held for the
 * life of the process.
 */
const iconStore = createIconStore(path.join(app.getPath("userData"), "icons"));

// Bump whenever extract-icon.ps1 changes how icons are produced, so cached
// entries rendered by the old pipeline are dropped instead of outliving it.
const ICON_PIPELINE_VERSION = 7;
const ICON_CACHE_MAX_ENTRIES = 600;

/**
 * Removes the native icons already written into the config on disk, so healing resolves them again.
 * Web shortcuts (`http…`) keep their favicon: they do not come from the Windows pipeline. Neither
 * does a custom icon (`iconSource: "custom"`) — the user chose it, and healing would never bring
 * it back.
 */
function stripStaleNativeIcons(configFilePath) {
  let removed = 0;
  try {
    const blob = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
    const isWebShortcut = (item) =>
      item.commandType === "url" || /^https?:/i.test(String(item.command || ""));

    const walk = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item && item.customIconUrl && !isWebShortcut(item) && item.iconSource !== "custom") {
          delete item.customIconUrl;
          removed += 1;
        }
        if (item && Array.isArray(item.children)) walk(item.children);
      }
    };
    const walkWorkspaces = (workspaces) => {
      if (!Array.isArray(workspaces)) return;
      for (const ws of workspaces) walk(ws && ws.apps);
    };

    walkWorkspaces(blob.workspaces);
    walkWorkspaces(blob.config && blob.config.workspaces);
    walk(blob.apps);

    if (removed > 0) {
      const tempPath = `${configFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(blob, null, 2), "utf-8");
      fs.renameSync(tempPath, configFilePath);
    }
  } catch (e) {
    diagLog(`[Import] Could not clear the old icons: ${e.message}`);
  }
  return removed;
}

/**
 * Moves cache entries written before the icon store into it, off the startup path.
 *
 * Deferred rather than inline in `loadIconCache` because the cap is 600 entries and each is a
 * SHA-256 plus a synchronous write of ~21 kB — up to half a second of blocked main process, and
 * `loadIconCache` runs before the window is created. Nothing needs it to have finished: an
 * unmigrated entry is still a `data:` URL, which every consumer already accepts.
 */
const scheduleIconCacheMigration = () => {
  setTimeout(() => {
    let migrated = 0;
    for (const [key, entry] of iconCache) {
      const value = entry && typeof entry === "object" ? entry.data : entry;
      if (typeof value !== "string" || !value.startsWith("data:")) continue;
      try {
        const ref = iconStore.putDataUrl(value);
        if (ref) {
          iconCache.set(key, { ...(entry && typeof entry === "object" ? entry : {}), data: ref });
          migrated += 1;
        }
      } catch (e) {
        diagLog(`[IconCache] migrate ${key}: ${e.message}`);
      }
    }
    if (migrated) {
      /**
       * `markIconCacheDirty`, not the bare flag: `scheduleIconCacheSave` is what arms the write
       * timer, and raising `iconCacheDirty` alone would leave the migration in memory only — the
       * same fat file would be re-migrated on every launch, forever.
       */
      markIconCacheDirty();
      diagLog(`[IconCache] Moved ${migrated} inline icons into the store`);
    }
  }, 3000).unref?.();
};

const loadIconCache = () => {
  try {
    if (fs.existsSync(iconCachePath)) {
      const data = JSON.parse(fs.readFileSync(iconCachePath, "utf-8"));
      if (data && data.__pipelineVersion === ICON_PIPELINE_VERSION && data.icons) {
        iconCache = new Map(Object.entries(data.icons));
        while (iconCache.size > ICON_CACHE_MAX_ENTRIES) {
          const oldest = iconCache.keys().next().value;
          if (!oldest) break;
          iconCache.delete(oldest);
        }
        /**
         * Entries written before the icon store hold a `data:` URL. Move the bytes into the store
         * and keep the reference — not by discarding them and bumping ICON_PIPELINE_VERSION, which
         * would mean re-running PowerShell extraction (about a second each) for icons already in
         * hand, and would make every existing backup import as iconless.
         */
        scheduleIconCacheMigration();
        diagLog(`[IconCache] Loaded ${iconCache.size} icons from disk`);
      } else {
        iconCache = new Map();
        diagLog("[IconCache] Discarded cache from an older icon pipeline");
      }
    }
  } catch (e) {
    diagLog(`[IconCache] Failed to load icon cache: ${e.message}`);
  }
};

/**
 * The cache is the app's biggest file (icons as data URLs) and was rewritten whole every minute,
 * new icons or not — icons are only resolved when apps are discovered, so the overwhelming majority
 * of those writes saved exactly the same content.
 * Marking dirty costs one assignment; the write became async for the same reason the config's did.
 */
let iconCacheDirty = false;
let iconCacheWriting = false;
let iconCacheSaveTimer = null;

const scheduleIconCacheSave = () => {
  if (!iconCacheDirty || iconCacheSaveTimer) return;
  iconCacheSaveTimer = setTimeout(() => {
    iconCacheSaveTimer = null;
    saveIconCache();
  }, 15000);
  iconCacheSaveTimer.unref?.();
};

const markIconCacheDirty = () => {
  iconCacheDirty = true;
  scheduleIconCacheSave();
};

/**
 * Remembers which icon belongs to a target, and returns the string the caller should hand to the
 * renderer — a `rovyl-icon://` reference, not the ~21 kB of base64 it was given.
 *
 * This is the point where base64 stops travelling. Everything downstream — React state, the three
 * `localStorage` mirrors, `config-v2.json` and its `.bak` — carries 85 bytes instead.
 */
const rememberFileIcon = (filePath, data) => {
  let stored = data;
  try {
    const ref = iconStore.putDataUrl(data);
    if (ref) stored = ref;
  } catch (e) {
    /** Storing failed: keep the inline icon rather than lose it. The config writer retries. */
    diagLog(`[IconStore] could not store icon for ${filePath}: ${e.message}`);
  }
  iconCache.delete(filePath);
  iconCache.set(filePath, { data: stored });
  while (iconCache.size > ICON_CACHE_MAX_ENTRIES) {
    const oldest = iconCache.keys().next().value;
    if (!oldest) break;
    iconCache.delete(oldest);
  }
  markIconCacheDirty();
  return stored;
};

const saveIconCache = ({ sync = false } = {}) => {
  if (iconCacheWriting && !sync) return;
  if (!iconCacheDirty) return;
  if (iconCacheSaveTimer) {
    clearTimeout(iconCacheSaveTimer);
    iconCacheSaveTimer = null;
  }
  try {
    const data = {
      __pipelineVersion: ICON_PIPELINE_VERSION,
      icons: Object.fromEntries(iconCache),
    };
    const json = JSON.stringify(data);
    /** Cleared before the write: a `set` that arrives during the I/O has to dirty it again. */
    iconCacheDirty = false;
    /** `will-quit`: async here would be lost — the process exits before the callback. */
    if (sync) {
      fs.writeFileSync(iconCachePath, json);
      return;
    }
    iconCacheWriting = true;
    fs.writeFile(iconCachePath, json, (err) => {
      iconCacheWriting = false;
      if (err) {
        iconCacheDirty = true;
        diagLog(`[IconCache] Failed to save icon cache: ${err.message}`);
      }
      if (iconCacheDirty) scheduleIconCacheSave();
    });
  } catch (e) {
    iconCacheWriting = false;
    iconCacheDirty = true;
    diagLog(`[IconCache] Failed to save icon cache: ${e.message}`);
  }
};

/** In-memory favicon data URLs — hostname lowercased */
const faviconDataUrlCache = new Map();
const FAVICON_CACHE_MAX_ENTRIES = 128;

const rememberFavicon = (hostname, dataUrl) => {
  faviconDataUrlCache.delete(hostname);
  faviconDataUrlCache.set(hostname, dataUrl);
  while (faviconDataUrlCache.size > FAVICON_CACHE_MAX_ENTRIES) {
    const oldest = faviconDataUrlCache.keys().next().value;
    if (!oldest) break;
    faviconDataUrlCache.delete(oldest);
  }
};

function sniffImageMimeFromBuffer(buf) {
  if (!buf || buf.length < 4) return "image/png";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    buf[2] === 0x01 &&
    buf[3] === 0x00
  )
    return "image/x-icon";
  if (
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    buf[2] === 0x02 &&
    buf[3] === 0x00
  )
    return "image/x-icon";
  return "image/png";
}

function fetchUrlBodyBuffer(targetUrl, maxBytes = 524288, redirectDepth = 0) {
  return new Promise((resolve) => {
    if (redirectDepth > 8) return resolve(null);
    let lib;
    try {
      const u = new URL(targetUrl);
      lib = u.protocol === "http:" ? http : https;
    } catch {
      return resolve(null);
    }
    const req = lib.get(
      targetUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; Rovyl/1.0; +https://github.com)",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        timeout: 12000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          let next;
          try {
            next = new URL(res.headers.location, targetUrl).href;
          } catch {
            res.resume();
            return resolve(null);
          }
          res.resume();
          fetchUrlBodyBuffer(next, maxBytes, redirectDepth + 1).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        let len = 0;
        res.on("data", (d) => {
          len += d.length;
          if (len > maxBytes) {
            req.destroy();
            resolve(null);
          } else chunks.push(d);
        });
        res.on("end", () => {
          if (!chunks.length) resolve(null);
          else resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Avoids <img src=https://…> in the renderer (often blocked); returns a data URL. */
/** Sniffed MIME to the extension the icon store will serve it back under. */
const faviconExtensionForMime = (mime) =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  })[String(mime).toLowerCase()] || "png";

ipcMain.handle("get-website-favicon-data-url", async (_event, pageUrl) => {
  try {
    let hostname;
    try {
      let s = String(pageUrl || "").trim();
      if (!s) return null;
      if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
      hostname = new URL(s).hostname;
    } catch {
      return null;
    }
    if (!hostname) return null;
    /**
     * A hostname has to look resolvable before it is worth a round trip to two third parties.
     *
     * The healing pass re-asks as the user types, so every prefix of a URL in progress — `g`,
     * `gi`, `git`, ... — used to become a lookup: up to 50 outbound TLS requests for one address,
     * each one handing a keystroke-by-keystroke reconstruction of what is being typed to Google and
     * DuckDuckGo. Requiring a dot and a plausible TLD costs nothing and stops both.
     *
     * `xn--` is spelled out because a punycode TLD (.рф encodes as `xn--p1ai`) carries digits and a
     * hyphen, which a letters-only pattern rejects. An IP literal or a single-label intranet host
     * falls out here too, and should: neither upstream can return a favicon for one.
     */
    if (!/\.(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/i.test(hostname)) {
      diagLog(`[Favicon] skipping incomplete hostname: ${hostname}`);
      return null;
    }
    const hostKey = hostname.toLowerCase();
    if (faviconDataUrlCache.has(hostKey)) {
      const cached = faviconDataUrlCache.get(hostKey);
      /** Same rule as the native cache: a reference whose file is gone must miss, not be served. */
      if (!iconStore.isIconRef(cached) || iconStore.exists(cached)) return cached;
      faviconDataUrlCache.delete(hostKey);
    }

    const candidates = [
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`,
    ];

    for (const u of candidates) {
      const buf = await fetchUrlBodyBuffer(u);
      if (!buf || buf.length < 16) continue;
      const mime = sniffImageMimeFromBuffer(buf);
      /**
       * Straight into the store, so a web shortcut's icon costs the same 85 bytes in the config as
       * a native one. `sniffImageMimeFromBuffer` reads the magic bytes, so the extension follows
       * the content rather than a server's content-type header.
       */
      let stored = null;
      try {
        stored = iconStore.putBuffer(buf, faviconExtensionForMime(mime));
      } catch (e) {
        diagLog(`[Favicon] could not store ${hostname}: ${e.message}`);
      }
      const value = stored || `data:${mime};base64,${buf.toString("base64")}`;
      rememberFavicon(hostKey, value);
      diagLog(`[Favicon] ${hostname} ok (${mime}, ${buf.length}b)${stored ? " stored" : " inline"}`);
      return value;
    }
    diagLog(`[Favicon] no image for ${hostname}`);
    return null;
  } catch (e) {
    diagLog(`[Favicon] error: ${e.message}`);
    return null;
  }
});

/**
 * The name a web shortcut is born with.
 *
 * A URL used to be labelled with its hostname, so "GitHub" arrived on the wheel as `github.com`.
 * The page already publishes the name its own tab shows, so it is fetched here: only the head is
 * needed, so the read stops the moment `</title>` goes past and the socket is dropped.
 */
const pageTitleCache = new Map();
const PAGE_TITLE_CACHE_MAX_ENTRIES = 128;
/** Enough for the head of a very padded page; the read usually ends long before this. */
const PAGE_TITLE_MAX_BYTES = 512 * 1024;

const rememberPageTitle = (key, title) => {
  pageTitleCache.delete(key);
  pageTitleCache.set(key, title);
  while (pageTitleCache.size > PAGE_TITLE_CACHE_MAX_ENTRIES) {
    const oldest = pageTitleCache.keys().next().value;
    if (oldest === undefined) break;
    pageTitleCache.delete(oldest);
  }
};

/** Servers hand a bot a different page than a browser; asking as a browser gets the real title. */
const PAGE_TITLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function fetchHtmlHead(targetUrl, redirectDepth = 0) {
  return new Promise((resolve) => {
    if (redirectDepth > 8) return resolve(null);
    let lib;
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(null);
      lib = u.protocol === "http:" ? http : https;
    } catch {
      return resolve(null);
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = lib.get(
      targetUrl,
      {
        headers: {
          "User-Agent": PAGE_TITLE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en;q=0.9,*;q=0.5",
          /** Identity only: a compressed head would have to be buffered whole before it parses. */
          "Accept-Encoding": "identity",
        },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next;
          try {
            next = new URL(res.headers.location, targetUrl).href;
          } catch {
            res.resume();
            return finish(null);
          }
          res.resume();
          fetchHtmlHead(next, redirectDepth + 1).then(finish);
          return;
        }
        const contentType = String(res.headers["content-type"] || "");
        /** A PDF or an image has no title to read, and its bytes are not worth pulling down. */
        if (contentType && !/^\s*(text\/html|application\/xhtml)/i.test(contentType)) {
          res.destroy();
          return finish(null);
        }
        /** 4xx/5xx pages still carry a <title>, but it names the error, not the site. */
        if (res.statusCode !== 200) {
          res.destroy();
          return finish(null);
        }

        const chunks = [];
        let length = 0;
        res.on("data", (chunk) => {
          chunks.push(chunk);
          length += chunk.length;
          const enough =
            length >= PAGE_TITLE_MAX_BYTES ||
            /<\/title\s*>|<\/head\s*>/i.test(
              Buffer.concat(chunks.slice(-2)).toString("latin1"),
            );
          if (!enough) return;
          res.destroy();
          finish({ buffer: Buffer.concat(chunks), contentType });
        });
        res.on("end", () =>
          finish(chunks.length ? { buffer: Buffer.concat(chunks), contentType } : null),
        );
        res.on("error", () => finish(chunks.length ? { buffer: Buffer.concat(chunks), contentType } : null));
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
  });
}

/** Returns the page's own name, or null — the renderer falls back to the host on null. */
ipcMain.handle("get-website-page-title", async (_event, pageUrl) => {
  let normalized;
  try {
    let s = String(pageUrl || "").trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    normalized = parsed.href;
  } catch {
    return null;
  }

  if (pageTitleCache.has(normalized)) return pageTitleCache.get(normalized);

  try {
    const response = await fetchHtmlHead(normalized);
    if (!response) {
      diagLog(`[PageTitle] no document for ${normalized}`);
      return null;
    }
    const title = titleFromHtmlBuffer(response.buffer, response.contentType);
    if (!title) {
      diagLog(`[PageTitle] no title in ${normalized}`);
      return null;
    }
    rememberPageTitle(normalized, title);
    diagLog(`[PageTitle] ${normalized} -> ${title}`);
    return title;
  } catch (e) {
    diagLog(`[PageTitle] error: ${e.message}`);
    return null;
  }
});

// Each extraction is its own PowerShell process (~1.3s, mostly Add-Type
// compiling the interop shim). A picker showing dozens of rows would otherwise
// spawn dozens of them at once and thrash the machine.
const ICON_EXTRACTION_CONCURRENCY = 4;
/** Ceiling on one extraction. ~12x a measured run; only a wedged shell call should ever reach it. */
const ICON_EXTRACTION_TIMEOUT_MS = 8000;
let activeIconExtractions = 0;
const iconExtractionQueue = [];

const runQueuedIconExtractions = () => {
  while (
    activeIconExtractions < ICON_EXTRACTION_CONCURRENCY &&
    iconExtractionQueue.length
  ) {
    const job = iconExtractionQueue.shift();
    activeIconExtractions++;
    job()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeIconExtractions--;
        runQueuedIconExtractions();
      });
  }
};

const enqueueIconExtraction = (job) =>
  new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
    iconExtractionQueue.push(job);
    runQueuedIconExtractions();
  });

/** Deduplicates concurrent requests for the same target. */
const inFlightIconRequests = new Map();

ipcMain.handle("get-file-icon", (_event, filePath) => getFileIconCached(filePath));

/**
 * The icon Windows shows for a target, from the cache when there is one. Shared by `get-file-icon`
 * and by the custom icon picker, which falls back to it for a file that is neither a picture nor
 * an icon library (a `.lnk`, a folder, a document).
 */
async function getFileIconCached(filePath) {
  try {
    if (!filePath || typeof filePath !== "string") {
      diagLog(`[IconRequest] Aborted: Invalid filePath: ${typeof filePath}`);
      return null;
    }

    // Check Memory Cache first (fastest)
    if (iconCache.has(filePath)) {
      const cached = iconCache.get(filePath);
      if (cached && cached.data) {
        /**
         * A reference whose file is gone has to miss, not hand back a broken image: to the
         * renderer's healing pass any non-empty string reads as "this one has an icon", so a dead
         * reference would sit there forever instead of being re-extracted.
         */
        if (!iconStore.isIconRef(cached.data) || iconStore.exists(cached.data)) {
          // diagLog(`[IconRequest] Cache Hit: ${filePath}`);
          return cached.data;
        }
        iconCache.delete(filePath);
        markIconCacheDirty();
      }
    }

    if (inFlightIconRequests.has(filePath)) {
      return inFlightIconRequests.get(filePath);
    }

    const pending = extractIconUncached(filePath).finally(() =>
      inFlightIconRequests.delete(filePath),
    );
    inFlightIconRequests.set(filePath, pending);
    return pending;
  } catch (error) {
    diagLog(`[IconRequest] Critical error in get-file-icon for ${filePath}: ${error.message}`);
    console.error("Critical error in get-file-icon:", error);
    return null;
  }
}

async function extractIconUncached(filePath) {
  try {
    diagLog(`[IconRequest] Fetching icon for: ${filePath}`);

    // 1. Resolve shell paths
    /**
     * The moniker is stripped back to the bare AppID first: `extract-icon.ps1` looks a target up by
     * exact equality against `Get-StartApps`, and `shell:AppsFolder\…` matches no AppID, no name and
     * no file — so a monikered shortcut would come back with no icon at all. The script builds the
     * moniker itself when it needs one.
     */
    let resolvedPath = win32Launch.appsFolderAppId(filePath) || resolveShellPath(filePath);
    resolvedPath = resolvedPath.replace(/['\"]/g, "");
    if (resolvedPath !== filePath) {
      diagLog(`[IconRequest] Resolved path: ${resolvedPath}`);
    }

    // Special Handling for Common Apps
    const lowerPath = filePath.toLowerCase();
    const isExplorer = lowerPath === "explorer" || lowerPath === "microsoft.windows.explorer" || lowerPath === "file explorer";
    const isCalc = lowerPath === "calc" || lowerPath === "calculator" || lowerPath === "calculadora" || lowerPath.includes("windowscalculator");
    const isEdge = lowerPath === "msedge" || lowerPath === "edge" || lowerPath.includes("microsoftedge");

    if (isExplorer) {
      resolvedPath = path.join(
        process.env["SystemRoot"] || "C:\\Windows",
        "explorer.exe",
      );
    } else if (isCalc) {
      const calcPath = path.join(
        process.env["SystemRoot"] || "C:\\Windows",
        "System32",
        "calc.exe",
      );
      if (fs.existsSync(calcPath)) {
        resolvedPath = calcPath;
      } else {
        resolvedPath = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
      }
    } else if (isEdge) {
      const edgePath = path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Microsoft\\Edge\\Application\\msedge.exe",
      );
      if (fs.existsSync(edgePath)) {
        resolvedPath = edgePath;
      } else {
        resolvedPath = "Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge";
      }
    }

    const isAUMID = resolvedPath.includes("!");
    const isExplicitFile =
      resolvedPath.includes("\\") || resolvedPath.includes("/");

    // 2. PowerShell extraction is the primary path for every target type.
    // app.getFileIcon returns a small, unnormalized shell icon, so mixing it in
    // for file paths made those apps render at a different size and resolution
    // than the packaged apps that always came through the script.
    // spawn + argv, so AUMIDs like Microsoft.X_y!App are not mangled by cmd.exe.
    const psScript = getAssetPath("extract-icon.ps1");
    diagLog(`[IconRequest] Trying PowerShell extraction for ${resolvedPath}`);

    const iconData = await enqueueIconExtraction(() => new Promise((resolve) => {
      const chunks = [];
      const psExe = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const child = spawn(
        fs.existsSync(psExe) ? psExe : "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", psScript, "-Target", resolvedPath],
        { windowsHide: true },
      );
      /**
       * This promise used to settle only on 'close' or 'error'. IShellItemImageFactory against a
       * disconnected share or a wedged shell extension never returns, and the queue slot it holds
       * is never given back — four such targets stall the whole pipeline for the life of the tray
       * process. The three other spawn sites in this file all guard; this one did not. 8 s is ~12x
       * a measured extraction.
       */
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(value);
      };
      const watchdog = setTimeout(() => {
        diagLog(`[IconRequest] PowerShell extraction timed out for ${resolvedPath}`);
        try {
          child.kill();
        } catch {}
        finish(null);
      }, ICON_EXTRACTION_TIMEOUT_MS);
      watchdog.unref?.();
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) =>
        diagLog(`[IconRequest] PowerShell stderr: ${String(d).trim()}`),
      );
      child.on("error", (err) => {
        diagLog(`[IconRequest] PowerShell spawn error: ${err.message}`);
        finish(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          diagLog(`[IconRequest] PowerShell exit ${code} for ${resolvedPath}`);
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        const lines = stdout.trim().split(/\r?\n/);
        const dataLine = lines.find((line) => line.startsWith("data:image"));
        finish(dataLine || null);
      });
    }));

    if (iconData) {
      diagLog(`[IconRequest] Success via PowerShell for ${filePath}`);
      return rememberFileIcon(filePath, iconData);
    }

    // 3. Last resort, file paths only. An AUMID means nothing to getFileIcon —
    // it yields the generic unknown-file icon, which reads as a wrong icon
    // rather than a missing one, so let the UI draw its own placeholder.
    if (isAUMID || !isExplicitFile) {
      diagLog(`[IconRequest] No icon available for ${filePath}`);
      return null;
    }
    diagLog(`[IconRequest] Falling back to generic Native extraction for ${resolvedPath}`);
    try {
      const icon = await app.getFileIcon(resolvedPath, { size: "large" });
      const dataUrl = icon.toDataURL();
      diagLog(`[IconRequest] Final fallback success for ${resolvedPath}`);
      return rememberFileIcon(filePath, dataUrl);
    } catch (e) {
      diagLog(`[IconRequest] All extraction methods failed for ${filePath}. Error: ${e.message}`);
      return null;
    }
  } catch (error) {
    diagLog(`[IconRequest] Critical error in get-file-icon for ${filePath}: ${error.message}`);
    console.error("Critical error in get-file-icon:", error);
    return null;
  }
}

function stripBom(str) {
  return String(str || "").replace(/^\uFEFF/, "").trim();
}

function getPowerShellExePath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function scanInstalledApps() {
  return new Promise((resolve) => {
    const { exec } = require("child_process");

    // Get-StartApps is much faster and reliable on Win 10/11
    // It returns both Win32 (as paths) and UWP (as AUMIDs)
    // We optimized the query to only select necessary fields
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue';
      try {
        $apps = Get-StartApps | Where-Object { $_.Name -and $_.AppID -and $_.Name -notmatch 'Help|Feedback|Contact|Support|Manual' } | Select-Object Name, AppID;
        $results = @();
        foreach ($app in $apps) {
          $path = $app.AppID;
          $iconPath = $path;
          if ($path -match '!') { $iconPath = '' };
          $results += [PSCustomObject]@{ 
            Name = [string]$app.Name; 
            DisplayName = [string]$app.Name; 
            Path = [string]$app.AppID; 
            IconPath = [string]$iconPath;
          };
        }
        $results | ConvertTo-Json -Compress
      } catch {
        "[]"
      }
    `.replace(/#.*$/gm, "");

    const command = `powershell -NoProfile -ExecutionPolicy RemoteSigned -Command "${psScript
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")
      .trim()}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout) => {
      if (error && !stdout) {
        console.error("Scanner failed:", error);
        resolve([]);
        return;
      }
      try {
        const apps = JSON.parse(stdout);
        const appList = (Array.isArray(apps) ? apps : [apps]).filter(
          (a) => a && a.Path && a.Name,
        );
        // Scanner found ${appList.length} valid apps
        resolve(appList);
      } catch (e) {
        console.error("Parse error:", e);
        console.debug("Raw scanner output:", stdout);
        resolve([]);
      }
    });
  });
}

ipcMain.handle("get-installed-apps", async (event, forceRefresh = false) => {
  try {
    if (installedAppsCache && !forceRefresh) {
      return installedAppsCache;
    }
    /** An empty scan is not worth remembering as the answer — leave the cache cold so the next ask retries. */
    const list = await scanInstalledApps();
    return list.length ? rememberInstalledApps(list) : list;
  } catch (e) {
    diagLog(`[get-installed-apps] ${e.message}`);
    return [];
  }
});

app.on("window-all-closed", (e) => {
  // Prevent app from quitting when all windows are closed
  // This ensures the app continues to run in the tray
  e.preventDefault();
});

app.on("will-quit", () => {
  /** The pointer may be parked at the wheel's centre: give it back while the helper is alive. */
  forceCloseRadial();
  releaseRadialCursor();
  /** Helpers first: while they live, the installer cannot touch the folder. */
  stopMouseHookForShutdown();
  stopRadialMouseBlocker();
  stopForegroundFocusHelper();
  systemStatus.stop();
  saveIconCache({ sync: true });
  globalShortcut.unregisterAll();
  if (keyboardListener) {
    try {
      keyboardListener.kill();
    } catch (_) {}
    keyboardListener = null;
  }
});
