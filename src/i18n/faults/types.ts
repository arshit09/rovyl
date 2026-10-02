/**
 * The sentences the fault card shows when a launch fails.
 *
 * They live beside `src/launchFailure.ts` rather than in it because that module is deliberately
 * free of React, of the DOM, and of any import that would drag a bundle behind it —
 * `scripts/launch-failure-smoke.mjs` runs it as plain input → output. So the classifier stays pure
 * and the words are handed IN: `humanizeExecutionError(raw, details, label, strings)`, defaulting
 * to English. The card passes the pack for the configured language.
 *
 * Same two-tier shape as `../wheel/`: English static, the rest behind one literal `import()` each.
 */
export interface LaunchFailureStrings {
  /** What the sentence calls an app whose name could not be worked out. */
  faultThisApp: string;
  /** empty-command title */
  faultNothingToLaunch: string;
  /** key-simulator title */
  faultKeysDidNotFire: string;
  /** cancelled title */
  faultLaunchCancelled: string;
  /** permission title */
  faultWindowsBlocked: string;
  /** start-app-gone title, carries {subject} */
  faultNoLongerListed: string;
  /** no-handler title */
  faultNoAppForLink: string;
  /** shared title, carries {subject} */
  faultCouldNotOpen: string;
  /** folder-missing title */
  faultFolderGone: string;
  /** file-no-handler title */
  faultNoAppForFile: string;
  /** file-missing title */
  faultFileGone: string;
  /** missing-file title, carries {subject} */
  faultNoLongerHere: string;
  /** unexpected title */
  faultSomethingWrong: string;
  /** empty-command message */
  msgEmptyCommand: string;
  /** key-simulator message */
  msgKeySimulator: string;
  /** cancelled message, carries {subject} */
  msgCancelled: string;
  /** permission message, carries {subject} */
  msgPermission: string;
  /** start-app-gone message */
  msgStartAppGone: string;
  /** no-handler message when the scheme is known, carries {scheme} */
  msgNoHandlerScheme: string;
  /** no-handler message when the scheme could not be read */
  msgNoHandlerGeneric: string;
  /** url unknown message */
  msgUrlRefused: string;
  /** folder-missing message */
  msgFolderMissing: string;
  /** file-no-handler message */
  msgFileNoHandler: string;
  /** file-missing message */
  msgFileMissing: string;
  /** file unknown message */
  msgFileRefused: string;
  /** missing-file message */
  msgProgramMissing: string;
  /** unlaunchable-app-id message */
  msgUnlaunchableAppId: string;
  /** not-found message */
  msgNotFound: string;
  /** unexpected message, carries {subject} */
  msgUnexpected: string;
  /** final unknown message */
  msgAllRefused: string;
  /** empty-command hint */
  hintReAddShortcut: string;
  /** key-simulator hint */
  hintRestartRovyl: string;
  /** cancelled hint */
  hintAcceptPrompt: string;
  /** permission hint */
  hintOpenFromStart: string;
  /** start-app-gone hint */
  hintRemoveAndReAdd: string;
  /** no-handler hint */
  hintInstallLinkApp: string;
  /** shared hint for the unknown cases */
  hintOpenDetails: string;
  /** folder-missing hint */
  hintPickFolderAgain: string;
  /** file-no-handler hint */
  hintInstallFileApp: string;
  /** file-missing hint */
  hintPickFileAgain: string;
  /** missing-file hint */
  hintReAddApp: string;
  /** unlaunchable-app-id hint */
  hintUseChooseFile: string;
  /** not-found hint */
  hintReAddChooseFile: string;
  /** unexpected hint */
  hintTryAgainRestart: string;
}
