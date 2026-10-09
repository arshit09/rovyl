; Injected by electron-builder (see package.json build.nsis.include).
; Ensures the app fully exits — including child processes (e.g. PowerShell mouse hook) —
; so files under $INSTDIR are not locked during uninstall.

!macro customUnInit
  ; `cmd.exe /c` flashed a console window on screen in the middle of a silent update — the one
  ; visible sign the user ever got that anything was happening. nsExec runs the same command with
  ; no window at all and hands back its exit code.
  ; /T kills the process tree (important for spawned helpers).
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; The two seconds are for the handles of whatever was killed to drop. taskkill answers 0 when it
  ; killed something and non-zero when there was nothing to kill — which is now the normal case,
  ; since the app installs its updates from a closed state, and waiting two seconds for nothing
  ; only makes that update slower. "error" means taskkill never ran, where the wait is cheap
  ; insurance rather than a delay.
  ${If} $0 == 0
  ${OrIf} $0 == "error"
    Sleep 2000
  ${EndIf}
!macroend
