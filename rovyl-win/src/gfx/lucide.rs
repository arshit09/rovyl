//! Glyph lookup and geometry caching.
//!
//! A glyph is parsed from its path string into an `ID2D1PathGeometry` the first time it is drawn
//! and kept for the session. The cache is keyed by NAME and not by name-and-size, because the
//! geometry is built in the glyph's own 24-unit box and scaled by the transform at draw time: one
//! geometry serves a 24px dock icon and a 64px tile. Caching per size would mean re-parsing every
//! glyph whenever the icon-size slider moved.

use super::lucide_data::{GLYPHS, VIEWBOX};
use super::path;
use std::cell::RefCell;
use std::collections::HashMap;
use windows::Win32::Graphics::Direct2D::{ID2D1Factory1, ID2D1PathGeometry1};

/// What gets drawn when a name does not resolve.
///
/// `Box` — a plain cube. It reads as "something, unidentified" rather than as a wrong answer,
/// which is what a more specific fallback (a question mark, a broken-image glyph) would be: most
/// unresolved names are a config written by a newer build, and the item itself is perfectly good.
pub const FALLBACK: &str = "Box";

/// The path data for a glyph name, accepting Lucide's alias spellings.
///
/// Lucide exports every glyph three times — `Globe`, `GlobeIcon`, `LucideGlobe` — and the icon
/// picker in older releases listed all three, so a config written by any earlier version can hold
/// any of them. Stripping the affix is total and collision-free in 0.292: every one of the 1,353
/// aliases strips to an existing name that is the identical glyph, and no canonical name carries
/// either affix.
pub fn path_data(name: &str) -> Option<&'static str> {
    if let Some(found) = exact(name) {
        return Some(found);
    }
    if let Some(stem) = name.strip_prefix("Lucide") {
        return exact(stem);
    }
    if let Some(stem) = name.strip_suffix("Icon") {
        return exact(stem);
    }
    // Spellings the original mapped by hand, because Lucide renamed the glyph between releases and
    // configs written against the old name have to keep working.
    let aliased = match name {
        "CurlyBraces" => "Braces",
        "Edit3" => "PenLine",
        "Grid" | "Grid3X3" => "Grid3x3",
        "Grid2X2" => "Grid2x2",
        "Sidebar" => "PanelLeft",
        "SidebarClose" => "PanelLeftClose",
        "Stars" => "Sparkles",
        _ => return None,
    };
    exact(aliased)
}

fn exact(name: &str) -> Option<&'static str> {
    GLYPHS
        .binary_search_by(|(key, _)| (*key).cmp(name))
        .ok()
        .map(|at| GLYPHS[at].1)
}

/// Whether a name draws as itself rather than as the fallback. Used by the icon picker's search,
/// which must not offer a name that resolves to a cube.
pub fn exists(name: &str) -> bool {
    path_data(name).is_some()
}

/// Every canonical name, for the picker.
///
/// Not one name per glyph: a handful also have a human-readable synonym that survives on purpose
/// (`PanelLeft`/`Sidebar`, `Sparkles`/`Stars`). They are worth the duplicate cell — collapsing by
/// geometry would silently delete the word a user is searching for.
pub fn names() -> impl Iterator<Item = &'static str> {
    GLYPHS.iter().map(|(name, _)| *name)
}

/// Glyph geometries, built on demand.
pub struct GlyphCache {
    /// Keyed by the name as RESOLVED, so the three spellings of one glyph share an entry.
    geometries: RefCell<HashMap<&'static str, ID2D1PathGeometry1>>,
}

impl GlyphCache {
    pub fn new() -> Self {
        Self {
            geometries: RefCell::new(HashMap::with_capacity(64)),
        }
    }

    /// The geometry for `name`, in the glyph's own 24-unit box, or the fallback's.
    ///
    /// `None` only when D2D refuses to build a geometry at all, which means the device is lost —
    /// the caller is already abandoning the frame in that case.
    pub fn geometry(&self, factory: &ID2D1Factory1, name: &str) -> Option<ID2D1PathGeometry1> {
        let data = path_data(name).or_else(|| path_data(FALLBACK))?;
        // The key is the DATA pointer's name, resolved: `GlobeIcon` and `Globe` are one entry.
        let key = resolved_key(name).unwrap_or(FALLBACK);
        if let Some(found) = self.geometries.borrow().get(key) {
            return Some(found.clone());
        }
        let geometry = build(factory, data)?;
        self.geometries
            .borrow_mut()
            .insert(key, geometry.clone());
        Some(geometry)
    }

    /// Drop everything. Called on device loss, where every cached geometry belongs to a factory
    /// that no longer exists.
    pub fn clear(&self) {
        self.geometries.borrow_mut().clear();
    }

    pub fn len(&self) -> usize {
        self.geometries.borrow().len()
    }
}

impl Default for GlyphCache {
    fn default() -> Self {
        Self::new()
    }
}

/// The canonical name a spelling resolves to, so the cache does not hold three entries for one
/// glyph.
fn resolved_key(name: &str) -> Option<&'static str> {
    let find = |n: &str| {
        GLYPHS
            .binary_search_by(|(key, _)| (*key).cmp(n))
            .ok()
            .map(|at| GLYPHS[at].0)
    };
    find(name)
        .or_else(|| name.strip_prefix("Lucide").and_then(find))
        .or_else(|| name.strip_suffix("Icon").and_then(find))
        .or_else(|| {
            let aliased = match name {
                "CurlyBraces" => "Braces",
                "Edit3" => "PenLine",
                "Grid" | "Grid3X3" => "Grid3x3",
                "Grid2X2" => "Grid2x2",
                "Sidebar" => "PanelLeft",
                "SidebarClose" => "PanelLeftClose",
                "Stars" => "Sparkles",
                _ => return None,
            };
            find(aliased)
        })
}

fn build(factory: &ID2D1Factory1, data: &str) -> Option<ID2D1PathGeometry1> {
    unsafe {
        let geometry = factory.CreatePathGeometry().ok()?;
        let sink = geometry.Open().ok()?;
        // Built at unit scale in the glyph's own box: the draw-time transform does the sizing, so
        // one geometry serves every size the glyph is ever drawn at.
        path::build(&sink, data, 1.0, (0.0, 0.0));
        sink.Close().ok()?;
        Some(geometry)
    }
}

/// The stroke weight a glyph is drawn at, in its own 24-unit box, for a given on-screen size.
///
/// A monochrome glyph has no colour of its own holding it up: legibility comes entirely from the
/// stroke, so a wheel tile's is heavier than Lucide's own default of 2 would give at that scale.
/// The weight is expressed in glyph units and scaled with everything else, which is what keeps a
/// 24px dock icon and a 64px tile reading as the same drawing — a constant pixel weight would make
/// the small one look like a different, bolder icon.
pub fn stroke_weight(nominal: f32) -> f32 {
    nominal * (VIEWBOX / VIEWBOX)
}


// ── Searching for a glyph ───────────────────────────────────────────────────

/// Does a keyword answer to what was typed?
///
/// The original's three rules, and the length cases are the whole of it: one character expands to
/// nothing, because `a` is inside half the table and the grid would be noise; two characters match
/// a keyword that STARTS that way, so `ph` reaches `phone` without also reaching `graph`; and from
/// three characters a substring is allowed, so `ettings` still finds `settings`.
fn keyword_answers(keyword: &str, token: &str) -> bool {
    if token.is_empty() || keyword.is_empty() {
        return false;
    }
    if keyword == token {
        return true;
    }
    match token.chars().count() {
        1 => false,
        2 => keyword.starts_with(token),
        _ => keyword.starts_with(token) || keyword.contains(token),
    }
}

/// The glyphs to offer for what has been typed, best first.
///
/// Two passes, in this order and not merged, because the order IS the answer: a name that contains
/// the term is what somebody typing a name meant, and the keyword matches are the help offered to
/// somebody who was typing English instead. Merging them would bury `Clock` under whatever
/// `time` happens to expand to.
///
/// 1. Glyphs whose NAME contains the term.
/// 2. Glyphs any matching KEYWORD offers, in the table's order — which is its own best-first.
///
/// Repeats are dropped, keeping the earlier position. A name that already matched does not come
/// back lower down because a keyword also names it.
pub fn search(term: &str, limit: usize) -> Vec<&'static str> {
    let term = term.trim().to_lowercase();
    if term.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<&'static str> = Vec::new();
    let push = |name: &'static str, out: &mut Vec<&'static str>| {
        if out.len() < limit && !out.contains(&name) {
            out.push(name);
        }
    };

    for name in names() {
        if name.to_lowercase().contains(&term) {
            push(name, &mut out);
        }
    }
    if out.len() >= limit {
        return out;
    }

    // Every word that was typed, so "video call" reaches both — the original's `tokens` argument,
    // which it always filled from a split on whitespace.
    for token in term.split_whitespace() {
        for (keyword, icons) in super::icon_keywords::KEYWORDS {
            if !keyword_answers(keyword, token) {
                continue;
            }
            for name in *icons {
                // A keyword may name a glyph this build does not draw — the table comes from the
                // other build, and the two track Lucide separately. Offering one would put a cube
                // in the grid, which reads as a broken icon rather than a missing one.
                if let Some(canonical) = canonical_name(name) {
                    push(canonical, &mut out);
                }
            }
        }
    }
    out
}

/// A name as this build spells it, or `None` if it does not draw.
///
/// The table's names are matched against the glyph list rather than used directly, so what the
/// picker stores is always a name `path_data` answers to.
fn canonical_name(name: &str) -> Option<&'static str> {
    names().find(|candidate| *candidate == name).or_else(|| {
        // An alias (`Stars` for `Sparkles`) resolves to the same path, and the picker is happy
        // with either — but only a name in the list can be returned with a static lifetime.
        exists(name)
            .then(|| names().find(|candidate| path_data(candidate) == path_data(name)))
            .flatten()
    })
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn found(term: &str) -> Vec<&'static str> {
        search(term, 84)
    }

    #[test]
    fn plain_english_finds_glyphs_that_are_not_called_that() {
        // The three the picker was useless for before: none of these is a Lucide name.
        assert!(found("time").contains(&"Clock"), "{:?}", found("time"));
        assert!(found("music").contains(&"Music"));
        assert!(found("internet").contains(&"Globe"), "{:?}", found("internet"));
        assert!(found("work").contains(&"Briefcase"));
        assert!(found("money").contains(&"Wallet") || found("money").contains(&"CreditCard"));
    }

    #[test]
    fn a_name_that_matches_comes_before_what_the_word_merely_means() {
        // Somebody typing a name is not asking for suggestions. `Timer` is a name containing
        // "timer"; the keyword `timer` also offers `Hourglass` and `Clock`, and those belong
        // after it rather than above it.
        let hits = found("timer");
        let timer = hits.iter().position(|name| *name == "Timer");
        let hourglass = hits.iter().position(|name| *name == "Hourglass");
        assert!(timer.is_some(), "{hits:?}");
        if let (Some(a), Some(b)) = (timer, hourglass) {
            assert!(a < b, "a name match must outrank a keyword match: {hits:?}");
        }
    }

    #[test]
    fn one_letter_expands_to_nothing() {
        // `a` is inside half the keywords, and a grid built from that is noise. Name matching
        // still works — the rule is about the keyword table, not about the search.
        let hits = found("a");
        assert!(!hits.is_empty(), "name matching still applies");
        // `work` is reachable by keyword and no glyph is called `a`-something that it offers.
        assert!(!keyword_answers("work", "a"));
        assert!(!keyword_answers("alarm", "a"));
    }

    #[test]
    fn two_letters_match_the_start_and_three_match_anywhere() {
        // The difference is what keeps `ph` out of `graph`.
        assert!(keyword_answers("phone", "ph"));
        assert!(!keyword_answers("graph", "ph"));
        assert!(keyword_answers("graph", "rap"));
        assert!(keyword_answers("settings", "ettings"));
        // An exact match is always one, whatever the length.
        assert!(keyword_answers("a", "a"));
    }

    #[test]
    fn nothing_offered_is_a_glyph_this_build_cannot_draw() {
        // The table comes from the other build and the two track Lucide separately. A name it has
        // and this one does not would draw the fallback cube, which reads as a broken icon.
        for term in ["time", "music", "work", "code", "game", "food", "weather", "travel"] {
            for name in found(term) {
                assert!(exists(name), "{term} offered {name}, which does not draw");
            }
        }
    }

    #[test]
    fn every_keyword_in_the_table_offers_something() {
        // A keyword whose icons this build has all dropped is a word that silently does nothing.
        // Not an assertion that every name resolves — the two builds may differ — but that no
        // keyword has been left answering with an empty grid.
        let mut dead = Vec::new();
        for (keyword, _) in super::super::icon_keywords::KEYWORDS {
            if search(keyword, 84).is_empty() {
                dead.push(*keyword);
            }
        }
        assert!(dead.is_empty(), "keywords that find nothing: {dead:?}");
    }

    #[test]
    fn the_table_is_sorted_and_free_of_repeats() {
        // The generator sorts it; this is what notices if a hand edit does not.
        let keywords: Vec<&str> = super::super::icon_keywords::KEYWORDS
            .iter()
            .map(|(k, _)| *k)
            .collect();
        let mut sorted = keywords.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(keywords, sorted, "KEYWORDS must be sorted with no repeats");
    }

    #[test]
    fn the_limit_is_honoured_and_nothing_appears_twice() {
        let hits = search("file", 5);
        assert!(hits.len() <= 5);
        let mut seen = hits.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), hits.len(), "{hits:?}");
        assert!(search("   ", 84).is_empty());
    }

    #[test]
    fn several_words_reach_what_each_of_them_means() {
        // "video call" is two keywords, and somebody typing it means both.
        let hits = found("video call");
        assert!(hits.iter().any(|n| *n == "Video" || *n == "Film"), "{hits:?}");
        assert!(hits.iter().any(|n| *n == "Phone" || *n == "PhoneCall"), "{hits:?}");
    }
}

#[cfg(test)]
mod extent_tests {
    //! Does every glyph stay inside the box it was drawn in?
    //!
    //! This exists because 481 of the 1353 did not, and nothing noticed for weeks. Lucide ships
    //! each icon as several `<path>` elements, and each one starts with the current point at the
    //! ORIGIN — so a leading lowercase `m` means the same as `M`. The generator concatenated the
    //! strings without saying so, which made every subpath after the first relative to wherever
    //! the previous one happened to end. `X` came out as two parallel strokes instead of a cross.
    //!
    //! The walker below is deliberately a SECOND implementation, not a call into `gfx::path`: the
    //! thing under test is the data, and a test that asks the renderer whether the data is good
    //! agrees with it about any assumption the two happen to share.

    /// Lucide draws in a 24×24 viewBox. The slack is for the handful of glyphs whose stroke caps
    /// are meant to sit on the edge, and for arcs whose endpoint rounds a hair outside.
    const LOW: f32 = -2.0;
    const HIGH: f32 = 26.0;

    /// Every point the pen is ever put at, following the SVG endpoint rules.
    fn endpoints(data: &str) -> Vec<(f32, f32)> {
        let bytes = data.as_bytes();
        let mut at = 0usize;
        let (mut x, mut y) = (0.0f32, 0.0f32);
        let (mut sx, mut sy) = (0.0f32, 0.0f32);
        let mut command = b' ';
        let mut out = Vec::new();

        let skip = |at: &mut usize| {
            while *at < bytes.len() && matches!(bytes[*at], b' ' | b',' | b'\t' | b'\n' | b'\r') {
                *at += 1;
            }
        };
        // One number, in the forms SVG actually uses: `3`, `-1.5`, `.5`, `1e-3`.
        let number = |at: &mut usize| -> Option<f32> {
            skip(at);
            let start = *at;
            if *at < bytes.len() && matches!(bytes[*at], b'+' | b'-') {
                *at += 1;
            }
            while *at < bytes.len() && (bytes[*at].is_ascii_digit() || bytes[*at] == b'.') {
                *at += 1;
            }
            if *at < bytes.len() && matches!(bytes[*at], b'e' | b'E') {
                *at += 1;
                if *at < bytes.len() && matches!(bytes[*at], b'+' | b'-') {
                    *at += 1;
                }
                while *at < bytes.len() && bytes[*at].is_ascii_digit() {
                    *at += 1;
                }
            }
            if *at == start {
                return None;
            }
            data[start..*at].parse().ok()
        };

        loop {
            skip(&mut at);
            if at >= bytes.len() {
                break;
            }
            if bytes[at].is_ascii_alphabetic() {
                command = bytes[at];
                at += 1;
                // An implicit repeat of a moveto is a LINE, which is the one asymmetry in the
                // grammar and the one a naive reader gets wrong.
            } else if command == b' ' {
                break;
            }

            let relative = command.is_ascii_lowercase();
            let (ox, oy) = if relative { (x, y) } else { (0.0, 0.0) };

            match command.to_ascii_uppercase() {
                b'Z' => {
                    x = sx;
                    y = sy;
                    out.push((x, y));
                    command = b' ';
                    continue;
                }
                b'M' => {
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                    sx = x;
                    sy = y;
                    command = if relative { b'l' } else { b'L' };
                }
                b'L' => {
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                }
                b'H' => {
                    let Some(a) = number(&mut at) else { break };
                    x = a + ox;
                }
                b'V' => {
                    let Some(a) = number(&mut at) else { break };
                    y = a + oy;
                }
                b'C' => {
                    for _ in 0..2 {
                        if number(&mut at).is_none() || number(&mut at).is_none() {
                            return out;
                        }
                    }
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                }
                b'S' | b'Q' => {
                    if number(&mut at).is_none() || number(&mut at).is_none() {
                        return out;
                    }
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                }
                b'T' => {
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                }
                b'A' => {
                    // rx ry rotation large-arc sweep x y. The two flags are SINGLE CHARACTERS and
                    // may be written with no separator at all -- `a1 1 0 005 0` is five tokens,
                    // not three. Reading them as numbers swallows the endpoint, which is how a
                    // reader of this grammar ends up believing half the icon set is off-canvas.
                    for _ in 0..3 {
                        if number(&mut at).is_none() {
                            return out;
                        }
                    }
                    for _ in 0..2 {
                        skip(&mut at);
                        if at >= bytes.len() || !matches!(bytes[at], b'0' | b'1') {
                            return out;
                        }
                        at += 1;
                    }
                    let (Some(a), Some(b)) = (number(&mut at), number(&mut at)) else { break };
                    x = a + ox;
                    y = b + oy;
                }
                _ => break,
            }
            out.push((x, y));
        }
        out
    }

    #[test]
    fn the_walker_agrees_with_the_grammar() {
        // An implicit repeat after a moveto is a line, not another move.
        assert_eq!(endpoints("M18 6 6 18"), vec![(18.0, 6.0), (6.0, 18.0)]);
        // Two absolute subpaths: the second is where it says it is.
        assert_eq!(
            endpoints("M18 6 6 18M6 6 12 12"),
            vec![(18.0, 6.0), (6.0, 18.0), (6.0, 6.0), (12.0, 12.0)]
        );
        // And the bug: the same shape written with a relative second subpath lands elsewhere.
        assert_eq!(
            endpoints("M18 6 6 18m6 6 12 12"),
            vec![(18.0, 6.0), (6.0, 18.0), (12.0, 24.0), (24.0, 36.0)]
        );
    }

    #[test]
    fn x_is_a_cross() {
        // The glyph that gave the bug away. Two strokes that actually cross: one from the
        // top-right to the bottom-left, one from the top-left to the bottom-right.
        let points = endpoints(super::path_data("X").expect("X exists"));
        assert_eq!(
            points,
            vec![(18.0, 6.0), (6.0, 18.0), (6.0, 6.0), (18.0, 18.0)],
            "X is not a cross"
        );
    }

    #[test]
    fn every_glyph_stays_inside_its_box() {
        let mut escaped: Vec<(&str, f32, f32)> = Vec::new();
        for name in super::names() {
            let Some(data) = super::path_data(name) else { continue };
            for (x, y) in endpoints(data) {
                if !(LOW..=HIGH).contains(&x) || !(LOW..=HIGH).contains(&y) {
                    escaped.push((name, x, y));
                    break;
                }
            }
        }
        assert!(
            escaped.is_empty(),
            "{} glyphs draw outside the 24x24 box, e.g. {:?}",
            escaped.len(),
            &escaped[..escaped.len().min(6)]
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_sorted() {
        // Lookup is a binary search; an unsorted table silently fails to find half the glyphs.
        for pair in GLYPHS.windows(2) {
            assert!(pair[0].0 < pair[1].0, "{} !< {}", pair[0].0, pair[1].0);
        }
    }

    #[test]
    fn every_default_icon_name_resolves() {
        // A default config that paints cubes is the most visible possible regression.
        let config = crate::config::defaults::ui_config();
        for ws in &config.workspaces {
            if let Some(name) = &ws.picker_icon_name {
                assert!(exists(name), "workspace glyph {name} is missing");
            }
            for app in &ws.apps {
                assert!(exists(&app.icon_name), "app glyph {} is missing", app.icon_name);
            }
        }
        assert!(exists(&config.center_button.icon_name));
        assert!(exists(FALLBACK));
    }

    #[test]
    fn the_wheels_own_glyphs_resolve() {
        // Named in code rather than in config, so nothing else would catch a rename.
        for name in ["CornerUpLeft", "Settings", "Layers", "Home", "Box", "Folder"] {
            assert!(exists(name), "{name} is missing");
        }
    }

    #[test]
    fn alias_spellings_resolve_to_the_same_glyph() {
        let canonical = path_data("Globe").unwrap();
        assert_eq!(path_data("GlobeIcon"), Some(canonical));
        assert_eq!(path_data("LucideGlobe"), Some(canonical));
        assert_eq!(resolved_key("GlobeIcon"), Some("Globe"));
        // And the hand-mapped renames.
        assert_eq!(path_data("Stars"), path_data("Sparkles"));
        assert_eq!(path_data("Grid"), path_data("Grid3x3"));
        assert_eq!(path_data("Edit3"), path_data("PenLine"));
    }

    #[test]
    fn an_unknown_name_does_not_resolve() {
        assert!(!exists("DefinitelyNotAGlyph"));
        assert!(path_data("DefinitelyNotAGlyph").is_none());
    }

    #[test]
    fn the_picker_has_the_whole_set() {
        assert_eq!(names().count(), GLYPHS.len());
        assert!(GLYPHS.len() > 1300, "only {} glyphs", GLYPHS.len());
    }
}
