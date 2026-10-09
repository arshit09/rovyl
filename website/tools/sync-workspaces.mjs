/**
 * Pulls the real workspaces out of an installed Rovyl and freezes them into the
 * site as static data.
 *
 * The hero is a mock-up of a launcher, and a mock-up of a launcher full of
 * invented shortcuts is a drawing. These are the actual workspaces, the actual
 * shortcut order and the actual extracted icons, so what the page shows is what
 * the product does. Re-run after changing your wheel:
 *
 *     node website/tools/sync-workspaces.mjs
 *
 * Reads `%APPDATA%/Rovyl/config-v2.json` and the icon store beside it; writes
 * `website/workspaces.js` and `website/assets/icons/`. Nothing else in the site
 * depends on Rovyl being installed - the generated file is committed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');

const appData = process.env.APPDATA
  || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const DATA_DIR = path.join(appData, 'Rovyl');
const CONFIG = path.join(DATA_DIR, 'config-v2.json');
const ICON_STORE = path.join(DATA_DIR, 'icons');

const OUT_ICONS = path.join(SITE, 'assets', 'icons');

/** The shipped version, from Cargo.toml - the manifest of the build the site advertises. */
function appVersion() {
  const manifest = fs.readFileSync(path.resolve(SITE, '..', 'Cargo.toml'), 'utf8');
  const found = /^version = "(.+)"/m.exec(manifest);
  if (!found) throw new Error('no version in Cargo.toml');
  return found[1];
}
const OUT_DATA = path.join(SITE, 'workspaces.js');
const LUCIDE = path.resolve(SITE, '..', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons');

if (!fs.existsSync(CONFIG)) {
  console.error(`No Rovyl config at ${CONFIG} - nothing to sync.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const appearance = config.config ?? {};
const workspaces = config.workspaces ?? [];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * A workspace's picker glyph by its Lucide name, read out of the very package
 * the app renders with - so the slice on the page is the same drawing as the
 * slice on the wheel, down to the version.
 */
function lucideNode(name, seen = new Set()) {
  const file = path.join(LUCIDE, `${kebab(name)}.js`);
  if (seen.has(file) || !fs.existsSync(file)) return null;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');

  /* Some names are aliases: `stars.js` is one line re-exporting `sparkles.js`. */
  const alias = /export \{ default \} from '\.\/([\w-]+)\.js'/.exec(src);
  if (alias) return lucideNode(alias[1], seen);

  const nodes = [];
  for (const [, tag, body] of src.matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)) {
    const attrs = {};
    for (const [, key, value] of body.matchAll(/"?([\w-]+)"?\s*:\s*"([^"]*)"/g)) {
      if (key !== 'key') attrs[key] = value;
    }
    nodes.push({ tag, attrs });
  }
  return nodes.length ? nodes : null;
}

fs.rmSync(OUT_ICONS, { recursive: true, force: true });
fs.mkdirSync(OUT_ICONS, { recursive: true });

/** `rovyl-icon://icon/<sha>.png` is a custom protocol; on disk it is a file. */
const copyIcon = (url, label) => {
  const hash = /icon\/([0-9a-f]+\.\w+)$/.exec(url || '')?.[1];
  if (!hash) return null;
  const src = path.join(ICON_STORE, hash);
  if (!fs.existsSync(src)) return null;
  const name = `${slug(label)}${path.extname(hash)}`;
  fs.copyFileSync(src, path.join(OUT_ICONS, name));
  return `assets/icons/${name}`;
};

let missing = 0;
const data = workspaces
  .filter((w) => w.enabled !== false)
  .map((w) => ({
    name: w.name,
    key: w.hotkey,
    /* The Workspaces page draws each card's ring and hub in this colour. */
    color: w.color || null,
    paused: w.enabled === false,
    /* Picker mode makes the wheel's ROOT a list of workspaces, each drawn with
       this glyph - so the site needs it to reproduce the first level. */
    glyph: lucideNode(w.pickerIconName?.trim() || 'Layers'),
    items: (w.apps ?? []).map((a) => {
      const icon = copyIcon(a.customIconUrl, a.label);
      if (!icon) missing += 1;
      return { label: a.label, icon, glyph: a.iconName || 'Circle' };
    }),
  }));

/* Only the appearance settings the mock-up actually honours. */
const look = {
  hoverColor: appearance.radialHoverColor ?? '#FFFFFF',
  menuRadius: appearance.menuRadius ?? 140,
  iconSize: appearance.iconSize ?? 64,
  appSpacing: appearance.appSpacing ?? 10,
  backdropOpacity: appearance.backdropOpacity ?? 0.9,
  /* Targeting is Area or Pointer; Area draws its wedges only with "Visible
     wedges" on, so the page draws them only then too. */
  selectionMode: appearance.radialSelectionMode === 'cursor' ? 'cursor' : 'area',
  areaWedges: appearance.radialAreaWedges === true,
  /* Appearance → Workspace name, and Where it opens. */
  showPill: appearance.showWorkspacePill !== false,
  placement: appearance.radialPlacement === 'cursor' ? 'cursor' : 'center',
  showLabels: appearance.showLabels !== false,
  globalShortcut: appearance.globalShortcut ?? 'Alt+Z',
  activationThreshold: appearance.activationThreshold ?? 60,
  radialMonitor: appearance.radialMonitor ?? 'cursor',
  /* The Activation page of the settings mock renders from these, so the window
     on the page cannot drift from the window on the machine. */
  keyboardTrigger: appearance.enableKeyboardTrigger !== false,
  shortcutMode: appearance.shortcutTriggerMode === 'hold' ? 'hold' : 'toggle',
  mouseTrigger: appearance.enableMouseTrigger === true,
  mouseButton: appearance.mouseTriggerButton ?? 'middle',
  mouseMode: appearance.mouseTriggerMode ?? 'hold',
  theme: appearance.appearanceTheme ?? 'black',
  /* The version in the settings mock's footer, from the app's own manifest. */
  version: appVersion(),
  /* There is no picker/keys switch any more: with more than one workspace the
     wheel always opens on the home launcher, which site.js works out itself. */
  activeWorkspace: appearance.activeWorkspaceIndex ?? 0,
  centerLabel: appearance.centerButton?.label || 'Center',
  /* Hands-free ("Launch without clicking") and its two tunings, which the app
     only shows while the gesture itself is on. */
  handsFree: appearance.radialInstantActivate === 'dwell',
  handsFreeSensitivity: appearance.radialInstantSensitivity ?? 'medium',
  handsFreeDwellMs: appearance.radialInstantDwellMs ?? 400,
  /* The Sound section, which sound.js seeds the page's one copy from - so the
     wheel on the page plays the notes the machine's wheel plays. */
  sounds: {
    radialSounds: appearance.radialSounds !== false,
    radialSoundVolume: typeof appearance.radialSoundVolume === 'number' ? appearance.radialSoundVolume : 100,
    radialOpenSound: appearance.radialOpenSound !== false,
    radialOpenSoundId: appearance.radialOpenSoundId ?? 'sub-tick',
    radialHoverSound: appearance.radialHoverSound !== false,
    radialHoverSoundId: appearance.radialHoverSoundId ?? 'thump',
  },
};

const banner = `/* Generated by tools/sync-workspaces.mjs - do not edit by hand.
   The real wheel: ${data.map((w) => `${w.name} (${w.items.length})`).join(', ')}. */\n`;

fs.writeFileSync(
  OUT_DATA,
  `${banner}window.ROVYL = ${JSON.stringify({ look, workspaces: data }, null, 2)};\n`,
);

console.log(`${data.length} workspaces → ${path.relative(SITE, OUT_DATA)}`);
for (const w of data) console.log(`  ${w.name} · key ${w.key} · ${w.items.length} shortcuts`);
console.log(`${fs.readdirSync(OUT_ICONS).length} icons → assets/icons/${missing ? ` (${missing} unresolved)` : ''}`);
