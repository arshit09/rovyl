/**
 * Turn the Electron build's `src/utils/iconPickerEnglishKeywords.ts` into a Rust table.
 *
 * Generated rather than retyped, for the reason `gen-i18n.mjs` gives: this is a judgement call
 * made once — that typing "work" should offer a briefcase — and a second, hand-copied version of
 * it would drift the first time either side gained a keyword. 178 entries is also more than
 * anybody should retype correctly.
 *
 * The source file builds its map out of shared `const` arrays (`WORK_OFFICE`, `TIME`, …) spread
 * into the entries, so those are resolved first and the map is read with them substituted.
 *
 * `iconPickerJapaneseKeywords.ts`, beside it, is read too: Japanese words and the English keywords
 * they stand for, so a Japanese query can be translated into the table's own language.
 *
 * Usage: node scripts/gen-icon-keywords.mjs <path to iconPickerEnglishKeywords.ts> <out.rs>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , source, out] = process.argv;
if (!source || !out) {
  console.error('usage: node gen-icon-keywords.mjs <iconPickerEnglishKeywords.ts> <out.rs>');
  process.exit(1);
}

const text = readFileSync(source, 'utf8');

/** Every `'Name'` in a bracketed list, which is all these arrays ever hold. */
function namesIn(body) {
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]);
}

/**
 * The shared arrays, by name.
 *
 * Read before the map because the map spreads them. A `const` that is not an array of plain
 * strings is skipped rather than guessed at — a spread of something this cannot resolve shows up
 * as a keyword with no icons, which the check at the end refuses.
 */
const groups = new Map();
const GROUP = /^const ([A-Z_]+) = (\[[\s\S]*?\]) as const;/gm;
let group;
while ((group = GROUP.exec(text))) {
  groups.set(group[1], namesIn(group[2]));
}
if (groups.size === 0) {
  console.error('no shared arrays found — has the source file changed shape?');
  process.exit(1);
}

/** The map itself, from the opening brace to the line that closes it. */
const mapStart = text.indexOf('export const ENGLISH_KEYWORD_TO_ICONS');
if (mapStart < 0) {
  console.error('ENGLISH_KEYWORD_TO_ICONS not found');
  process.exit(1);
}
const mapBody = text.slice(text.indexOf('{', mapStart) + 1, text.indexOf('\n};', mapStart));

const entries = new Map();
const ENTRY = /^  ([a-z][a-z0-9]*):\s*(\[[\s\S]*?\]),\s*$/gm;
let entry;
while ((entry = ENTRY.exec(mapBody))) {
  const [, keyword, raw] = entry;
  // `[...WORK_OFFICE]` becomes that array; a literal list becomes itself. Both can appear in one
  // entry, so the spreads are expanded in place and the leftovers read as names.
  const spreads = [...raw.matchAll(/\.\.\.([A-Z_]+)/g)].map((m) => m[1]);
  const icons = [...spreads.flatMap((name) => groups.get(name) ?? []), ...namesIn(raw)];
  const unknown = spreads.filter((name) => !groups.has(name));
  if (unknown.length) {
    console.error(`${keyword}: spreads an array this script cannot resolve: ${unknown.join(', ')}`);
    process.exit(1);
  }
  // Order is kept — it is the order the picker offers them in — and repeats are dropped.
  entries.set(keyword, [...new Set(icons)]);
}

const empty = [...entries].filter(([, icons]) => icons.length === 0).map(([k]) => k);
if (empty.length) {
  console.error(`keywords with no icons: ${empty.join(', ')}`);
  process.exit(1);
}
if (entries.size < 100) {
  // A regex that stopped matching returns a short table rather than an error, and a silently
  // halved keyword list is exactly the kind of thing nobody notices.
  console.error(`only ${entries.size} keywords — the parse almost certainly went wrong`);
  process.exit(1);
}

const keywords = [...entries.keys()].sort();
const rows = keywords
  .map((keyword) => {
    const icons = entries.get(keyword).map((name) => `"${name}"`).join(', ');
    return `    ("${keyword}", &[${icons}]),`;
  })
  .join('\n');

const total = keywords.reduce((sum, key) => sum + entries.get(key).length, 0);

/**
 * Japanese words, as the English keywords they stand for.
 *
 * Emitted LONGEST FIRST rather than sorted, because that is the order the lookup wants: 買い物
 * has to be tried before 物 so the longer, more specific word is the one that answers first.
 */
const japaneseSource = join(dirname(source), 'iconPickerJapaneseKeywords.ts');
const japanese = [];
if (existsSync(japaneseSource)) {
  const jaText = readFileSync(japaneseSource, 'utf8');
  const jaStart = jaText.indexOf('export const JAPANESE_KEYWORD_TO_ENGLISH');
  if (jaStart < 0) {
    console.error('JAPANESE_KEYWORD_TO_ENGLISH not found');
    process.exit(1);
  }
  const jaBody = jaText.slice(jaText.indexOf('{', jaStart) + 1, jaText.indexOf('\n};', jaStart));
  const JA_ENTRY = /^  ([^\s:'"]+):\s*\[([^\]]*)\],\s*$/gm;
  let row;
  while ((row = JA_ENTRY.exec(jaBody))) {
    const tokens = [...row[2].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
    // A token no keyword answers to would translate a query into nothing, silently.
    const dead = tokens.filter((t) => !keywords.some((k) => k === t || k.startsWith(t)));
    if (dead.length) {
      console.warn(`${row[1]}: no keyword answers to ${dead.join(', ')}`);
    }
    japanese.push([row[1], tokens]);
  }
  japanese.sort((a, b) => [...b[0]].length - [...a[0]].length || (a[0] < b[0] ? -1 : 1));
}
const japaneseRows = japanese
  .map(([word, tokens]) => `    ("${word}", &[${tokens.map((t) => `"${t}"`).join(', ')}]),`)
  .join('\n');

const body = `//! Plain English, as the glyphs somebody typing it is looking for.
//!
//! GENERATED by \`scripts/gen-icon-keywords.mjs\` from the Electron build's
//! \`src/utils/iconPickerEnglishKeywords.ts\`. Do not edit by hand: edit that file and run the
//! script, so the two pickers answer "music" with the same icons.
//!
//! Without this the picker matches a glyph's NAME and nothing else, so "browser" finds nothing
//! and "time" finds \`Timer\` but not \`Clock\` — which is a search that only works for somebody
//! who already knows what Lucide called the thing they want.
//!
//! Sorted by keyword, so the lookup can binary-search it. ${keywords.length} keywords, ${total} references.

/// Keyword, then the glyphs it offers, best first.
pub const KEYWORDS: &[(&str, &[&str])] = &[
${rows}
];

/// A Japanese word, then the English keywords above that it stands for.
///
/// From \`src/utils/iconPickerJapaneseKeywords.ts\`. The table above is English by construction and
/// 仕事 is not a prefix of \`work\`, so a Japanese query is translated rather than indexed. Longest
/// first, so the more specific of two overlapping words is the one tried first. ${japanese.length} words.
pub const JAPANESE: &[(&str, &[&str])] = &[
${japaneseRows}
];
`;

writeFileSync(out, body);
console.log(
  `${keywords.length} keywords, ${total} references, ${japanese.length} Japanese words -> ${out}`,
);
