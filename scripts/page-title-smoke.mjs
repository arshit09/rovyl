/**
 * Smoke test for backend/page-title.cjs (no Electron, no network).
 * Run: node scripts/page-title-smoke.mjs
 *
 * What a shortcut is called is the first thing a user sees on the wheel, and the HTML it is read
 * out of is written by strangers: entities, a charset nobody uses any more, an SVG icon that
 * brought its own <title>. Each of those is a way to end up with a label that reads as broken.
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const require = createRequire(import.meta.url);
const {
  decodeHtmlEntities,
  tidyTitleText,
  extractPageTitle,
  charsetFromHtml,
  titleFromHtmlBuffer,
  hostLabelFromUrl,
} = require("../backend/page-title.cjs");

/** The plain case: the tab's name, exactly as the browser shows it. */
assert.equal(
  extractPageTitle("<html><head><title>GitHub</title></head><body>x</body></html>"),
  "GitHub",
);

/** Entities are the difference between "Ben &amp; Jerry" and a name someone would write. */
assert.equal(decodeHtmlEntities("Ben &amp; Jerry&#39;s &mdash; &#x2019;24"), "Ben & Jerry's — ’24");
/** Windows-1252 numbers: `&#146;` is an apostrophe in every browser, not a control character. */
assert.equal(decodeHtmlEntities("Rovyl&#146;s"), "Rovyl’s");
/** An entity nobody has heard of stays as typed rather than turning into a blank. */
assert.equal(decodeHtmlEntities("a &nosuchentity; b"), "a &nosuchentity; b");

/** Titles are pretty-printed across lines more often than you would think. */
assert.equal(
  extractPageTitle("<head>\n  <title>\n    Linear\n    — Plan and build\n  </title>\n</head>"),
  "Linear — Plan and build",
);

/** A single-page app ships a placeholder title and fills it in from script; og: knows better. */
assert.equal(
  extractPageTitle(
    '<head><title>React App</title><meta property="og:site_name" content="Figma"></head>',
  ),
  "Figma",
);
assert.equal(
  extractPageTitle('<head><title></title><meta property="og:title" content="Notion"></head>'),
  "Notion",
);
/** But a real title outranks the marketing copy in og:title. */
assert.equal(
  extractPageTitle(
    '<head><title>Inbox (12)</title><meta property="og:title" content="Buy our thing"></head>',
  ),
  "Inbox (12)",
);

/** An inline SVG in the body carries its own <title>; naming a shortcut after it is nonsense. */
assert.equal(
  extractPageTitle(
    "<head><title>Vercel</title></head><body><svg><title>menu icon</title></svg></body>",
  ),
  "Vercel",
);
/** Same trap with no page title at all: the icon's name must not win by default. */
assert.equal(extractPageTitle("<body><svg><title>menu icon</title></svg></body>"), null);

/** Attribute order is not guaranteed, and single quotes are legal. */
assert.equal(
  extractPageTitle("<head><meta content='Slack' property='og:site_name'></head>"),
  "Slack",
);

/** Markup inside the title is rare but legal; the label takes the text, not the tags. */
assert.equal(extractPageTitle("<head><title>Rovyl <b>Pro</b></title></head>"), "Rovyl Pro");

/** A wheel label has a width; a page with an essay in its <title> gets cut, not passed through. */
const long = tidyTitleText(`Rovyl ${"very ".repeat(60)}long`);
assert.ok(long.length <= 120, `expected a capped title, got ${long.length} chars`);
assert.ok(long.endsWith("…"));

/** Nothing to read is null, not an empty label the user then has to fix. */
assert.equal(extractPageTitle(""), null);
assert.equal(extractPageTitle("<html><head></head><body>no title</body></html>"), null);

/** The charset comes from the header first, then from the document's own meta. */
assert.equal(charsetFromHtml("text/html; charset=ISO-8859-1", ""), "iso-8859-1");
assert.equal(charsetFromHtml("text/html", '<meta charset="utf-8">'), "utf-8");
assert.equal(
  charsetFromHtml(
    "text/html",
    '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
  ),
  "windows-1252",
);
assert.equal(charsetFromHtml("text/html", "<title>x</title>"), null);

/** Bytes in, name out: UTF-8 by default… */
assert.equal(
  titleFromHtmlBuffer(
    Buffer.from("<head><title>Café Münster</title></head>", "utf8"),
    "text/html; charset=utf-8",
  ),
  "Café Münster",
);
/** …and a page that still declares latin-1 is decoded as latin-1, not as mojibake. */
assert.equal(
  titleFromHtmlBuffer(
    Buffer.from("<head><title>Café Münster</title></head>", "latin1"),
    "text/html; charset=ISO-8859-1",
  ),
  "Café Münster",
);

/** The last resort, when the page will not say what it is called. */
assert.equal(hostLabelFromUrl("https://www.github.com/user/repo"), "github.com");
assert.equal(hostLabelFromUrl("example.com"), "example.com");
assert.equal(hostLabelFromUrl("http://localhost:5173/app"), "localhost");
assert.equal(hostLabelFromUrl(""), "");

console.log("page-title-smoke: OK");
