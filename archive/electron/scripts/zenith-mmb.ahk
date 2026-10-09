; Zenith Radial Menu - MMB Shortcut
; This script maps the middle mouse button (MMB) to the Zenith shortcut (Alt+Z)

#NoEnv  ; Recommended for performance and compatibility with future AutoHotkey releases.
; #Warn  ; Enable warnings to assist with detecting common errors.
SendMode Input  ; Recommended for new scripts due to its superior speed and reliability.
SetWorkingDir %A_ScriptDir%  ; Ensures a consistent starting directory.

; Press MMB to run the action
MButton::
    ; Sends Alt+Z, the global shortcut defined in electron-main.js
    Send, !z
Return

; Test shortcut: Ctrl + MMB
^MButton::
    MsgBox, Zenith Radial Menu AHK Script is Active!
Return
