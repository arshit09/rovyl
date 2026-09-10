/**
 * What `execute-command` answers with when it fails, turned into a sentence a person can read.
 *
 * The string that arrives is still the one that was always sent — `Failed to run "…". Error: <stderr>`
 * — and, since the change that accompanies this file, a second optional argument carrying the facts
 * already separated. There is deliberately no React and no DOM here: it is input → output, so
 * `scripts/launch-failure-smoke.mjs` can run it under plain node.
 *
 * Two invariants this module exists to guarantee:
 *  - `title`, `message` and `hint` are short and single-line. The raw stderr leaves only through
 *    `raw`, and the card puts that behind "Details" in a box that scrolls. It was the absence of
 *    that separation that put eight lines of PowerShell in a red box over the Settings window.
 *  - classification prefers signals that are not prose — `errorCode`, the exit code, the probe on
 *    disk, the shape of the command. Windows in Portuguese answers "Acesso negado", and this app
 *    has users on that Windows.
 *
 * The suppression of global-shortcut registration noise does NOT live here: it stays in `App.tsx`,
 * ahead of this chunk being requested at all — otherwise a failure nobody will see would go and
 * fetch `framer-motion`.
 */

/** Facts the main process attaches to the string. All optional: the string alone still classifies. */
export interface ExecutionErrorDetails {
  command?: string;
  resolvedCommand?: string;
  commandType?: 'app' | 'url' | 'folder';
  /** Last rung of the ladder (`exec_direct`, `shell.openPath`, …) — the one that produced the error. */
  method?: string | null;
  /** Node's `err.code`: a string for `spawn` (`ENOENT`), a number (the exit code) for `exec`. */
  errorCode?: string | number | null;
  /**
   * `fs.existsSync` on the executable the main process parsed out of the command, or `null` when it
   * could not be parsed. Locale-independent, and the only signal that separates "the file is gone"
   * from "the shell refused a file that is right there" — Windows prints the same stderr for both.
   */
  exeExists?: boolean | null;
  raw?: string;
}

export type LaunchFailureCode =
  | 'empty-command'
  | 'key-simulator'
  | 'cancelled'
  | 'permission'
  | 'no-handler'
  | 'folder-missing'
  | 'missing-file'
  | 'start-app-gone'
  | 'unlaunchable-app-id'
  | 'not-found'
  | 'unexpected'
  | 'unknown';

export interface HumanFault {
  code: LaunchFailureCode;
  title: string;
  message: string;
  hint?: string;
  /** The full stderr (capped). This is what "Details" opens — and the only text without a fixed size. */
  raw: string;
  /** What the Copy button puts on the clipboard: a report, not just the dump. */
  report: string;
}

/**
 * Where the shortcut that failed lives, so the card can offer to open it.
 *
 * By id and not by index: the card outlives the launch by seconds, and a reorder or a delete in
 * Settings during those seconds would make an index point at a different shortcut. An id that no
 * longer resolves simply opens the workspace, which is the honest outcome.
 */
export interface FaultShortcutRef {
  workspaceIndex: number;
  /** The item as stored — for a shortcut nested in a group, its top-level ancestor is `rootId`. */
  appId: string;
  rootId: string;
}

/** What `App.tsx` holds: either a failure still to be translated, or a notice already written by hand. */
export type SurfacedFault =
  | {
      kind: 'launch';
      seq: number;
      raw: string;
      details?: ExecutionErrorDetails;
      appLabel?: string;
      /** Absent when the launch had no item behind it — a centre button bound to a raw command. */
      shortcut?: FaultShortcutRef;
    }
  | { kind: 'notice'; seq: number; title: string; message: string; hint?: string };

/** A PowerShell stderr brings eight lines; one that goes badly brings a thousand. */
const RAW_LIMIT = 4000;

const EXECUTABLE_SUFFIX = /\.(exe|lnk|bat|cmd|com|msi|ps1|url)$/i;
/**
 * A file Windows can open but `exec_direct` cannot start as a program. Without this, a shortcut
 * to `gpedit.msc` is dotted, has no `!` and is not path-like — the exact shape of a vendor id —
 * and would be told it is "an internal ID", which is both wrong and unactionable.
 */
const DATA_FILE_SUFFIX =
  /\.(msc|cpl|vbs|vbe|wsf|wsh|jse|hta|scr|jar|py|pyw|rb|pl|php|sh|ahk|reg|inf|chm|appref-ms|txt|pdf|zip|docx?|xlsx?|pptx?)$/i;
const PATH_LIKE = /^[A-Za-z]:[\\/]|^\\\\|[\\/]/;
/**
 * `Telegram.TelegramDesktop`, `Anysphere.Cursor`, `electron.app.Foo`: a vendor id, not a program.
 * Real MSIX AUMIDs always carry a `!` — see the note at `backend/electron-main.js:5191`.
 */
const VENDOR_STYLE_ID = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

const unquote = (value: string) => value.replace(/^"([\s\S]*)"$/, '$1');

/** Not one newline leaves here for the body of the card: that is the difference from the old box. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** First token of the command, quotes resolved; the rest are arguments. */
const executablePart = (command: string): string => {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const space = trimmed.indexOf(' ');
  return space > 0 ? trimmed.slice(0, space) : trimmed;
};

/** The name the sentence calls the app. The item's label always wins: it is what was on the wheel. */
const subjectOf = (appLabel: string | undefined, exe: string): string => {
  const label = (appLabel || '').trim();
  if (label) return truncate(label, 34);
  const bare = unquote(exe).replace(/[\\/]+$/, '');
  const base = bare.split(/[\\/]/).pop() || bare;
  const named = base.replace(EXECUTABLE_SUFFIX, '');
  /**
   * `Telegram.TelegramDesktop` → `TelegramDesktop`, and only ever for a bare vendor id. A real file
   * keeps its dots: dropping everything before the last one turned `python3.11.exe` into "11" and
   * `vlc-3.0.20-win64.exe` into "20-win64".
   */
  const tail = !PATH_LIKE.test(bare) && VENDOR_STYLE_ID.test(named)
    ? named.split('.').pop() || named
    : named;
  return tail ? truncate(tail, 34) : 'this app';
};

const build = (
  code: LaunchFailureCode,
  title: string,
  message: string,
  hint: string | undefined,
  raw: string,
  details: ExecutionErrorDetails | undefined,
): HumanFault => ({
  code,
  /** One line each, with a ceiling. The card still clips with an ellipsis, but should never need to. */
  title: truncate(oneLine(title), 60),
  message: truncate(oneLine(message), 160),
  hint: hint ? truncate(oneLine(hint), 140) : undefined,
  raw,
  report: [
    'Rovyl launch failure',
    `Code: ${code}`,
    details?.command ? `Command: ${details.command}` : null,
    details?.resolvedCommand && details.resolvedCommand !== details.command
      ? `Resolved: ${details.resolvedCommand}`
      : null,
    details?.commandType ? `Type: ${details.commandType}` : null,
    details?.method ? `Method: ${details.method}` : null,
    details?.errorCode !== undefined && details?.errorCode !== null
      ? `Error code: ${details.errorCode}`
      : null,
    details?.exeExists === true || details?.exeExists === false
      ? `Executable on disk: ${details.exeExists ? 'yes' : 'no'}`
      : null,
    '',
    raw,
  ]
    .filter((line): line is string => line !== null)
    .join('\n'),
});

export function humanizeExecutionError(
  message: string,
  details?: ExecutionErrorDetails,
  appLabel?: string,
): HumanFault {
  const raw = String(message ?? '').slice(0, RAW_LIMIT);

  /**
   * These two are born as literals in `backend/electron-main.js` (:5389 and :5505) and carry no
   * details at all — comparing the whole string is what there is, and it is stable.
   */
  if (raw === 'Empty or invalid command') {
    return build(
      'empty-command',
      'Nothing to launch',
      'This shortcut has no app attached to it, so there is nothing for Rovyl to open.',
      'Open Settings, remove the shortcut, and add it again.',
      raw,
      details,
    );
  }
  if (raw === 'Failed to start key simulator') {
    return build(
      'key-simulator',
      'Shortcut keys did not fire',
      'Rovyl could not start the small helper that presses keys for you — PowerShell may be blocked on this PC.',
      'Restart Rovyl; if it keeps failing, reinstall it.',
      raw,
      details,
    );
  }

  const parsed = /^Failed to run "([\s\S]*?)"\. Error: ([\s\S]*)$/.exec(raw);
  const isUnexpected = raw.startsWith('Unexpected error while running command:');

  /** Without `details` there is only the string, and in it the command is cut to 50 chars by main. */
  const command = (details?.command || (parsed ? parsed[1].replace(/\.\.\.$/, '') : '')).trim();
  const stderr = details?.raw || (parsed ? parsed[2] : raw);
  const commandType = details?.commandType;
  const errorCode = details?.errorCode ?? null;
  const exitCode = typeof errorCode === 'number' ? errorCode : null;
  const exeExists = details?.exeExists ?? null;
  const exe = executablePart(details?.resolvedCommand || command);
  const bareExe = unquote(exe);
  const subject = subjectOf(appLabel, exe);
  const has = (pattern: RegExp) => pattern.test(stderr);

  const cancelled =
    exitCode === 1223 ||
    has(/ERROR_CANCELLED|operation was cancell?ed by the user|opera[çc][ãa]o (foi )?cancelada/i);
  const denied =
    errorCode === 'EACCES' ||
    errorCode === 'EPERM' ||
    exitCode === 5 ||
    has(/access is denied|acesso negado|unauthorizedaccess|requires elevation|running scripts is disabled on this system/i);
  const missing =
    errorCode === 'ENOENT' ||
    exitCode === 2 ||
    exitCode === 3 ||
    /** pt-BR says "arquivo" and "não pode encontrar"; pt-PT says "ficheiro" and "não consegue". */
    has(/cannot find the (file|path) specified|cannot find path|could not find file|itemnotfoundexception|n[ãa]o (conseguiu|consegue|pode|foi poss[íi]vel) encontrar o (ficheiro|arquivo|caminho)/i);
  const notRecognised =
    exitCode === 9009 ||
    has(/is not recognized as (the name of a cmdlet|an internal or external command)|commandnotfoundexception|objectnotfound|n[ãa]o [ée] reconhecido como/i);
  const noHandler =
    exitCode === 1155 ||
    has(/no application is associated|class not registered|n[ãa]o (h[áa]|existe) (nenhuma )?aplica[çc][ãa]o associada/i);

  /**
   * The order is what does the work. A cancelled elevation also writes "requires elevation", and
   * `CommandNotFoundException` fires both for a vendor id and for a wrong name — only the shape of
   * the command separates them.
   */
  if (cancelled) {
    return build(
      'cancelled',
      'Launch cancelled',
      `The Windows administrator prompt for ${subject} was dismissed.`,
      'Launch it again and choose Yes on the prompt.',
      raw,
      details,
    );
  }

  if (denied) {
    return build(
      'permission',
      'Windows blocked this launch',
      `Windows would not let Rovyl start ${subject} — it usually needs administrator rights, or a policy is blocking it.`,
      'Open it once from the Start menu to see what it asks for.',
      raw,
      details,
    );
  }

  /**
   * Main looked the app up in the Start menu and it is not there. That verdict is exact, so it is
   * read before any of the text signals below — and it has to be, because a Start menu shortcut is
   * stored as `shell:AppsFolder\<AppID>` and `URL_SCHEME` reads that `shell:` as a link scheme:
   * left to fall through, an uninstalled app was announced as "No app handles this link".
   */
  if (details?.method === 'start-apps-probe') {
    return build(
      'start-app-gone',
      `Windows no longer lists ${subject}`,
      'This shortcut points at a Start menu entry that has gone — the app was uninstalled, or it changed its id when it updated.',
      'Remove the shortcut in Settings and add the app again from the list.',
      raw,
      details,
    );
  }

  /** A single letter before `:` is the drive `C:`, not a link scheme. */
  const schemeMatch = URL_SCHEME.exec(bareExe);
  const scheme = schemeMatch && schemeMatch[1].length > 1 ? schemeMatch[1].toLowerCase() : null;
  const isUri = commandType === 'url' || Boolean(scheme);
  /**
   * A link is decided here and nowhere else. `steam://run/440` contains a slash, so it satisfies
   * `PATH_LIKE`; and the probe in main stats the link itself, so `exeExists` comes back false for
   * every URI. Left to fall through, both said "the program file is gone — pick its .exe", about a
   * shortcut that has no executable at all.
   */
  if (isUri) {
    if (noHandler || missing || exeExists === false) {
      return build(
        'no-handler',
        'No app handles this link',
        `Nothing on this PC is registered to open ${scheme ? `${scheme}:` : 'this kind of'} links.`,
        'Install the app that owns this link, or edit the shortcut to a normal https:// address.',
        raw,
        details,
      );
    }
    return build(
      'unknown',
      `Could not open ${subject}`,
      'Windows would not open this link.',
      'Open Details to see exactly what Windows reported.',
      raw,
      details,
    );
  }

  /**
   * Every folder failure is a folder failure. `shell.openPath` — the only rung a folder ever gets
   * — rejects with Electron's bare "Failed to open path", which matches none of the text signals,
   * so requiring `missing` here dropped deleted folders into the missing-file copy instead.
   */
  if (commandType === 'folder') {
    return build(
      'folder-missing',
      'That folder is gone',
      'The folder this shortcut opens does not exist any more — it was moved, renamed, or deleted.',
      'Edit the shortcut in Settings and pick the folder again.',
      raw,
      details,
    );
  }

  /**
   * The probe outranks the prose. `exec_direct` builds `<terminal> /c <line>`, so a quoting or
   * argument-splitting slip on a file that is present prints the very same "is not recognized" —
   * and telling someone to re-add a shortcut that was never broken is worse than saying nothing.
   */
  const looksLikePath = PATH_LIKE.test(bareExe) || EXECUTABLE_SUFFIX.test(bareExe);
  const fileIsGone = exeExists === false || (exeExists === null && (missing || notRecognised));
  if (looksLikePath && fileIsGone) {
    return build(
      'missing-file',
      `${subject} is no longer here`,
      'The program file this shortcut points to is gone — the app was probably uninstalled, moved, or updated into a new folder.',
      'Re-add it in Settings with Application → Choose file, or remove the shortcut.',
      raw,
      details,
    );
  }

  /**
   * The case in the user's screenshot. `Get-StartApps` hands back the shortcut's AppUserModelID
   * when it carries one (`Telegram.TelegramDesktop`), the app stores it verbatim, and no Windows
   * shell knows how to start that: `exec_direct` ends up passing the id itself to PowerShell and
   * what comes back is the whole `CommandNotFoundException`. Same family already documented at
   * `backend/electron-main.js:5129` and `:5191`.
   */
  if (
    !looksLikePath &&
    !DATA_FILE_SUFFIX.test(bareExe) &&
    !bareExe.includes('!') &&
    VENDOR_STYLE_ID.test(bareExe) &&
    !isUnexpected
  ) {
    return build(
      'unlaunchable-app-id',
      `Could not open ${subject}`,
      'Windows gave Rovyl an internal ID for this app instead of the program file, and that ID cannot be started on its own.',
      'In Settings, remove this shortcut and add it again with Application → Choose file, pointing at the app’s .exe.',
      raw,
      details,
    );
  }

  if (notRecognised && exeExists !== true) {
    return build(
      'not-found',
      `Could not open ${subject}`,
      'Windows does not know a program by that name — it may have been renamed, or it was never installed on this PC.',
      'Re-add the shortcut in Settings with Application → Choose file.',
      raw,
      details,
    );
  }

  if (isUnexpected) {
    return build(
      'unexpected',
      'Something went wrong',
      `Rovyl hit an unexpected problem while starting ${subject}.`,
      'Try again; if it keeps happening, restart Rovyl.',
      raw,
      details,
    );
  }

  return build(
    'unknown',
    `Could not open ${subject}`,
    'Rovyl tried several ways to start it and Windows refused every one.',
    'Open Details to see exactly what Windows reported.',
    raw,
    details,
  );
}
