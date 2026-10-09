Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Environment("PROCESS")("NODE_ENV") = "production"
' Windows names the running app from the exe's own resources, not from app.setName(). The rename
' and stamp are persistent and self-skipping, so this waits only on the first run after an install.
' On Error: this is the login-startup path, and no cosmetic step gets to stop Rovyl from starting --
' a node that is not on PATH here would otherwise abort the script outright.
On Error Resume Next
WshShell.Run "node scripts\brand-dev-electron.cjs --quiet", 0, True
On Error Goto 0
' Fall back to the stock name when branding could not run.
exePath = "node_modules\electron\dist\Rovyl.exe"
If Not fso.FileExists(exePath) Then exePath = "node_modules\electron\dist\electron.exe"
WshShell.Run """" & exePath & """ .", 0, False
