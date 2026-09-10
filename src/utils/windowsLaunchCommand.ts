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
