# Rovyl — persistent helper that steals the foreground for an HWND.
#
# The radial is revealed with ShowWindow(SW_SHOWNOACTIVATE) + always-on-top, so Windows applies
# the foreground lock: SetForegroundWindow called by the process itself (or by Electron's app.focus)
# is ignored and the window stays visible but with no keyboard — keys keep going to the app below.
# The documented way out of the lock is to share the input queue with the thread that IS in the
# foreground (AttachThreadInput) and only then ask for the foreground.
#
# Stays alive reading stdin ("FOCUS <hwnd>" / "EXIT") because spawning a powershell costs hundreds
# of milliseconds — long enough for the user to start typing into the wrong window.
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RovylForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

function Invoke-ForegroundSteal([string]$rawHandle) {
  $value = 0L
  if (-not [int64]::TryParse($rawHandle, [ref]$value) -or $value -eq 0) { return 'BADHWND' }
  $target = [IntPtr]$value
  if (-not [RovylForeground]::IsWindowVisible($target)) { return 'HIDDEN' }
  if ([RovylForeground]::GetForegroundWindow() -eq $target) { return 'ALREADY' }

  $foreground = [RovylForeground]::GetForegroundWindow()
  $foregroundThread = [RovylForeground]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
  $targetThread = [RovylForeground]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
  $selfThread = [RovylForeground]::GetCurrentThreadId()

  $attachedForeground = $false
  $attachedTarget = $false
  try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $selfThread) {
      $attachedForeground = [RovylForeground]::AttachThreadInput($selfThread, $foregroundThread, $true)
    }
    if ($targetThread -ne 0 -and $targetThread -ne $selfThread) {
      $attachedTarget = [RovylForeground]::AttachThreadInput($selfThread, $targetThread, $true)
    }

    # SW_SHOW (5): never SW_RESTORE — the window is transparent and a restore animates/flashes it.
    [void][RovylForeground]::ShowWindow($target, 5)
    [void][RovylForeground]::BringWindowToTop($target)
    [void][RovylForeground]::SetForegroundWindow($target)
    [void][RovylForeground]::SetFocus($target)
  } finally {
    if ($attachedTarget) { [void][RovylForeground]::AttachThreadInput($selfThread, $targetThread, $false) }
    if ($attachedForeground) { [void][RovylForeground]::AttachThreadInput($selfThread, $foregroundThread, $false) }
  }

  if ([RovylForeground]::GetForegroundWindow() -eq $target) { return 'OK' }
  return 'MISS'
}

Write-Output 'READY'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '' ) { continue }
  if ($line -eq 'EXIT') { break }
  $parts = $line.Split(' ')
  if ($parts[0] -ne 'FOCUS' -or $parts.Length -lt 2) { continue }
  try {
    Write-Output (Invoke-ForegroundSteal $parts[1])
  } catch {
    Write-Output "ERR $($_.Exception.Message)"
  }
}
