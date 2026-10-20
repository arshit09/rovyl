<# :
@echo off
rem Rovyl diagnostics: double-click, follow the prompts, send the zip it puts on the Desktop.
rem
rem This header is batch, so the file can be double-clicked. Everything after it is PowerShell,
rem read back out of this same file: the "<# :" line above is a label to cmd and the start of a
rem comment to PowerShell, which is what lets one file be both.
set "ROVYL_DIAG_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:ROVYL_DIAG_SELF))"
echo.
if not defined ROVYL_DIAG_SECONDS pause
exit /b
#>

# What it collects, all into one zip on the Desktop. Nothing is uploaded.
#   report.txt       Windows, CPU, GPU and driver, displays, power plan, pointing devices,
#                    which programs used the CPU and the GPU while Rovyl was being tested,
#                    and the names of the programs that were running.
#   rovyl-perf.log   Rovyl's own trace, from versions that have one: how many frames each
#                    window drew per second against the display's refresh rate, how long they
#                    took, the mouse's polling rate. See src/sys/perf.rs.
#   diagnose.txt     rovyl.exe --diagnose: how Rovyl reads its configuration.
#   rovyl-persistence.log   the last 300 lines of Rovyl's own log.
#
# For testing: ROVYL_DIAG_SECONDS runs it unattended for that long (no prompts, no pause, no
# Explorer window), ROVYL_DIAG_EXE names the rovyl.exe to use, ROVYL_DIAG_OUT the folder for the
# zip, and ROVYL_USER_DATA is honoured exactly as Rovyl honours it.

$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'Rovyl diagnostics'

function Say([string]$text) { Write-Host $text }
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $env:TEMP "Rovyl-diagnostics-$stamp"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$report = Join-Path $work 'report.txt'
function Report([string]$text) { Add-Content -LiteralPath $report -Value $text -Encoding UTF8 }

Say 'Rovyl diagnostics'
Say ''
Say 'This checks how Rovyl runs on this PC and saves what it finds as a zip file on your'
Say 'Desktop: system details, the names of the programs running, and Rovyl''s own logs.'
Say 'Nothing is uploaded: you decide whether to send the zip.'
Say 'It closes Rovyl for a moment and opens it again, so save anything you are doing in it.'
Say ''
$unattended = [int]$env:ROVYL_DIAG_SECONDS
if (-not $unattended) { Read-Host 'Press Enter to start' | Out-Null }

# --- Find Rovyl -------------------------------------------------------------------------------

$running = @(Get-Process -Name rovyl -ErrorAction SilentlyContinue)
$candidates = @($env:ROVYL_DIAG_EXE)
foreach ($p in $running) { try { if ($p.Path) { $candidates += $p.Path } } catch {} }
$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Rovyl\Rovyl.exe')
$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Rovyl Native\Rovyl.exe')
$exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$dataDir = if ($env:ROVYL_USER_DATA) { $env:ROVYL_USER_DATA } else { Join-Path $env:APPDATA 'Rovyl' }
$version = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Rovyl' -ErrorAction SilentlyContinue).DisplayVersion

Report "Rovyl diagnostics, $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Report "rovyl.exe        $exe (version $version)"
Report "was running      $($running.Count -gt 0)"

# --- The machine ------------------------------------------------------------------------------

Step 'Reading system information'
try {
    $os = Get-CimInstance Win32_OperatingSystem
    Report "Windows          $($os.Caption) $($os.Version) (build $($os.BuildNumber)), $([math]::Round($os.TotalVisibleMemorySize / 1MB, 1)) GB RAM"
} catch { Report "Windows          unknown: $_" }
try {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    Report "CPU              $($cpu.Name.Trim()) ($($cpu.NumberOfLogicalProcessors) threads)"
} catch { Report "CPU              unknown: $_" }
try {
    foreach ($g in Get-CimInstance Win32_VideoController) {
        Report "GPU              $($g.Name), driver $($g.DriverVersion), $($g.CurrentHorizontalResolution)x$($g.CurrentVerticalResolution) @ $($g.CurrentRefreshRate) Hz"
    }
} catch { Report "GPU              unknown: $_" }
try {
    Add-Type -AssemblyName System.Windows.Forms
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        Report "Display          $($s.DeviceName) $($s.Bounds.Width)x$($s.Bounds.Height) at ($($s.Bounds.X),$($s.Bounds.Y))$(if ($s.Primary) { ', primary' })"
    }
} catch {}
$hags = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
Report "GPU scheduling   $(if ($hags -eq 2) { 'hardware-accelerated' } elseif ($hags -eq 1) { 'off' } else { 'default' })"
try { Report "Power plan       $(((powercfg /getactivescheme) -join ' ').Trim())" } catch {}
try {
    foreach ($m in Get-CimInstance Win32_PointingDevice) { Report "Pointing device  $($m.Name) ($($m.Manufacturer))" }
} catch {}

# --- Rovyl's own view -------------------------------------------------------------------------

if (-not $exe) {
    Say 'Rovyl was not found on this PC, so only the system information was collected.'
} else {
    Step 'Closing Rovyl'
    Get-Process -Name rovyl -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800

    try {
        Start-Process -FilePath $exe -ArgumentList '--diagnose' -RedirectStandardOutput (Join-Path $work 'diagnose.txt') -NoNewWindow -Wait
    } catch { Report "diagnose         failed: $_" }

    $persistence = Join-Path $dataDir 'rovyl-persistence.log'
    if (Test-Path -LiteralPath $persistence) {
        Get-Content -LiteralPath $persistence -Tail 300 | Set-Content -LiteralPath (Join-Path $work 'rovyl-persistence.log') -Encoding UTF8
    }

    # --- The session: Rovyl running with its trace on, sampled every second -------------------

    Step 'Starting Rovyl with performance logging'
    $perfLog = Join-Path $dataDir 'rovyl-perf.log'
    Remove-Item -LiteralPath $perfLog -ErrorAction SilentlyContinue
    $env:ROVYL_TRACE_PERF = '1'
    Start-Process -FilePath $exe | Out-Null
    Remove-Item Env:ROVYL_TRACE_PERF

    Say ''
    Say 'Rovyl is open again. For about 30 seconds, please use it the way that feels slow:'
    Say '  1. Move the mouse around over the Settings window, especially the menu on the left.'
    Say '  2. Open the wheel several times and move around it, the way you normally do.'
    Say '  3. Come back to this window and press any key.'
    Say ''

    $cpuStart = @{}
    foreach ($p in Get-Process) { try { $cpuStart[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }
    $sessionStart = Get-Date
    $gpu = @{}        # pid -> list of 3D utilisation samples
    $gpuTotal = @()   # whole-GPU 3D utilisation, one per second
    $gpuCounters = $true
    $limit = if ($unattended) { $unattended } else { 180 }
    while (-not ($unattended -eq 0 -and [Console]::KeyAvailable) -and ((Get-Date) - $sessionStart).TotalSeconds -lt $limit) {
        if ($gpuCounters) {
            try {
                $engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop |
                    Where-Object { $_.Name -like '*engtype_3D*' }
                $byPid = @{}
                foreach ($e in $engines) {
                    if ($e.Name -match '^pid_(\d+)_') {
                        $id = [int]$Matches[1]
                        $byPid[$id] = [double]$byPid[$id] + [double]$e.UtilizationPercentage
                    }
                }
                $sum = 0
                foreach ($id in $byPid.Keys) {
                    if (-not $gpu.ContainsKey($id)) { $gpu[$id] = New-Object System.Collections.ArrayList }
                    [void]$gpu[$id].Add($byPid[$id])
                    $sum += $byPid[$id]
                }
                $gpuTotal += [math]::Min(100, $sum)
            } catch { $gpuCounters = $false }
        }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $unattended -and [Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    $seconds = ((Get-Date) - $sessionStart).TotalSeconds

    Step 'Collecting the results'
    $names = @{}
    $cpuUse = @()
    foreach ($p in Get-Process) {
        $names[$p.Id] = $p.ProcessName
        try {
            $before = if ($cpuStart.ContainsKey($p.Id)) { $cpuStart[$p.Id] } else { 0 }
            $used = ($p.TotalProcessorTime.TotalMilliseconds - $before) / 10 / $seconds
            $cpuUse += [pscustomobject]@{ Name = $p.ProcessName; Id = $p.Id; Percent = $used }
        } catch {}
    }

    Report ''
    Report "Test session     $([math]::Round($seconds)) s"
    Report 'CPU during the session (percent of one core):'
    foreach ($c in ($cpuUse | Sort-Object Percent -Descending | Select-Object -First 15)) {
        Report ("  {0,6:N1}%  {1} ({2})" -f $c.Percent, $c.Name, $c.Id)
    }
    if ($gpuTotal.Count -gt 0) {
        Report ''
        Report ("GPU 3D during the session: average {0:N0}%, peak {1:N0}%" -f ($gpuTotal | Measure-Object -Average).Average, ($gpuTotal | Measure-Object -Maximum).Maximum)
        $gpuUse = foreach ($id in $gpu.Keys) {
            [pscustomobject]@{
                Name    = $(if ($names.ContainsKey($id)) { $names[$id] } else { 'exited' })
                Id      = $id
                Average = ($gpu[$id] | Measure-Object -Average).Average
                Peak    = ($gpu[$id] | Measure-Object -Maximum).Maximum
            }
        }
        foreach ($g in ($gpuUse | Sort-Object Average -Descending | Select-Object -First 10)) {
            Report ("  {0,5:N1}% avg {1,5:N1}% peak  {2} ({3})" -f $g.Average, $g.Peak, $g.Name, $g.Id)
        }
    } else {
        Report 'GPU 3D during the session: no counters on this PC'
    }

    Get-Process -Name rovyl -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    if (Test-Path -LiteralPath $perfLog) {
        Copy-Item -LiteralPath $perfLog -Destination $work
    } else {
        Report ''
        Report 'rovyl-perf.log   not written: this Rovyl version has no performance trace'
    }

    # Back the way it was found: running in the tray, or not running.
    if ($running.Count -gt 0) {
        Start-Process -FilePath $exe -ArgumentList '--tray' | Out-Null
    }
}

Report ''
Report 'Programs running:'
Report ((Get-Process | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object) -join ', ')

# --- The zip ----------------------------------------------------------------------------------

$desktop = if ($env:ROVYL_DIAG_OUT) { $env:ROVYL_DIAG_OUT } else { [Environment]::GetFolderPath('Desktop') }
$zip = Join-Path $desktop "Rovyl-diagnostics-$stamp.zip"
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

Step 'Done'
Say "Saved: $zip"
Say 'Please send that file. It holds system details, the names of running programs, and'
Say "Rovyl's own logs; you can open it and look before sending."
if (-not $unattended) { Start-Process explorer.exe -ArgumentList "/select,`"$zip`"" }
