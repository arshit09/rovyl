/**
 * Entry for `scripts/launch-failure-smoke.mjs`. Kept as a real source file rather than a temp one
 * so it resolves `../src/launchFailure` through the project's own Vite config. Not imported by the
 * app.
 *
 * The stderr blobs below are the real thing, copied from the failures they describe — the first one
 * is the `CommandNotFoundException` that was printed whole into a red box over the Settings window.
 */
import { humanizeExecutionError } from "../src/launchFailure";

/** Exactly what `exec_direct` produced for a Start-Menu AppUserModelID stored as a command. */
const TELEGRAM_STDERR = `Command failed: powershell.exe /c Telegram.TelegramDesktop
Telegram.TelegramDesktop : The term 'Telegram.TelegramDesktop' is not recognized as the name of a
cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path
was included, verify that the path is correct and try again.
At line:1 char:1
+ Telegram.TelegramDesktop
+ ~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : ObjectNotFound: (Telegram.TelegramDesktop:String) [],
   CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException
`;

const telegramMessage = `Failed to run "Telegram.TelegramDesktop". Error: ${TELEGRAM_STDERR}`;

const isSingleLine = (value: string | undefined) =>
  value === undefined || !/[\r\n]/.test(value);

export function collect() {
  /** The screenshot, with the facts main now sends. */
  const telegram = humanizeExecutionError(
    telegramMessage,
    {
      command: "Telegram.TelegramDesktop",
      resolvedCommand: "Telegram.TelegramDesktop",
      commandType: "app",
      method: "exec_direct",
      errorCode: 1,
      exeExists: null,
      raw: TELEGRAM_STDERR,
    },
    "Telegram",
  );

  /** The same failure from a main process that has not been updated: string only, no details. */
  const telegramLegacy = humanizeExecutionError(telegramMessage);

  /** A path that is genuinely gone. */
  const uninstalled = humanizeExecutionError(
    'Failed to run "C:\\Apps\\Zed\\zed.exe". Error: spawn C:\\Apps\\Zed\\zed.exe ENOENT',
    {
      command: "C:\\Apps\\Zed\\zed.exe",
      resolvedCommand: "C:\\Apps\\Zed\\zed.exe",
      commandType: "app",
      method: "exec_silent_spawn",
      errorCode: "ENOENT",
      exeExists: false,
      raw: "spawn C:\\Apps\\Zed\\zed.exe ENOENT",
    },
    "Zed",
  );

  /**
   * The same stderr, but the probe says the file is right there — a quoting slip, not an uninstall.
   * Telling someone to re-add a shortcut that was never broken is the failure this guards.
   */
  const presentButRefused = humanizeExecutionError(
    'Failed to run "C:\\Apps\\Zed\\zed.exe". Error: Command failed',
    {
      command: "C:\\Apps\\Zed\\zed.exe",
      resolvedCommand: "C:\\Apps\\Zed\\zed.exe",
      commandType: "app",
      method: "exec_direct",
      errorCode: 1,
      exeExists: true,
      raw: "'C:\\Apps\\Zed\\zed.exe' is not recognized as an internal or external command",
    },
    "Zed",
  );

  /** Portuguese Windows: the prose signal misses, the structured one does not. */
  const deniedPortuguese = humanizeExecutionError(
    'Failed to run "C:\\Windows\\System32\\gpedit.msc". Error: Acesso negado',
    {
      command: "C:\\Windows\\System32\\gpedit.msc",
      commandType: "app",
      method: "exec_start",
      errorCode: null,
      exeExists: true,
      raw: "Acesso negado.",
    },
    "Group Policy",
  );

  const uacCancelled = humanizeExecutionError('Failed to run "setup.exe". Error: Command failed', {
    command: "setup.exe",
    commandType: "app",
    method: "exec_start",
    errorCode: 1223,
    exeExists: true,
    raw: "The requested operation requires elevation.",
  });

  const deadProtocol = humanizeExecutionError('Failed to run "steam://run/440". Error: failed', {
    command: "steam://run/440",
    commandType: "url",
    method: "shell.openExternal",
    errorCode: null,
    exeExists: null,
    raw: "No application is associated with the specified file for this operation.",
  });

  /**
   * A URL whose failure returns through main's outer catch: Electron's rejection has no `.code`
   * and its text matches no signal, so only the URI branch keeps this off the missing-file copy.
   * The probe stats the link itself, which is why `exeExists` arrives false for something that
   * never had an executable.
   */
  const deadUrlNoSignal = humanizeExecutionError(
    "Unexpected error while running command: Failed to open path",
    {
      command: "https://intranet.corp/portal",
      resolvedCommand: "https://intranet.corp/portal",
      commandType: "url",
      method: null,
      errorCode: null,
      exeExists: false,
      raw: "Failed to open path",
    },
  );

  /** A deleted folder: `shell.openPath` says only "Failed to open path" — no code, no keywords. */
  const deletedFolder = humanizeExecutionError(
    'Failed to run "D:\\Projects\\old". Error: Failed to open path',
    {
      command: "D:\\Projects\\old",
      resolvedCommand: "D:\\Projects\\old",
      commandType: "folder",
      method: "shell.openPath",
      errorCode: null,
      exeExists: false,
      raw: "Failed to open path",
    },
  );

  /** A bare alias Windows does not know — not dotted, so not a vendor id. */
  const bareAlias = humanizeExecutionError('Failed to run "zed". Error: not recognized', {
    command: "zed",
    resolvedCommand: "zed",
    commandType: "app",
    method: "exec_direct",
    errorCode: 9009,
    exeExists: null,
    raw: "'zed' is not recognized as an internal or external command, operable program or batch file.",
  });

  /** A data file: dotted and not path-like, but a real file — never "an internal ID". */
  const dataFile = humanizeExecutionError('Failed to run "gpedit.msc". Error: not recognized', {
    command: "gpedit.msc",
    resolvedCommand: "gpedit.msc",
    commandType: "app",
    method: "exec_direct",
    errorCode: 9009,
    exeExists: null,
    raw: "'gpedit.msc' is not recognized as an internal or external command",
  });

  const keySimulator = humanizeExecutionError("Failed to start key simulator");

  const emptyCommand = humanizeExecutionError("Empty or invalid command");
  const unknown = humanizeExecutionError('Failed to run "weird". Error: Unknown');

  /** Version numbers in a filename are not a vendor prefix. */
  const versionedExe = humanizeExecutionError(
    'Failed to run "C:\\Python311\\python3.11.exe". Error: spawn ENOENT',
    {
      command: "C:\\Python311\\python3.11.exe",
      resolvedCommand: "C:\\Python311\\python3.11.exe",
      commandType: "app",
      method: "exec_silent_spawn",
      errorCode: "ENOENT",
      exeExists: false,
      raw: "spawn C:\\Python311\\python3.11.exe ENOENT",
    },
  );

  /** pt-BR Windows: "arquivo", and "não pode encontrar". */
  const missingBrazilian = humanizeExecutionError(
    'Failed to run "C:\\Apps\\x.exe". Error: erro',
    {
      command: "C:\\Apps\\x.exe",
      resolvedCommand: "C:\\Apps\\x.exe",
      commandType: "app",
      method: "exec_start",
      errorCode: null,
      exeExists: null,
      raw: "O sistema não pode encontrar o arquivo especificado.",
    },
    "Thing",
  );

  /** A stderr that goes badly: the card must still be a card. */
  const flood = humanizeExecutionError(
    `Failed to run "x". Error: ${"noise ".repeat(5000)}`,
    { command: "x", commandType: "app", raw: "noise ".repeat(5000) },
  );

  /**
   * The pre-flight probe, which is a different failure from a launch that was attempted and lost.
   *
   * `shell.openPath` and `start ""` answer a deleted file with a modal Windows dialog that owns
   * the app's window, so the ladder never returns and no card ever appears. Main now stats the
   * target first and reports this instead — a message no shell wrote, so nothing in it matches the
   * stderr patterns. It has to classify on `exeExists` alone, and it has to say the same thing to
   * the user as the launch that failed the long way round.
   */
  const preflightMissingApp = humanizeExecutionError(
    'Failed to run "C:\\Apps\\Zed\\zed.exe". Error: Windows cannot find the file specified: C:\\Apps\\Zed\\zed.exe',
    {
      command: "C:\\Apps\\Zed\\zed.exe",
      resolvedCommand: "C:\\Apps\\Zed\\zed.exe",
      commandType: "app",
      method: "exists-probe",
      errorCode: "ENOENT",
      exeExists: false,
      raw: "Rovyl checked the path before launching it and Windows reports no such file:" + String.fromCharCode(10) + "C:\\Apps\\Zed\\zed.exe",
    },
    "Zed",
  );

  const preflightMissingFolder = humanizeExecutionError(
    'Failed to run "D:\\Projects\\gone". Error: Windows cannot find the folder specified: D:\\Projects\\gone',
    {
      command: "D:\\Projects\\gone",
      resolvedCommand: "D:\\Projects\\gone",
      commandType: "folder",
      method: "exists-probe",
      errorCode: "ENOENT",
      exeExists: false,
      raw: "Rovyl checked the path before launching it and Windows reports no such folder:" + String.fromCharCode(10) + "D:\\Projects\\gone",
    },
  );

  /**
   * A Start menu entry that is no longer registered — CapCut pins its version into its own AppID
   * (`…apps.9.5.0.4045.capcut.exe`), so updating the app is enough to strand the shortcut.
   *
   * The command is stored as `shell:AppsFolder\<AppID>`, and `shell:` is a URL scheme as far as the
   * scheme test is concerned: left to fall through, an uninstalled app was announced as "No app
   * handles this link", pointing at a link that does not exist. The `start-apps-probe` method has to
   * outrank the scheme.
   */
  const startMenuEntryGone = humanizeExecutionError(
    'Failed to run "c:.users.me.appdata.local.capcut.apps.9.5.0.4045.capcut.exe". Error: Windows no longer lists this app in the Start menu.',
    {
      command: "shell:AppsFolder\\c:.users.me.appdata.local.capcut.apps.9.5.0.4045.capcut.exe",
      resolvedCommand: "shell:AppsFolder\\c:.users.me.appdata.local.capcut.apps.9.5.0.4045.capcut.exe",
      commandType: "app",
      method: "start-apps-probe",
      errorCode: "ENOENT",
      exeExists: false,
      raw: "Rovyl checked the Start menu before launching and no installed app has this id.",
    },
    "CapCut",
  );

  const everyCase = [
    startMenuEntryGone,
    telegram,
    telegramLegacy,
    uninstalled,
    presentButRefused,
    deniedPortuguese,
    uacCancelled,
    deadProtocol,
    deadUrlNoSignal,
    deletedFolder,
    bareAlias,
    dataFile,
    keySimulator,
    emptyCommand,
    unknown,
    versionedExe,
    missingBrazilian,
    preflightMissingApp,
    preflightMissingFolder,
    flood,
  ];

  return {
    /** Not a link failure, and it must name the app rather than a scheme. */
    startMenuEntryGoneCode: startMenuEntryGone.code,
    startMenuEntryGoneNamesTheApp: startMenuEntryGone.title.includes("CapCut"),
    startMenuEntryGoneSaysNothingAboutLinks: !`${startMenuEntryGone.message} ${startMenuEntryGone.hint ?? ""}`
      .toLowerCase()
      .includes("link"),

    /** The probe must reach the same words as the launch that failed the long way round. */
    preflightMissingAppCode: preflightMissingApp.code,
    preflightMissingAppTitle: preflightMissingApp.title,
    preflightMatchesUninstalled: preflightMissingApp.message === uninstalled.message,
    preflightMissingFolderCode: preflightMissingFolder.code,

    // The screenshot names the real cause, and names the app the way the user does.
    telegramCode: telegram.code,
    telegramTitle: telegram.title,
    telegramKeepsRawForDetails: telegram.raw.includes("CommandNotFoundException"),

    // Without the new second IPC argument the same string still classifies from its own shape.
    telegramLegacyCode: telegramLegacy.code,
    telegramLegacySubjectFromCommand: telegramLegacy.title === "Could not open TelegramDesktop",

    uninstalledCode: uninstalled.code,
    // The probe overrules the prose: same "is not recognized", opposite conclusion.
    presentButRefusedCode: presentButRefused.code,

    deniedPortugueseCode: deniedPortuguese.code,
    uacCancelledCode: uacCancelled.code,
    deadProtocolCode: deadProtocol.code,
    deadProtocolNamesScheme: deadProtocol.message.includes("steam:"),

    // A link must never be told to go and pick an .exe: it has no executable to pick.
    deadUrlNoSignalCode: deadUrlNoSignal.code,
    noUrlCaseMentionsAnExe: ![deadProtocol, deadUrlNoSignal].some((f) =>
      `${f.message} ${f.hint ?? ""}`.includes(".exe"),
    ),

    deletedFolderCode: deletedFolder.code,
    bareAliasCode: bareAlias.code,
    // A real file with an extension Windows will not execute is not "an internal ID".
    dataFileCode: dataFile.code,
    keySimulatorCode: keySimulator.code,
    emptyCommandCode: emptyCommand.code,
    unknownCode: unknown.code,

    // "python3.11.exe" must not become "11".
    versionedExeTitle: versionedExe.title,
    missingBrazilianCode: missingBrazilian.code,

    // The three structural guarantees. These pin shape, not wording, so copy edits stay free.
    bodyIsSingleLine: everyCase.every(
      (f) => isSingleLine(f.title) && isSingleLine(f.message) && isSingleLine(f.hint),
    ),
    bodyExcludesStderr: everyCase.every(
      (f) =>
        !f.title.includes("CommandNotFoundException") &&
        !f.message.includes("CommandNotFoundException") &&
        !(f.hint ?? "").includes("CommandNotFoundException") &&
        !f.message.includes("Command failed"),
    ),
    bodyIsCapped: everyCase.every(
      (f) => f.title.length <= 60 && f.message.length <= 160 && (f.hint?.length ?? 0) <= 140,
    ),
    rawIsCapped: everyCase.every((f) => f.raw.length <= 4000),
    reportCarriesTheFacts:
      telegram.report.includes("Code: unlaunchable-app-id") &&
      telegram.report.includes("Method: exec_direct") &&
      telegram.report.includes("CommandNotFoundException"),
  };
}
