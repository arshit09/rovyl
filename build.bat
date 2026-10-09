@echo off
rem ===========================================================================
rem  Rovyl - double-click build and run
rem
rem  Rebuilds target\release\rovyl.exe, prints how long the build took, and
rem  starts the binary it just built.
rem
rem  It stops EVERY running rovyl.exe first, the copy installed under
rem  %LOCALAPPDATA% included. Two reasons, and both are hard: a running
rem  executable holds its own file open, so the link step would fail with
rem  "Access is denied"; and the launcher takes a named single-instance mutex,
rem  so a second copy would hand off to the first and exit without ever
rem  showing the build that was just made.
rem
rem  scripts\dev.ps1 still stops only this tree's copy - it is the careful
rem  door, for a session that must leave the installed Rovyl alone. This file
rem  is the blunt one: it exists to put the newest build on screen.
rem ===========================================================================

setlocal
title Rovyl build
cd /d "%~dp0"

set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "ROVYL_BUILD_STAMP=%TEMP%\rovyl-build-start.txt"
set "ROVYL_EXE=%~dp0target\release\rovyl.exe"

echo ===========================================================================
echo   Rovyl  -  cargo build --release  ^+  run
echo ===========================================================================
echo.

where cargo >nul 2>&1
if errorlevel 1 goto :nocargo

echo   Closing every running rovyl.exe...
rem  Wait-Process after Stop-Process, not just a sleep: the file lock and the
rem  mutex are released when the process is GONE, and a fixed delay is either
rem  too short on a loaded machine or wasted on every other run.
%PS% "$p = @(Get-Process -Name rovyl -ErrorAction SilentlyContinue); if ($p.Count) { $p | Stop-Process -Force -ErrorAction SilentlyContinue; $p | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; Write-Host ('  Stopped    : {0} running cop{1}' -f $p.Count, $(if ($p.Count -eq 1) { 'y' } else { 'ies' })) } else { Write-Host '  Stopped    : nothing was running' }; [DateTime]::UtcNow.Ticks | Set-Content -LiteralPath $env:ROVYL_BUILD_STAMP"
echo.

cargo build --release
set "RC=%ERRORLEVEL%"

echo.
echo ---------------------------------------------------------------------------
%PS% "$t0 = [long]( Get-Content -LiteralPath $env:ROVYL_BUILD_STAMP ); $e = [TimeSpan]::FromTicks( [DateTime]::UtcNow.Ticks - $t0 ); Write-Host ( '  Build time : {0}m {1:00}.{2:000}s' -f [int]$e.TotalMinutes, $e.Seconds, $e.Milliseconds )"

if not "%RC%"=="0" goto :failed

echo   Status     : OK
for %%F in ("%ROVYL_EXE%") do echo   Output     : %%~fF
for %%F in ("%ROVYL_EXE%") do echo   Size       : %%~zF bytes, written %%~tF
echo   Starting   : the build above, in the notification area
echo ---------------------------------------------------------------------------
del /q "%ROVYL_BUILD_STAMP%" >nul 2>&1
rem  `start` detaches, so this window can close while the launcher keeps
rem  running. The empty "" is the window title argument start insists on when
rem  the path it is given is quoted.
start "" "%ROVYL_EXE%"
echo.
echo   Press the trigger (Alt+Z by default) to open the wheel.
timeout /t 4 /nobreak >nul 2>&1
exit /b 0

:failed
echo   Status     : FAILED  -  cargo exited with code %RC%
echo ---------------------------------------------------------------------------
del /q "%ROVYL_BUILD_STAMP%" >nul 2>&1
echo.
echo   Nothing was started: the old copies are stopped and the build did not
echo   produce a new one. Fix the errors above and run this again.
echo.
pause
exit /b %RC%

:nocargo
echo   cargo is not on PATH.
echo   Install Rust from https://rustup.rs, then open a new window.
echo.
pause
exit /b 1
