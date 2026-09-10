/**
 * Ensures absolute Windows paths with spaces are stored quoted (picker / paste).
 * The main process still canonicalizes on run — this avoids a fragile initial state in the UI.
 */
export function normalizeWindowsExecutablePickerPath(filePath: string): string {
  const t = (filePath || '').trim();
  if (!t) return t;
  if (t.startsWith('"')) return t;
  const isWinAbs = /^[a-zA-Z]:\\/.test(t) || /^\\\\/.test(t);
  if (!isWinAbs || !t.includes(' ')) return t;
  return `"${t.replace(/"/g, '')}"`;
}

/**
 * Turns a `Get-StartApps` AppID into a launch line.
 *
 * The picker lists Start menu entries, and their AppIDs are identifiers, not commands. Most of them
 * — `com.squirrel.Figma.Figma`, `c:.users.…capcut.exe`, `zoom.us.Zoom Video Meetings` — mean nothing
 * to `start` or `spawn`, so storing one as the command is what put "Windows cannot find…" in front
 * of anyone who added Figma or CapCut from the list. `shell:AppsFolder\<AppID>` is the route the
 * Start menu itself uses and it accepts every shape, including the bare aliases (`Chrome`) that no
 * amount of shape-guessing can tell apart from a plain command name.
 *
 * An AppID that is ALREADY an absolute path is left alone: many are (`C:\Games\…\Subnautica.exe`),
 * and a real path is worth more than a moniker — it carries arguments, it can be probed on disk
 * before launching, and the IDE/recents handling knows what to do with it.
 */
export function startMenuAppIdToLaunchCommand(appId: string): string {
  const id = (appId || '').trim();
  if (!id) return id;
  if (/^shell:appsfolder[\\/]/i.test(id)) return id;
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(id) || id.startsWith('\\\\');
  if (isWinAbs) return normalizeWindowsExecutablePickerPath(id);
  return `shell:AppsFolder\\${id}`;
}
