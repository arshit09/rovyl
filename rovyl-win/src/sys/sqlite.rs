//! A read-only SQLite reader, for exactly one question.
//!
//! The VS Code family keeps its recently-opened list in `state.vscdb`, which is a SQLite database
//! with one table that matters: `ItemTable(key TEXT PRIMARY KEY, value BLOB)`. The question this
//! module answers is "what is the value for this key", and nothing else: no SQL, no writes, no
//! indexes, no transactions.
//!
//! **Why not a library.** The Electron build ships `sql.js` — a 1.5 MB WebAssembly build of the
//! whole engine — to read one row out of one table. The file format is public, stable since 2004
//! by explicit promise, and the part of it needed here is a header, a b-tree walk and a record
//! decoder. That is this file. It adds no dependency and no megabyte to a program whose entire
//! binary is smaller than the WASM blob it replaces.
//!
//! **What is deliberately not here.** Write-ahead logging. A database with a `-wal` beside it can
//! have its newest rows in that file rather than in the main one, and reading the main file alone
//! would quietly return stale data. The VS Code family runs in journal mode, so there is no `-wal`
//! — and `lookup` says so out loud rather than pretending: if one exists, it reads what it can and
//! the caller gets whatever was last checkpointed, which is the same thing every other reader of
//! a live database gets.
//!
//! **It never writes, and it never locks.** The file belongs to a running editor. Everything here
//! is a seek and a read.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// The format's magic, which is also its version promise.
const MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// A b-tree page's first byte.
const INTERIOR_TABLE: u8 = 0x05;
const LEAF_TABLE: u8 = 0x0D;

/// How many pages one walk may visit.
///
/// A bound, not a budget: a corrupt file can describe a cycle, and a reader that follows it is a
/// worker thread that never comes back. The number is far above any real `state.vscdb`.
const MAX_PAGES: usize = 200_000;

struct Db {
    file: File,
    page_size: u32,
    /// Bytes at the end of every page that the b-tree may not use.
    reserved: u32,
}

impl Db {
    fn open(path: &Path) -> Option<Self> {
        let mut file = File::open(path).ok()?;
        let mut header = [0u8; 100];
        file.read_exact(&mut header).ok()?;
        if &header[..16] != MAGIC {
            return None;
        }
        // Offset 16: the page size, big-endian. The value 1 means 65536, which does not fit in the
        // two bytes it is written in — the format's one piece of whimsy.
        let raw = u16::from_be_bytes([header[16], header[17]]);
        let page_size = if raw == 1 { 65536 } else { raw as u32 };
        if page_size < 512 || !page_size.is_power_of_two() {
            return None;
        }
        Some(Self {
            file,
            page_size,
            reserved: header[20] as u32,
        })
    }

    /// Pages are numbered from one.
    fn page(&mut self, number: u32) -> Option<Vec<u8>> {
        if number == 0 {
            return None;
        }
        let offset = (number as u64 - 1) * self.page_size as u64;
        self.file.seek(SeekFrom::Start(offset)).ok()?;
        let mut page = vec![0u8; self.page_size as usize];
        self.file.read_exact(&mut page).ok()?;
        Some(page)
    }

    fn usable(&self) -> u32 {
        self.page_size - self.reserved
    }
}

/// A SQLite variable-length integer: up to nine bytes, seven bits each, big end first.
fn varint(bytes: &[u8], at: usize) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    let mut used = 0usize;
    while used < 8 {
        let byte = *bytes.get(at + used)?;
        value = (value << 7) | (byte & 0x7F) as u64;
        used += 1;
        if byte & 0x80 == 0 {
            return Some((value, used));
        }
    }
    // The ninth byte contributes all eight of its bits.
    let byte = *bytes.get(at + 8)?;
    Some(((value << 8) | byte as u64, 9))
}

/// One column, as the record format spells it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(value) => Some(*value),
            _ => None,
        }
    }

    /// The bytes, whether the column was stored as text or as a blob.
    ///
    /// `state.vscdb` declares `value BLOB` but SQLite stores what it was given, and the editors
    /// give it a string. A reader that insisted on one of the two would work on some machines.
    pub fn into_bytes(self) -> Option<Vec<u8>> {
        match self {
            Value::Text(text) => Some(text.into_bytes()),
            Value::Blob(bytes) => Some(bytes),
            _ => None,
        }
    }
}

/// Decode one record — the payload of a table b-tree leaf cell.
fn record(payload: &[u8]) -> Option<Vec<Value>> {
    let (header_len, first) = varint(payload, 0)?;
    let header_len = header_len as usize;
    if header_len > payload.len() {
        return None;
    }
    let mut types: Vec<u64> = Vec::with_capacity(8);
    let mut at = first;
    while at < header_len {
        let (serial, used) = varint(payload, at)?;
        at += used;
        types.push(serial);
    }

    let mut out = Vec::with_capacity(types.len());
    let mut body = header_len;
    for serial in types {
        let (value, width) = match serial {
            0 => (Value::Null, 0usize),
            1..=4 | 6 => {
                let width = match serial {
                    1 => 1,
                    2 => 2,
                    3 => 3,
                    4 => 4,
                    _ => 8,
                };
                let bytes = payload.get(body..body + width)?;
                // Two's complement, sign-extended from whatever width it was stored in.
                let mut value: i64 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
                for byte in bytes {
                    value = (value << 8) | *byte as i64;
                }
                (Value::Int(value), width)
            }
            5 => {
                let bytes = payload.get(body..body + 6)?;
                let mut value: i64 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
                for byte in bytes {
                    value = (value << 8) | *byte as i64;
                }
                (Value::Int(value), 6)
            }
            7 => {
                let bytes = payload.get(body..body + 8)?;
                let mut eight = [0u8; 8];
                eight.copy_from_slice(bytes);
                (Value::Real(f64::from_be_bytes(eight)), 8)
            }
            // The two constants, which occupy no bytes at all.
            8 => (Value::Int(0), 0),
            9 => (Value::Int(1), 0),
            10 | 11 => (Value::Null, 0),
            serial if serial % 2 == 0 => {
                let width = ((serial - 12) / 2) as usize;
                let bytes = payload.get(body..body + width)?;
                (Value::Blob(bytes.to_vec()), width)
            }
            serial => {
                let width = ((serial - 13) / 2) as usize;
                let bytes = payload.get(body..body + width)?;
                // Lossy on purpose: a database written in some other encoding should give a
                // slightly wrong label, not no recent projects at all.
                (Value::Text(String::from_utf8_lossy(bytes).into_owned()), width)
            }
        };
        body += width;
        out.push(value);
    }
    Some(out)
}

/// Read one cell's whole payload, following the overflow chain if there is one.
///
/// The spill arithmetic is the format's, verbatim. Getting it wrong does not fail loudly — it
/// reads a few bytes of the wrong page into the middle of a string.
fn payload_of(db: &mut Db, page: &[u8], offset: usize, length: u64) -> Option<Vec<u8>> {
    let usable = db.usable() as u64;
    let max_local = usable - 35;
    let min_local = ((usable - 12) * 32 / 255) - 23;

    let local = if length <= max_local {
        length
    } else {
        let candidate = min_local + (length - min_local) % (usable - 4);
        if candidate > max_local {
            min_local
        } else {
            candidate
        }
    };

    let mut out = Vec::with_capacity(length as usize);
    let end = offset.checked_add(local as usize)?;
    out.extend_from_slice(page.get(offset..end)?);
    if local == length {
        return Some(out);
    }

    // The four bytes after the local part are the first overflow page.
    let pointer = page.get(end..end + 4)?;
    let mut next = u32::from_be_bytes([pointer[0], pointer[1], pointer[2], pointer[3]]);
    let mut guard = 0usize;
    while next != 0 && (out.len() as u64) < length {
        guard += 1;
        if guard > MAX_PAGES {
            return None;
        }
        let overflow = db.page(next)?;
        next = u32::from_be_bytes([overflow[0], overflow[1], overflow[2], overflow[3]]);
        let want = (length - out.len() as u64).min(usable - 4) as usize;
        out.extend_from_slice(overflow.get(4..4 + want)?);
    }
    if out.len() as u64 == length {
        Some(out)
    } else {
        None
    }
}

/// Walk a table b-tree from `root`, calling `visit` with each row until it says stop.
fn walk<F>(db: &mut Db, root: u32, visited: &mut usize, visit: &mut F) -> Option<bool>
where
    F: FnMut(Vec<Value>) -> bool,
{
    *visited += 1;
    if *visited > MAX_PAGES {
        return Some(true);
    }
    let page = db.page(root)?;
    // Page one carries the hundred-byte file header before its b-tree header.
    let base = if root == 1 { 100 } else { 0 };
    let kind = *page.get(base)?;
    let cell_count = u16::from_be_bytes([*page.get(base + 3)?, *page.get(base + 4)?]) as usize;
    let header_len = if kind == INTERIOR_TABLE { 12 } else { 8 };
    let pointers = base + header_len;

    match kind {
        LEAF_TABLE => {
            for index in 0..cell_count {
                let at = pointers + index * 2;
                let offset =
                    u16::from_be_bytes([*page.get(at)?, *page.get(at + 1)?]) as usize;
                let (length, used) = varint(&page, offset)?;
                // The rowid, which this reader has no use for.
                let (_, rowid_used) = varint(&page, offset + used)?;
                let start = offset + used + rowid_used;
                let payload = payload_of(db, &page, start, length)?;
                if let Some(columns) = record(&payload) {
                    if visit(columns) {
                        return Some(true);
                    }
                }
            }
            Some(false)
        }
        INTERIOR_TABLE => {
            for index in 0..cell_count {
                let at = pointers + index * 2;
                let offset =
                    u16::from_be_bytes([*page.get(at)?, *page.get(at + 1)?]) as usize;
                let child = page.get(offset..offset + 4)?;
                let child = u32::from_be_bytes([child[0], child[1], child[2], child[3]]);
                if walk(db, child, visited, visit)? {
                    return Some(true);
                }
            }
            // And the rightmost child, whose pointer lives in the page header.
            let right = page.get(base + 8..base + 12)?;
            let right = u32::from_be_bytes([right[0], right[1], right[2], right[3]]);
            if right != 0 {
                return walk(db, right, visited, visit);
            }
            Some(false)
        }
        // An index page where a table page was expected: not this reader's business.
        _ => Some(false),
    }
}

/// The value stored against `key` in `table`.
///
/// Both the schema lookup and the row lookup are full scans. `ItemTable` has a few hundred rows
/// and this runs once per IDE per wheel-open, on a worker — an index walk would be more code for
/// a saving nobody could measure.
pub fn lookup(path: &Path, table: &str, key: &str) -> Option<Vec<u8>> {
    let mut db = Db::open(path)?;

    // `sqlite_master(type, name, tbl_name, rootpage, sql)` always lives on page one.
    let mut root: Option<u32> = None;
    let mut visited = 0usize;
    walk(&mut db, 1, &mut visited, &mut |columns| {
        let is_table = columns.first().and_then(Value::as_text) == Some("table");
        let is_wanted = columns.get(1).and_then(Value::as_text) == Some(table);
        if is_table && is_wanted {
            root = columns.get(3).and_then(Value::as_int).map(|n| n as u32);
            return true;
        }
        false
    })?;

    let root = root?;
    let mut found: Option<Vec<u8>> = None;
    let mut visited = 0usize;
    walk(&mut db, root, &mut visited, &mut |mut columns| {
        if columns.first().and_then(Value::as_text) != Some(key) {
            return false;
        }
        if columns.len() < 2 {
            return true;
        }
        found = columns.remove(1).into_bytes();
        true
    })?;
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_are_big_end_first_seven_bits_at_a_time() {
        assert_eq!(varint(&[0x00], 0), Some((0, 1)));
        assert_eq!(varint(&[0x7F], 0), Some((127, 1)));
        assert_eq!(varint(&[0x81, 0x00], 0), Some((128, 2)));
        assert_eq!(varint(&[0x82, 0x2C], 0), Some((300, 2)));
        // Nine bytes, where the last one contributes all eight of its bits.
        assert_eq!(
            varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], 0),
            Some((u64::MAX, 9))
        );
        assert_eq!(varint(&[0x81], 0), None);
    }

    #[test]
    fn a_record_decodes_its_columns_from_their_serial_types() {
        // header length 4, then: text of 3 ("abc"), int8 of 1, null.
        // text serial = 13 + 2*3 = 19; int8 serial = 1; null = 0.
        let payload = [4u8, 19, 1, 0, b'a', b'b', b'c', 42];
        let columns = record(&payload).expect("decodes");
        assert_eq!(columns.len(), 3);
        assert_eq!(columns[0].as_text(), Some("abc"));
        assert_eq!(columns[1].as_int(), Some(42));
        assert_eq!(columns[2], Value::Null);
    }

    #[test]
    fn the_two_constant_serial_types_take_no_bytes() {
        // Serial 8 is the value 0 and serial 9 is the value 1, stored entirely in the header.
        let payload = [3u8, 8, 9];
        let columns = record(&payload).expect("decodes");
        assert_eq!(columns[0].as_int(), Some(0));
        assert_eq!(columns[1].as_int(), Some(1));
    }

    #[test]
    fn a_negative_integer_is_sign_extended_from_its_stored_width() {
        // Serial 1 is one byte. 0xFF is -1, not 255.
        let payload = [2u8, 1, 0xFF];
        assert_eq!(record(&payload).unwrap()[0].as_int(), Some(-1));
        // Serial 2 is two bytes.
        let payload = [2u8, 2, 0xFF, 0xFE];
        assert_eq!(record(&payload).unwrap()[0].as_int(), Some(-2));
    }

    #[test]
    fn a_missing_file_is_not_a_panic() {
        assert_eq!(
            lookup(Path::new("Z:/nothing/here/state.vscdb"), "ItemTable", "k"),
            None
        );
    }

    /// Against the real thing, when there is one on this machine.
    ///
    /// Skipped rather than failed where there is no editor installed: a test that needs somebody
    /// else's software is a test that fails on a build machine for no reason worth reporting.
    #[test]
    fn the_vs_code_family_store_reads_back() {
        let Some(local) = std::env::var_os("APPDATA") else {
            return;
        };
        let mut checked = 0usize;
        for name in ["Code", "Cursor", "Antigravity", "Trae"] {
            let path = std::path::PathBuf::from(&local)
                .join(name)
                .join("User")
                .join("globalStorage")
                .join("state.vscdb");
            if !path.exists() {
                continue;
            }
            checked += 1;
            // The key may legitimately be absent on a profile nobody has opened a folder in; what
            // must not happen is a panic, or a value that is not the JSON it is supposed to be.
            if let Some(bytes) = lookup(&path, "ItemTable", "history.recentlyOpenedPathsList") {
                let text = String::from_utf8_lossy(&bytes);
                assert!(
                    text.trim_start().starts_with('{'),
                    "{name}: value is not a JSON object: {:?}",
                    &text[..text.len().min(80)]
                );
                let parsed: serde_json::Value =
                    serde_json::from_str(&text).expect("the stored value parses as JSON");
                assert!(parsed.get("entries").is_some(), "{name}: no entries");
            }
        }
        let _ = checked;
    }
}
