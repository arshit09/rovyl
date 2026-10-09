# Line1 exe | Line2 title | Line3 cmdline | Line4 left,top,width,height (foreground HWND rect)
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public class ZFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  /**
   * The rect on line 4 has to be in the same units as the one the warm helper reports, because
   * both are handed to the same isBoundsFullscreenMonitor. A powershell left DPI-unaware is given
   * coordinates virtualized to the system DPI instead of physical pixels, which on a scaled
   * display is a third unit again — it would survive the conversion in the main process looking
   * plausible and be wrong by exactly the scale factor. Per-monitor-v2, same as Electron and same
   * as backend/foreground-focus.ps1.
   */
  public static void MatchElectronDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@ | Out-Null
[ZFG]::MatchElectronDpiAwareness()
$hwndFg = [ZFG]::GetForegroundWindow()
if ($hwndFg -eq [IntPtr]::Zero) { exit 1 }
$procId = 0
[void][ZFG]::GetWindowThreadProcessId($hwndFg, [ref]$procId)
if ($procId -le 0) { exit 1 }
$sb = New-Object System.Text.StringBuilder 4096
[void][ZFG]::GetWindowText($hwndFg, $sb, $sb.Capacity)
$titleRaw = $sb.ToString()
if (-not $titleRaw) { $titleRaw = "" }
$proc = $null
try {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
} catch {
  exit 1
}
$exe = $proc.ExecutablePath
if (-not $exe) { exit 1 }
$cmdLine = [string]$proc.CommandLine
if (-not $cmdLine) { $cmdLine = "" }
$one = { param($s) (($s -replace '[\r\n]+',' ').Trim().ToLowerInvariant()) }
Write-Output (& $one $exe)
Write-Output (& $one $titleRaw)
Write-Output (& $one $cmdLine)
try {
  $r = [RECT]::new()
  if ([ZFG]::GetWindowRect($hwndFg, [ref]$r)) {
    $bw = [Math]::Max(0, $r.Right - $r.Left)
    $bh = [Math]::Max(0, $r.Bottom - $r.Top)
    Write-Output "$($r.Left),$($r.Top),$bw,$bh"
  } else {
    Write-Output "0,0,0,0"
  }
} catch {
  Write-Output "0,0,0,0"
}
