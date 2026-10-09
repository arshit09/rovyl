//! Is there a newer Rovyl?
//!
//! The Electron build publishes to GitHub releases and `electron-updater` watches that feed. This
//! asks the same feed the same question, over the HTTP client Windows already has.
//!
//! **What it deliberately does not do: install.** An updater that downloads and swaps the running
//! binary needs an elevation story, a rollback story, a "what if it is mid-gesture" story and a
//! signature to check — and getting any of them wrong turns a launcher into a machine that cannot
//! launch. Until there is a signed installer to hand the work to, this tells the truth and opens
//! the page, which is what the row promises and all of what it promises.
//!
//! **It runs on a worker and only when asked.** A launcher that phones home on every start is a
//! launcher with a network dependency it did not need, and this one is meant to open in four
//! milliseconds on a machine with no network at all.

/// Where the Electron build publishes, so both builds see the same releases.
const OWNER: &str = "arshit09";
const REPO: &str = "rovyl";

/// What the feed said.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    /// The version, with any leading `v` taken off.
    pub version: String,
    /// The page to send somebody to.
    pub url: String,
}

/// The newest published release, or `None` if the question could not be answered.
///
/// Call from a WORKER. It is somebody else's TLS handshake.
pub fn latest() -> Option<Release> {
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/releases/latest");
    let body = super::web::fetch(&url)?;
    parse(&body)
}

/// Pull the version and the page out of the feed's answer.
fn parse(body: &[u8]) -> Option<Release> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let tag = value.get("tag_name")?.as_str()?.trim();
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    if version.is_empty() {
        return None;
    }
    let url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = if url.is_empty() {
        format!("https://github.com/{OWNER}/{REPO}/releases/latest")
    } else {
        url
    };
    Some(Release { version, url })
}

/// Whether `candidate` is a later version than `current`.
///
/// Compared component by component as numbers, not as strings: `1.9.0` and `1.10.0` sort the wrong
/// way round as text, and that is the comparison an updater gets to be wrong about exactly once.
/// Anything non-numeric in a component — `1.20.0-beta.1` — makes it a PRE-release of that
/// component, which sorts BEFORE the plain one, as semver says.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (candidate_core, candidate_pre) = split_pre(candidate);
    let (current_core, current_pre) = split_pre(current);

    let mut left = candidate_core.split('.');
    let mut right = current_core.split('.');
    for _ in 0..4 {
        let a: u64 = left.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let b: u64 = right.next().unwrap_or("0").trim().parse().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    // Same numbers. A release outranks a pre-release of itself; two pre-releases compare as text,
    // which is the best anything can do without a full semver parser and is never load-bearing.
    match (candidate_pre, current_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => a > b,
        (None, None) => false,
    }
}

fn split_pre(version: &str) -> (&str, Option<&str>) {
    match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers_and_not_as_text() {
        // The one an updater gets to be wrong about exactly once.
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.19.1", "1.19.0"));
        assert!(!is_newer("1.19.0", "1.19.0"));
        assert!(!is_newer("1.18.0", "1.19.0"));
        // A missing component is a zero.
        assert!(is_newer("1.20", "1.19.3"));
        assert!(!is_newer("1.19", "1.19.0"));
    }

    #[test]
    fn a_release_outranks_its_own_pre_release() {
        assert!(is_newer("1.20.0", "1.20.0-beta.1"));
        assert!(!is_newer("1.20.0-beta.1", "1.20.0"));
        assert!(is_newer("1.20.0-beta.2", "1.20.0-beta.1"));
        // And a pre-release of a later version still wins on the numbers.
        assert!(is_newer("1.21.0-beta.1", "1.20.0"));
    }

    #[test]
    fn the_feeds_answer_is_read_the_way_github_writes_it() {
        let body = br#"{"tag_name":"v1.20.0","html_url":"https://github.com/a/b/releases/tag/v1.20.0","name":"1.20.0"}"#;
        let release = parse(body).expect("parses");
        assert_eq!(release.version, "1.20.0");
        assert_eq!(release.url, "https://github.com/a/b/releases/tag/v1.20.0");

        // A tag with no `v`, and no page given.
        let release = parse(br#"{"tag_name":"2.0.0"}"#).expect("parses");
        assert_eq!(release.version, "2.0.0");
        assert!(release.url.contains("releases/latest"));

        // Rate-limited, or any other answer that is not a release.
        assert_eq!(parse(br#"{"message":"API rate limit exceeded"}"#), None);
        assert_eq!(parse(b"not json at all"), None);
    }
}
