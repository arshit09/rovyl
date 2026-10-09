# End-to-end smoke test for the click/hold classification in backend/mouse-blocker.ps1.
#
# Drives the real helper with SIMULATED PHYSICAL middle-button input (dwExtraInfo = 0, so the hook
# treats it as genuine hardware input rather than one of its own replays) and asserts two things:
#   1. which line the helper emits             -> decides whether Rovyl's wheel opens
#   2. what the window under the pointer gets   -> decides whether autoscroll can work
#
# SAFETY: a case that crosses the threshold makes the helper press a real middle button at the
# pointer. So the test puts its OWN borderless top-most window under the pointer to catch it -
# nothing reaches the user's browser or editor, and the shield doubles as the assertion target.
#
# Three PowerShell traps this deliberately avoids (none affect the product, which drives the helper
# from Node):
#   - OutputDataReceived with a scriptblock: converted to a delegate and invoked on a threadpool
#     thread, it hard-kills the runspace (exit 5, no output at all). Hence the C# reader thread.
#   - ReadLineAsync with a timeout: an abandoned task leaves the stream "in use by a previous
#     operation" and every later read throws.
#   - The child's console reader prefixes junk bytes onto the FIRST line it reads, whatever
#     encoding the parent writes with. The helper then sees an unknown command word and drops it
#     in silence. Hence raw ASCII bytes plus a throwaway priming line.
#
# NOT a headless test. It needs an interactive desktop session (it creates a window, parks the
# pointer inside it, and injects real mouse input) and must run under Windows PowerShell, since
# WinForms needs STA:
#   npm run test:trigger-gesture
#
# Run it with Rovyl CLOSED, and not twice at once. A second WH_MOUSE_LL hook in the chain - a live
# Rovyl, or an orphaned mouse-blocker.ps1 from an earlier run - sees this test's synthetic input
# first and makes the results intermittent: the classification lines stay correct but the replay
# stops reaching the shield, and the replayed pair can come back around as a fresh press.
# Symptom to recognise: "under-pointer=[]" on a case that expects the pair. Check for stray
# powershell.exe processes before believing a failure.

param([string]$ScriptPath)

if (-not $ScriptPath) {
    $ScriptPath = Join-Path $PSScriptRoot (Join-Path ".." (Join-Path "backend" "mouse-blocker.ps1"))
}
$ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path

Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class SmokeInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public MOUSEINPUT mi; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);
    public static void Middle(bool down) {
        var inputs = new INPUT[1];
        inputs[0].type = 0;
        inputs[0].mi = new MOUSEINPUT { dwFlags = down ? 0x0020u : 0x0040u, dwExtraInfo = UIntPtr.Zero };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}

/** Catches whatever the helper replays, so the desktop underneath never sees it. */
public class ShieldForm : Form {
    public List<string> Seen = new List<string>();
    /** When each one landed. The DOWN must arrive MID-PRESS or autoscroll cannot anchor. */
    public List<long> Ticks = new List<long>();
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0207) { Seen.Add("MBUTTONDOWN"); Ticks.Add(Environment.TickCount); }
        else if (m.Msg == 0x0208) { Seen.Add("MBUTTONUP"); Ticks.Add(Environment.TickCount); }
        base.WndProc(ref m);
    }
}

public class LineReader {
    private readonly TextReader _reader;
    private readonly ConcurrentQueue<string> _lines = new ConcurrentQueue<string>();
    public LineReader(TextReader reader) {
        _reader = reader;
        var t = new Thread(Pump);
        t.IsBackground = true;
        t.Start();
    }
    private void Pump() {
        try {
            string line;
            while ((line = _reader.ReadLine()) != null) _lines.Enqueue(line);
        } catch { }
    }
    public string[] Drain() {
        var list = new List<string>();
        string s;
        while (_lines.TryDequeue(out s)) list.Add(s);
        return list.ToArray();
    }
}
"@

function Wait-Pumped([int]$Ms) {
    $until = [DateTime]::UtcNow.AddMilliseconds($Ms)
    while ([DateTime]::UtcNow -lt $until) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 4
    }
}

function Send-Command($Proc, [string]$Text) {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Text + "`n")
    $Proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $Proc.StandardInput.BaseStream.Flush()
}

$cursor = [System.Windows.Forms.Cursor]::Position
$shield = New-Object ShieldForm
$shield.FormBorderStyle = 'None'
$shield.StartPosition = 'Manual'
$shield.Left = $cursor.X - 150
$shield.Top = $cursor.Y - 150
$shield.Width = 300
$shield.Height = 300
$shield.TopMost = $true
$shield.ShowInTaskbar = $false
$shield.BackColor = 'DarkRed'
$shield.Show()
Wait-Pumped 500

$script:results = @()

function Invoke-Case {
    param([string]$Name, [string]$Trigger, [int]$HoldMs, [string[]]$ExpectLines, [string[]]$ExpectShield,
          [int]$DownWindowLo = -1, [int]$DownWindowHi = -1, [int]$DragPx = 0)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$ScriptPath`" $PID"
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $rd = New-Object LineReader -ArgumentList $proc.StandardOutput

    $seen = New-Object System.Collections.ArrayList
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $armed = $false
    $primed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($l in $rd.Drain()) { [void]$seen.Add($l) }
        if ($seen -contains "TRIGGER_READY") { $armed = $true; break }
        if ($seen -contains "TRIGGER_FAILED") { break }
        if ((-not $primed) -and ($seen -contains "READY")) {
            Send-Command $proc "PING"
            Send-Command $proc $Trigger
            $primed = $true
        }
        Wait-Pumped 25
    }

    $gotLines = @()
    $gotShield = @()
    $offsets = @()
    if ($armed) {
        [void]$rd.Drain()
        $shield.Seen.Clear()
        $shield.Ticks.Clear()
        # Park the pointer inside the shield for the duration of the press. A replayed button is
        # hit-tested by POSITION, so without this it lands on whatever the pointer happens to be
        # over - which on a machine someone is actually using is a real window, and a stray middle
        # click there pastes into a terminal or closes a browser tab. The pointer is put back after
        # the last case.
        [void][SmokeInput]::SetCursorPos($shield.Left + 150, $shield.Top + 150)
        Wait-Pumped 60
        $pressAt = [Environment]::TickCount
        [SmokeInput]::Middle($true)
        if ($DragPx -gt 0) {
            # Hold still briefly, then move - the shape of someone starting to scroll. The move
            # stays inside the shield so the replayed button still lands on it.
            Wait-Pumped 50
            [void][SmokeInput]::SetCursorPos($shield.Left + 150 + $DragPx, $shield.Top + 150)
            Wait-Pumped ([Math]::Max(0, $HoldMs - 50))
        } else {
            Wait-Pumped $HoldMs
        }
        [SmokeInput]::Middle($false)
        Wait-Pumped 400
        $gotShield = @($shield.Seen)
        $offsets = @($shield.Ticks | ForEach-Object { $_ - $pressAt })
        $gotLines = @($rd.Drain())
    }

    try { Send-Command $proc "EXIT" } catch { }
    if (-not $proc.WaitForExit(5000)) { try { $proc.Kill() } catch { } }
    Wait-Pumped 150

    # The DOWN has to land MID-PRESS. Delivered at release it would be useless: autoscroll anchors
    # on the DOWN and scrolls from the motion AFTER it, so a DOWN with no motion left behind it
    # scrolls nothing (and in Chrome/Edge leaves the sticky-autoscroll puck stuck to the pointer).
    $timingOk = $true
    $timingNote = ""
    if ($DownWindowLo -ge 0) {
        $downAt = if ($offsets.Count -gt 0) { $offsets[0] } else { -1 }
        $timingOk = ($downAt -ge $DownWindowLo) -and ($downAt -le $DownWindowHi)
        $timingNote = "  DOWN at +${downAt}ms (want ${DownWindowLo}-${DownWindowHi}, release at +${HoldMs})"
    }

    $ok = $armed -and $timingOk -and
          ((($gotLines -join ',') -eq ($ExpectLines -join ',')) -and
           (($gotShield -join ',') -eq ($ExpectShield -join ',')))
    if (-not $ok) { "      debug: armed=$armed seen=[" + ($seen -join ',') + "] offsets=[" + ($offsets -join ',') + "]" }
    $script:results += $ok
    "{0}  {1,-28}  helper=[{2}] want=[{3}]   under-pointer=[{4}] want=[{5}]{6}" -f `
        $(if ($ok) { "PASS" } else { "FAIL" }), $Name, ($gotLines -join ','), ($ExpectLines -join ','), `
        ($gotShield -join ','), ($ExpectShield -join ','), $timingNote
}

# A real click, well under the threshold: the wheel is meant to open, and the press is OURS -
# nothing may reach the window underneath, or one press would both open Rovyl and close a tab.
Invoke-Case "click 80ms thr400" "TRIGGER 4 click 6 400" 80 @("TRIGGER_DOWN","TRIGGER_UP") @()
# The reported bug: a hold must not emit TRIGGER_UP (the wheel would open), and the button must
# reach the window underneath WHILE still held, which is what makes autoscroll possible at all.
Invoke-Case "hold 700ms thr400" "TRIGGER 4 click 6 400" 700 @("TRIGGER_DOWN","TRIGGER_HOLD") @("MBUTTONDOWN","MBUTTONUP") 380 520
# Same press, threshold raised past it: proves the threshold decides, not the duration alone.
Invoke-Case "hold 700ms thr5000" "TRIGGER 4 click 6 5000" 700 @("TRIGGER_DOWN","TRIGGER_UP") @()
# THE SCROLL GESTURE. Press, then move - which is what scrolling IS. The hand leaving the spot
# proves the press is not a click, so the button goes down immediately instead of waiting out the
# 400 ms: the DOWN must land near the move (~50 ms), nowhere near the time threshold.
Invoke-Case "drag 600ms thr400" "TRIGGER 4 click 6 400 30" 600 @("TRIGGER_DOWN","TRIGGER_HOLD") @("MBUTTONDOWN","MBUTTONUP") 40 220 80
# A drag released before even one 15 ms tick still must not launch: the release path checks the
# same distance the tick does.
Invoke-Case "drag 80ms thr400" "TRIGGER 4 click 6 400 30" 80 @("TRIGGER_DOWN","TRIGGER_HOLD") @("MBUTTONDOWN","MBUTTONUP") 40 220 80
# Movement UNDER the drag threshold is hand tremor, not a scroll - this must still be a click that
# opens the wheel and leaks nothing underneath.
Invoke-Case "jitter 8px 80ms" "TRIGGER 4 click 6 400 30" 80 @("TRIGGER_DOWN","TRIGGER_UP") @() -1 -1 8
# Hold MODE must be untouched: every release still reports TRIGGER_UP, and a long press replays
# nothing (its replay has always been gated on short-and-still).
Invoke-Case "hold MODE 700ms" "TRIGGER 4 hold 6 400" 700 @("TRIGGER_DOWN","TRIGGER_UP") @()
# Hold MODE, short and still: the pre-existing down+up replay still fires.
Invoke-Case "hold MODE 80ms" "TRIGGER 4 hold 6 400" 80 @("TRIGGER_DOWN","TRIGGER_UP") @("MBUTTONDOWN","MBUTTONUP")
# A 4-field command (no threshold) must still arm and still classify, on the built-in default.
Invoke-Case "legacy 4-field 700ms" "TRIGGER 4 click 6" 700 @("TRIGGER_DOWN","TRIGGER_HOLD") @("MBUTTONDOWN","MBUTTONUP")

[void][SmokeInput]::SetCursorPos($cursor.X, $cursor.Y)
$shield.Close()
[System.Windows.Forms.Application]::DoEvents()

""
if ($script:results -contains $false) { "RESULT: FAILURES PRESENT"; exit 1 }
"RESULT: all $($script:results.Count) cases passed"
exit 0
