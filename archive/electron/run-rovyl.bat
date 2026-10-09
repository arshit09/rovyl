@echo off
title Rovyl Launcher
cd /d "%~dp0"
set NODE_ENV=production
if not exist "dist\index.html" (
    echo [Rovyl] Building app files for the first time...
    call npm run build
)
rem Windows names the running app from the exe, not from app.setName(). See scripts/brand-dev-electron.cjs.
node scripts\brand-dev-electron.cjs --quiet
rem Fall back to the stock name when branding could not run (no node on PATH, a locked binary).
set "ROVYL_EXE=node_modules\electron\dist\Rovyl.exe"
if not exist "%ROVYL_EXE%" set "ROVYL_EXE=node_modules\electron\dist\electron.exe"
start "" "%ROVYL_EXE%" .
exit
