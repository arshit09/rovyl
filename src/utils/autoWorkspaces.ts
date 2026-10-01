import type { AppItem, AutoWorkspacesConfig, CatalogEntry, UIConfig, Workspace } from '../types';

/**
 * The two workspaces Rovyl makes for itself: every installed app, grouped, and every game it found.
 *
 * They are VIRTUAL. The wheel appends them to what it draws; nothing here is ever written back, so
 * a saved config, an exported workspace file and the positional hotkeys of the user's own
 * workspaces stay exactly what the user made.
 */

/** What one ring shows legibly, and so the size of a Games folder. */
export const GAMES_FOLDER_SIZE = 12;

export const AUTO_APPS_ID = 'auto-apps';
export const AUTO_GAMES_ID = 'auto-games';

const CATEGORY_ORDER = [
  'Internet', 'Development', 'Multimedia', 'Office', 'Graphics', 'Utility', 'System', 'Settings', 'Other',
] as const;
export type MainCategory = (typeof CATEGORY_ORDER)[number];

/** freedesktop category names, each mapped to the one folder that holds it. */
const CATEGORY_OF: Record<string, MainCategory> = {
  Network: 'Internet', WebBrowser: 'Internet', Email: 'Internet', Chat: 'Internet', InstantMessaging: 'Internet',
  Development: 'Development', IDE: 'Development',
  AudioVideo: 'Multimedia', Audio: 'Multimedia', Video: 'Multimedia', Music: 'Multimedia', Player: 'Multimedia',
  Office: 'Office',
  Graphics: 'Graphics',
  Utility: 'Utility',
  System: 'System', Monitor: 'System', TerminalEmulator: 'System',
  Settings: 'Settings', DesktopSettings: 'Settings',
};

export function mainCategory(categories: string[]): MainCategory {
  for (const category of categories) {
    const found = CATEGORY_OF[category];
    if (found) return found;
  }
  return 'Other';
}

const byName = (a: CatalogEntry, b: CatalogEntry) => a.name.localeCompare(b.name);

function toItem(entry: CatalogEntry, icons: Record<string, string>): AppItem {
  const icon = icons[entry.id];
  return {
    id: `auto:${entry.id}`,
    type: 'app',
    label: entry.name,
    iconName: entry.kind === 'game' ? 'Gamepad2' : 'AppWindow',
    iconSource: icon ? 'native' : 'lucide',
    ...(icon ? { customIconUrl: icon } : {}),
    command: entry.command,
    commandType: 'app',
    description: '',
  };
}

function folder(id: string, label: string, iconName: string, children: AppItem[]): AppItem {
  return { id, type: 'folder', label, iconName, iconSource: 'lucide', command: '', commandType: 'folder', description: '', children };
}

const initial = (name: string) => {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(first) ? first : '#';
};

/** Near-equal A–Z groups of at most `GAMES_FOLDER_SIZE`, named by their first and last initial. */
function chunkByInitial(entries: CatalogEntry[], icons: Record<string, string>): AppItem[] {
  const groups = Math.ceil(entries.length / GAMES_FOLDER_SIZE);
  const size = Math.ceil(entries.length / groups);
  const folders: AppItem[] = [];
  for (let i = 0; i < entries.length; i += size) {
    const part = entries.slice(i, i + size);
    const first = initial(part[0].name);
    const last = initial(part[part.length - 1].name);
    folders.push(folder(`auto:games:${i / size}`, first === last ? first : `${first}–${last}`, 'Gamepad2', part.map((e) => toItem(e, icons))));
  }
  return folders;
}

const FOLDER_ICON: Record<MainCategory, string> = {
  Internet: 'Globe', Development: 'Code', Multimedia: 'Play', Office: 'FileText', Graphics: 'Image',
  Utility: 'Wrench', System: 'Cpu', Settings: 'Settings', Other: 'Folder',
};

/** 0–2 workspaces: All apps (category folders) and Games (flat, or A–Z folders past twelve). */
export function buildAutoWorkspaces(
  entries: CatalogEntry[],
  cfg: AutoWorkspacesConfig,
  icons: Record<string, string>,
): Workspace[] {
  const out: Workspace[] = [];

  if (cfg.apps) {
    const buckets = new Map<MainCategory, CatalogEntry[]>();
    for (const entry of entries.filter((e) => e.kind === 'app').sort(byName)) {
      const key = mainCategory(entry.categories);
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }
    const folders = CATEGORY_ORDER.filter((c) => buckets.has(c)).map((c) =>
      folder(`auto:apps:${c}`, c, FOLDER_ICON[c], buckets.get(c)!.map((e) => toItem(e, icons))),
    );
    if (folders.length) {
      out.push({ id: AUTO_APPS_ID, name: 'All apps', apps: folders, hotkey: 0, enabled: true, pickerIconName: 'LayoutGrid' });
    }
  }

  if (cfg.games) {
    const games = entries.filter((e) => e.kind === 'game').sort(byName);
    if (games.length) {
      const apps = games.length <= GAMES_FOLDER_SIZE ? games.map((e) => toItem(e, icons)) : chunkByInitial(games, icons);
      out.push({ id: AUTO_GAMES_ID, name: 'Games', apps, hotkey: 0, enabled: true, pickerIconName: 'Gamepad2' });
    }
  }

  return out;
}

export function isAutoWorkspace(workspace: Pick<Workspace, 'id'> | null | undefined): boolean {
  return workspace?.id === AUTO_APPS_ID || workspace?.id === AUTO_GAMES_ID;
}

/** The config the wheel draws: the user's workspaces, then the virtual ones. Same object when there are none. */
export function withAutoWorkspaces(config: UIConfig, extra: Workspace[]): UIConfig {
  if (!extra.length) return config;
  return { ...config, workspaces: [...(config.workspaces ?? []), ...extra] };
}
