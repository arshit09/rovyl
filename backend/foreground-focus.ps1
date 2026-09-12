# Rovyl — persistent helper that steals the foreground for an HWND, and reports what holds it.
#
# The radial is revealed with ShowWindow(SW_SHOWNOACTIVATE) + always-on-top, so Windows applies
# the foreground lock: SetForegroundWindow called by the process itself (or by Electron's app.focus)
# is ignored and the window stays visible but with no keyboard — keys keep going to the app below.
# The documented way out of the lock is to share the input queue with the thread that IS in the
# foreground (AttachThreadInput) and only then ask for the foreground.
#
# Stays alive reading stdin ("FOCUS <hwnd>" / "FG" / "EXIT") because spawning a powershell costs
# hundreds of milliseconds — long enough for the user to start typing into the wrong window.
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

# The foreground snapshot the game-mode gate used to get from the `active-win` native addon.
#
# `active-win` pulled node-gyp and @mapbox/node-pre-gyp behind it — 11 deprecated packages and a
# network fetch on every install — to make four Win32 calls this host is already sitting next to.
# `backend/get-foreground-exe.ps1` had the same calls but paid a fresh powershell (and a WMI
# Win32_Process query) per open, which is the 1-2s that made it a fallback rather than the path.
# Here the process is already warm and QueryFullProcessImageNameW replaces the WMI query, so the
# whole answer costs a pipe round-trip.
Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public struct ROVYLRECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class RovylSnapshot {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ROVYLRECT lpRect);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr min, IntPtr max);

  const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int PROCESS_SET_QUOTA = 0x0100;

  public static bool TrimProcessMemory(int pid) {
    if (pid <= 0) return false;
    IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      return SetProcessWorkingSetSize(h, (IntPtr)(-1), (IntPtr)(-1));
    } finally {
      CloseHandle(h);
    }
  }

  public static int TrimProcesses(int[] pids) {
    int count = 0;
    if (pids == null) return 0;
    for (int i = 0; i < pids.Length; i++) {
      if (TrimProcessMemory(pids[i])) count++;
    }
    return count;
  }

  /**
   * GetWindowRect answers in physical pixels only for a per-monitor-aware process. Electron's main
   * process is per-monitor-v2 aware, so that is what `active-win` was returning from inside it, and
   * the bounds comparisons downstream are written against physical pixels. A non-aware powershell
   * would be handed virtualized coordinates instead and would silently change fullscreen detection
   * on any scaled display, so match Electron rather than take the default.
   */
  public static void MatchElectronDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static string ProcessPath(int pid) {
    if (pid <= 0) return "";
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      StringBuilder sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (QueryFullProcessImageNameW(h, 0, sb, ref size)) return sb.ToString(0, size);
      return "";
    } finally {
      CloseHandle(h);
    }
  }

  // Held in a field so the marshalled callback is not collected while EnumChildWindows runs.
  static readonly EnumWindowsProc childCallback = OnChildWindow;
  static IntPtr uwpChild;
  static string frameHostPath;

  static bool OnChildWindow(IntPtr hWnd, IntPtr lParam) {
    int pid;
    GetWindowThreadProcessId(hWnd, out pid);
    string candidate = ProcessPath(pid);
    if (candidate.Length > 0 && !candidate.Equals(frameHostPath, StringComparison.OrdinalIgnoreCase)) {
      uwpChild = hWnd;
      return false;
    }
    return true;
  }

  public static string Snapshot() {
    IntPtr hWnd = GetForegroundWindow();
    if (hWnd == IntPtr.Zero) return "||";
    int pid;
    GetWindowThreadProcessId(hWnd, out pid);
    string exe = ProcessPath(pid);

    /**
     * A Store app does not own its own top-level window: ApplicationFrameHost.exe does, and the
     * real executable is the odd one out among that frame's children. Without this walk every UWP
     * app in the foreground reports as ApplicationFrameHost.exe, so a per-app game-mode block on
     * one of them would match all of them.
     */
    if (exe.Length > 0 &&
        string.Equals(Path.GetFileName(exe), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
      uwpChild = IntPtr.Zero;
      frameHostPath = exe;
      try {
        EnumChildWindows(hWnd, childCallback, IntPtr.Zero);
        if (uwpChild != IntPtr.Zero) {
          int childPid;
          GetWindowThreadProcessId(uwpChild, out childPid);
          string childExe = ProcessPath(childPid);
          if (childExe.Length > 0) exe = childExe;
        }
      } catch { }
    }

    StringBuilder title = new StringBuilder(1024);
    GetWindowTextW(hWnd, title, title.Capacity);
    string caption = title.ToString().Replace('\r', ' ').Replace('\n', ' ');

    string bounds = "";
    ROVYLRECT r;
    if (GetWindowRect(hWnd, out r)) {
      int w = Math.Max(0, r.Right - r.Left);
      int h = Math.Max(0, r.Bottom - r.Top);
      bounds = r.Left + "," + r.Top + "," + w + "," + h;
    }

    // `<bounds>|<exe>|<title>`: a Windows path can never contain '|', so splitting on the first two
    // separators is unambiguous no matter what the window is called.
    return bounds + "|" + exe + "|" + caption;
  }
}
'@

[RovylSnapshot]::MatchElectronDpiAwareness()

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
  # Every FG reply is prefixed, because the answer carries an arbitrary window title and the reader
  # must never have to guess whether a line is a reply or a diagnostic.
  if ($line -eq 'FG') {
    try {
      Write-Output "FG|$([RovylSnapshot]::Snapshot())"
    } catch {
      Write-Output 'FG|||'
    }
    continue
  }
  $parts = $line.Split(' ')
  if ($parts[0] -eq 'TRIM') {
    try {
      $pids = @()
      if ($parts.Length -gt 1 -and $parts[1] -ne '') {
        $pids = $parts[1].Split(',') | ForEach-Object { [int]$_ }
      }
      $trimmed = [RovylSnapshot]::TrimProcesses($pids)
      [void][RovylSnapshot]::TrimProcessMemory([System.Diagnostics.Process]::GetCurrentProcess().Id)
      Write-Output "TRIM|OK|$trimmed"
    } catch {
      Write-Output "TRIM|ERR|$($_.Exception.Message)"
    }
    continue
  }
  if ($parts[0] -ne 'FOCUS' -or $parts.Length -lt 2) { continue }
  try {
    Write-Output (Invoke-ForegroundSteal $parts[1])
  } catch {
    Write-Output "ERR $($_.Exception.Message)"
  }
}
