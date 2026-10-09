@echo off
rem ===========================================================================
rem  Rovyl - double-click build
rem
rem  Rebuilds target\release\rovyl.exe and prints how long the build took.
rem
rem  A running executable holds its own file open, so the link step would fail
rem  with "Access is denied" - this stops the rovyl.exe started from THIS tree
rem  first, and only that one, never the copy installed under %LOCALAPPDATA%.
rem  Matching on the full path rather than the process name is the whole point,
rem  same rule as scripts\dev.ps1.
rem ===========================================================================

setlocal
title Rovyl build
cd /d "%~dp0"

set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "ROVYL_BUILD_STAMP=%TEMP%\rovyl-build-start.txt"

echo ===========================================================================
echo   Rovyl  -  cargo build --release
echo ===========================================================================
echo.

where cargo >nul 2>&1
if errorlevel 1 goto :nocargo

echo   Closing any rovyl.exe launched from this folder...
%PS% "Get-Process -Name rovyl -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($PWD.Path + '\*') } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; [DateTime]::UtcNow.Ticks | Set-Content -LiteralPath $env:ROVYL_BUILD_STAMP"
echo.

cargo build --release
set "RC=%ERRORLEVEL%"

echo.
echo ---------------------------------------------------------------------------
%PS% "$t0 = [long]( Get-Content -LiteralPath $env:ROVYL_BUILD_STAMP ); $e = [TimeSpan]::FromTicks( [DateTime]::UtcNow.Ticks - $t0 ); Write-Host ( '  Build time : {0}m {1:00}.{2:000}s' -f [int]$e.TotalMinutes, $e.Seconds, $e.Milliseconds )"

if not "%RC%"=="0" goto :failed

echo   Status     : OK
for %%F in ("target\release\rovyl.exe") do echo   Output     : %%~fF
for %%F in ("target\release\rovyl.exe") do echo   Size       : %%~zF bytes, written %%~tF
goto :done

:failed
echo   Status     : FAILED  -  cargo exited with code %RC%

:done
echo ---------------------------------------------------------------------------
del /q "%ROVYL_BUILD_STAMP%" >nul 2>&1
echo.
pause
exit /b %RC%

:nocargo
echo   cargo is not on PATH.
echo   Install Rust from https://rustup.rs, then open a new window.
echo.
pause
exit /b 1
