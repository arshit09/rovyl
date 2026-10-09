---
name: release
description: Build the native Rovyl executable, bump the version, and publish a new GitHub release on arshit09/rovyl with changelog-style notes.
argument-hint: "[patch|minor|major|X.Y.Z]  (default: minor)"
disable-model-invocation: true
---

# Release Rovyl

Cut a new Rovyl release: bump the version, build the one `.exe`, publish it to GitHub with the
update feed beside it, and write the release notes. Argument: `$ARGUMENTS` — `patch`, `minor`,
`major`, or an explicit `X.Y.Z`. Empty means `minor`.

Run everything from the repo root (`C:\Git\rovyl`) in PowerShell. Stop and report on the first
failure — never skip a step silently, and never force-push or delete a published release.

The shipped product is the Rust build at the root. The 1.x Electron line lives in
`archive/electron/` and is never built or published; nothing in this process touches it.

## 1. Preflight

- `git fetch origin` and confirm the branch is `main` and not behind `origin/main`.
- `git status --porcelain` must come back empty. Anything uncommitted → stop and ask the user
  whether to commit it first.
- `gh auth status` must succeed.

## 2. Pick the version

- Get the latest published version from GitHub, NOT from `git tag` (local tags lag, and plain
  `gh` points at the upstream fork):
  `gh release list --repo arshit09/rovyl --limit 1 --json tagName -q '.[0].tagName'`
- Compute the next version from the argument (patch/minor/major on the published version, or use
  the explicit `X.Y.Z`). It must be higher than the published one.
- Set it in `Cargo.toml` — the `version` under `[package]`, nothing else — then
  `cargo check` so `Cargo.lock` picks the new version up. Both files change.

## 3. Commit and push the bump

```powershell
git add Cargo.toml Cargo.lock
git commit -m "chore: bump the version to <next>" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

## 4. Build

A running copy holds `target\release\rovyl.exe` open, and cargo cannot replace a file Windows has
locked — a build with Rovyl running fails with "Access is denied". Build into another directory
and point the release script at it, which avoids touching the user's running launcher at all:

```powershell
cargo build --release --target-dir target\setup-build
scripts\release.ps1 -SkipBuild -Binary target\setup-build\release\rovyl.exe
```

That writes `dist\Rovyl-Setup-<next>.exe` and `dist\latest.yml`, and prints the publish command.
It does not publish.

- `latest.yml` is electron-updater's feed, written by hand so every 1.x install updates itself
  into this build. Its `sha512` is base64 of the raw digest; hex fails every update.
- There is no `.blockmap` on purpose — see the comments in `scripts/release.ps1`.
- If the user is not running Rovyl, plain `scripts\release.ps1` builds and writes in one step.

## 5. Publish

```powershell
gh release create v<next> "dist\Rovyl-Setup-<next>.exe" "dist\latest.yml" --repo arshit09/rovyl --title <next> --notes-file <file>
```

Write the notes to a file in the scratchpad first (next section) and pass it here, so the release
is never published with an empty body. Then verify both assets arrived:

```powershell
gh release view v<next> --repo arshit09/rovyl --json assets -q '.assets[].name'
```

It must list `Rovyl-Setup-<next>.exe` and `latest.yml`. Without the feed file no client sees the
update: `gh release upload v<next> dist\latest.yml --repo arshit09/rovyl`.

## 6. The release notes

Build them from `git log --no-merges --format='%h %s%n%b' v<prev>..v<next>` (use `origin/main` if
the tag hasn't been fetched).

Style (antigravity.google/changelog), matching the previous releases exactly:

```markdown
<Month D, YYYY>

### <One heading that sums up the whole release>

<1–2 sentence summary of what changed for the user.>

**Improvements (N)**

* Added …
* X can now …

**Fixes (N)**

* Fixed an issue where …

---

**Install:** download **Rovyl-Setup-<next>.exe** below and run it. The installer is unsigned, so if Windows says it protected your PC, click **More info**, then **Run anyway**. Already on Rovyl? It updates itself.

**Full changelog**: https://github.com/arshit09/rovyl/compare/v<prev>...v<next>
```

- One short sentence per bullet, user-visible effect only — no internals, no rationale.
- `feat` → Improvements, `fix` → Fixes. Skip `chore`, `docs`, `refactor`, `chore(dev)`,
  website-only and version-bump commits.
- Omit a section entirely if it has no bullets; N is the bullet count.

## 7. Finish

- `git fetch origin --tags` so the new tag exists locally.
- Reply with the version and the release URL: `https://github.com/arshit09/rovyl/releases/tag/v<next>`.
