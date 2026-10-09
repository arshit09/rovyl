//! The two things a web shortcut needs from the network: its icon, and its name.
//!
//! **Why WinHTTP.** It is the HTTP client Windows already has, it follows redirects, it honours
//! the system proxy, and it validates certificates — all of which an HTTP client written here
//! would have to be written, and then trusted. It costs no dependency and no megabyte.
//!
//! **Everything here runs on a worker, never on a frame.** A launcher must not reach the network
//! to draw a wheel. The rule the icon cache follows applies with more force here: a file read is
//! milliseconds and somebody else's TLS handshake is not bounded at all.
//!
//! **Nothing is fetched for a host that cannot have an answer.** The original learned this the
//! expensive way: the healing pass re-asked as the user typed, so every prefix of an address in
//! progress — `g`, `gi`, `git` — became a lookup. Fifty outbound requests for one address, each
//! handing a keystroke-by-keystroke reconstruction of what was being typed to Google and
//! DuckDuckGo. `is_fetchable_host` is what stops that, and it is the reason this module is
//! careful rather than clever.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Networking::WinHttp::*;

/// How long any one request may take, in milliseconds.
///
/// Generous, because this is a background fetch nobody is waiting on — and short enough that a
/// host which black-holes connections does not keep a worker thread for the session.
const TIMEOUT_MS: i32 = 12_000;

/// The largest body this will read.
///
/// 512 KB is the original's cap and is far more than a favicon; it is the HEAD of a page that
/// needs the room, and even then the title usually arrives in the first few kilobytes.
const MAX_BYTES: usize = 512 * 1024;

/// What this client calls itself.
///
/// A real-looking agent, because several of the icon services answer a bare one with a 403. It
/// names the product so the request is honest about who is making it.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Rovyl/1.0";

/// Whether a hostname is one worth asking an icon service about.
///
/// A dot and a plausible TLD. `xn--` is spelled out because a punycode TLD (`.рф` encodes as
/// `xn--p1ai`) carries digits and a hyphen, which a letters-only test rejects. An IP literal or a
/// single-label intranet host falls out here too, and should: no upstream can answer for one.
pub fn is_fetchable_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let Some(tld) = host.rsplit('.').next() else {
        return false;
    };
    if tld == host {
        // No dot at all.
        return false;
    }
    let lower = tld.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("xn--") {
        return rest.len() >= 2 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    }
    lower.len() >= 2 && lower.chars().all(|c| c.is_ascii_alphabetic())
}

/// The hostname of a URL, lower-cased, with no port and no credentials.
pub fn host_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rest = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '?', '#']).next()?;
    // `user:pass@host` — everything before the last `@` is credentials.
    let authority = authority.rsplit('@').next()?;
    // A port, but not the colons of an IPv6 literal, which this never accepts anyway.
    let host = authority.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Add a scheme if the user did not type one. `https`, because this is 2026.
pub fn with_scheme(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

/// GET a URL and return the body, up to `MAX_BYTES`.
///
/// `None` covers every failure — no network, a refusal, a redirect loop, a body too large — because
/// the caller's next move is the same for all of them: try the next candidate, or give up and
/// leave the glyph alone.
pub fn fetch(url: &str) -> Option<Vec<u8>> {
    unsafe {
        let session = WinHttpOpen(
            &HSTRING::from(USER_AGENT),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return None;
        }
        let session = Handle(session);
        // All four timeouts, because the default for a connect is 60 seconds and a background
        // fetch that holds a worker for a minute is a background fetch that is in the way.
        let _ = WinHttpSetTimeouts(session.0, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS);

        let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let mut components = URL_COMPONENTS {
            dwStructSize: std::mem::size_of::<URL_COMPONENTS>() as u32,
            dwSchemeLength: u32::MAX,
            dwHostNameLength: u32::MAX,
            dwUrlPathLength: u32::MAX,
            dwExtraInfoLength: u32::MAX,
            ..Default::default()
        };
        WinHttpCrackUrl(&wide, 0, &mut components).ok()?;

        let host = slice_of(&wide, components.lpszHostName, components.dwHostNameLength)?;
        let path = slice_of(&wide, components.lpszUrlPath, components.dwUrlPathLength)
            .unwrap_or_else(|| "/".to_string());
        let extra = slice_of(&wide, components.lpszExtraInfo, components.dwExtraInfoLength)
            .unwrap_or_default();
        let secure = components.nScheme == WINHTTP_INTERNET_SCHEME_HTTPS;

        let connect = WinHttpConnect(session.0, &HSTRING::from(host), components.nPort, 0);
        if connect.is_null() {
            return None;
        }
        let connect = Handle(connect);

        let target = format!("{path}{extra}");
        let request = WinHttpOpenRequest(
            connect.0,
            &HSTRING::from("GET"),
            &HSTRING::from(target.as_str()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null_mut(),
            if secure {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        );
        if request.is_null() {
            return None;
        }
        let request = Handle(request);

        // UTF-16 with no terminator: WinHTTP takes the headers as a counted slice.
        let headers: Vec<u16> =
            "Accept: image/avif,image/webp,image/png,image/*,text/html;q=0.9,*/*;q=0.8\r\n"
                .encode_utf16()
                .collect();
        WinHttpSendRequest(request.0, Some(&headers), None, 0, 0, 0).ok()?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).ok()?;

        // The status line. WinHTTP has already followed redirects by this point, so anything but
        // 200 is an answer of "no".
        let mut status: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut _),
            &mut size,
            std::ptr::null_mut(),
        )
        .ok()?;
        if status != 200 {
            return None;
        }

        let mut body: Vec<u8> = Vec::with_capacity(16 * 1024);
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let mut read: u32 = 0;
            if WinHttpReadData(
                request.0,
                chunk.as_mut_ptr() as *mut _,
                chunk.len() as u32,
                &mut read,
            )
            .is_err()
            {
                return None;
            }
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read as usize]);
            if body.len() > MAX_BYTES {
                // Truncated rather than refused: a page whose head is in the first half megabyte
                // still has a title, and an image that large was never a favicon.
                body.truncate(MAX_BYTES);
                break;
            }
        }
        if body.is_empty() {
            None
        } else {
            Some(body)
        }
    }
}

/// A WinHTTP handle that closes itself.
struct Handle(*mut std::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

/// Read one of `WinHttpCrackUrl`'s pointer-and-length pairs back out of the buffer it points into.
unsafe fn slice_of(buffer: &[u16], start: windows::core::PWSTR, length: u32) -> Option<String> {
    if start.is_null() || length == 0 {
        return None;
    }
    let base = buffer.as_ptr();
    let offset = start.0.offset_from(base as *mut u16);
    if offset < 0 {
        return None;
    }
    let offset = offset as usize;
    let end = offset.checked_add(length as usize)?;
    if end > buffer.len() {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[offset..end]))
}

/// Fetch a site's icon, trying the services the original tries, in the same order.
///
/// Neither is asked for anything but a hostname, and `is_fetchable_host` has already refused the
/// ones that are nobody's business.
pub fn favicon(host: &str) -> Option<Vec<u8>> {
    if !is_fetchable_host(host) {
        return None;
    }
    let candidates = [
        format!("https://www.google.com/s2/favicons?domain={host}&sz=128"),
        format!("https://icons.duckduckgo.com/ip3/{host}.ico"),
    ];
    for url in candidates {
        // `continue`, not `?`: the whole point of a list of candidates is that the first one
        // failing is the reason there is a second. Propagating the failure out of the loop made
        // the fallback unreachable in exactly the case it exists for.
        let Some(body) = fetch(&url) else { continue };
        // Below sixteen bytes there is no image, only a server being polite about having nothing.
        if body.len() >= 16 && looks_like_an_image(&body) {
            return Some(body);
        }
    }
    None
}

/// Whether the bytes begin the way an image does.
///
/// Read from the content rather than from a `Content-Type` header, because the services here are
/// generous with `application/octet-stream` and a stored file named by its header is a stored file
/// named wrong.
pub fn looks_like_an_image(bytes: &[u8]) -> bool {
    matches!(
        bytes,
        [0x89, b'P', b'N', b'G', ..]          // PNG
            | [0xFF, 0xD8, 0xFF, ..]          // JPEG
            | [b'G', b'I', b'F', b'8', ..]    // GIF
            | [0x00, 0x00, 0x01, 0x00, ..]    // ICO
            | [0x00, 0x00, 0x02, 0x00, ..]    // CUR
            | [b'B', b'M', ..]                // BMP
    ) || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
        || bytes.starts_with(b"<svg")
        || bytes.starts_with(b"<?xml")
}

/// The extension the icon store should file these bytes under.
pub fn extension_for(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [b'G', b'I', b'F', b'8', ..] => "gif",
        [0x00, 0x00, 0x01, 0x00, ..] | [0x00, 0x00, 0x02, 0x00, ..] => "ico",
        [b'B', b'M', ..] => "bmp",
        _ if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "webp",
        _ => "png",
    }
}

/// The name a web shortcut is born with.
///
/// A URL labelled with its hostname puts `github.com` on the wheel. The page already publishes the
/// name its own tab shows, so it is read from there.
pub fn page_title(url: &str) -> Option<String> {
    let body = fetch(&with_scheme(url))?;
    title_from_html(&body)
}

/// Pull `<title>` out of a page.
///
/// Byte-wise and case-insensitive, on purpose: the body is whatever encoding the server sent, and
/// decoding a whole page to read one tag would mean carrying an encoding table for the sake of a
/// label. Entities are decoded for the five that actually appear in titles.
pub fn title_from_html(body: &[u8]) -> Option<String> {
    let lower: Vec<u8> = body
        .iter()
        .map(|b| b.to_ascii_lowercase())
        .take(MAX_BYTES)
        .collect();
    let open = find(&lower, b"<title")?;
    // `<title>` or `<title lang="en">`: skip to the end of the tag.
    let text_start = open + lower[open..].iter().position(|&b| b == b'>')? + 1;
    let close = find(&lower[text_start..], b"</title>")? + text_start;
    let raw = &body[text_start..close];
    let text = String::from_utf8_lossy(raw);

    let decoded = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ");
    // One line: a title with a newline in it is a title that breaks the row it is drawn in.
    let collapsed: String = decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        None
    } else {
        // A long one is a sentence, not a name. Cut it where the eye would.
        Some(collapsed.chars().take(80).collect())
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_hosts_an_icon_service_can_answer_for() {
        assert!(is_fetchable_host("github.com"));
        assert!(is_fetchable_host("www.youtube.com"));
        assert!(is_fetchable_host("sub.domain.co.uk"));
        // A punycode TLD carries digits and a hyphen.
        assert!(is_fetchable_host("example.xn--p1ai"));

        // The ones that cost fifty requests while somebody typed an address.
        assert!(!is_fetchable_host("g"));
        assert!(!is_fetchable_host("git"));
        assert!(!is_fetchable_host("github"));
        assert!(!is_fetchable_host("github.c"));
        // And the ones no upstream can answer for.
        assert!(!is_fetchable_host("localhost"));
        assert!(!is_fetchable_host("192.168.1.1"));
        assert!(!is_fetchable_host(""));
    }

    #[test]
    fn a_host_is_taken_out_of_a_url_the_way_a_browser_takes_it() {
        assert_eq!(host_of("https://www.google.com/search?q=x").as_deref(), Some("www.google.com"));
        assert_eq!(host_of("http://example.com:8080/a").as_deref(), Some("example.com"));
        assert_eq!(host_of("example.org").as_deref(), Some("example.org"));
        // Credentials are not part of the host, and must never be handed to an icon service.
        assert_eq!(host_of("https://user:pw@secret.example.com/x").as_deref(), Some("secret.example.com"));
        assert_eq!(host_of("HTTPS://EXAMPLE.COM/").as_deref(), Some("example.com"));
        assert_eq!(host_of(""), None);
    }

    #[test]
    fn a_scheme_is_added_but_never_replaced() {
        assert_eq!(with_scheme("example.com"), "https://example.com");
        assert_eq!(with_scheme("http://example.com"), "http://example.com");
        assert_eq!(with_scheme("  https://example.com  "), "https://example.com");
    }

    #[test]
    fn a_title_is_read_whatever_the_tag_looks_like() {
        assert_eq!(
            title_from_html(b"<html><head><TITLE>Hello</TITLE></head>").as_deref(),
            Some("Hello")
        );
        assert_eq!(
            title_from_html(b"<title lang=\"en\">With attributes</title>").as_deref(),
            Some("With attributes")
        );
        // Entities, and whitespace collapsed to one line.
        assert_eq!(
            title_from_html(b"<title>A &amp; B\n   C</title>").as_deref(),
            Some("A & B C")
        );
        assert_eq!(title_from_html(b"<title></title>"), None);
        assert_eq!(title_from_html(b"<html>no title here</html>"), None);
    }

    #[test]
    fn an_image_is_recognised_by_its_first_bytes_and_not_by_a_header() {
        assert!(looks_like_an_image(&[0x89, b'P', b'N', b'G', 13, 10, 26, 10]));
        assert!(looks_like_an_image(&[0x00, 0x00, 0x01, 0x00, 1, 0]));
        assert_eq!(extension_for(&[0x00, 0x00, 0x01, 0x00, 1, 0]), "ico");
        assert_eq!(extension_for(&[0xFF, 0xD8, 0xFF, 0xE0]), "jpg");
        assert_eq!(extension_for(&[0x89, b'P', b'N', b'G']), "png");
        // An HTML error page is not an icon, however politely it was served.
        assert!(!looks_like_an_image(b"<!DOCTYPE html><html>"));
        assert!(!looks_like_an_image(b"not an image at all"));
    }
}
