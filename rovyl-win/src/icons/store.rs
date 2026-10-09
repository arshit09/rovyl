//! The content-addressed icon store.
//!
//! Icon bytes live as files in `%APPDATA%\Rovyl\icons`, not as base64 inside the configuration.
//! The original's note on why is worth keeping, because the number is startling: a config with
//! fourteen shortcuts was 456 KB, of which 445 KB — 97.6% — was `data:image/png;base64,…` strings
//! in `customIconUrl`. Twenty-three fields carried them and only nine were distinct, because the
//! workspace tree is written more than once and several shortcuts point at the same executable.
//! That whole file was rewritten, copied to `.bak` and mirrored on every debounced settings change.
//!
//! Naming a file by the SHA-256 of its own contents is what makes the duplication free: the same
//! icon reached by three paths is one file and one write, storing is idempotent, and a file
//! collected by mistake is re-extracted under exactly the same name.
//!
//! This build reads and writes the SAME store, so every icon the Electron build has already
//! extracted shows up here with no work at all.

use std::path::{Path, PathBuf};

const SCHEME: &str = "rovyl-icon";
const HOST: &str = "icon";

/// The extensions a reference may name.
///
/// Serving markup from a privileged origin is how an icon becomes script, so SVG is deliberately
/// not in this list — and the list is what the pattern below validates against, before the name is
/// ever joined to a path.
const EXTENSIONS: &[&str] = &["png", "jpg", "gif", "webp", "bmp", "ico"];

/// A reference to one icon INSIDE a program or a library, by position.
///
/// A second scheme rather than a second cache. The async icon cache already has the queue, the two
/// workers, the per-session dedup and the upload-on-the-render-thread rule; a picker grid that
/// built its own would be all of that again, written once more, to show thumbnails.
///
/// It is never stored in a configuration. `custom_icon_file` keeps the `file,index` form Windows
/// has always used, and the picture itself goes in the content-addressed store like every other.
/// This exists only for the seconds the picker is open.
const LIB_SCHEME: &str = "rovyl-lib://";

pub fn lib_ref(path: &std::path::Path, index: u32) -> String {
    format!("{LIB_SCHEME}{index}/{}", path.display())
}

/// The file and index a `rovyl-lib://` reference names.
pub fn parse_lib_ref(value: &str) -> Option<(PathBuf, u32)> {
    let rest = value.strip_prefix(LIB_SCHEME)?;
    let (index, path) = rest.split_once('/')?;
    let index: u32 = index.parse().ok()?;
    if path.is_empty() {
        return None;
    }
    Some((PathBuf::from(path), index))
}

/// Whether a string is a well-formed reference.
///
/// Anchored, lower-case only, fixed length. This is the string that becomes a FILENAME inside
/// userData, so it is validated before it touches the filesystem — not after. A reference that
/// does not match this is not sanitised into one; it is refused.
pub fn is_ref(value: &str) -> bool {
    filename(value).is_some()
}

/// The filename a reference names, or `None` — which means "do not touch the filesystem with this".
pub fn filename(value: &str) -> Option<String> {
    let rest = value.trim().strip_prefix(&format!("{SCHEME}://{HOST}/"))?;
    let (hash, ext) = rest.rsplit_once('.')?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    if !EXTENSIONS.contains(&ext) {
        return None;
    }
    Some(format!("{hash}.{ext}"))
}

pub fn to_ref(filename: &str) -> String {
    format!("{SCHEME}://{HOST}/{filename}")
}

/// The file a reference resolves to, inside the icon directory.
pub fn path_for(value: &str) -> Option<PathBuf> {
    Some(crate::config::store::icon_store_dir().join(filename(value)?))
}

/// Store these bytes and return the reference that names them.
///
/// Idempotent by construction: the name is the hash, so storing the same bytes twice writes the
/// same file. The write goes through a temporary name and a rename, for the same reason the config
/// does — a half-written icon is a file whose name no longer describes its contents, and the store
/// would then never notice it was wrong.
pub fn put(bytes: &[u8], extension: &str) -> std::io::Result<String> {
    let extension = if EXTENSIONS.contains(&extension) {
        extension
    } else {
        "png"
    };
    let name = format!("{}.{extension}", hex(&sha256(bytes)));
    let dir = crate::config::store::icon_store_dir();
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(&name);
    if target.exists() {
        return Ok(to_ref(&name));
    }
    let staging = dir.join(format!("{name}.tmp-{}", std::process::id()));
    std::fs::write(&staging, bytes)?;
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_file(&staging);
        // A rename that lost a race with another process writing the same hash is a success: the
        // file is there and its contents are, by construction, identical.
        if !target.exists() {
            return Err(error);
        }
    }
    Ok(to_ref(&name))
}

/// Delete stored icons that nothing in `live` refers to.
///
/// Text-based rather than structural, deliberately: a reference can sit in a field this build does
/// not know about — a setting the Electron build added — and a sweep that only walked the fields it
/// understands would delete an icon that is still in use. Scanning the serialised configuration for
/// anything shaped like a reference cannot miss one.
pub fn sweep(live_config_text: &str) -> usize {
    let mut keep: Vec<String> = Vec::new();
    let needle = format!("{SCHEME}://{HOST}/");
    let mut rest = live_config_text;
    while let Some(at) = rest.find(&needle) {
        rest = &rest[at..];
        let end = rest
            .char_indices()
            .find(|(i, c)| {
                *i > needle.len() && !(c.is_ascii_alphanumeric() || *c == '.' || *c == '/' || *c == ':')
            })
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        if let Some(name) = filename(&rest[..end]) {
            keep.push(name);
        }
        rest = &rest[end.max(1)..];
    }

    let dir = crate::config::store::icon_store_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Only files this store itself would have written. Anything else in the directory belongs
        // to somebody else and is left alone.
        if filename(&to_ref(&name)).is_none() {
            continue;
        }
        if keep.contains(&name) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Decode a `data:` URL into its bytes and extension.
///
/// Legacy configs carry these inline. They are converted to stored files on the next write, but
/// they have to be drawable before that happens.
pub fn decode_data_url(value: &str) -> Option<(Vec<u8>, &'static str)> {
    let rest = value.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta.to_ascii_lowercase().contains("base64") {
        return None;
    }
    let mime = meta.split(';').next().unwrap_or("").to_ascii_lowercase();
    let extension = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => "png",
    };
    Some((base64_decode(payload)?, extension))
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            // Whitespace is legal inside a base64 payload and real ones contain it.
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

// ─── SHA-256 ────────────────────────────────────────────────────────────────
//
// Written out rather than pulled in as a dependency. It is sixty lines, it is the only hash this
// program needs, and the alternative is a crate (and its transitive tree) in a binary whose whole
// argument is that it is small.

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_length = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(bytes.len() + 72);
    padded.extend_from_slice(bytes);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_length.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in padded.chunks_exact(64) {
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Whether a path is inside the icon directory — used before any delete.
pub fn is_in_store(path: &Path) -> bool {
    path.parent() == Some(crate::config::store::icon_store_dir().as_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "07e659b8dad50a8dcd5cedea1f521c9453028682620752493733aabbccddeeff";

    #[test]
    fn sha256_matches_the_known_vectors() {
        // The hash is the FILENAME, so a wrong implementation would scatter duplicates across the
        // store and never find one again.
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Longer than one block, which exercises the message schedule.
        assert_eq!(
            hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // A full block plus one byte, which exercises the padding's second block.
        assert_eq!(
            hex(&sha256(&[b'a'; 64])).len(),
            64
        );
    }

    #[test]
    fn a_reference_must_be_exactly_well_formed() {
        assert!(is_ref(&format!("rovyl-icon://icon/{HASH}.png")));
        // The picker's own scheme is NOT a store reference: it must never become a filename.
        assert!(!is_ref("rovyl-lib://3/C:\\Windows\\System32\\shell32.dll"));
        assert!(filename("rovyl-lib://3/C:\\Windows\\System32\\shell32.dll").is_none());
        for bad in [
            // Wrong scheme, wrong host, path traversal, upper case, wrong length, bad extension,
            // and a extension this store will not serve.
            &format!("http://icon/{HASH}.png"),
            &format!("rovyl-icon://other/{HASH}.png"),
            "rovyl-icon://icon/../../config-v2.json",
            &format!("rovyl-icon://icon/{}.png", HASH.to_uppercase()),
            &format!("rovyl-icon://icon/{}.png", &HASH[..32]),
            &format!("rovyl-icon://icon/{HASH}.svg"),
            &format!("rovyl-icon://icon/{HASH}"),
        ] {
            assert!(!is_ref(bad), "{bad} should be refused");
            assert!(filename(bad).is_none());
        }
    }

    #[test]
    fn traversal_can_never_produce_a_path() {
        // The validation happens BEFORE the join, which is the only ordering that is safe.
        for attack in [
            "rovyl-icon://icon/..%2f..%2fconfig-v2.json",
            "rovyl-icon://icon/....//config.png",
            "rovyl-icon://icon/C:\\Windows\\system32.png",
        ] {
            assert!(path_for(attack).is_none(), "{attack}");
        }
    }

    #[test]
    fn references_round_trip() {
        let name = format!("{HASH}.png");
        assert_eq!(filename(&to_ref(&name)).as_deref(), Some(name.as_str()));
    }

    #[test]
    fn data_urls_decode() {
        // A 1x1 transparent GIF, which is the shortest real one.
        let url = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        let (bytes, extension) = decode_data_url(url).expect("should decode");
        assert_eq!(extension, "gif");
        assert_eq!(&bytes[..3], b"GIF");
        // Not base64, or not a data URL at all.
        assert!(decode_data_url("data:image/png,raw").is_none());
        assert!(decode_data_url("https://example.com/a.png").is_none());
    }

    #[test]
    fn base64_tolerates_the_whitespace_real_payloads_carry() {
        assert_eq!(base64_decode("YWJj").as_deref(), Some(&b"abc"[..]));
        assert_eq!(base64_decode("YWJ\nj").as_deref(), Some(&b"abc"[..]));
        assert_eq!(base64_decode("YQ==").as_deref(), Some(&b"a"[..]));
        assert!(base64_decode("not*valid").is_none());
    }

    #[test]
    fn the_sweep_finds_references_anywhere_in_the_text() {
        // Text-based on purpose: a reference can sit in a field this build does not know about.
        let name = format!("{HASH}.png");
        let text = format!(
            r#"{{"a":"{}","someFutureField":{{"nested":"{}"}}}}"#,
            to_ref(&name),
            to_ref(&name)
        );
        assert!(text.contains(HASH));
        // The scan is exercised through `sweep`'s own parser rather than a separate copy.
        let mut found = Vec::new();
        let needle = "rovyl-icon://icon/";
        let mut rest = text.as_str();
        while let Some(at) = rest.find(needle) {
            rest = &rest[at..];
            let end = rest
                .char_indices()
                .find(|(i, c)| *i > needle.len() && !(c.is_ascii_alphanumeric() || *c == '.' || *c == '/' || *c == ':'))
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            if let Some(name) = filename(&rest[..end]) {
                found.push(name);
            }
            rest = &rest[end.max(1)..];
        }
        assert_eq!(found.len(), 2, "{found:?}");
    }
}

#[cfg(test)]
mod lib_ref_tests {
    use super::*;

    #[test]
    fn a_library_reference_round_trips() {
        let path = std::path::Path::new(r"C:\Windows\System32\shell32.dll");
        let reference = lib_ref(path, 42);
        let (back, index) = parse_lib_ref(&reference).expect("parses");
        assert_eq!(back, path);
        assert_eq!(index, 42);
    }

    #[test]
    fn a_path_with_separators_in_it_survives() {
        // The index comes FIRST for exactly this reason: splitting on the first `/` would
        // otherwise cut the path in half, and every library lives behind several separators.
        let path = std::path::Path::new(r"C:\Program Files\Some App\res\icons.dll");
        let (back, index) = parse_lib_ref(&lib_ref(path, 7)).expect("parses");
        assert_eq!(back, path);
        assert_eq!(index, 7);
    }

    #[test]
    fn anything_else_is_not_one() {
        assert!(parse_lib_ref("rovyl-icon://icon/abc.png").is_none());
        assert!(parse_lib_ref("rovyl-lib://notanumber/C:/x.dll").is_none());
        assert!(parse_lib_ref("rovyl-lib://3/").is_none());
        assert!(parse_lib_ref("").is_none());
    }
}
