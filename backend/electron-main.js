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
const { autoUpdater } = require("electron-updater");
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
const { titleFromHtmlBuffer } = require("./page-title.cjs");
const crypto = require("crypto");
const { GlobalKeyboardListener } = require("node-global-key-listener");
const http = require("http");
const https = require("https");
const url = require("url");

const isDev = !app.isPackaged;

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
  : path.join(os.homedir(), ".zenith-radial-menu");
const logFile = path.join(logDir, "diagnostic.log");

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
 * Mouse buttons accepted as a trigger. Left (0x01) and right (0x02) are deliberately out: watching
 * them globally would collide with the primary click and the context menu of the whole system. The
 * side buttons (X1/X2) are free in the overwhelming majority of applications.
 */
const MOUSE_TRIGGER_VK = { middle: 0x04, x1: 0x05, x2: 0x06 };
const MOUSE_TRIGGER_BUTTONS = Object.keys(MOUSE_TRIGGER_VK);

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

async function loadRecentlyOpenedPathsFromVscdb(vscdbPath) {
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
    const db = new SQL.Database(buf);
    const res = db.exec(
      "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
    );
    if (!res.length || !res[0].values?.length) return [];
    const parsed = JSON.parse(res[0].values[0][0]);
    return normalizeRecentlyOpenedPathsList(parsed);
  } catch (e) {
    diagLog(`[Recents] state.vscdb read failed (${vscdbPath}): ${e.message}`);
    return [];
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
    "CalculateNativeWinOcclusion,WindowOcclusionPrediction",
  );
}
diagLog("[Perf] Background throttling dynamically controlled by window visibility.");

// Fix Taskbar Icon Grouping
app.setName("Rovyl");
app.setAppUserModelId("com.henry.rovyl"); // AUMID explicitly set
// app.setPath("userData", path.join(os.tmpdir(), "zenith-radial-menu-cache")); // REMOVED: tmpdir is not persistent

// Single instance: prevents two Zenith processes when login startup is slow and the user launches manually.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  diagLog("Second instance blocked — another Zenith is already running; exiting.");
  app.quit();
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
/** Cleared when leaving radial overlay for settings so a pending hide does not break the window. */
let skipTaskbarHideTimer = null;

/**
 * Renderer "hide-window" leaves the window technically visible but opacity 0 + mouse passthrough.
 * If the user later focuses Zenith from the taskbar / Alt+Tab, no IPC runs — they see a blank / dead window.
 * We recover on focus/restore when this flag is set.
 */
let windowBuriedPassive = false;

/** Last mode passed to updateWindowSize — used to fix hit-testing after minimize/restore without renderer IPC. */
let nativeWindowSizeMode = "windowed";

/** Sync with `set-window-hit-shape`: "__empty__" or "" = mouse passed through; anything else = HUD regions. */
let lastWindowHitShapeKey = "";

/**
 * `updateWindowSize` cannot apply `setBounds` while the window is minimized; we keep the last
 * request and apply it on `restore` so the island/`small` sync back up with the HWND.
 */
let pendingWindowSize = null;

function flushPendingWindowSizeIfNeeded() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) return;
  } catch (e) {
    return;
  }
  if (!pendingWindowSize) return;
  const p = pendingWindowSize;
  pendingWindowSize = null;
  updateWindowSize(p.mode, p.anchorScreenPoint);
}

/**
 * `show-window` and focus restores must not force `setIgnoreMouseEvents(false)` in `small` mode:
 * that made the monitor-sized overlay capture the mouse (invisibly).
 */
function applyMousePolicyAfterReveal(win) {
  const w = win || mainWindow;
  if (!w || w.isDestroyed()) return;
  try {
    if (nativeWindowSizeMode === "fullscreen" || nativeWindowSizeMode === "windowed") {
      w.setIgnoreMouseEvents(false);
      return;
    }
    if (nativeWindowSizeMode === "small") {
      if (lastWindowHitShapeKey === "__empty__" || lastWindowHitShapeKey === "") {
        if (typeof w.setShape === "function") {
          w.setShape([]);
        }
        w.setIgnoreMouseEvents(true, { forward: true });
      } else {
        w.setIgnoreMouseEvents(false);
      }
    }
  } catch (e) {
    /* ignore */
  }
}

/** When true, allow BrowserWindow to close (real quit). Otherwise close → hide to tray. */
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
  if (keyboardListener) return;

  keyboardListener = new GlobalKeyboardListener();
  recordingActive = true;

  keyboardListener.addListener((e, down) => {
    if (e.state === "DOWN" && recordingActive) {
      // Collect all currently pressed keys
      const modifiers = {
        CTRL: false,
        ALT: false,
        SHIFT: false,
        META: false,
      };

      // Check modifiers using the 'down' object which tracks all pressed keys
      // The listener provides names like "LEFT CTRL", "RIGHT SHIFT", etc.
      Object.keys(down).forEach((keyName) => {
        if (keyName.includes("CTRL")) modifiers.CTRL = true;
        if (keyName.includes("ALT")) modifiers.ALT = true;
        if (keyName.includes("SHIFT")) modifiers.SHIFT = true;
        if (keyName.includes("META") || keyName.includes("WINDOWS"))
          modifiers.META = true;
      });

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
        mainWindow.webContents.send("shortcut-recorded", shortcutString);
      }
    }
  });
}

function stopShortcutRecording() {
  recordingActive = false;
  if (keyboardListener) {
    keyboardListener.kill();
    keyboardListener = null;
  }
}

async function createWindow() {
  /** Centred and clamped to the work area — never larger than the screen at high Windows scaling. */
  const initialBounds = windowedBoundsForWorkArea();
  /** `updateWindowSize('windowed')` can run before the first `resize` event: line them up now. */
  lastWindowedBounds = { ...initialBounds };
  const newWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    frame: false, // Keep frameless for transparency
    titleBarStyle: "hidden", // Hide default title bar but keep controls
    titleBarOverlay: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    show: false,
    fullscreen: false,
    hasShadow: false, // Disable native shadow to prevent rectangular ghosting around rounded CSS corners
    thickFrame: false, // Prevents native resizing border artifacts on Win 11
    icon: isDev
      ? path.join(__dirname, "../public/icon.png")
      : path.join(__dirname, "../dist/icon.png"),
    backgroundColor: "#00000000",
    backgroundMaterial: "none", // Avoid acrylic blur leaking outside rounded corners
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
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
        resolve(newWindow);
      }, 200);
    });

    // Track bounds for persistence — only in `windowed` mode (fullscreen/small use special bounds; small+island must not overwrite the last real size).
    newWindow.on("resize", () => {
      if (
        nativeWindowSizeMode === "windowed" &&
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
        nativeWindowSizeMode === "windowed" &&
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
      /**
       * Minimize→radial shortcut: `updateWindowSize('fullscreen')` only parks in `pendingWindowSize`.
       * The next handler flushes it in `setImmediate`; if we send `window-native-display-restored` first,
       * the renderer applies `setWindowSize('windowed')` with the native mode still stale and the menu stays in the panel's rect.
       */
      flushPendingWindowSizeIfNeeded();
      if (
        nativeWindowSizeMode !== "small" &&
        window.isVisible() &&
        !window.isMinimized()
      ) {
        window.setOpacity(1);
        window.setIgnoreMouseEvents(false);
        /** Only the visible windowed panel stands for Settings in the taskbar. */
        window.setSkipTaskbar(
          nativeWindowSizeMode !== "windowed" || !rendererPanelVisible,
        );
        if (window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send("window-native-display-restored", {
            mode: nativeWindowSizeMode,
          });
        }
      }
    } catch (e) {
      diagLog(`[Window] onRestore refresh: ${e.message}`);
    }
  };

  window.on("restore", onRestore);
  window.on("focus", recoverPassiveBurialOnly);
}

function setupMainWindow(window) {
  // Highest overlay level
  window.setAlwaysOnTop(true, "screen-saver", 1);

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
  });

  window.webContents.on("did-finish-load", () => {
    diagLog("Renderer: Content finished loading successfully");
    console.log("DEBUG: Content finished loading successfully");
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
    /** Lets the renderer process `open-dashboard` / IPC before applying the pending one (tray → windowed). */
    setImmediate(() => {
      try {
        if (win.isDestroyed()) return;
        if (!win.isMinimized()) {
          flushPendingWindowSizeIfNeeded();
        }
      } catch (e) {
        /* ignore */
      }
      sendMainWindowMinimizedState();
    });
  });
}

let radialOpenPaintSequence = 0;

/* zenith-verify:radial-handshake-main — prepare → radial-prep-paint-done → open-menu → radial-open-paint-done → show; see scripts/verify-radial-windowing.mjs */
function showMenuAtCursor(source = "shortcut") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const radialOpenStartedAt = Date.now();

  /** A fixed position means truly fixed: neither the position nor the monitor follows the cursor. */
  const targetDisplay = screen.getPrimaryDisplay();
  let radialCenter = {
    x: Math.round(targetDisplay.bounds.x + targetDisplay.bounds.width / 2),
    y: Math.round(targetDisplay.bounds.y + targetDisplay.bounds.height / 2),
  };
  /**
   * If the monitor's real centre falls inside the Settings HWND, we keep the HWND completely still
   * (no DWM flash) and draw the wheel at that point in client coordinates. This path used to
   * replace `radialCenter` with SETTINGS' centre — (906,345) in the video — and looked like it was
   * following the cursor. If the panel is on another monitor / off centre, the safe hide+resize
   * path below is used to honour the primary monitor's centre.
   */
  let keepExistingPanelWindow = false;
  if (
    /**
     * Not when the dimming fills the window. This shortcut's whole trick is drawing the radial
     * inside SETTINGS' frame, and a scrim with no falloff left would paint that frame solid — a
     * black rectangle the size of the panel, on a bright desktop. Tuning the dimming and then
     * firing the wheel to look at it is the obvious way to meet that, so it takes the slower
     * hide-and-resize path instead and gets the monitor, which is what it asked for.
     */
    !radialFullBleed &&
    nativeWindowSizeMode === "windowed" &&
    rendererPanelVisible &&
    isMainWindowOnScreen()
  ) {
    try {
      const bounds = mainWindow.getBounds();
      const visualMargin = Math.min(150, Math.floor(Math.min(bounds.width, bounds.height) / 4));
      keepExistingPanelWindow =
        radialCenter.x >= bounds.x + visualMargin &&
        radialCenter.x <= bounds.x + bounds.width - visualMargin &&
        radialCenter.y >= bounds.y + visualMargin &&
        radialCenter.y <= bounds.y + bounds.height - visualMargin;
    } catch (e) {
      keepExistingPanelWindow = false;
    }
  }

  let wasMinimized = false;
  try {
    wasMinimized = mainWindow.isMinimized();
  } catch (e) {
    wasMinimized = false;
  }

  /**
   * Set this BEFORE any resize, `open-menu` or `show-window`. If we wait for the `reveal`, the
   * renderer can ask for `show()` first and Windows briefly creates a taskbar button for the
   * radial. When Settings stays underneath the radial we preserve the existing button, because it
   * still stands for the visible panel, not the radial modal.
   */
  if (!rendererPanelVisible) {
    clearSkipTaskbarHideTimer();
    try {
      mainWindow.setSkipTaskbar(true);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * The logical state can lag the geometry by one IPC (Settings→radial→Settings→close).
   * Once the renderer has confirmed there is no panel, no union flag may survive.
   */
  if (!rendererPanelVisible) {
    panelOverlayActive = false;
    panelOverlayKeptWindow = false;
  }

  /**
   * Any geometric transition → radial changes the native bounds. If the HWND stays visible, the DWM
   * stretches Settings' last texture (or the texture that just closed) for one frame, which is the
   * flash. We record first that the panel really was visible and pull the surface out of the
   * compositor before the resize; the handshake shows it again once it is painted.
   */
  let nativeResizeRisk = false;
  if (!wasMinimized && !keepExistingPanelWindow) {
    try {
      const currentBounds = mainWindow.getBounds();
      const desiredBounds = radialOpenBounds(targetDisplay.bounds, radialCenter);
      nativeResizeRisk =
        mainWindow.isVisible() && !boundsApproxEqual(currentBounds, desiredBounds);
    } catch (e) {
      nativeResizeRisk = true;
    }
  }
  if (nativeResizeRisk) {
    diagLog(
      `[RadialOpen] Native bounds differ from centered radial; hiding before resize (mode=${nativeWindowSizeMode}, panel=${rendererPanelVisible})`,
    );
    if (rendererPanelVisible && isMainWindowOnScreen()) {
      panelOverlayActive = true;
    }
    try {
      mainWindow.hide();
      windowBuriedPassive = true;
    } catch (e) {
      /* ignore */
    }
  }

  // Resize before IPC so the first renderer paint is already monitor-sized (send() is async; windowed→radial looked like "dashboard size").
  updateWindowSize("fullscreen", radialCenter);

  /**
   * Park the pointer BEFORE `open-menu`: the first sample the renderer uses has to be the centre
   * one already, or the gesture is born pointing wherever the hand happened to be.
   *
   * MMB in hold mode is left out — that gesture executes on release and its aim comes from the
   * main-process polling, which starts at the point where the button was pressed. Moving the cursor
   * under it would confirm a slice nobody chose.
   */
  if (source !== "mmb") captureRadialCursor(radialCenter);

  // Do NOT setOpacity(0) here — on Windows + transparent BrowserWindow it often leaves the compositor
  // without a fresh web frame (user sees through / "nothing", while hit-testing still works).

  /**
   * `hide-window` / `collapse-idle-overlay` / `reapply-small-overlay` leave the renderer throttled.
   * If we open through the fast path without waking it, the `show()` arrives before the first new
   * frame and the DWM presents the previous texture (island/dashboard) or black. Wake on ALL paths.
   */
  try {
    if (typeof mainWindow.webContents?.setBackgroundThrottling === "function") {
      mainWindow.webContents.setBackgroundThrottling(false);
    }
  } catch (e) {
    /* ignore */
  }

  const sendOpenMenuAndReveal = (waitForRadialPaint = false) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    let radialClientPosition = null;
    let radialWindowOrigin = null;
    let radialClientSize = null;
    try {
      /**
       * While minimized, `updateWindowSize` only queues fullscreen; `getBounds()` still returns
       * Settings at the position it was minimized from. Using that rect produced (440,300) and
       * pinned the first wheel to the panel's old centre. The radial rect is deterministic, so the
       * payload can — and should — anticipate the geometry that will be applied on restore.
       */
      const bounds = wasMinimized
        ? radialOpenBounds(targetDisplay.bounds, radialCenter)
        : mainWindow.getBounds();
      radialWindowOrigin = { x: bounds.x, y: bounds.y };
      radialClientPosition = {
        x: radialCenter.x - bounds.x,
        y: radialCenter.y - bounds.y,
      };
      radialClientSize = { width: bounds.width, height: bounds.height };
    } catch (e) {
      /* renderer falls back to screen coordinates */
    }

    const paintToken = waitForRadialPaint ? ++radialOpenPaintSequence : undefined;
    let revealStarted = false;
    let paintTimeout = null;
    let onRadialPaint = null;

    const reveal = () => {
      if (revealStarted) return;
      revealStarted = true;
      if (paintTimeout) clearTimeout(paintTimeout);
      if (onRadialPaint) ipcMain.removeListener("radial-open-paint-done", onRadialPaint);

      setImmediate(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        /**
         * Radial on top of the panel with no resize: the window is ALREADY visible, in the right
         * place and in the taskbar. Repeating `show`/`setSkipTaskbar`/`setVisibleOnAllWorkspaces`
         * here only forces the HWND to recompose — and every recomposition of a layered window is
         * a flash risk. On this path it just needs to be brought to the front.
         */
        if (panelOverlayKeptWindow) {
          windowBuriedPassive = false;
          mainWindow.setIgnoreMouseEvents(false);
          mainWindow.focus();
          mainWindow.webContents.focus();
          if (process.platform === "win32") {
            mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
          }
          return;
        }

        /**
         * Closing Settings fires the async collapse to `small`. The global shortcut can arrive
         * while that IPC is still queued: it then overwrote the radial's first resize and the HWND
         * was revealed in the old rect / monitor corner. The reveal is the opening's final barrier;
         * reapplying fullscreen here guarantees no stale resize from the close is the last
         * geometric command before `show()`.
         */
        updateWindowSize("fullscreen", radialCenter);

        /** Final defence: only a Settings still visible under the radial keeps the button. */
        mainWindow.setSkipTaskbar(!rendererPanelVisible);

        windowBuriedPassive = false;
        mainWindow.setIgnoreMouseEvents(false);
        mainWindow.setOpacity(1);
        if (!mainWindow.isVisible()) mainWindow.showInactive();
        if (typeof paintToken === "number") {
          /**
           * The renderer prepared the radial at zero alpha. Releasing the bloom only after `show()`
           * guarantees the first frame handed to the DWM is transparent, never half an animation.
           */
          const releaseAnimationTimer = setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send("radial-native-revealed", paintToken);
          }, 16);
          releaseAnimationTimer.unref?.();
        }

        try {
          const revealBounds = mainWindow.getBounds();
          const revealClientCenter = {
            x: radialCenter.x - revealBounds.x,
            y: radialCenter.y - revealBounds.y,
          };
          diagLog(
            `[RadialOpen] reveal latency=${Date.now() - radialOpenStartedAt}ms bounds=${JSON.stringify(revealBounds)} centerScreen=${JSON.stringify(radialCenter)} centerClient=${JSON.stringify(revealClientCenter)}`,
          );
        } catch (e) {
          /* diagnostic only */
        }

        mainWindow.focus();
        mainWindow.webContents.focus();
        if (process.platform === "win32") {
          mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
        }

        /**
         * The handshake already waited for two full paints. Invalidating after `show()` made the
         * DWM re-present the empty/old texture, seen as a flash on the first few opens.
         */
      });
    };

    if (waitForRadialPaint) {
      onRadialPaint = (_event, acknowledgedToken) => {
        if (acknowledgedToken !== paintToken) return;
        reveal();
      };
      ipcMain.on("radial-open-paint-done", onRadialPaint);
      // Fallback only: normal path acknowledges after the next painted animation frame.
      paintTimeout = setTimeout(reveal, wasMinimized ? 240 : 120);
      paintTimeout.unref?.();
    }

    mainWindow.webContents.send("open-menu", {
      /** The monitor's real centre; never use these coordinates as a free cursor position. */
      x: radialCenter.x,
      y: radialCenter.y,
      source: source,
      /** Main already called `updateWindowSize('fullscreen')` (except minimized: bounds queued). */
      preSizedByMain: !wasMinimized,
      /** The panel is still on screen under the radial — the renderer must not close it. */
      keepPanel: panelOverlayActive,
      /**
       * The panel's screen rect, WHENEVER it sits under the radial.
       *
       * It used to be sent only when the window had been widened, on the assumption that on the
       * other path it stayed panel-sized. But the radial window is a square box (988×988 with the
       * typical values) and the panel is 880×600: with no rect it is drawn at `inset-0` and grows
       * with the window — Settings came out bigger than it is.
       *
       * Always sending it removes the ambiguity: on the no-resize path the rect coincides with the
       * window bounds, so positioning gives exactly the same result as `inset-0`.
       */
      panelRect: panelOverlayActive ? { ...lastWindowedBounds } : null,
      /** Do not rely on window.screenX/Y on the first tick after setBounds: they can still be Settings'. */
      clientPosition: radialClientPosition,
      windowOrigin: radialWindowOrigin,
      clientSize: radialClientSize,
      paintToken,
    });

    if (!waitForRadialPaint) reveal();
  };

  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) {
    sendOpenMenuAndReveal();
    return;
  }

  let visibleOk = false;
  try {
    visibleOk = mainWindow.isVisible();
  } catch {
    visibleOk = false;
  }

  /**
   * Fast path: window already visible and not minimized — the prepare-radial handshake costs ~2 rAF
   * + IPC and reads as “lag” on open. The prep stays only when minimized or the HWND is hidden
   * (tray / DWM flash).
   */
  if (!wasMinimized && visibleOk) {
    setImmediate(sendOpenMenuAndReveal);
    return;
  }

  /**
   * The idle window is hidden and throttled. We wake the renderer but keep the HWND hidden:
   * `showInactive()` here exposed exactly the stale Settings texture the handshake exists to
   * replace. With background throttling off, the preparation rAFs keep being painted.
   */
  try {
    if (typeof wc.setBackgroundThrottling === "function") {
      wc.setBackgroundThrottling(false);
    }
  } catch (e) {
    /* ignore */
  }

  /**
   * Normal idle: the HWND is hidden but not minimized. `open-menu` itself mounts every layer at
   * zero alpha and acknowledges the paint, so the earlier neutral handshake was redundant and added
   * up to 72 ms before the wheel was even mounted. Minimization keeps the special preparation.
   */
  if (!wasMinimized) {
    sendOpenMenuAndReveal(true);
    return;
  }

  /**
   * Neutral frame before `open-menu` + `show` — mostly restore from minimize / hidden HWND.
   */
  const prepTimeoutMs = wasMinimized ? 200 : 72;
  const prepPromise = new Promise((resolve) => {
    const t = setTimeout(resolve, prepTimeoutMs);
    ipcMain.once("radial-prep-paint-done", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      wc.send("prepare-radial-show");
    } catch (e) {
      clearTimeout(t);
      resolve();
    }
  });

  prepPromise.then(() => sendOpenMenuAndReveal(true));
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
ipcMain.on("set-radial-viewport", (_event, payload) => {
  if (!payload || typeof payload !== "object") return;
  const n = Number(payload.size);
  if (Number.isFinite(n) && n >= 320 && n <= 4096) {
    radialViewportSize = Math.round(n);
  }
  radialFullBleed = !!payload.fullBleed;
});

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
 * `updateWindowSize("fullscreen")` starts it before the wheel exists. If it died, or we are on the
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
  const child = spawn(
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
 */
function setRadialTriggerCapture(virtualKey, mode, slop, clickHoldMs, clickDragPx) {
  if (process.platform !== "win32") return;
  ensureRadialMouseBlocker();
  writeRadialMouseBlocker(
    `TRIGGER ${virtualKey} ${mode} ${slop} ${clickHoldMs} ${clickDragPx}`,
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

/**
 * Radial open ON TOP of the panel (Settings/Welcome): there is only one window, so shrinking to the
 * radial's square made the panel disappear — that was the "it blinks and only the radial is left".
 * Here the radial's box grows to take in the panel's rect too, and the renderer draws it at the
 * same screen position it had. `windowed` mode still keeps that rect in `lastWindowedBounds`, so
 * closing the radial puts the window back in the exact spot.
 */
let panelOverlayActive = false;
/** True when the radial opened over the panel WITHOUT touching the bounds (see `keepPanelWindow`). */
let panelOverlayKeptWindow = false;
/**
 * Panel in view, according to the renderer. `nativeWindowSizeMode === 'windowed'` is NOT good for
 * this: `hide-window` hides the window without changing mode, and the next radial concluded there
 * was a panel on screen — it opened without resizing and dragged the settings along behind it.
 */
let rendererPanelVisible = false;
ipcMain.on("set-panel-surface-visible", (event, visible) => {
  rendererPanelVisible = !!visible;
  /** The renderer uses sendSync: closing Settings and firing the radial at the same instant must not read stale state. */
  event.returnValue = true;
});

function isMainWindowOnScreen() {
  try {
    return (
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized()
    );
  } catch (e) {
    return false;
  }
}

function radialBoundsUnionWithPanel(radialRect, displayBounds) {
  if (!panelOverlayActive) return radialRect;
  const panel = lastWindowedBounds;
  if (!panel || !Number.isFinite(panel.width) || panel.width <= 0) return radialRect;

  const union = unionScreenRects([radialRect, panel]);
  if (!union) return radialRect;

  /** Capped to the monitor: a panel dragged outside must not stretch the window past it. */
  const width = Math.min(union.width, displayBounds.width);
  const height = Math.min(union.height, displayBounds.height);
  return {
    x: Math.round(
      Math.max(displayBounds.x, Math.min(union.x, displayBounds.x + displayBounds.width - width)),
    ),
    y: Math.round(
      Math.max(displayBounds.y, Math.min(union.y, displayBounds.y + displayBounds.height - height)),
    ),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** The radial's box is always centred on the monitor being pointed at. Free positioning is gone. */
function radialModeBounds(displayBounds, point) {
  const side = Math.min(
    radialViewportSize,
    displayBounds.width,
    displayBounds.height,
  );
  const center = {
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
 * monitor, because that edge would otherwise be drawn on screen as a rectangle.
 *
 * Every caller that computes the open bounds has to go through here, including the one that only
 * compares them against the current bounds to decide whether to hide before resizing: two callers
 * disagreeing about the target is a visible DWM flash.
 */
function radialOpenBounds(displayBounds, point) {
  if (!radialFullBleed) return radialModeBounds(displayBounds, point);
  return {
    x: Math.round(displayBounds.x),
    y: Math.round(displayBounds.y),
    width: Math.round(displayBounds.width),
    height: Math.round(displayBounds.height),
  };
}

/**
 * Stable idle: the transparent surface uses exactly the radial's bounds.
 * Opening then needs no hide/show and no resize; since the mouse is ignored, the area does not block the desktop.
 */
function smallModeBounds(displayBounds) {
  return radialModeBounds(displayBounds, {
    x: displayBounds.x + displayBounds.width / 2,
    y: displayBounds.y + displayBounds.height / 2,
  });
}

function applySmallModeCollapsedBounds(anchorScreenPoint) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  /** The radial is fixed on the primary monitor; idle never follows the cursor. */
  const targetDisplay = screen.getPrimaryDisplay();
  const nextBounds = smallModeBounds(targetDisplay.bounds);
  if (!boundsApproxEqual(mainWindow.getBounds(), nextBounds)) {
    mainWindow.setBounds(nextBounds);
  }
}

function unionScreenRects(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!r || typeof r.x !== "number") continue;
    const x1 = r.x;
    const y1 = r.y;
    const x2 = r.x + r.width;
    const y2 = r.y + r.height;
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
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
 * @param {string} mode
 * @param {{ x: number, y: number } | undefined} anchorScreenPoint — screen coordinates (e.g. cursor). Picks the monitor with getDisplayNearestPoint so multi-monitor matches the radial overlay.
 */
function updateWindowSize(mode, anchorScreenPoint) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  /** While minimized we do not apply `setBounds`; queue it and apply on `restore` (flush). */
  try {
    if (mainWindow.isMinimized()) {
      pendingWindowSize = { mode, anchorScreenPoint };
      /** Minimized there is no panel in view — do not let the previous flag decide the next radial. */
      panelOverlayActive = false;
      panelOverlayKeptWindow = false;
      return;
    }
  } catch (e) {
    return;
  }

  pendingWindowSize = null;

  const previousMode = nativeWindowSizeMode;
  nativeWindowSizeMode = mode;

  let point =
    anchorScreenPoint &&
    typeof anchorScreenPoint.x === "number" &&
    typeof anchorScreenPoint.y === "number" &&
    !Number.isNaN(anchorScreenPoint.x) &&
    !Number.isNaN(anchorScreenPoint.y)
      ? anchorScreenPoint
      : screen.getCursorScreenPoint();

  const targetDisplay = screen.getDisplayNearestPoint(point);
  const b = targetDisplay.bounds;

  if (mode === "fullscreen") {
    lastWindowHitShapeKey = "__empty__";
    if (!rendererPanelVisible) {
      panelOverlayActive = false;
      panelOverlayKeptWindow = false;
    }
    /**
     * Coming from `windowed` means there is a panel on screen: it stays visible under the radial,
     * so the window has to keep covering it. The flag is the state, not `previousMode` — reopening
     * the radial while already fullscreen must not lose the panel.
     */
    const keepPanelWindow =
      /** Same reason as `keepExistingPanelWindow`: a flat scrim must not be cut to the panel's rect. */
      !radialFullBleed &&
      previousMode === "windowed" &&
      rendererPanelVisible &&
      isMainWindowOnScreen();
    if (keepPanelWindow) {
      panelOverlayActive = true;
    }
    /**
     * We keep the visual surface compact so the DWM does not freeze videos/apps underneath. The
     * temporary hook blocks clicks on the rest of the monitor without creating a window to cover them.
     */
    /** A visible Settings uses the stable HWND; outside it the radial box stays centred on the monitor. */
    panelOverlayKeptWindow = keepPanelWindow;
    if (keepPanelWindow) {
      /**
       * Do not touch the bounds: Settings and radial share the already composed frame. On close,
       * `windowed` finds the same bounds and does not recompose the window either.
       */
      const stableBounds = mainWindow.getBounds();
      setRadialMouseBlocking(stableBounds, b);
    } else {
      const radialRect = radialBoundsUnionWithPanel(radialOpenBounds(b, point), b);
      if (!boundsApproxEqual(mainWindow.getBounds(), radialRect)) {
        mainWindow.setBounds(radialRect);
      }
      setRadialMouseBlocking(radialRect, b);
    }
    mainWindow.setResizable(true);
    mainWindow.setBackgroundColor("#00000000"); // FORCE TRANSPARENCY
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    mainWindow.setIgnoreMouseEvents(false);
    /**
     * Do not use hundreds of rects in `setShape` to imitate the circle: the DWM recomputes those
     * regions during movement and can lag the global cursor. The visual circle is already drawn in CSS.
     */
    try {
      if (typeof mainWindow.setShape === "function") mainWindow.setShape([]);
    } catch (e) {
      /* ignore */
    }
  } else if (mode === "windowed") {
    clearRadialMouseBlocking();
    releaseRadialCursor();
    panelOverlayActive = false;
    panelOverlayKeptWindow = false;
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
    /** The island had the HWND shrunk — reset the hit-shape state so the next mode does not inherit a ghost rect. */
    lastWindowHitShapeKey = "__empty__";
    mainWindow.setResizable(true);
    resetLastWindowedBoundsIfIslandCorrupted();
    /**
     * If the window is already at exactly these bounds (the case of the radial opened over the
     * panel without a resize), applying them again is a pointless HWND recomposition — and every
     * one of those is a flash risk on the transparent window. Closing the radial now leaves the
     * geometry alone.
     */
    let boundsAlreadyCorrect = false;
    try {
      /**
       * Maximized counts as correct. `lastWindowedBounds` is frozen at the rect from BEFORE the
       * maximize — the `resize`/`move` trackers ignore a maximized window — so the two rects always
       * differ and `setBounds` ran for certain. And `setBounds` on a maximized window unmaximizes
       * it without emitting `unmaximize`, leaving the title button showing "Restore" on a window
       * that is no longer maximized: the next hit maximizes instead of restoring. Reopening
       * Settings (tray, `toggle-settings`, double-MMB) is not a request to change the window size.
       */
      boundsAlreadyCorrect =
        mainWindow.isMaximized() ||
        boundsApproxEqual(mainWindow.getBounds(), lastWindowedBounds);
    } catch (e) {
      boundsAlreadyCorrect = false;
    }
    if (!boundsAlreadyCorrect) {
      isUpdatingBounds = true;
      mainWindow.setBounds(lastWindowedBounds);
      isUpdatingBounds = false;
    }
    mainWindow.setBackgroundColor("#00000000"); // Maintain transparency mask
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setIgnoreMouseEvents(false);
    try {
      if (typeof mainWindow.setShape === "function") {
        mainWindow.setShape([]);
      }
    } catch (e) {
      /* ignore */
    }
    /** Island in `small` → windowed rect: the DWM reuses the texture and the clock looks like it “slides” into the panel. */
    if (previousMode === "small") {
      try {
        setImmediate(() => {
          try {
            if (
              mainWindow &&
              !mainWindow.isDestroyed() &&
              mainWindow.webContents &&
              typeof mainWindow.webContents.invalidate === "function"
            ) {
              mainWindow.webContents.invalidate();
            }
          } catch (e) {
            /* ignore */
          }
        });
      } catch (e) {
        /* ignore */
      }
    }
  } else if (mode === "small") {
    clearRadialMouseBlocking();
    releaseRadialCursor();
    panelOverlayActive = false;
    panelOverlayKeptWindow = false;
    lastWindowHitShapeKey = "__empty__";
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
    clearSkipTaskbarHideTimer();
    try {
      mainWindow.setSkipTaskbar(true);
    } catch (e) {
      /* ignore */
    }
    mainWindow.setBackgroundColor("#00000000"); // ESSENTIAL for zero-lag transparency
    try {
      mainWindow.setIgnoreMouseEvents(true);
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      /* ignore */
    }
    applySmallModeCollapsedBounds(point);
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    mainWindow.setResizable(true);
    try {
      if (!mainWindow.isVisible()) mainWindow.showInactive();
      mainWindow.webContents.setBackgroundThrottling(true);
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof mainWindow.setShape === "function") {
        mainWindow.setShape([]);
      }
    } catch (e) {
      /* ignore */
    }
  }

}

/**
 * Recreate the BrowserWindow if it was closed/destroyed (e.g. after errors).
 *
 * `createWindow` only resolves on `ready-to-show` plus a 200 ms stabilization wait. Two gestures
 * inside that window — a tray double-click is the literal case — both cleared the guard above and
 * built TWO BrowserWindows: the second took `mainWindow`, the first was orphaned but still alive,
 * invisible, holding its own listeners and having already overwritten `lastWindowedBounds`.
 * Sharing the in-flight promise covers all four callers at once. The `.finally` reset is
 * load-bearing: without it a rejected create would wedge every later call.
 */
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

function clearSkipTaskbarHideTimer() {
  if (skipTaskbarHideTimer) {
    clearTimeout(skipTaskbarHideTimer);
    skipTaskbarHideTimer = null;
  }
}

/**
 * Force windowed, interactive mode, then notify renderer to open settings.
 * Cancels the deferred skipTaskbar from showMenuAtCursor (fixes double-MMB → settings glitches).
 *
 * The single entry point for every way of asking for Settings: tray menu, tray click,
 * `toggle-settings` and double-MMB. Two things about arriving here from a minimized window, which
 * only the tray paths can do:
 *
 *   - `updateWindowSize` refuses to `setBounds` while minimized and queues into
 *     `pendingWindowSize` instead, so the queueing call has to come BEFORE `restore()` — Win32
 *     dispatches WM_SIZE synchronously, which means `onRestore` runs inside `restore()` and its
 *     `flushPendingWindowSizeIfNeeded()` is what actually applies the geometry. Queue after, and
 *     the flush applies the island's `small` and tells the renderer to re-shrink the window a beat
 *     after Settings opened.
 *   - that same `onRestore` then rewrites skipTaskbar from `nativeWindowSizeMode` and
 *     `rendererPanelVisible` — and `rendererPanelVisible` is still false here, since the renderer
 *     has not been sent `open-settings` yet. So `setSkipTaskbar(false)` is re-asserted afterwards,
 *     in a `setImmediate` that lands after the second `restore` listener's own deferred flush.
 */
function openSettingsFromMainProcess() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearSkipTaskbarHideTimer();
  /** Steers `onRestore` away from its passive-hide branch and into the one that flushes. */
  windowBuriedPassive = false;
  try {
    if (mainWindow.isMinimized()) {
      updateWindowSize("windowed");
      mainWindow.restore();
    }
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
  updateWindowSize("windowed");
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
  mainWindow.webContents.send("open-settings");
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
    mainWindow.webContents.send("update-state", { ...lastKnownUpdate });
  } catch (e) {
    /* ignore */
  }
}

/** The app lives in the tray for days: checking only once at startup is not enough. */
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

function configureAutoUpdates() {
  if (!app.isPackaged || process.platform !== "win32") return;

  /**
   * Store build: we do not even register the listeners. Not calling `checkForUpdates` is not
   * enough — `autoInstallOnAppQuit` would leave the installer running on exit, which is exactly
   * the behaviour certification looks for.
   */
  if (isStoreBuild()) {
    diagLog("[Update] Store build — updater disabled");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

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
  if (!gotTheLock) return;

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
    enableMouseTrigger: true,
    mouseTriggerMode: "click",
    mouseTriggerButton: "middle",
    openAtLogin: false,
  };

  const syncLoginItemSettings = (openAtLogin) => {
    try {
      if (typeof openAtLogin === "boolean") {
        const currentLoginSettings = app.getLoginItemSettings();
        if (currentLoginSettings.openAtLogin !== openAtLogin) {
          app.setLoginItemSettings({
            openAtLogin: openAtLogin,
            path: app.getPath("exe"),
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

  const loadSettings = () => {
    try {
      if (fs.existsSync(settingsPath)) {
        const data = fs.readFileSync(settingsPath, "utf-8");
        currentSettings = { ...currentSettings, ...JSON.parse(data) };
      }
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
    if (typeof ui.enableMouseTrigger === "boolean") {
      currentSettings.enableMouseTrigger = ui.enableMouseTrigger;
    }
    if (ui.mouseTriggerMode === "click" || ui.mouseTriggerMode === "hold") {
      currentSettings.mouseTriggerMode = ui.mouseTriggerMode;
    }
    if (MOUSE_TRIGGER_BUTTONS.includes(ui.mouseTriggerButton)) {
      currentSettings.mouseTriggerButton = ui.mouseTriggerButton;
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
        enableMouseTrigger: currentSettings.enableMouseTrigger !== false,
        mouseTriggerMode:
          currentSettings.mouseTriggerMode === "hold" ? "hold" : "click",
        mouseTriggerButton: MOUSE_TRIGGER_BUTTONS.includes(currentSettings.mouseTriggerButton)
          ? currentSettings.mouseTriggerButton
          : "middle",
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

  if (currentSettings.openAtLogin !== undefined) {
    syncLoginItemSettings(currentSettings.openAtLogin);
  }

  /** Used with the non-blocking middle-button state monitor. */
  const cachedRadialFlags = {
    enableMouseTrigger: currentSettings.enableMouseTrigger !== false,
    mouseTriggerMode:
      currentSettings.mouseTriggerMode === "hold" ? "hold" : "click",
    mouseTriggerButton: MOUSE_TRIGGER_BUTTONS.includes(currentSettings.mouseTriggerButton)
      ? currentSettings.mouseTriggerButton
      : "middle",
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
      if (MOUSE_TRIGGER_BUTTONS.includes(fc.mouseTriggerButton)) {
        cachedRadialFlags.mouseTriggerButton = fc.mouseTriggerButton;
      }
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
    if (MOUSE_TRIGGER_BUTTONS.includes(payload.mouseTriggerButton)) {
      cachedRadialFlags.mouseTriggerButton = payload.mouseTriggerButton;
    }
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
      if (MOUSE_TRIGGER_BUTTONS.includes(ui.mouseTriggerButton)) {
        cachedRadialFlags.mouseTriggerButton = ui.mouseTriggerButton;
      }
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
      if (process.platform === "win32") {
        try {
          const copy = JSON.parse(JSON.stringify(shaped));
          win32Launch.normalizePersistedPayloadWin32(copy);
          return copy;
        } catch (e) {
          diagLog(`[Persist] get-full-config win32 normalize (${label}): ${e.message}`);
        }
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
      console.error("Failed to load full config:", e);
      diagLog(`[Persist] get-full-config primary failed: ${e.message}`);
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

  /** invoke: main processes and writes before the renderer moves on — more reliable than `send` while the app is closing. */
  ipcMain.handle("save-full-config", async (_event, payload) => {
    try {
      if (!payload || typeof payload !== "object") {
        return { ok: false, error: "invalid payload" };
      }
      const ok = await persistFullConfigFromRendererAsync(payload);
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
      event.returnValue = persistFullConfigFromRenderer(payload);
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
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Rovyl Backup",
      defaultPath: path.join(app.getPath("downloads"), "rovyl-backup.json"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) return { success: false };

    try {
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
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Rovyl Backup",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) return { success: false };

    try {
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
  ipcMain.handle("app-supports-recents", (event, appName, appCommand) =>
    Boolean(resolveIdeGlobalStorage(appName, appCommand)),
  );

  ipcMain.handle("get-app-recents", async (event, appName, appCommand) => {
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

    try {
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

  // Dashboard windowed: keep the taskbar button when the user switches to another app without using Minimize.
  // (Minimize uses skipTaskbar true — see minimize-window — so the icon only lives in the tray until restore.)
  mainWindow.on("blur", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (mainWindow.isMinimized()) return;
      if (nativeWindowSizeMode === "windowed" && rendererPanelVisible) {
        mainWindow.setSkipTaskbar(false);
      }
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
      mainWindow.webContents.send("switch-workspace", index);
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
   * The menu is a snapshot: item labels, icons and checkmarks are fixed when it is built, so every
   * state it shows — the pause countdown, which workspace is current — means rebuilding it.
   */
  const refreshTrayMenu = () => {
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.setContextMenu(buildTrayMenu());
      tray.setToolTip(triggersArePaused() ? "Rovyl — trigger paused" : "Rovyl");
    } catch (e) {
      diagLog(`[Tray] rebuild menu: ${e.message}`);
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
    tray.setContextMenu(buildTrayMenu());

    /** A menu item's icon is fixed at build time, so a theme flip means rebuilding the menu. */
    nativeTheme.on("updated", refreshTrayMenu);

    /**
     * On Windows a context menu does NOT swallow the left button — that constraint is macOS's.
     * The right button pops the menu by itself and stops emitting `right-click`, so there is no
     * listener for it here. Both listeners below share one cooldown on purpose: whether a
     * double-click really yields click+double-click or click+click, the outcome is the same.
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
  const shortcutRegistrationSignature = () => {
    const entries = [String(currentSettings.globalShortcut || "Alt+Z")];
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
      /**
       * Closing directly avoids going through the show/resize flow again and, above all, stops the
       * key that fired the toggle from confirming the app/workspace currently pointed at.
       */
      if (workspaceShortcutsMenuOpen && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("open-menu", {
          source: "shortcut",
          closeOnly: true,
        });
        return;
      }
      const allowed = await shouldOpenMenu();
      if (!allowed) return;
      showMenuAtCursor("shortcut");
    };

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
    diagLog("[Shortcuts] Unregistering global numeric workspace shortcuts (1-9)");
    for (let i = 1; i <= 9; i++) {
      globalShortcut.unregister(i.toString());
    }
  };

  // PERF: Workspace shortcuts registered via permanent listeners — flag gates IPC send
  // We extract this to a function so it can be re-called when main shortcuts are refreshed (unregisterAll)
  const registerWorkspaceShortcuts = () => {
    diagLog("[Shortcuts] Registering global numeric workspace shortcuts (1-9)");
    // RESTORED: Registration of 1-9 as global shortcuts is the ONLY reliable way
    // to capture keys when the Zenith window fails to take keyboard focus away 
    // from a background text field.
    for (let i = 1; i <= 9; i++) {
      try {
        // Unregister first if already registered to avoid double-registration errors (though Electron handles it gracefully)
        if (globalShortcut.isRegistered(i.toString())) {
            globalShortcut.unregister(i.toString());
        }

        const success = globalShortcut.register(i.toString(), () => {
          diagLog(`[Shortcuts] Global numeric shortcut triggered: ${i}`);
          if (workspaceShortcutsMenuOpen && mainWindow && !mainWindow.isDestroyed()) {
            diagLog(`[Shortcuts] Sending switch-workspace IPC: ${i - 1}`);
            mainWindow.webContents.send("switch-workspace", i - 1);
          }
        });
        if (!success) diagLog(`[Shortcuts] Failed to register workspace shortcut ${i}`);
      } catch (e) {
        diagLog(`[Shortcuts] Exception registering workspace shortcut ${i}: ${e.message}`);
      }
    }
  };

  let workspaceShortcutsMenuOpen = false;
  /** When false (picker mode), 1–9 are not registered while the radial is open. */
  let workspaceShortcutsUseNumeric = true;

  // Register initial shortcut
  registerGlobalShortcut();

  refreshShortcutsFromFullConfig = () => {
    registerGlobalShortcut();
  };

  ipcMain.on("set-settings", (event, settings) => {
    if (!settings || typeof settings !== "object") return;
    const patch = {};
    if (typeof settings.globalShortcut === "string") patch.globalShortcut = settings.globalShortcut;
    if (typeof settings.enableMouseTrigger === "boolean") patch.enableMouseTrigger = settings.enableMouseTrigger;
    if (settings.mouseTriggerMode === "click" || settings.mouseTriggerMode === "hold") {
      patch.mouseTriggerMode = settings.mouseTriggerMode;
    }
    if (MOUSE_TRIGGER_BUTTONS.includes(settings.mouseTriggerButton)) {
      patch.mouseTriggerButton = settings.mouseTriggerButton;
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
    if (patch.mouseTriggerButton !== undefined) {
      cachedRadialFlags.mouseTriggerButton = patch.mouseTriggerButton;
      syncMouseHookState();
    }

    if (patch.globalShortcut) {
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
    if (typeof url !== "string") {
      return { ok: false, error: "Invalid URL" };
    }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return { ok: false, error: "Only http(s) URLs are allowed" };
    }
    try {
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

  ipcMain.on("set-workspace-shortcuts", (event, isOpen, mode) => {
    const useNumeric = mode !== "picker";
    if (
      workspaceShortcutsMenuOpen === isOpen &&
      workspaceShortcutsUseNumeric === useNumeric
    ) {
      return;
    }
    workspaceShortcutsMenuOpen = isOpen;
    workspaceShortcutsUseNumeric = useNumeric;
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
        mainWindow.webContents.send("mmb-cursor", { x: point.x, y: point.y });
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
    const virtualKey = MOUSE_TRIGGER_VK[activeMouseHookButton] ?? MOUSE_TRIGGER_VK.middle;
    const mode = cachedRadialFlags.mouseTriggerMode === "click" ? "click" : "hold";
    diagLog(
      `Mouse trigger captured by the hook (${activeMouseHookButton}, ${mode}, slop ${TRIGGER_PASSTHROUGH_SLOP_PX}px)`,
    );
    /** "Active" marker: there is no process of its own any more, but the rest of the code tests the truth of this. */
    mouseHook = { active: true };
    radialTriggerListener = (text) => {
      if (handleTriggerData) void handleTriggerData(text);
    };
    setRadialTriggerCapture(
      virtualKey,
      mode,
      TRIGGER_PASSTHROUGH_SLOP_PX,
      MMB_CLICK_MAX_MS,
      MMB_CLICK_DRAG_PX,
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
            mainWindow.webContents.send("open-menu", {
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("mmb-release");
          }
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
    const wantHook = cachedRadialFlags.enableMouseTrigger;
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

/** A small working set kept in RAM; Windows also keeps these pages in the file cache. */
const prewarmedExecutableBuffers = new Map();
let prewarmAppsSignature = "";
ipcMain.on("prewarm-apps", async (_event, rawCommands) => {
  const commands = Array.isArray(rawCommands)
    ? [...new Set(rawCommands.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    : [];
  const signature = commands.slice().sort().join("\u0000");
  if (signature === prewarmAppsSignature) return;
  prewarmAppsSignature = signature;
  prewarmedExecutableBuffers.clear();

  const MAX_APPS = 8;
  const MAX_BYTES_PER_APP = 8 * 1024 * 1024;
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
      const length = Math.min(stat.size, MAX_BYTES_PER_APP);
      const handle = await fs.promises.open(exe, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        prewarmedExecutableBuffers.set(exe.toLowerCase(), buffer.subarray(0, bytesRead));
        diagLog(`[Prewarm] Cached ${(bytesRead / 1024 / 1024).toFixed(1)} MB from ${exe}`);
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
    target =
      commandType === "folder"
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

// IPC: receives a command from React to run an app
const runExecuteCommand = async (command, commandType, options = {}) => {
  if (!command || typeof command !== "string" || command.trim() === "") {
    console.warn("EXEC_ERROR: Received empty or invalid command");
    return launchFailed("Empty or invalid command", undefined);
  }

  const trimmedCommand = command.trim();

  // CRITICAL: Resolve GUIDs to real paths FIRST, before any detection logic
  let resolvedCommand = resolveShellPath(trimmedCommand);
  resolvedCommand = normalizeAumidIdeCommands(resolvedCommand);
  const prefersProcessReuse = options?.launchMode === "reuse" || options?.launchMode === "prewarm";
  resolvedCommand = prefersProcessReuse
    ? removeIdeNewWindowFlag(resolvedCommand)
    : addIdeNewWindowFlag(resolvedCommand);
  if (process.platform === "win32") {
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
      lower.includes("google.antigravity") ||
      lower.includes("microsoft.") ||
      lower.includes("discord") ||
      base.startsWith("{") || // GUID
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
        case "exec_explorer_shell":
          // Special handling for AUMIDs with arguments
          let aumid = cmd;
          let args = "";

          // If the command already starts with shell:AppsFolder\, strip it to avoid double prefixing
          if (aumid.toLowerCase().startsWith("shell:appsfolder\\")) {
            aumid = aumid.substring("shell:appsfolder\\".length);
          } else if (aumid.toLowerCase().startsWith("shell:appsfolder/")) {
            aumid = aumid.substring("shell:appsfolder/".length);
          }

          if (aumid.includes(" ")) {
            const firstSpace = aumid.indexOf(" ");
            args = aumid.substring(firstSpace + 1);
            aumid = aumid.substring(0, firstSpace);
          }

          // Basic AUMID launch - args support depends on Windows version and app
          const shellPath = `shell:AppsFolder\\${aumid}`;
          execCmd = args ? `start "" "${shellPath}" ${args}` : `start "" "${shellPath}"`;
          diagLog(`  → [${method}] Running: ${execCmd}`);
          exec(execCmd, (err, stdout, stderr) => {
            if (err) {
              console.log(`  ✗ [${method}] Failed: ${err.message}`);
              if (stderr) console.log(`  stderr: ${stderr}`);
              reject(err);
            } else {
              diagLog(`  ✓ [${method}] Success!`);
              resolve(true);
            }
          });
          break;

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

      if (isIDE && finalCommand.includes(" ")) {
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

// IPC: receives a command to hide the window
ipcMain.on("hide-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  clearRadialMouseBlocking();
  releaseRadialCursor();
  if (nativeWindowSizeMode === "small") {
    windowBuriedPassive = false;
    try {
      mainWindow.setIgnoreMouseEvents(true);
      applySmallModeCollapsedBounds(undefined);
      if (!mainWindow.isVisible()) mainWindow.showInactive();
      mainWindow.webContents.setBackgroundThrottling(true);
    } catch (e) {
      /* ignore */
    }
    return;
  }

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
  const child = spawn(
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
 * Windows applies the foreground lock to anyone who did not receive the last input: the radial is
 * shown with `showInactive()` and neither `focus()` nor `app.focus({ steal: true })` gives it the
 * keyboard — the keys keep landing in the app underneath. Only by sharing the input queue with the
 * foreground thread (in the helper) does `SetForegroundWindow` go through.
 */
function stealForegroundForMainWindow() {
  if (process.platform !== "win32") return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  const now = Date.now();
  if (now < foregroundStealBusyUntil) return;
  foregroundStealBusyUntil = now + 250;

  let hwnd;
  try {
    hwnd = mainWindow.getNativeWindowHandle().readBigUInt64LE(0).toString();
  } catch (e) {
    diagLog(`[Foreground] HWND unavailable: ${e.message}`);
    return;
  }
  ensureForegroundFocusHelper();
  writeForegroundFocus(hwnd);
}

/**
 * Surfaces with a text field (the licence gate) ask for the keyboard explicitly. The renderer only
 * sends this when `document.hasFocus()` is false, so we do NOT trust `isFocused()` here: Electron
 * reports focus as soon as `focus()` is called, even when Windows refused it — that optimistic read
 * is exactly what blocked the native steal and forced the click.
 */
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
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch (e) {
    return false;
  }
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
  if (!app.isPackaged || process.platform !== "win32") return "unsupported";
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
      const result = await autoUpdater.checkForUpdates();
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

  /**
   * `isForceRunAfter: true` — without this NSIS installs and does NOT relaunch the app, forcing the
   * user to open it by hand. An app that lives in the tray simply vanished after updating.
   */
  autoUpdater.quitAndInstall(false, true);
};

ipcMain.on("install-update-now", installUpdateNow);

ipcMain.on("request-keyboard-focus", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  /** Before the reveal the window is still hidden; the renderer asks again right after. */
  if (!mainWindow.isVisible()) return;
  try {
    windowBuriedPassive = false;
    mainWindow.setIgnoreMouseEvents(false);
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    }
    app.focus({ steal: true });
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.webContents.focus();
  } catch (e) {
    /* ignore */
  }

  stealForegroundForMainWindow();
  /** Electron's `focus()` only takes effect once the HWND really is the foreground one. */
  const settle = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch (e) {
      /* ignore */
    }
  }, 180);
  settle.unref?.();
});

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

// IPC: Toggle Window Size
ipcMain.on("set-window-size", (event, mode, anchorScreenPoint) => {
  updateWindowSize(mode, anchorScreenPoint);
});

/** Same as set-window-size but invoke() so the renderer can await before painting (avoids one frame at windowed bounds). */
ipcMain.handle("apply-window-size", (event, mode, anchorScreenPoint) => {
  updateWindowSize(mode, anchorScreenPoint);
  return true;
});

/** Guarantees clicks reach the renderer after opening a widget/radial — clears the `small` island's passthrough. */
ipcMain.handle("ensure-window-interactive", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (typeof mainWindow.setShape === "function") {
      mainWindow.setShape([]);
    }
  } catch (e) {
    /* ignore */
  }
  lastWindowHitShapeKey = "__empty__";
  try {
    mainWindow.setIgnoreMouseEvents(false);
  } catch (e) {
    /* ignore */
  }
  return true;
});

/** Compatibility: the stable geometry already removes the small↔fullscreen transition. */
let radialTransitionWarmed = false;
ipcMain.handle("warm-radial-transition", () => {
  if (radialTransitionWarmed) return true;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMinimized()) return false;
  } catch (e) {
    return false;
  }
  if (nativeWindowSizeMode !== "small") {
    radialTransitionWarmed = true;
    return true;
  }

  /** `small` and the radial already share the same bounds; there is no native transition to warm. */
  radialTransitionWarmed = true;
  return true;
});

/**
 * Idle with no HUD: keeps only the radial's compact square, fully transparent and with mouse
 * passthrough. It is not a monitor-sized layer and there is no hide/show/resize on open.
 */
ipcMain.handle("collapse-idle-overlay", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMinimized()) return false;
  } catch (e) {
    return false;
  }
  /** Only in `small`: in fullscreen/windowed either the radial or a panel is using the window. */
  if (nativeWindowSizeMode !== "small") return false;

  const cur = mainWindow.getBounds();
  const disp = screen.getPrimaryDisplay();
  const nb = smallModeBounds(disp.bounds);
  const key = JSON.stringify(nb);
  lastWindowHitShapeKey = key;
  try {
    if (typeof mainWindow.setShape === "function") mainWindow.setShape([]);
  } catch (e) {
    /* ignore */
  }
  try {
    mainWindow.setIgnoreMouseEvents(true);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    mainWindow.webContents.setBackgroundThrottling(true);
  } catch (e) {
    /* ignore */
  }
  if (!boundsApproxEqual(cur, nb)) {
    try {
      mainWindow.setBounds(nb);
    } catch (e) {
      /* ignore */
    }
  }
  windowBuriedPassive = false;
  diagLog("[Overlay] Stable idle: transparent radial surface and mouse passthrough.");
  return true;
});

/** Re-run `small` overlay (forward mouse) — refreshes Windows hit-testing after fullscreen → HUD-only. */
ipcMain.handle("reapply-small-overlay", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMinimized()) return false;
  } catch (e) {
    return false;
  }
  /** Widget / radial / panel — never regress fullscreen|windowed → small (it leaves clicks “stuck” until the useEffect realigns). */
  if (nativeWindowSizeMode === "fullscreen" || nativeWindowSizeMode === "windowed") {
    try {
      mainWindow.setIgnoreMouseEvents(false);
    } catch (e) {
      /* ignore */
    }
    return true;
  }
  /** `small` mode: keep the radial's bounds and a stable transparent surface. */
  try {
    mainWindow.setIgnoreMouseEvents(true);
    applySmallModeCollapsedBounds(undefined);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    mainWindow.webContents.setBackgroundThrottling(true);
  } catch (e) {
    /* ignore */
  }
  return true;
});

/**
 * Island: with `coordinateSpace: "screen"` we shrink the HWND to the island's rect — outside it the
 * mouse does not go through a fullscreen transparent topmost window (clicks in other apps stop
 * “jamming” the DWM).
 * Legacy: client coords + `setShape` on a fullscreen window.
 */
ipcMain.handle("set-window-hit-shape", (event, rects, opts = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMinimized()) return false;
  } catch (e) {
    return false;
  }
  const coordinateSpace =
    opts && opts.coordinateSpace === "screen" ? "screen" : "client";

  try {
    if (!rects || !Array.isArray(rects) || rects.length === 0) {
      if (lastWindowHitShapeKey === "__empty__") return true;
      lastWindowHitShapeKey = "__empty__";
      if (typeof mainWindow.setShape === "function") {
        try {
          mainWindow.setShape([]);
        } catch (e) {
          /* ignore */
        }
      }
      /*
       * Only in `small` mode should the mouse pass through by default. In fullscreen (radial),
       * clearing the compact island unmounts the HUD and sends [] — we cannot apply forward here or
       * the radial menu becomes “invisible” to clicks and looks like a tiny rectangle behind the island.
       *
       * `setImmediate`: the renderer can send `set-window-size` `windowed` in the same tick (opening the dashboard).
       * If we expand to the whole monitor before that, the DWM shows a flashing rectangle. Defer the expand.
       */
      try {
        if (nativeWindowSizeMode === "fullscreen" || nativeWindowSizeMode === "windowed") {
          mainWindow.setIgnoreMouseEvents(false);
        } else {
          setImmediate(() => {
            try {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              if (mainWindow.isMinimized()) return;
              if (nativeWindowSizeMode !== "small") return;
              mainWindow.setIgnoreMouseEvents(true);
              applySmallModeCollapsedBounds(undefined);
              if (!mainWindow.isVisible()) mainWindow.showInactive();
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
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
      return true;
    }

    if (nativeWindowSizeMode === "small" && coordinateSpace === "screen") {
      const u = unionScreenRects(rects);
      if (!u || u.width < 3 || u.height < 3) return false;
      const center = { x: u.x + u.width / 2, y: u.y + u.height / 2 };
      const disp = screen.getDisplayNearestPoint(center);
      const nb = clampBoundsToWorkArea(u, disp.workArea);
      const key = JSON.stringify(nb);
      if (key === lastWindowHitShapeKey) return true;
      const cur = mainWindow.getBounds();
      lastWindowHitShapeKey = key;
      if (!boundsApproxEqual(cur, nb)) {
        mainWindow.setBounds(nb);
      }
      try {
        if (typeof mainWindow.setShape === "function") {
          mainWindow.setShape([]);
        }
      } catch (e) {
        /* ignore */
      }
      try {
        mainWindow.setIgnoreMouseEvents(false);
      } catch (e) {
        /* ignore */
      }
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
      return true;
    }

    if (typeof mainWindow.setShape !== "function") return false;
    const normalized = rects.map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    }));
    const key = JSON.stringify(normalized);
    if (key === lastWindowHitShapeKey) return true;
    lastWindowHitShapeKey = key;
    try {
      mainWindow.setIgnoreMouseEvents(false);
    } catch (e) {
      /* ignore */
    }
    mainWindow.setShape(normalized);
    return true;
  } catch (e) {
    return false;
  }
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

// IPC: Select File (Executable)
ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Executables", extensions: ["exe", "lnk", "bat", "cmd"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// IPC: Select Folder (Directory)
ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// IPC: Select Image (Custom Icon)
// Copy into userData so the icon survives if the original file is deleted/moved.
ipcMain.handle("select-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "ico", "svg"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const srcPath = result.filePaths[0];
  try {
    const customIconsDir = path.join(app.getPath("userData"), "custom-icons");
    if (!fs.existsSync(customIconsDir)) {
      fs.mkdirSync(customIconsDir, { recursive: true });
    }
    const ext = path.extname(srcPath) || ".png";
    const destPath = path.join(
      customIconsDir,
      `${crypto.randomUUID()}${ext}`,
    );
    fs.copyFileSync(srcPath, destPath);
    return destPath;
  } catch (e) {
    diagLog(`[select-image] Failed to copy into app data: ${e.message}`);
    return null;
  }
});

// Delete a copied custom icon file (only if path is under userData/custom-icons).
ipcMain.handle("remove-managed-custom-icon", async (_, urlOrPath) => {
  try {
    if (!urlOrPath || typeof urlOrPath !== "string") return;
    let filePath = urlOrPath.trim();
    if (filePath.startsWith("file:")) {
      filePath = url.fileURLToPath(filePath);
    }
    filePath = path.resolve(filePath);
    const customDir = path.resolve(path.join(app.getPath("userData"), "custom-icons"));
    const rel = path.relative(customDir, filePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    diagLog(`[remove-managed-custom-icon] ${e.message}`);
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
 * Web shortcuts (`http…`) keep their favicon: they do not come from the Windows pipeline.
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
        if (item && item.customIconUrl && !isWebShortcut(item)) {
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

ipcMain.handle("get-file-icon", async (event, filePath) => {
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
});

async function extractIconUncached(filePath) {
  try {
    diagLog(`[IconRequest] Fetching icon for: ${filePath}`);

    // 1. Resolve shell paths
    let resolvedPath = resolveShellPath(filePath);
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
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) =>
        diagLog(`[IconRequest] PowerShell stderr: ${String(d).trim()}`),
      );
      child.on("error", (err) => {
        diagLog(`[IconRequest] PowerShell spawn error: ${err.message}`);
        resolve(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          diagLog(`[IconRequest] PowerShell exit ${code} for ${resolvedPath}`);
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        const lines = stdout.trim().split(/\r?\n/);
        const dataLine = lines.find((line) => line.startsWith("data:image"));
        resolve(dataLine || null);
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

let installedAppsCache = null;

ipcMain.handle("get-installed-apps", async (event, forceRefresh = false) => {
  if (installedAppsCache && !forceRefresh) {
    return installedAppsCache;
  }

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
        installedAppsCache = appList; // Cache the result
        resolve(appList);
      } catch (e) {
        console.error("Parse error:", e);
        console.debug("Raw scanner output:", stdout);
        resolve([]);
      }
    });
  });
});

app.on("window-all-closed", (e) => {
  // Prevent app from quitting when all windows are closed
  // This ensures the app continues to run in the tray
  e.preventDefault();
});

app.on("will-quit", () => {
  /** The pointer may be parked at the wheel's centre: give it back while the helper is alive. */
  releaseRadialCursor();
  /** Helpers first: while they live, the installer cannot touch the folder. */
  stopMouseHookForShutdown();
  stopRadialMouseBlocker();
  stopForegroundFocusHelper();
  saveIconCache({ sync: true });
  globalShortcut.unregisterAll();
});
