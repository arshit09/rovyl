/**
 * Publishes a Rovyl release, checking everything that can go wrong first.
 *
 * `electron-builder --publish always` only finds the problems at the END: it compiles for ten
 * minutes, packages, uploads the files — and only then fails because the repository is empty, or
 * because the token is not enough, or because the version already exists. All of those conditions
 * are checkable in seconds, before spending the build.
 *
 *   node scripts/release.mjs           publishes
 *   node scripts/release.mjs --check   only validates, does not compile
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
const { owner, repo } = pkg.build.publish;
const version = pkg.version;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const checkOnly = process.argv.includes("--check");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg, hint) => {
  console.error(`  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
};

async function api(pathname, init = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "rovyl-release",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  return response;
}

console.log(`\nRovyl ${version} → ${owner}/${repo}\n`);

/* ── 1. Token ─────────────────────────────────────────────────────────────── */
if (!token) {
  fail(
    "GH_TOKEN is not set.",
    'PowerShell:  $env:GH_TOKEN = "<token>"',
  );
}
ok("GH_TOKEN present");

/* ── 2. Repository access, and write permission ───────────────────────────── */
const repoResponse = await api(`/repos/${owner}/${repo}`);
if (repoResponse.status === 404) {
  fail(
    `No access to ${owner}/${repo}.`,
    "The token has to include this repository under Repository access.",
  );
}
if (!repoResponse.ok) fail(`GitHub returned ${repoResponse.status} while reading the repository.`);

const repoInfo = await repoResponse.json();
if (!repoInfo.permissions?.push) {
  fail(
    "The token has no write permission.",
    "Repository permissions → Contents: Read and write.",
  );
}
ok("token with write access to the repository");

if (repoInfo.private) {
  console.warn(
    "  ! private repository — the clients' updater cannot read releases without a token",
  );
}

/* ── 3. The repository must have history ──────────────────────────────────── */
const commits = await api(`/repos/${owner}/${repo}/commits?per_page=1`);
if (commits.status === 409) {
  fail(
    "The repository is empty.",
    "GitHub needs a tag for a release, and a tag needs a commit. Create a README first.",
  );
}
if (!commits.ok) fail(`GitHub returned ${commits.status} while checking commits.`);
ok("repository with history");

/* ── 4. The version must be new, and higher than the published one ────────── */
const existing = await api(`/repos/${owner}/${repo}/releases/tags/v${version}`);
if (existing.ok) {
  fail(
    `Release v${version} already exists.`,
    "Bump `version` in package.json before publishing.",
  );
}
ok(`v${version} does not exist yet`);

const latest = await api(`/repos/${owner}/${repo}/releases/latest`);
if (latest.ok) {
  const latestTag = (await latest.json()).tag_name?.replace(/^v/, "") ?? "0.0.0";
  const compare = (a, b) => {
    const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  };
  if (compare(version, latestTag) <= 0) {
    fail(
      `v${version} is not higher than the published one (v${latestTag}).`,
      "No client would see this update.",
    );
  }
  ok(`v${version} is higher than the published one (v${latestTag})`);
} else {
  ok("first release of this repository");
}

if (checkOnly) {
  console.log("\nAll set. Run without --check to publish.\n");
  process.exit(0);
}

/* ── 5. Build and publish ─────────────────────────────────────────────────── */
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });

console.log("\n→ build\n");
await run("npm", ["run", "build"]);

console.log("\n→ package and publish\n");
await run("npx", ["electron-builder", "--win", "--publish", "always"]);

/* ── 6. Confirm what ended up there ───────────────────────────────────────── */
const published = await api(`/repos/${owner}/${repo}/releases/tags/v${version}`);
if (!published.ok) {
  fail("The release did not show up on GitHub. Read the output above.");
}
const assets = (await published.json()).assets.map((a) => a.name);
console.log(`\nRelease v${version} published with: ${assets.join(", ")}`);

/** Without `latest.yml` the installer is there but no client finds it. */
if (!assets.includes("latest.yml")) {
  console.error(
    "\n  ! latest.yml IS MISSING — clients will not see this update.\n" +
      "    Upload it by hand from build-out/latest.yml.",
  );
  process.exit(1);
}
console.log("latest.yml present: clients will get the update.\n");
