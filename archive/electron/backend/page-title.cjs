"use strict";

/**
 * Reading a page's own name out of its HTML.
 *
 * A web shortcut used to be labelled with its hostname — `github.com`, `chat.openai.com` — which
 * is not what anyone calls the site. The name the page itself advertises sits in <title>, so that
 * is what a new URL shortcut is named after; the Open Graph pair is a second opinion for the apps
 * that ship an empty <title> and fill it in from script, and the host stays the last resort.
 *
 * Parsing lives here rather than in `electron-main.js` so it can be driven from plain node.
 */

/** The entities that actually turn up in titles — separators, quotes, symbols. */
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  middot: "·",
  bull: "•",
  dagger: "†",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  micro: "µ",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
};

/**
 * Windows-1252 filled the C1 range with punctuation, and pages written against it still emit
 * `&#146;` for a right single quote. Browsers map those numbers the same way; so do we, or a
 * title comes back with a control character where an apostrophe belongs.
 */
const CP1252_C1 = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…",
  134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š",
  139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’",
  147: "“", 148: "”", 149: "•", 150: "–", 151: "—",
  152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ",
  158: "ž", 159: "Ÿ",
};

function codePointToText(code) {
  if (!Number.isFinite(code) || code <= 0) return "";
  if (CP1252_C1[code]) return CP1252_C1[code];
  /** Lone surrogates and anything past the last plane would throw; drop them instead. */
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** `&amp;` `&#39;` `&#x2019;` — the three forms a title can carry. Unknown names are left alone. */
function decodeHtmlEntities(text) {
  return String(text ?? "").replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return codePointToText(code) || whole;
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

/** Titles are a single line in a wheel: no markup, no newlines, no runaway length. */
function tidyTitleText(raw, maxLength = 120) {
  let text = String(raw ?? "");
  if (!text) return "";
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeHtmlEntities(text);
  /** Zero-width marks, the BOM and stray control bytes read as blanks or gaps in a label. */
  text = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  text = text.replace(/[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  return text;
}

const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function parseTagAttributes(tag) {
  const attributes = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(tag))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

/** Only the head is searched, and inline SVG is dropped first: `<svg><title>` is not the page's. */
function headRegionOf(html) {
  const withoutSvg = html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ");
  const headEnd = withoutSvg.search(/<\/head\s*>/i);
  if (headEnd >= 0) return withoutSvg.slice(0, headEnd);
  /** No `</head>` yet (a truncated read, or a page that never opens a body) — search what we have. */
  const bodyStart = withoutSvg.search(/<body\b/i);
  return bodyStart >= 0 ? withoutSvg.slice(0, bodyStart) : withoutSvg;
}

/** The `<meta>` names a page uses to say what it is called, best first. */
const META_TITLE_KEYS = [
  "og:site_name",
  "og:title",
  "twitter:title",
  "application-name",
  "apple-mobile-web-app-title",
];

function metaTitlesOf(head) {
  const found = new Map();
  const tags = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = parseTagAttributes(tag);
    const key = (attributes.property || attributes.name || attributes.itemprop || "")
      .trim()
      .toLowerCase();
    if (!key || found.has(key)) continue;
    const value = tidyTitleText(attributes.content);
    if (value) found.set(key, value);
  }
  return found;
}

/**
 * The page's own name.
 *
 * `<title>` wins — it is the thing the user asked for and the thing their browser tab shows. The
 * meta names only stand in when it is missing or empty, which is the single-page-app case where
 * the served HTML has a placeholder title that script replaces after load.
 */
function extractPageTitle(html) {
  const source = String(html ?? "");
  if (!source) return null;
  const head = headRegionOf(source);

  const titleMatch = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? tidyTitleText(titleMatch[1]) : "";
  /** A framework placeholder is not a name; fall through to the meta tags when we see one. */
  const isPlaceholder = /^(document|untitled|react app|vite app|home|index|new tab)$/i.test(title);
  if (title && !isPlaceholder) return title;

  const metas = metaTitlesOf(head);
  for (const key of META_TITLE_KEYS) {
    const value = metas.get(key);
    if (value) return value;
  }
  return title || null;
}

/** `charset=` from the response header, else the `<meta>` the document opens with. */
function charsetFromHtml(headerContentType, htmlHead) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(String(headerContentType || ""));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const source = String(htmlHead || "").slice(0, 4096);
  const metaCharset = /<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/i.exec(source);
  if (metaCharset) return metaCharset[1].toLowerCase();
  const httpEquiv = /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(source);
  if (httpEquiv) return httpEquiv[1].toLowerCase();
  return null;
}

/** Bytes to text. UTF-8 unless the page says otherwise; an encoding node cannot do stays UTF-8. */
function decodeHtmlBuffer(buffer, headerContentType) {
  if (!buffer || !buffer.length) return "";
  const sniff = buffer.toString("latin1", 0, Math.min(buffer.length, 4096));
  const charset = charsetFromHtml(headerContentType, sniff);
  if (!charset || /^utf-?8$/.test(charset)) return buffer.toString("utf8");
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** The one call the main process makes: response bytes in, page name out. */
function titleFromHtmlBuffer(buffer, headerContentType) {
  return extractPageTitle(decodeHtmlBuffer(buffer, headerContentType));
}

/** What a shortcut is called when the page will not say: the host, without the `www.` noise. */
function hostLabelFromUrl(urlString) {
  try {
    let s = String(urlString ?? "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    return new URL(s).hostname.replace(/^www\./i, "");
  } catch {
    return String(urlString ?? "").trim();
  }
}

module.exports = {
  decodeHtmlEntities,
  tidyTitleText,
  extractPageTitle,
  charsetFromHtml,
  decodeHtmlBuffer,
  titleFromHtmlBuffer,
  hostLabelFromUrl,
};
