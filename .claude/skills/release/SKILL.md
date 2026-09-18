---
name: release
description: Build the Windows installer for Rovyl, bump the version, and publish a new GitHub release on arshit09/rovyl with changelog-style notes.
argument-hint: "[patch|minor|major|X.Y.Z]  (default: minor)"
disable-model-invocation: true
---

# Release Rovyl

Cut a new Rovyl release: bump the version, build the Windows `.exe` installer, publish it to GitHub, and write the release notes. Argument: `$ARGUMENTS` — `patch`, `minor`, `major`, or an explicit `X.Y.Z`. Empty means `minor`.

Run everything from the repo root (`C:\Git\rovyl`) in PowerShell. Stop and report on the first failure — never skip a step silently, and never force-push or delete a published release.

## 1. Preflight

- `git fetch origin` and confirm the branch is `main` and not behind `origin/main`.
- `git status --porcelain`: the only allowed uncommitted changes are `backend/rovyl-helper.exe` and `resources/bin/rovyl-helper.exe` (the build regenerates them). Anything else → stop and ask the user whether to commit it first.
- `gh auth status` must succeed.

## 2. Pick the version

- Get the latest published version from GitHub, NOT from `git tag` (local tags lag, and plain `gh` points at the upstream fork):
  `gh release list --repo arshit09/rovyl --limit 1 --json tagName -q '.[0].tagName'`
- Compute the next version from the argument (patch/minor/major on the published version, or use the explicit `X.Y.Z`). It must be higher than the published one.
- Set it without tagging: `npm version <next> --no-git-tag-version` (updates `package.json` and `package-lock.json`).

## 3. Commit and push the bump

```powershell
git add package.json package-lock.json
git commit -m "chore: bump the version to <next>" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push origin main
```

Do not commit the `rovyl-helper.exe` files as part of this commit.

## 4. Check, build, publish

First kill every running Rovyl: the dev instance, the installed app, the native helper, and any installer or uninstaller. They lock `rovyl-helper.exe` and `app.asar` and break the build. Also stop the node launchers (`npm run dev`/`start:*`), or they restart the app right away. Do this without asking — the user wants it every time:

```powershell
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'rovyl' -and $_.CommandLine -match 'vite|scripts[\\/](start-|dev-runtime|launch-electron)'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process -Name 'Rovyl','rovyl-helper','Rovyl-Setup*','Uninstall Rovyl' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Get-Process -Name 'Rovyl','rovyl-helper','Rovyl-Setup*','Uninstall Rovyl' -ErrorAction SilentlyContinue
```

The last command must print nothing. If something is still running, run the kill again, or stop and tell the user which process is left. If the build later fails with `EnsureEmptyDir … used by another process` or `EBUSY`, run this kill again and retry into a new output folder.

Then check, build and publish:

```powershell
$env:GH_TOKEN = (gh auth token)
node scripts/release.mjs --check
npm run build
npx electron-builder --win --publish always --config.directories.output=build-out-<next>
```

- `release.mjs --check` validates token, write access, and that the version is new and higher. Must pass before building.
- Build into a fresh `build-out-<next>` folder, because `build-out/win-unpacked/resources/app.asar` often stays locked. Use the long `--config.directories.output=…` form; the short `-c.…` form does not parse.
- The build takes several minutes: use a 600000 ms timeout, or run it in the background and wait for it to finish.

## 5. Verify the release

```powershell
gh release view v<next> --repo arshit09/rovyl --json assets -q '.assets[].name'
```

It must contain `Rovyl-Setup-<next>.exe`, its `.blockmap`, and `latest.yml`. If `latest.yml` is missing, upload it: `gh release upload v<next> build-out-<next>/latest.yml --repo arshit09/rovyl`. Without it no client sees the update.

## 6. Write the release notes

electron-builder publishes the release with an empty body. Build the notes from `git log --no-merges --format='%h %s%n%b' v<prev>..v<next>` (use `origin/main` if the tag hasn't been fetched), write them to a file in the scratchpad, then:

```powershell
gh release edit v<next> --repo arshit09/rovyl --notes-file <file>
```

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
- `feat` → Improvements, `fix` → Fixes. Skip `chore`, `docs`, `refactor`, `chore(dev)`, website-only and version-bump commits.
- Omit a section entirely if it has no bullets; N is the bullet count.

## 7. Finish

- `git fetch origin --tags` so the new tag exists locally.
- Reply with the version and the release URL: `https://github.com/arshit09/rovyl/releases/tag/v<next>`.
