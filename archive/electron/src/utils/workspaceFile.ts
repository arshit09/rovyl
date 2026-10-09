import type { AppItem, Workspace } from '../types';
import { normalizeSiteUrl } from '../siteTitle';
import { ZENITH_LAUNCHER_DOCS_URL } from '../constants/siteUrls';

/**
 * A workspace as a text file — the power-user view of the workspace editor.
 *
 * The file is NOT the stored `Workspace`. That shape carries things that mean nothing to a person
 * and nothing on another machine: ids, `rovyl-icon://` references into this profile's icon store,
 * the positional hotkey. The file carries only what somebody would type, so it can be pasted into
 * a friend's Rovyl or kept in a dotfiles repo, and `applyWorkspaceFile` carries the hidden fields
 * across from the shortcuts the text still names. A custom picture is named by the file it came
 * from (`iconFile`), never by its reference; one with no file behind it (pasted) is a hidden field.
 *
 * The syntax is JSON with comments and trailing commas (what VS Code calls JSONC), parsed here by
 * hand for one reason: an error has to say WHICH LINE. `JSON.parse` in this Chromium reports a
 * snippet of the text at best, and "is not valid JSON" over a 200-line file is not a diagnosis.
 *
 * The reference page is `website/docs.html`; the two describe the same rules and move together.
 */

export const WORKSPACE_FILE_DOCS_URL = ZENITH_LAUNCHER_DOCS_URL;

export type ShortcutFileType = 'app' | 'url' | 'folder' | 'file' | 'command' | 'group';

export const SHORTCUT_FILE_TYPES: readonly ShortcutFileType[] = ['app', 'url', 'folder', 'file', 'command', 'group'];

/** The glyph each kind wears when the file names none. Mirrors the add forms in Settings. */
export const SHORTCUT_DEFAULT_ICONS: Record<ShortcutFileType, string> = {
  app: 'AppWindow',
  url: 'Globe',
  folder: 'Folder',
  file: 'File',
  command: 'TerminalSquare',
  group: 'Folder',
};

const SHORTCUT_DESCRIPTIONS: Record<ShortcutFileType, string> = {
  app: 'Application',
  url: 'Web link',
  folder: 'Folder shortcut',
  file: 'File shortcut',
  command: 'Command',
  group: 'Group',
};

const WORKSPACE_KEYS = ['name', 'icon', 'iconFile', 'color', 'enabled', 'shortcuts'] as const;

/** Which keys each kind admits. Anything else is an error, because a typo that is ignored is a setting that silently does nothing. */
const SHORTCUT_KEYS: Record<ShortcutFileType, readonly string[]> = {
  app: ['type', 'name', 'icon', 'iconFile', 'target', 'launch', 'recents', 'terminalForRecents', 'terminalCommands', 'openTerminal', 'workingDirectory'],
  url: ['type', 'name', 'icon', 'iconFile', 'target', 'launch'],
  folder: ['type', 'name', 'icon', 'iconFile', 'target'],
  file: ['type', 'name', 'icon', 'iconFile', 'target'],
  command: ['type', 'name', 'icon', 'iconFile', 'target', 'shell', 'window', 'workingDirectory'],
  group: ['type', 'name', 'icon', 'iconFile', 'items'],
};

/**
 * The kinds that find a picture by themselves — the program's icon, the file type's, the favicon.
 * For these a named glyph is a choice that replaces that picture; for the others it is simply the
 * icon.
 */
const FINDS_OWN_ICON: ReadonlySet<ShortcutFileType> = new Set(['app', 'file', 'url']);

/** An absolute path, a UNC path, or one that starts with a `%VARIABLE%`; an icon number may follow. */
const ICON_FILE_PATTERN = /^(%[^%\\/]+%|[A-Za-z]:[\\/]|\\\\)[^\r\n]*$/;

const sameIconFile = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();

const MAX_GROUP_DEPTH = 8;

/* ─────────────────────────────── Writing ─────────────────────────────── */

function shortcutKind(item: AppItem): ShortcutFileType {
  if (item.type === 'folder') return 'group';
  switch (item.commandType) {
    case 'url':
    case 'folder':
    case 'file':
    case 'command':
      return item.commandType;
    default:
      return 'app';
  }
}

function shortcutToFile(item: AppItem): Record<string, unknown> {
  const type = shortcutKind(item);
  const out: Record<string, unknown> = { type, name: item.label ?? '' };
  const icon = item.iconName?.trim();
  /**
   * On an app, a file or a site the glyph is only written when the user chose it: the automatic
   * picture is what that shortcut shows, and a glyph line would read back as a choice.
   */
  const glyphIsShown = !FINDS_OWN_ICON.has(type) || item.iconSource === 'custom';
  if (icon && icon !== SHORTCUT_DEFAULT_ICONS[type] && glyphIsShown) out.icon = icon;
  if (item.iconSource === 'custom' && item.customIconFile?.trim()) out.iconFile = item.customIconFile.trim();

  if (type === 'group') {
    out.items = (item.children ?? []).map(shortcutToFile);
    return out;
  }

  out.target = item.command ?? '';
  if (type === 'app' || type === 'url') {
    if (item.launchMode && item.launchMode !== 'normal') out.launch = item.launchMode;
  }
  if (type === 'app') {
    if (item.hasRecents) out.recents = true;
    if (item.openTerminalForRecents) out.terminalForRecents = true;
    if (item.terminalCommands?.length) out.terminalCommands = [...item.terminalCommands];
    if (item.openTerminal) out.openTerminal = true;
  }
  if (type === 'command') {
    out.shell = item.commandShell ?? 'powershell';
    out.window = item.commandWindow ?? 'open';
  }
  if ((type === 'app' || type === 'command') && item.workingDirectory) {
    out.workingDirectory = item.workingDirectory;
  }
  return out;
}

export function workspaceToFileText(workspace: Workspace): string {
  const body: Record<string, unknown> = { name: workspace.name };
  if (workspace.pickerIconName?.trim()) body.icon = workspace.pickerIconName.trim();
  if (workspace.pickerIconFile?.trim()) body.iconFile = workspace.pickerIconFile.trim();
  if (workspace.color) body.color = workspace.color;
  body.enabled = workspace.enabled !== false;
  body.shortcuts = (workspace.apps ?? []).map(shortcutToFile);
  return `// Rovyl workspace. Reference: ${WORKSPACE_FILE_DOCS_URL}\n${JSON.stringify(body, null, 2)}\n`;
}

/* ─────────────────────────────── Reading ─────────────────────────────── */

export interface WorkspaceFileError {
  message: string;
  /** 1-based. */
  line: number;
  column: number;
}

export type WorkspaceFileResult =
  | { ok: true; workspace: WorkspaceFileData }
  | { ok: false; error: WorkspaceFileError };

/** What the file says, before it is merged into a stored workspace. */
export interface WorkspaceFileData {
  name: string;
  icon?: string;
  iconFile?: string;
  color?: string;
  enabled: boolean;
  shortcuts: ShortcutFileData[];
}

export interface ShortcutFileData {
  type: ShortcutFileType;
  name: string;
  icon?: string;
  iconFile?: string;
  target: string;
  launch?: 'normal' | 'reuse' | 'prewarm';
  recents?: boolean;
  terminalForRecents?: boolean;
  terminalCommands?: string[];
  openTerminal?: boolean;
  workingDirectory?: string;
  shell?: 'powershell' | 'cmd';
  window?: 'open' | 'hidden';
  items?: ShortcutFileData[];
}

class FileError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

/** A parsed value that remembers where it began, so a rule broken three levels down can still point at its line. */
interface Node {
  value: unknown;
  offset: number;
  /** Only for objects: where each key was written. */
  keyOffsets?: Map<string, number>;
  /** Only for objects and arrays: the child nodes. */
  children?: Map<string, Node> | Node[];
}

function parseJsonc(text: string): Node {
  let i = 0;

  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') { i += 1; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) throw new FileError('This comment is never closed with */.', i);
        i = end + 2;
        continue;
      }
      return;
    }
  };

  const describe = (at: number) => (at >= text.length ? 'the end of the file' : `"${text[at]}"`);

  const parseString = (): string => {
    const start = i;
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length || text[i] === '\n') {
        throw new FileError('This text is never closed with a double quote.', start);
      }
      const c = text[i];
      if (c === '"') { i += 1; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in simple) { out += simple[e]; i += 2; continue; }
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        throw new FileError(
          `"\\${e ?? ''}" is not an escape JSON knows. A Windows path needs its backslashes doubled: "C:\\\\Tools".`,
          i,
        );
      }
      out += c;
      i += 1;
    }
  };

  const parseValue = (): Node => {
    skip();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i += 1;
      const value: Record<string, unknown> = {};
      const keyOffsets = new Map<string, number>();
      const children = new Map<string, Node>();
      skip();
      while (text[i] !== '}') {
        if (text[i] !== '"') throw new FileError(`Expected a "key" in double quotes, found ${describe(i)}.`, i);
        const keyAt = i;
        const key = parseString();
        if (keyOffsets.has(key)) throw new FileError(`"${key}" is written twice in the same object.`, keyAt);
        skip();
        if (text[i] !== ':') throw new FileError(`Expected ":" after "${key}", found ${describe(i)}.`, i);
        i += 1;
        const child = parseValue();
        value[key] = child.value;
        keyOffsets.set(key, keyAt);
        children.set(key, child);
        skip();
        if (text[i] === ',') { i += 1; skip(); continue; }
        if (text[i] !== '}') throw new FileError(`Expected "," or "}" here, found ${describe(i)}. Is a comma missing?`, i);
      }
      i += 1;
      return { value, offset: start, keyOffsets, children };
    }
    if (c === '[') {
      i += 1;
      const value: unknown[] = [];
      const children: Node[] = [];
      skip();
      while (text[i] !== ']') {
        const child = parseValue();
        value.push(child.value);
        children.push(child);
        skip();
        if (text[i] === ',') { i += 1; skip(); continue; }
        if (text[i] !== ']') throw new FileError(`Expected "," or "]" here, found ${describe(i)}. Is a comma missing?`, i);
      }
      i += 1;
      return { value, offset: start, children };
    }
    if (c === '"') return { value: parseString(), offset: start };
    const word = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))?.[0];
    if (word) {
      i += word.length;
      const value = word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : Number(word);
      return { value, offset: start };
    }
    if (c === "'") throw new FileError('Text goes in double quotes, not single quotes.', i);
    throw new FileError(`Expected a value, found ${describe(i)}.`, i);
  };

  const root = parseValue();
  skip();
  if (i < text.length) throw new FileError(`Unexpected ${describe(i)} after the end of the workspace.`, i);
  return root;
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** The allowed word a typo was probably aiming at: same letters in another case, or two edits away. */
function nearest(word: string, options: readonly string[]): string | null {
  const a = word.toLowerCase();
  const distance = (b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= b.length; j += 1) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[b.length];
  };
  let best: string | null = null;
  let bestScore = Infinity;
  for (const option of options) {
    const score = distance(option.toLowerCase());
    if (score < bestScore) { best = option; bestScore = score; }
  }
  return bestScore <= Math.min(2, Math.max(1, Math.floor(a.length / 2))) ? best : null;
}

function validateWorkspace(root: Node): WorkspaceFileData {
  expectObject(root, 'The file must be one workspace object, starting with "{".');
  checkKeys(root, WORKSPACE_KEYS, 'a workspace');

  const name = requireString(root, 'name', 'The workspace');
  if (!name.trim()) throw new FileError('"name" cannot be empty.', valueOffset(root, 'name'));
  const icon = optionalString(root, 'icon');
  if (icon) checkGlyphName(root, icon);
  const iconFile = optionalIconFile(root);
  const color = optionalString(root, 'color');
  if (color !== undefined && color !== '' && !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    throw new FileError('"color" must be a hex colour such as "#3b82f6".', valueOffset(root, 'color'));
  }
  const enabled = optionalBool(root, 'enabled') ?? true;

  const listNode = child(root, 'shortcuts');
  if (!listNode) throw new FileError('A workspace needs a "shortcuts" list, even an empty one: "shortcuts": [].', root.offset);
  const shortcuts = validateShortcutList(listNode, 'shortcuts', 0);
  return { name, icon: icon || undefined, iconFile, color: color || undefined, enabled, shortcuts };
}

function validateShortcutList(node: Node, where: string, depth: number): ShortcutFileData[] {
  if (!Array.isArray(node.value)) throw new FileError(`"${where}" must be a list: [ ... ].`, node.offset);
  if (depth > MAX_GROUP_DEPTH) throw new FileError(`Groups are nested more than ${MAX_GROUP_DEPTH} deep.`, node.offset);
  return (node.children as Node[]).map((entry, index) => validateShortcut(entry, `${where}[${index}]`, depth));
}

function validateShortcut(node: Node, where: string, depth: number): ShortcutFileData {
  expectObject(node, `Each entry in the list must be a shortcut object, starting with "{" (${where}).`);
  const rawType = child(node, 'type');
  if (!rawType) throw new FileError(`This shortcut has no "type". Use one of: ${SHORTCUT_FILE_TYPES.join(', ')}.`, node.offset);
  if (typeof rawType.value !== 'string' || !SHORTCUT_FILE_TYPES.includes(rawType.value as ShortcutFileType)) {
    const guess = typeof rawType.value === 'string' ? nearest(rawType.value, SHORTCUT_FILE_TYPES) : null;
    throw new FileError(
      `"type" must be one of: ${SHORTCUT_FILE_TYPES.join(', ')}.${guess ? ` Did you mean "${guess}"?` : ''}`,
      rawType.offset,
    );
  }
  const type = rawType.value as ShortcutFileType;
  checkKeys(node, SHORTCUT_KEYS[type], `a "${type}" shortcut`);

  const name = requireString(node, 'name', 'A shortcut');
  const icon = optionalString(node, 'icon') || undefined;
  if (icon !== undefined) checkGlyphName(node, icon);
  const iconFile = optionalIconFile(node);

  if (type === 'group') {
    const items = child(node, 'items');
    if (!items) throw new FileError('A group needs an "items" list of shortcuts.', node.offset);
    return { type, name, icon, iconFile, target: '', items: validateShortcutList(items, `${where}.items`, depth + 1) };
  }

  let target = requireString(node, 'target', `A "${type}" shortcut`).trim();
  if (!target) throw new FileError('"target" cannot be empty.', valueOffset(node, 'target'));
  if (type === 'url') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:\/\//i.test(target)) {
      throw new FileError('A "url" target must be an http:// or https:// address.', valueOffset(node, 'target'));
    }
    target = normalizeSiteUrl(target);
    try {
      new URL(target);
    } catch {
      throw new FileError(`"${target}" is not a web address.`, valueOffset(node, 'target'));
    }
  }

  const out: ShortcutFileData = { type, name, icon, iconFile, target };
  if (type === 'app' || type === 'url') {
    const allowed = type === 'url' ? ['normal', 'reuse'] as const : ['normal', 'reuse', 'prewarm'] as const;
    out.launch = optionalEnum(node, 'launch', allowed);
  }
  if (type === 'app') {
    out.recents = optionalBool(node, 'recents');
    out.terminalForRecents = optionalBool(node, 'terminalForRecents');
    out.openTerminal = optionalBool(node, 'openTerminal');
    const commands = child(node, 'terminalCommands');
    if (commands) {
      if (!Array.isArray(commands.value) || commands.value.some((line) => typeof line !== 'string')) {
        throw new FileError('"terminalCommands" must be a list of command lines: ["npm install", "npm run dev"].', commands.offset);
      }
      out.terminalCommands = (commands.value as string[]).map((line) => line.trim()).filter(Boolean);
    }
  }
  if (type === 'command') {
    out.shell = optionalEnum(node, 'shell', ['powershell', 'cmd'] as const);
    out.window = optionalEnum(node, 'window', ['open', 'hidden'] as const);
  }
  if (type === 'app' || type === 'command') {
    out.workingDirectory = optionalString(node, 'workingDirectory')?.trim() || undefined;
  }
  return out;
}

function checkGlyphName(node: Node, icon: string) {
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(icon)) return;
  throw new FileError(
    /[\\/.]/.test(icon)
      ? '"icon" is a glyph name such as "Rocket". For a picture or a program\'s icon, use "iconFile".'
      : '"icon" is a Lucide icon name in PascalCase, such as "Rocket" or "FolderGit2".',
    valueOffset(node, 'icon'),
  );
}

function optionalIconFile(node: Node): string | undefined {
  const value = optionalString(node, 'iconFile')?.trim();
  if (!value) return undefined;
  if (!ICON_FILE_PATTERN.test(value)) {
    throw new FileError(
      '"iconFile" is the full path to a picture, an .ico or a program, such as "C:\\\\Icons\\\\app.png" or "%SystemRoot%\\\\System32\\\\shell32.dll,4".',
      valueOffset(node, 'iconFile'),
    );
  }
  return value;
}

function expectObject(node: Node, message: string) {
  if (!node.value || typeof node.value !== 'object' || Array.isArray(node.value)) throw new FileError(message, node.offset);
}

function child(node: Node, key: string): Node | undefined {
  return (node.children as Map<string, Node> | undefined)?.get(key);
}

function valueOffset(node: Node, key: string): number {
  return child(node, key)?.offset ?? node.offset;
}

function checkKeys(node: Node, allowed: readonly string[], what: string) {
  for (const [key, offset] of node.keyOffsets ?? []) {
    if (allowed.includes(key)) continue;
    const guess = nearest(key, allowed);
    throw new FileError(
      `"${key}" is not a setting of ${what}.${guess ? ` Did you mean "${guess}"?` : ` Allowed: ${allowed.join(', ')}.`}`,
      offset,
    );
  }
}

function requireString(node: Node, key: string, who: string): string {
  const found = child(node, key);
  if (!found) throw new FileError(`${who} needs a "${key}".`, node.offset);
  if (typeof found.value !== 'string') throw new FileError(`"${key}" must be text in double quotes.`, found.offset);
  return found.value;
}

function optionalString(node: Node, key: string): string | undefined {
  const found = child(node, key);
  if (!found || found.value === null) return undefined;
  if (typeof found.value !== 'string') throw new FileError(`"${key}" must be text in double quotes.`, found.offset);
  return found.value;
}

function optionalBool(node: Node, key: string): boolean | undefined {
  const found = child(node, key);
  if (!found || found.value === null) return undefined;
  if (typeof found.value !== 'boolean') throw new FileError(`"${key}" must be true or false, without quotes.`, found.offset);
  return found.value;
}

function optionalEnum<T extends string>(node: Node, key: string, allowed: readonly T[]): T | undefined {
  const found = child(node, key);
  if (!found || found.value === null) return undefined;
  if (typeof found.value !== 'string' || !allowed.includes(found.value as T)) {
    throw new FileError(`"${key}" must be one of: ${allowed.map((v) => `"${v}"`).join(', ')}.`, found.offset);
  }
  return found.value as T;
}

export function parseWorkspaceFile(text: string): WorkspaceFileResult {
  try {
    return { ok: true, workspace: validateWorkspace(parseJsonc(text)) };
  } catch (error) {
    if (error instanceof FileError) {
      return { ok: false, error: { message: error.message, ...position(text, error.offset) } };
    }
    return { ok: false, error: { message: String((error as Error)?.message ?? error), line: 1, column: 1 } };
  }
}

/* ─────────────────────────────── Merging ─────────────────────────────── */

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

const matchKey = (type: ShortcutFileType, nameOrTarget: string) => `${type}\u0000${nameOrTarget.trim().toLowerCase()}`;

/**
 * Existing shortcuts, indexed by what the file can still say about them: kind + target, or kind +
 * name for a group. Each is handed out once, so two identical lines do not share one id.
 */
function indexExisting(items: AppItem[], pool = new Map<string, AppItem[]>()): Map<string, AppItem[]> {
  for (const item of items) {
    const type = shortcutKind(item);
    const key = matchKey(type, type === 'group' ? item.label ?? '' : item.command ?? '');
    pool.set(key, [...(pool.get(key) ?? []), item]);
    if (item.children?.length) indexExisting(item.children, pool);
  }
  return pool;
}

/** A picture the file names that is not the one already stored for it — the caller imports it. */
export interface PictureRequest {
  /** The shortcut that receives it; absent for the workspace's own icon. */
  itemId?: string;
  file: string;
}

interface MergeState {
  pool: Map<string, AppItem[]>;
  /** New apps, files and sites, still without the picture they find by themselves. */
  needsIcon: AppItem[];
  needsPicture: PictureRequest[];
}

function buildItem(data: ShortcutFileData, state: MergeState): AppItem {
  const key = matchKey(data.type, data.type === 'group' ? data.name : data.target);
  const previous = state.pool.get(key)?.shift();
  const id = previous?.id ?? newId();
  const defaultIcon = SHORTCUT_DEFAULT_ICONS[data.type];
  const findsOwnIcon = FINDS_OWN_ICON.has(data.type);
  const wasCustom = previous?.iconSource === 'custom';
  let iconName = data.icon ?? defaultIcon;

  /** The icon rules are spelled out on `applyWorkspaceFile`. */
  let icon: Pick<AppItem, 'iconSource' | 'customIconUrl' | 'customIconFile'>;
  let needsAutomaticIcon = false;
  if (data.iconFile) {
    const kept = wasCustom && Boolean(previous!.customIconUrl) && sameIconFile(previous!.customIconFile, data.iconFile);
    icon = { iconSource: 'custom', customIconFile: data.iconFile, ...(kept ? { customIconUrl: previous!.customIconUrl } : {}) };
    if (!kept) state.needsPicture.push({ itemId: id, file: data.iconFile });
  } else if (wasCustom && previous!.customIconUrl && !previous!.customIconFile) {
    icon = { iconSource: 'custom', customIconUrl: previous!.customIconUrl };
  } else if (findsOwnIcon && data.icon !== undefined && data.icon !== defaultIcon) {
    icon = { iconSource: 'custom' };
  } else if (findsOwnIcon && previous && !wasCustom) {
    /** A bitmap belongs to the target it was extracted from; a matched shortcut still has that target. */
    icon = { iconSource: previous.iconSource, ...(previous.customIconUrl ? { customIconUrl: previous.customIconUrl } : {}) };
    /** Not written to the file, so not the file's to change: it is only the fallback under the picture. */
    iconName = previous.iconName;
  } else if (findsOwnIcon) {
    /** New, or back from a custom icon: the picture it finds by itself is fetched after applying. */
    icon = { iconSource: 'lucide' };
    needsAutomaticIcon = true;
  } else {
    icon = { iconSource: previous && !wasCustom ? previous.iconSource : 'lucide' };
  }

  if (data.type === 'group') {
    return {
      id,
      type: 'folder',
      label: data.name,
      iconName,
      ...icon,
      command: '',
      description: previous?.description ?? SHORTCUT_DESCRIPTIONS.group,
      children: (data.items ?? []).map((entry) => buildItem(entry, state)),
    };
  }

  const item: AppItem = {
    id,
    type: 'app',
    label: data.name,
    iconName,
    ...icon,
    command: data.target,
    commandType: data.type,
    description: previous?.description ?? SHORTCUT_DESCRIPTIONS[data.type],
  };
  if (data.launch && data.launch !== 'normal') item.launchMode = data.launch;
  if (data.recents) item.hasRecents = true;
  if (data.terminalForRecents) item.openTerminalForRecents = true;
  if (data.terminalCommands?.length) item.terminalCommands = data.terminalCommands;
  if (data.openTerminal) item.openTerminal = true;
  if (data.workingDirectory) item.workingDirectory = data.workingDirectory;
  if (data.type === 'command') {
    item.commandShell = data.shell ?? 'powershell';
    item.commandWindow = data.window ?? 'open';
  }
  if (needsAutomaticIcon) state.needsIcon.push(item);
  return item;
}

/**
 * The stored workspace the file describes, plus the icons still to fetch: `needsIcon` are the
 * shortcuts that have to find their own picture (the caller does it the way the add forms do), and
 * `needsPicture` the `iconFile`s that are not already stored.
 *
 * Icons, for the workspace and for every shortcut:
 *  - `iconFile` is the picture. The stored one is kept only if it came from that same file.
 *  - no `iconFile`: a picture that was pasted is kept, since the file has no way to name it; any
 *    other custom picture goes.
 *  - on an app, a file or a site, `icon` naming a glyph other than the default replaces the
 *    picture the shortcut finds by itself; leaving it out gives that picture back.
 */
export function applyWorkspaceFile(
  current: Workspace,
  data: WorkspaceFileData,
  options: { isActive: boolean },
): { workspace: Workspace; needsIcon: AppItem[]; needsPicture: PictureRequest[] } {
  const state: MergeState = { pool: indexExisting(current.apps ?? []), needsIcon: [], needsPicture: [] };
  const apps = data.shortcuts.map((entry) => buildItem(entry, state));

  let pickerIconUrl: string | undefined;
  if (data.iconFile) {
    if (current.pickerIconUrl && sameIconFile(current.pickerIconFile, data.iconFile)) pickerIconUrl = current.pickerIconUrl;
    else state.needsPicture.push({ file: data.iconFile });
  } else if (current.pickerIconUrl && !current.pickerIconFile) {
    pickerIconUrl = current.pickerIconUrl;
  }

  const workspace: Workspace = {
    ...current,
    name: data.name.trim(),
    /** The current workspace cannot be hidden — the Settings switch refuses it too. */
    enabled: options.isActive ? true : data.enabled,
    /**
     * `undefined`, not deleted: the result is spread over the stored workspace as a patch, and a
     * missing key would leave the old icon in place after the line naming it was removed.
     */
    pickerIconName: data.icon,
    pickerIconUrl,
    pickerIconFile: data.iconFile,
    color: data.color,
    apps,
  };
  return { workspace, needsIcon: state.needsIcon, needsPicture: state.needsPicture };
}
