/**
 * The name and icon Windows shows for the running app, asserted against the binary itself.
 *
 * An unpackaged run launches Electron's prebuilt binary, and Windows labels a process from that
 * file's PE version resource and its path — not from `app.setName("Rovyl")`, which renames only
 * what Electron owns. Left alone, the app the user started appears in Task Manager, Alt-Tab and
 * the taskbar as "Electron", wearing Electron's icon.
 *
 * `scripts/brand-dev-electron.cjs` renames the binary and rewrites those resources. This reads
 * both back, because nothing else in the tree would notice them reverting: an Electron upgrade
 * drops a fresh unstamped binary and rewrites `path.txt`, and a launcher that stops calling the
 * script fails silently.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { brandDevElectron, EXE_NAME } = require(join(root, "scripts", "brand-dev-electron.cjs"));

if (process.platform !== "win32") {
  console.log("exe-branding-smoke: skipped — PE version resources are a Windows notion");
  process.exit(0);
}

const electronDir = join(root, "node_modules", "electron");
if (!existsSync(join(electronDir, "dist"))) {
  console.log("exe-branding-smoke: skipped — electron is not installed");
  process.exit(0);
}

const first = await brandDevElectron({ quiet: true });
assert.notEqual(
  first.reason,
  "electron is not installed",
  "no binary to brand, yet dist/ exists — the rename lost the executable",
);
/**
 * A locked image means an instance is up, and neither the rename nor rcedit can write through
 * that. Reading the resources back is still the assertion that matters, so only the idempotence
 * check is conditional on the stamp having been reachable.
 */
if (first.reason !== "rcedit failed") {
  const second = await brandDevElectron({ quiet: true });
  assert.equal(
    second.stamped,
    false,
    "a second run re-stamped: the marker beside the exe is not being honoured, and every launch now pays for rcedit",
  );
  assert.equal(second.reason, "already branded");
}

const exePath = join(electronDir, "dist", EXE_NAME);
assert.ok(
  existsSync(exePath),
  `${exePath} is missing — Task Manager caches an executable's icon per path, so running from the stock path shows Electron's icon for every windowless child process`,
);
assert.equal(
  readFileSync(join(electronDir, "path.txt"), "utf8").trim(),
  EXE_NAME,
  'path.txt still points at the old name — require("electron") resolves to a file that is no longer there',
);

/** `Get-Item .VersionInfo` is the same resource Task Manager's Name column reads. */
const info = JSON.parse(
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$v = (Get-Item -LiteralPath '${exePath}').VersionInfo; ` +
        "ConvertTo-Json -Compress @{ " +
        "FileDescription = $v.FileDescription; ProductName = $v.ProductName; " +
        "InternalName = $v.InternalName; CompanyName = $v.CompanyName }",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  ),
);

for (const field of ["FileDescription", "ProductName", "InternalName"]) {
  assert.equal(
    info[field],
    "Rovyl",
    `${field} is "${info[field]}" — Windows will introduce the running app as that, not as Rovyl`,
  );
}
assert.equal(info.CompanyName, "Henry Cauan");

console.log("exe-branding-smoke: ok — the dev runtime runs as Rovyl.exe and identifies as Rovyl");
