# Capture one of this build's windows to a PNG.
#
# It exists because a screenshot of the whole screen is a poor way to look at a window — the thing
# under test ends up one third of the image, scaled down, next to whatever else was open. This
# finds the window by CLASS within this build's own process, raises it, and captures exactly its
# rectangle.
#
#   scripts\shot.ps1 -Class RovylSettings -Out settings.png
param(
    [string] $Class = 'RovylSettings',
    [Parameter(Mandatory = $true)] [string] $Out,
    [int] $WaitMs = 600
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Shot {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Done in C# rather than in PowerShell because the callback has to write to a variable the
    // caller can read, and a PowerShell scriptblock's scope does not reliably survive being
    // marshalled through a native callback.
    static IntPtr found;
    static uint want;
    static string wantClass;
    public static IntPtr Find(uint processId, string className) {
        found = IntPtr.Zero; want = processId; wantClass = className;
        EnumWindows(Check, IntPtr.Zero);
        return found;
    }
    static bool Check(IntPtr h, IntPtr p) {
        uint owner; GetWindowThreadProcessId(h, out owner);
        if (owner != want) return true;
        var name = new StringBuilder(128);
        GetClassNameW(h, name, name.Capacity);
        if (name.ToString() == wantClass) { found = h; return false; }
        return true;
    }
}
'@

$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$proc = Get-Process -Name rovyl -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$here\*" } | Select-Object -First 1
if (-not $proc) { Write-Error "no rovyl process under $here"; exit 1 }

$hwnd = [Shot]::Find([uint32]$proc.Id, $Class)
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "no '$Class' window in pid $($proc.Id)"; exit 1 }

# HWND_TOP, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
[Shot]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x43) | Out-Null
Start-Sleep -Milliseconds $WaitMs

$r = New-Object Shot+RECT
[Shot]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error "window has no size ($w x $h)"; exit 1 }

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap([int]$w, [int]$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(
    (New-Object System.Drawing.Point([int]$r.Left, [int]$r.Top)),
    [System.Drawing.Point]::Empty,
    (New-Object System.Drawing.Size([int]$w, [int]$h)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$Class $($w)x$($h) -> $Out"
