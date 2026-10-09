# Build the release artifacts: the setup .exe, and the feed file the 1.x builds read.
#
# `latest.yml` is electron-updater's update feed. Every Rovyl 1.x install checks it on launch —
# it fetches https://github.com/arshit09/rovyl/releases.atom, takes the newest tag, downloads
# `latest.yml` from that release, and compares its `version` with its own. If the feed is newer it
# downloads the file named in `path`, checks it against `sha512`, and spawns it with NSIS's
# arguments: `--updated /S --force-run`.
#
# Nothing in that chain knows or cares that the file it downloads is no longer an NSIS installer.
# There is no signature to satisfy (the 1.x builds ship no `publisherName`, so electron-updater
# skips the check) and no format to imitate beyond being an `.exe` whose hash matches. So this
# writes the feed by hand, naming the native build, and the next update check moves every user
# across. See `src/sys/migrate.rs` for what happens on the other side of that spawn.
#
#   scripts\release.ps1              # build and write dist\
#   scripts\release.ps1 -SkipBuild   # just rewrite the feed from what is already built
#
# `-Binary` takes the executable from somewhere other than `target\release\rovyl.exe`, which a
# running copy of the launcher holds open — cargo cannot replace a file Windows has locked, so a
# build while Rovyl is running from the build tree fails with "Access is denied". Build into
# another directory (`cargo build --release --target-dir target\setup-build`) and point this at it.
#
# It does NOT publish. The command to do that is printed at the end, to be run deliberately.

param(
    [switch] $SkipBuild,
    [string] $Binary
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$version = (Select-String -Path "$root\Cargo.toml" -Pattern '^version = "(.+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $version) { throw "no version in Cargo.toml" }

if (-not $SkipBuild) {
    Push-Location $root
    try { cargo build --release } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
}

$built = if ($Binary) { $Binary } else { "$root\target\release\rovyl.exe" }
if (-not (Test-Path $built)) { throw "no binary at $built" }

$dist = "$root\dist"
New-Item -ItemType Directory -Force $dist | Out-Null

# The name matters twice over: electron-updater saves the download under it, and this build reads
# its own file name to decide whether a double-click should open the setup window or launch the
# launcher. See `setup_mode` in src/main.rs.
$name = "Rovyl-Setup-$version.exe"
$setup = "$dist\$name"
Copy-Item $built $setup -Force

# Base64 of the raw SHA-512 digest, which is the encoding electron-builder writes and
# electron-updater compares against. Hex here would fail every update with "sha512 mismatch".
$bytes = [System.IO.File]::ReadAllBytes($setup)
$sha = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash($bytes))
$size = $bytes.Length
$date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# No `.blockmap` beside it, on purpose: that is electron-builder's differential-download index, and
# without one the updater logs "Cannot download differentially, fallback to full download" and
# downloads the whole 3.5 MB file. Which is smaller than the blockmap of the installer it replaces.
@"
version: $version
files:
  - url: $name
    sha512: $sha
    size: $size
path: $name
sha512: $sha
releaseDate: '$date'
"@ | Set-Content -Path "$dist\latest.yml" -Encoding utf8 -NoNewline

"built    $name  ($([math]::Round($size / 1MB, 2)) MB)"
"feed     $dist\latest.yml  (version $version)"
""
"Publish with:"
"  gh release create v$version ""$setup"" ""$dist\latest.yml"" --repo arshit09/rovyl --title $version --notes-file <notes>"
""
"Every 1.x install picks this up on its next update check. Test it on a machine with 1.x on it"
"first: run the setup .exe by hand, or `"$name`" --updated /S --force-run for the silent path."
