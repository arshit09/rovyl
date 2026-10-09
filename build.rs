//! Build-time glue: the link flags that shape the executable, and the resources inside it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

fn main() {
    // GUI subsystem: no console window ever flashes. Set here rather than with a
    // `#![windows_subsystem]` attribute so a debug build can still be run from a
    // terminal with the same binary shape as release.
    println!("cargo:rustc-link-arg-bins=/SUBSYSTEM:WINDOWS");
    println!("cargo:rustc-link-arg-bins=/ENTRY:mainCRTStartup");
    link_resources();
}

/// Compile `rovyl.rc` and hand the result to the linker.
///
/// Cargo has no notion of a resource script, so without this step the `.rc` file sits next to the
/// source doing nothing and the executable ships with no `.rsrc` section at all — which means no
/// icon anywhere the shell looks for one: not in Explorer, not in the taskbar, and not in the
/// notification area, where `LoadImageW` then hands back nothing and the shell draws a blank
/// placeholder in its place.
fn link_resources() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest.join("rovyl.rc");
    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed={}", manifest.join("build/icon.ico").display());

    let compiled = PathBuf::from(env::var("OUT_DIR").unwrap()).join("rovyl.res");
    let Some(compiler) = find_resource_compiler() else {
        println!(
            "cargo:warning=no resource compiler found (rc.exe from the Windows SDK, or llvm-rc on \
             PATH); rovyl.exe will be built without its icon"
        );
        return;
    };

    // The script names its icon by a path relative to the manifest, so that is where it is run
    // from. `-` rather than `/` for the switches: both are accepted, and the slash form is rewritten
    // into a path by some POSIX shells on Windows before it ever reaches the compiler.
    let output = Command::new(&compiler)
        .current_dir(&manifest)
        .arg("-nologo")
        .arg("-fo")
        .arg(&compiled)
        .arg(&script)
        .output();

    match output {
        Ok(result) if result.status.success() => {
            // The MSVC linker takes a `.res` as an input file like any object.
            println!("cargo:rustc-link-arg-bins={}", compiled.display());
        }
        Ok(result) => {
            let message = String::from_utf8_lossy(&result.stderr)
                .lines()
                .chain(String::from_utf8_lossy(&result.stdout).lines())
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            println!(
                "cargo:warning={} failed on rovyl.rc ({}): {message}",
                compiler.display(),
                result.status
            );
        }
        Err(error) => {
            println!("cargo:warning=could not run {}: {error}", compiler.display());
        }
    }
}

/// Find a resource compiler, preferring the Windows SDK's `rc.exe`.
///
/// `rc.exe` lives in the SDK rather than next to `link.exe`, so it is on `PATH` only inside a
/// Visual Studio developer prompt — a plain `cargo build` has to go looking for it. The search
/// mirrors the order of trust: an explicit override, then `PATH`, then the SDK the current
/// toolchain is already linking against, then the newest SDK installed.
fn find_resource_compiler() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("RC").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    println!("cargo:rerun-if-env-changed=RC");

    on_path("rc.exe")
        .or_else(|| sdk_from_lib_paths().and_then(|bin| newest_rc(&bin)))
        .or_else(installed_sdk_rc)
        // llvm-rc understands the same `-fo input` shape and ships with LLVM, which is the usual
        // fallback on a machine with the Rust MSVC toolchain but no full SDK bin directory.
        .or_else(|| on_path("llvm-rc.exe"))
}

fn on_path(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// Derive the SDK's `bin` directory from the `LIB` the toolchain was configured with.
///
/// A developer prompt puts `...\Windows Kits\10\Lib\10.0.26100.0\um\x64` on `LIB`. That names the
/// exact kit root the linker is using, so the `rc.exe` found through it is the matching one rather
/// than merely the newest.
fn sdk_from_lib_paths() -> Option<PathBuf> {
    for entry in env::split_paths(&env::var_os("LIB").unwrap_or_default()) {
        let mut parts = entry.components().collect::<Vec<_>>();
        // Walk up from `<root>/Lib/<version>/um/<arch>` to `<root>`, then down into `bin`.
        while let Some(last) = parts.pop() {
            if last.as_os_str().eq_ignore_ascii_case("Lib") {
                let root: PathBuf = parts.iter().collect();
                let bin = root.join("bin");
                if bin.is_dir() {
                    return Some(bin);
                }
                break;
            }
        }
    }
    None
}

/// The newest `rc.exe` under any installed Windows Kit.
fn installed_sdk_rc() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|variable| env::var_os(variable))
        .map(|program_files| Path::new(&program_files).join("Windows Kits").join("10").join("bin"))
        .find_map(|bin| newest_rc(&bin))
}

/// Pick `rc.exe` out of an SDK `bin` directory, newest version first.
///
/// The layout is `bin/<version>/<arch>/rc.exe` on current kits and `bin/<arch>/rc.exe` or
/// `bin/rc.exe` on older ones, so all three are tried.
fn newest_rc(bin: &Path) -> Option<PathBuf> {
    let mut versions: Vec<(Vec<u64>, PathBuf)> = fs::read_dir(bin)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            // Only the version directories, so `arm64` and friends do not sort in as version zero.
            let parsed: Option<Vec<u64>> = name.split('.').map(|part| part.parse().ok()).collect();
            Some((parsed?, path))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));

    let plain = [bin.to_path_buf()];
    versions
        .iter()
        .map(|(_, path)| path.clone())
        .chain(plain)
        .find_map(|directory| {
            host_architectures()
                .iter()
                .map(|arch| directory.join(arch).join("rc.exe"))
                .chain(std::iter::once(directory.join("rc.exe")))
                .find(|candidate| candidate.is_file())
        })
}

/// SDK `bin` subdirectory names to try, the host's own first.
///
/// `rc.exe` emits a machine-independent `.res`, so a mismatched build of the compiler still
/// produces the right output — which is why x64 and x86 stay in the list as fallbacks.
fn host_architectures() -> Vec<OsString> {
    let host = env::var("HOST").unwrap_or_default();
    let native = if host.starts_with("aarch64") {
        "arm64"
    } else if host.starts_with("i686") || host.starts_with("i586") {
        "x86"
    } else {
        "x64"
    };
    let mut order = vec![OsString::from(native)];
    order.extend(
        ["x64", "x86", "arm64"]
            .iter()
            .filter(|arch| **arch != native)
            .map(OsString::from),
    );
    order
}
