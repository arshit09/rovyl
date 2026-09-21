/**
 * The key that switches workspace while the wheel is open, shared by the wheel, the settings
 * recorder and the main process.
 *
 * Same reason as `radialBackKey`: main registers these as global shortcuts and the renderer keeps
 * a fallback handler for the same keystrokes, so "what key does this workspace answer to" has to
 * be answered in exactly one place. Two copies of that rule is a key that records in settings and
 * never fires on the wheel.
 */
import type { AppItem, UIConfig, Workspace } from '../types';
import { RESERVED_BACK_KEYS } from './radialBackKey';

/** No key at all — the workspace stays reachable through the picker wheel and the mouse wheel. */
export const WORKSPACE_KEY_NONE = '';

/**
 * Keys the wheel answers to before it ever looks at the workspace bindings. Binding one would not
 * override that branch, it would simply never fire — the same list, for the same reason, as the
 * back key's, and imported rather than repeated so the two cannot drift.
 */
export const RESERVED_WORKSPACE_KEYS = RESERVED_BACK_KEYS;

/**
 * The shipped key for a position: 1–9 counting down the list, nothing past the ninth.
 *
 * This is the DEFAULT, not the binding. It follows the position — reorder the list and the keys
 * follow — which is what `withPositionalHotkeys` has always done, and what anybody who never
 * touches the field still gets.
 */
export function positionalWorkspaceKey(index: number): string {
  return index < 9 ? String(index + 1) : WORKSPACE_KEY_NONE;
}

/**
 * The stored form of a recorded key: one character, upper case.
 *
 * Unlike the back key, digits are allowed — they are what this field ships with. `e.key` carries
 * the CHARACTER the layout produced, so the physical key someone pressed on AZERTY is stored as
 * the character it prints, which is the one they will press again.
 *
 * Returns `WORKSPACE_KEY_NONE` for anything that is not a single character, including the key
 * NAMES ("Escape", "F5") and an accelerator with modifiers in it ("Ctrl+P").
 */
export function normalizeWorkspaceKey(value: unknown): string {
  if (typeof value !== 'string') return WORKSPACE_KEY_NONE;
  const trimmed = value.trim();
  if (trimmed === '') return WORKSPACE_KEY_NONE;
  /** `Array.from` and not `.length`: an accented or non-Latin key can be more than one UTF-16 unit. */
  const chars = Array.from(trimmed);
  if (chars.length !== 1) return WORKSPACE_KEY_NONE;
  return chars[0].toUpperCase();
}

/**
 * What this workspace actually answers to.
 *
 * `hotkeyKey` is the override and its ABSENCE is meaningful: undefined means "whatever this
 * position gets", so a workspace nobody has edited keeps following its position forever. The empty
 * string is the deliberate "no key" — what taking a key away from a workspace leaves behind — and
 * it has to survive a reorder, which a positional default would not.
 *
 * A stored value that is not a single character is read as absent rather than as none: that is a
 * hand-edited or corrupted config, and falling back to the position leaves the workspace reachable
 * instead of silently mute.
 */
export function workspaceKeyAt(workspace: Pick<Workspace, 'hotkeyKey'>, index: number): string {
  const stored = workspace.hotkeyKey;
  if (typeof stored !== 'string') return positionalWorkspaceKey(index);
  if (stored.trim() === '') return WORKSPACE_KEY_NONE;
  return normalizeWorkspaceKey(stored) || positionalWorkspaceKey(index);
}

/** Whether this workspace is still on its positional default — what the recorder calls "Default". */
export function isDefaultWorkspaceKey(workspace: Pick<Workspace, 'hotkeyKey'>): boolean {
  return typeof workspace.hotkeyKey !== 'string';
}

/** Whether this keydown is that key. Modifiers disqualify it — only the bare key counts. */
export function isWorkspaceKeyEvent(
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  workspaceKey: string,
): boolean {
  if (!workspaceKey) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (Array.from(event.key).length !== 1) return false;
  return event.key.toUpperCase() === workspaceKey;
}

/** Why a recorded key was refused, or `null` when it is fine. `key` is the raw `e.key`. */
export function rejectWorkspaceKey(
  key: string,
  ctrl: boolean,
  alt: boolean,
  meta: boolean,
): string | null {
  if (ctrl || alt || meta) return 'Hold nothing — a workspace key is a single key on its own.';
  if ((RESERVED_WORKSPACE_KEYS as readonly string[]).includes(key)) {
    const shown = key === ' ' ? 'Space' : key;
    return `${shown} already does something on the wheel, so it would never reach the workspaces.`;
  }
  if (Array.from(key).length !== 1) return 'That is not a single key. Press a letter, a digit or a symbol.';
  return null;
}

/**
 * Every workspace that has a key, paired with its index — the list main registers while the wheel
 * is open, and the table the wheel's own keydown handler looks a pressed key up in.
 *
 * Two workspaces cannot both answer to K, and the recorder refuses to create that state, so this
 * only resolves duplicates that arrived some other way: a hand-edited config, an imported
 * workspace file, or — the one that happens by accident — a reorder. Record 3 for a workspace at
 * the top of the list, drag another into third place, and its positional default is now that same
 * digit.
 *
 * A RECORDED key therefore beats a positional one, whatever their order. The alternative is that
 * a key somebody deliberately chose stops working because an unrelated workspace was dragged
 * somewhere, and the one that gives way is the one whose key was never chosen in the first place.
 * Between two of the same kind, the earlier wins — an arbitrary rule, but a fixed one, where
 * registration order is neither.
 */
export function workspaceKeyBindings(
  config: Pick<UIConfig, 'workspaces'>,
): Array<{ key: string; index: number }> {
  const workspaces = config.workspaces || [];
  const bindings: Array<{ key: string; index: number }> = [];
  const seen = new Set<string>();

  const take = (recorded: boolean) => {
    workspaces.forEach((workspace, index) => {
      if (isDefaultWorkspaceKey(workspace) === recorded) return;
      const key = workspaceKeyAt(workspace, index);
      if (!key || seen.has(key)) return;
      seen.add(key);
      bindings.push({ key, index });
    });
  };
  take(true);
  take(false);

  /** In wheel order, not in claim order: this is read by people reading a log, and by nothing else. */
  return bindings.sort((a, b) => a.index - b.index);
}

/**
 * Who else in Rovyl already answers to this key.
 *
 * Only BARE keys can clash. An app shortcut of `Ctrl+Alt+P` and a workspace key of `P` are two
 * different keystrokes and both work; `P` and `P` are one keystroke that two features claim, and
 * whichever registers last wins in silence. Naming the holder is the whole point — "already used"
 * is not something anyone can act on, "already opens Figma in Main" is.
 */
export type WorkspaceKeyClash =
  | { kind: 'workspace'; label: string; index: number }
  | { kind: 'back'; label: string }
  | { kind: 'app'; label: string; workspaceIndex: number; appId: string };

export function findWorkspaceKeyClash(
  config: Pick<UIConfig, 'workspaces' | 'radialBackKey'>,
  key: string,
  excludeIndex: number,
): WorkspaceKeyClash | null {
  if (!key) return null;
  const workspaces = config.workspaces || [];

  for (let index = 0; index < workspaces.length; index++) {
    if (index === excludeIndex) continue;
    if (workspaceKeyAt(workspaces[index], index) === key) {
      return { kind: 'workspace', label: workspaces[index].name || `Workspace ${index + 1}`, index };
    }
  }

  if (normalizeWorkspaceKey(config.radialBackKey) === key) {
    return { kind: 'back', label: 'the back key' };
  }

  /** Depth-first: a shortcut on an item inside a folder is registered exactly like a root one. */
  const walk = (items: AppItem[], workspaceIndex: number, workspaceName: string): WorkspaceKeyClash | null => {
    for (const item of items || []) {
      if (item.shortcut && normalizeWorkspaceKey(item.shortcut) === key) {
        return {
          kind: 'app',
          label: `${item.label || 'a shortcut'} in ${workspaceName}`,
          workspaceIndex,
          appId: item.id,
        };
      }
      const nested = item.children?.length ? walk(item.children, workspaceIndex, workspaceName) : null;
      if (nested) return nested;
    }
    return null;
  };

  for (let index = 0; index < workspaces.length; index++) {
    const hit = walk(workspaces[index].apps, index, workspaces[index].name || `Workspace ${index + 1}`);
    if (hit) return hit;
  }

  return null;
}

/**
 * The config with the clashing binding taken away, so the key is free for its new owner.
 *
 * Clearing a workspace's key writes the explicit empty string rather than dropping the field:
 * absent means "follow the position", which would hand the key straight back on the next renumber.
 */
export function clearWorkspaceKeyClash(config: UIConfig, clash: WorkspaceKeyClash): UIConfig {
  if (clash.kind === 'back') return { ...config, radialBackKey: WORKSPACE_KEY_NONE };

  if (clash.kind === 'workspace') {
    return {
      ...config,
      workspaces: config.workspaces.map((workspace, index) =>
        index === clash.index ? { ...workspace, hotkeyKey: WORKSPACE_KEY_NONE } : workspace,
      ),
    };
  }

  const strip = (items: AppItem[]): AppItem[] =>
    items.map((item) => {
      const next = item.id === clash.appId ? { ...item, shortcut: '' } : item;
      return next.children?.length ? { ...next, children: strip(next.children) } : next;
    });

  return {
    ...config,
    workspaces: config.workspaces.map((workspace, index) =>
      index === clash.workspaceIndex ? { ...workspace, apps: strip(workspace.apps) } : workspace,
    ),
  };
}
