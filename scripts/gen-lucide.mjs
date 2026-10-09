// Generates src/gfx/lucide_data.rs from the Electron build's lucide-react package.
//
// Every Lucide primitive is flattened to one SVG path string per icon, because the wheel strokes
// all of them identically: one geometry per glyph instead of a list of shapes means one
// ID2D1PathGeometry, one DrawGeometry call, and no per-element attribute handling at runtime.
//
// Run: node gen-lucide.mjs <lucide-react/dist/esm dir> <out .rs path>

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [, , esmDir, outPath] = process.argv;
if (!esmDir || !outPath) {
  console.error('usage: node gen-lucide.mjs <esmDir> <out.rs>');
  process.exit(2);
}

const n = (v) => {
  const num = Number(v);
  if (!Number.isFinite(num)) throw new Error(`not a number: ${v}`);
  // Trim to 4 decimals; Lucide's own coordinates are at most 2 and the conversions below add a few.
  return String(Math.round(num * 10000) / 10000);
};

/** One SVG element as path data. Everything Lucide 0.292 uses is covered; anything else throws. */
function toPath(tag, attrs) {
  switch (tag) {
    case 'path':
      return attrs.d;
    case 'line':
      return `M${n(attrs.x1)} ${n(attrs.y1)}L${n(attrs.x2)} ${n(attrs.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = String(attrs.points).trim().split(/[\s,]+/).map(n);
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
    case 'circle': {
      // Two half-arcs: a single arc whose endpoints coincide draws nothing at all.
      const cx = Number(attrs.cx), cy = Number(attrs.cy), r = Number(attrs.r);
      return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
    }
    case 'ellipse': {
      const cx = Number(attrs.cx), cy = Number(attrs.cy);
      const rx = Number(attrs.rx), ry = Number(attrs.ry);
      return `M${n(cx - rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)}Z`;
    }
    case 'rect': {
      const x = Number(attrs.x ?? 0), y = Number(attrs.y ?? 0);
      const w = Number(attrs.width), h = Number(attrs.height);
      let r = Number(attrs.rx ?? attrs.ry ?? 0);
      r = Math.min(r, w / 2, h / 2);
      if (!r) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
      return (
        `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
        `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
        `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
        `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`
      );
    }
    default:
      throw new Error(`unhandled tag: ${tag}`);
  }
}

// name -> file, from the package's own export list, so aliases come out authoritative.
/**
 * Make one path's leading move absolute, so several paths can be concatenated into one string.
 *
 * Each `<path>` element starts a figure of its own with the current point at the ORIGIN, so a
 * leading lowercase `m` means exactly what `M` means. Joining the strings without saying so makes
 * every subpath after the first relative to wherever the previous one happened to end — which is
 * how `X` came out as two parallel strokes rather than a cross, and 480 other glyphs with it.
 *
 * Uppercasing the `m` is not enough on its own. What FOLLOWS a moveto with no command letter of
 * its own is an implicit lineto of the same case, so `m5 8 3-3` is "move to (5,8), then a line
 * 3 right and 3 up". Rewriting it as `M5 8 3-3` turns that line into an absolute one to (3,-3),
 * which is off the canvas. The remainder therefore gets an explicit relative `l` of its own.
 */
const NUMBER = String.raw`-?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?`;
const LEADING_MOVE = new RegExp(String.raw`^\s*m\s*(${NUMBER})[\s,]*(${NUMBER})`);

function absoluteStart(part) {
  const match = LEADING_MOVE.exec(part);
  if (!match) return part;
  const rest = part.slice(match[0].length);
  // A remainder that starts with a number is the implicit lineto; one that starts with a letter
  // carries its own command and needs nothing.
  const implicit = /^[\s,]*[-.\d]/.test(rest);
  return `M${match[1]} ${match[2]}${implicit ? 'l' : ''}${rest}`;
}

const index = readFileSync(join(esmDir, 'lucide-react.js'), 'utf8');
const fileFor = new Map();
for (const line of index.split('\n')) {
  const m = /^export \{(.*)\} from '\.\/icons\/(.+)\.js';$/.exec(line.trim());
  if (!m) continue;
  for (const spec of m[1].split(',')) {
    const as = /default as ([A-Za-z0-9_]+)/.exec(spec.trim());
    if (as) fileFor.set(as[1], m[2]);
  }
}

// file -> path data, parsed from each icon module.
const pathFor = new Map();
const unusual = [];
for (const entry of readdirSync(join(esmDir, 'icons'))) {
  if (!entry.endsWith('.js') || entry === 'index.js') continue;
  const text = readFileSync(join(esmDir, 'icons', entry), 'utf8');
  const open = text.indexOf('createLucideIcon(');
  if (open < 0) continue;
  const comma = text.indexOf(',', open);
  const start = text.indexOf('[', comma);
  // Match brackets to find the array literal's end; `d` strings never contain brackets.
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  const nodes = new Function(`return ${text.slice(start, end)}`)();
  const parts = [];
  for (const [tag, attrs] of nodes) {
    for (const key of Object.keys(attrs)) {
      if (!['d', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'key'].includes(key)) {
        unusual.push(`${entry}: ${tag} ${key}=${attrs[key]}`);
      }
    }
    parts.push(toPath(tag, attrs));
  }
  pathFor.set(basename(entry, '.js'), parts.map(absoluteStart).join(''));
}

if (unusual.length) {
  // Surfaced rather than swallowed: an attribute this generator ignores is a glyph that will draw
  // differently from the web build, which is exactly the kind of divergence nobody notices.
  console.error(`attributes not carried over (${unusual.length}):`);
  for (const u of unusual.slice(0, 20)) console.error('  ' + u);
}

// Canonical names only: Lucide exports every glyph three times (`Globe`, `GlobeIcon`,
// `LucideGlobe`), and the affixed spellings are stripped at lookup instead of stored.
const rows = [];
for (const [name, file] of fileFor) {
  if (name.startsWith('Lucide') || name.endsWith('Icon')) continue;
  const d = pathFor.get(file);
  if (!d) { console.error(`no path for ${name} (${file})`); continue; }
  rows.push([name, d]);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const bytes = rows.reduce((t, [k, v]) => t + k.length + v.length, 0);

const out = `//! Lucide glyph geometry, generated — do not edit by hand.
//!
//! Generated from lucide-react ${/version": "([^"]+)/.exec(readFileSync(join(esmDir, '..', '..', 'package.json'), 'utf8'))?.[1] ?? '?'}
//! by \`scripts/gen-lucide.mjs\`. ISC licensed, (c) Lucide Contributors.
//!
//! Every glyph is ONE path string, with Lucide's \`circle\`/\`rect\`/\`line\`/\`polyline\`/\`polygon\`
//! elements already flattened into path data. The wheel strokes all of them identically, so a
//! glyph is one \`ID2D1PathGeometry\` and one draw call rather than a list of shapes with
//! per-element attributes to interpret at runtime.
//!
//! All ${rows.length} canonical names are here, not a curated subset. The Electron build split them
//! into a hot list of ~290 and a lazy chunk of the rest, because every byte in the renderer's
//! critical chunk delayed the wheel's first paint. A native binary has no such critical path: this
//! table is ${(bytes / 1024).toFixed(0)} KB of read-only data in the image, paged in on demand by the
//! loader, so the icon picker is complete and instant and there is no second resolution path that
//! could disagree with this one.
//!
//! The viewBox is 24x24 for every glyph.

/// Side of the box every path below is drawn in.
pub const VIEWBOX: f32 = 24.0;

/// Name to path data, sorted by name so lookup is a binary search.
pub static GLYPHS: &[(&str, &str)] = &[
${rows.map(([k, v]) => `    ("${esc(k)}", "${esc(v)}"),`).join('\n')}
];
`;
writeFileSync(outPath, out);
console.log(`${rows.length} glyphs, ${(bytes / 1024).toFixed(1)} KB of data -> ${outPath}`);
