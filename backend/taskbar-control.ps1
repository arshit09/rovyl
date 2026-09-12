Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/**
 * Hides parts of the Windows taskbar while the wheel is open, and puts them back.
 *
 * It is a separate process from the mouse hook on purpose. `mouse-blocker.ps1` serves a
 * WH_MOUSE_LL hook, and Windows silently unhooks a low-level hook that overruns
 * LowLevelHooksTimeout -- so taskbar work on that thread would intermittently kill the trigger
 * button. Nothing here may ever run on that pump.
 */
public static class RovylTaskbarControl {
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xFFFFFFFF;

    private const int SW_HIDE = 0;
    /** SHOWNA, not SHOW: restoring must not pull activation away from whatever the user is in. */
    private const int SW_SHOWNA = 8;

    private const int WCA_ACCENT_POLICY = 19;

    private const int ACCENT_DISABLED = 0;
    private const int ACCENT_ENABLE_TRANSPARENTGRADIENT = 2;
    private const int ACCENT_ENABLE_BLURBEHIND = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ACCENTPOLICY { public int State; public int Flags; public int Color; public int AnimationId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINCOMPATTRDATA { public int Attribute; public IntPtr Data; public int SizeOfData; }

    private delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string windowName);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder buffer, int max);
    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WINCOMPATTRDATA data);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static readonly object Gate = new object();

    /** Exactly the windows THIS process hid, so restoring never shows something the user had off. */
    private static readonly List<IntPtr> Hidden = new List<IntPtr>();
    /** Set only while we own the bar background; tells RESTORE whether it has anything to undo. */
    private static bool AccentChanged;
    private static IntPtr AccentTarget = IntPtr.Zero;

    private static string ClassOf(IntPtr hwnd) {
        StringBuilder buffer = new StringBuilder(256);
        GetClassNameW(hwnd, buffer, 256);
        return buffer.ToString();
    }

    /**
     * Immediate children, by class.
     *
     * Enumeration rather than a FindWindowEx chain, and that is not a style preference: measured on
     * Windows 10 19045, FindWindowExW returns NULL for `Start` and for `TrayClockWClass` while both
     * are plainly there and hideable. Every published "hide the taskbar clock" snippet uses the
     * chain, and on this machine it silently does nothing at all.
     */
    private static List<IntPtr> ChildrenOf(IntPtr parent) {
        List<IntPtr> found = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr hwnd, IntPtr param) {
            if (GetParent(hwnd) == parent) found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /** Every taskbar: the primary plus one secondary per additional monitor. */
    private static List<IntPtr> AllBars() {
        List<IntPtr> bars = new List<IntPtr>();
        IntPtr primary = FindWindowExW(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null);
        if (primary != IntPtr.Zero) bars.Add(primary);
        IntPtr secondary = IntPtr.Zero;
        while ((secondary = FindWindowExW(IntPtr.Zero, secondary, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) {
            bars.Add(secondary);
        }
        return bars;
    }

    /** The bar whose centre falls inside the monitor the wheel is opening on. */
    private static IntPtr BarOnMonitor(int mx, int my, int mw, int mh) {
        foreach (IntPtr bar in AllBars()) {
            RECT r;
            if (!GetWindowRect(bar, out r)) continue;
            int cx = (r.Left + r.Right) / 2;
            int cy = (r.Top + r.Bottom) / 2;
            if (cx >= mx && cx < mx + mw && cy >= my && cy < my + mh) return bar;
        }
        return IntPtr.Zero;
    }

    /**
     * Which kind of taskbar this is, which is the whole of the Windows 11 story.
     *
     * Since 22H2 the Start button, the clock, the tray icons and the task buttons are XAML visuals
     * inside a single composition island -- they have no HWND, so there is nothing to hide from
     * outside the process. Shell_TrayWnd itself still exists on every Win11 build (the widely
     * repeated claim that it was removed is false), so the bar is still FOUND; only its parts are
     * unreachable. Callers use this to withdraw the per-element switches rather than offer controls
     * that would do nothing.
     */
    private static string Capability() {
        IntPtr bar = FindWindowExW(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null);
        if (bar == IntPtr.Zero) return "none";
        int legacy = 0;
        int islands = 0;
        foreach (IntPtr child in ChildrenOf(bar)) {
            string cls = ClassOf(child);
            if (cls == "Start" || cls == "ReBarWindow32" || cls == "TrayNotifyWnd") legacy++;
            if (cls == "Windows.UI.Composition.DesktopWindowContentBridge") islands++;
        }
        if (legacy >= 2 && islands == 0) return "classic";
        if (legacy == 0 && islands >= 1) return "xaml";
        return "mixed";
    }

    private static void Hide(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
        /** Something already invisible is not ours to show again later. */
        if (!IsWindowVisible(hwnd)) return;
        if (ShowWindow(hwnd, SW_HIDE)) Hidden.Add(hwnd);
    }

    private static void SetAccent(IntPtr hwnd, int state, int color) {
        ACCENTPOLICY policy = new ACCENTPOLICY();
        policy.State = state;
        /** All four borders; without it the bar keeps a lit edge where the desktop shows through. */
        policy.Flags = 0x1F3;
        policy.Color = color;
        policy.AnimationId = 0;
        int size = Marshal.SizeOf(policy);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(policy, buffer, false);
            WINCOMPATTRDATA data = new WINCOMPATTRDATA();
            data.Attribute = WCA_ACCENT_POLICY;
            data.Data = buffer;
            data.SizeOfData = size;
            SetWindowCompositionAttribute(hwnd, ref data);
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /** The "Transparency effects" switch, which is the only honest clue to what to restore. */
    private static bool TransparencyEffectsOn() {
        try {
            object value = Microsoft.Win32.Registry.GetValue(
                "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                "EnableTransparency", 1);
            return value == null || Convert.ToInt32(value, CultureInfo.InvariantCulture) != 0;
        } catch (Exception) {
            return true;
        }
    }

    /**
     * Give the background back.
     *
     * There is no reliable way to read what explorer had: GetWindowCompositionAttribute reports
     * ACCENT_DISABLED even on a bar that is visibly translucent, so the original is simply not
     * legible. Measured on 19045 with transparency on, restoring ACCENT_DISABLED leaves the bar
     * flat and opaque -- the wallpaper tint that was bleeding through (green channel 4.5 above the
     * other two) drops to exactly zero. BLURBEHIND with a dark tint lands near it instead, so an
     * approximation in the right direction is what gets written back.
     *
     * The thing NOT to do here is make explorer re-apply its own: toggling EnableTransparency and
     * broadcasting ImmersiveColorSet does restore the look, and it also wedged the taskbar into a
     * 1px-tall strip that no amount of ABM_SETPOS or SetWindowPos would undo -- only restarting
     * explorer fixed it. That is why this whole switch is opt-in and says so in Settings.
     */
    private static void RestoreAccent() {
        if (!AccentChanged || AccentTarget == IntPtr.Zero) return;
        if (IsWindow(AccentTarget)) {
            if (TransparencyEffectsOn()) SetAccent(AccentTarget, ACCENT_ENABLE_BLURBEHIND, unchecked((int)0xB3000000));
            else SetAccent(AccentTarget, ACCENT_DISABLED, 0);
        }
        AccentChanged = false;
        AccentTarget = IntPtr.Zero;
    }

    /**
     * What to put back if this process is killed outright.
     *
     * The parent watch covers a Rovyl crash, and stdin EOF covers a clean quit -- but both run
     * INSIDE this process, so neither survives TerminateProcess ("End process tree" in Task
     * Manager, or any job object that takes the whole tree down at once). Measured: killed that
     * way, the helper dies ~5 ms after its parent having run no finally block at all, and the
     * taskbar stays empty for good.
     *
     * So the intent is written to disk before anything is hidden, and erased once it is back. The
     * file lists CLASS NAMES, not handles: whatever reads it next is a new process, and after an
     * explorer restart the handles would be dead anyway. Only ever written with windows that were
     * visible when we hid them, so replaying it cannot reveal something the user keeps off.
     */
    private static string JournalPath() {
        return System.IO.Path.Combine(System.IO.Path.GetTempPath(), "rovyl-taskbar-restore.txt");
    }

    private static void WriteJournal() {
        try {
            List<string> classes = new List<string>();
            foreach (IntPtr hwnd in Hidden) {
                if (IsWindow(hwnd)) classes.Add(ClassOf(hwnd));
            }
            if (classes.Count == 0) { ClearJournal(); return; }
            System.IO.File.WriteAllLines(JournalPath(), classes.ToArray());
        } catch (Exception) { }
    }

    private static void ClearJournal() {
        try {
            if (System.IO.File.Exists(JournalPath())) System.IO.File.Delete(JournalPath());
        } catch (Exception) { }
    }

    /** Replays a journal left by a previous run that never got to clean up after itself. */
    private static void ReplayJournal() {
        try {
            if (!System.IO.File.Exists(JournalPath())) return;
            HashSet<string> wanted = new HashSet<string>(System.IO.File.ReadAllLines(JournalPath()));
            ClearJournal();
            if (wanted.Count == 0) return;
            Diag("replaying journal: " + string.Join(",", new List<string>(wanted).ToArray()));
            foreach (IntPtr bar in AllBars()) {
                foreach (IntPtr child in ChildrenOf(bar)) {
                    if (wanted.Contains(ClassOf(child)) && !IsWindowVisible(child)) ShowWindow(child, SW_SHOWNA);
                    foreach (IntPtr part in ChildrenOf(child)) {
                        if (wanted.Contains(ClassOf(part)) && !IsWindowVisible(part)) ShowWindow(part, SW_SHOWNA);
                    }
                }
            }
        } catch (Exception error) {
            Diag("journal replay failed: " + error.Message);
        }
    }

    internal static void Diag(string message) {
        if (Environment.GetEnvironmentVariable("ROVYL_TASKBAR_DIAG") == null) return;
        try {
            System.IO.File.AppendAllText(
                System.IO.Path.Combine(System.IO.Path.GetTempPath(), "rovyl-taskbar-diag.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " [" + Thread.CurrentThread.ManagedThreadId + "] " + message + Environment.NewLine);
        } catch (Exception) { }
    }

    private static void RestoreAll() {
        Diag("RestoreAll enter");
        lock (Gate) {
            Diag("RestoreAll lock, hidden=" + Hidden.Count);
            for (int i = Hidden.Count - 1; i >= 0; i--) {
                IntPtr hwnd = Hidden[i];
                /** Explorer restarted under us: the handle is dead and its window came back shown. */
                if (!IsWindow(hwnd)) continue;
                bool shown = ShowWindow(hwnd, SW_SHOWNA);
                Diag("  show " + ClassOf(hwnd) + " -> " + shown);
            }
            Hidden.Clear();
            RestoreAccent();
            /** Nothing outstanding any more, so the next start must not replay anything. */
            ClearJournal();
        }
        Diag("RestoreAll done");
    }

    private static bool Flag(string[] parts, int index) {
        return parts.Length > index && parts[index] == "1";
    }

    private static int Number(string[] parts, int index) {
        int value;
        if (parts.Length > index && int.TryParse(parts[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return value;
        return 0;
    }

    /**
     * APPLY mx my mw mh transparent showStart showApps showTray showClock
     *
     * The monitor rect picks WHICH taskbar, because the wheel dims one screen and the bar on the
     * screen nobody is looking at is not part of the gesture.
     */
    private static void ApplyOverlay(string[] parts) {
        lock (Gate) {
            /** Idempotent: a second open without a close must not stack a second set of hidden windows. */
            RestoreAll();

            IntPtr bar = BarOnMonitor(Number(parts, 1), Number(parts, 2), Number(parts, 3), Number(parts, 4));
            if (bar == IntPtr.Zero) return;

            bool transparent = Flag(parts, 5);
            bool showStart = Flag(parts, 6);
            bool showApps = Flag(parts, 7);
            bool showTray = Flag(parts, 8);
            bool showClock = Flag(parts, 9);

            /**
             * Shell_TrayWnd itself is never hidden, and this is the one rule that cannot be relaxed.
             * ShowWindow(SW_HIDE) on the bar hands its 40px back to the desktop work area -- every
             * maximised window reflows -- and SW_SHOW does NOT give it back: measured, the work area
             * stayed 1920x1079 after the bar returned. A sub-second gesture may not resize the
             * windows someone is working in, so only children are ever touched.
             */
            foreach (IntPtr child in ChildrenOf(bar)) {
                string cls = ClassOf(child);

                if (!showStart && cls == "Start") Hide(child);
                /** Task View rides with Start: both are fixed shell buttons at the start edge. */
                if (!showStart && cls == "TrayButton") Hide(child);

                /** ReBarWindow32 on the primary bar, WorkerW on a secondary one -- same contents. */
                if (!showApps && (cls == "ReBarWindow32" || cls == "WorkerW")) Hide(child);

                /** A secondary bar has no TrayNotifyWnd; its clock is a ClockButton on the bar itself. */
                if (!showClock && cls == "ClockButton") Hide(child);

                if (cls == "TrayNotifyWnd") {
                    /**
                     * Never the whole TrayNotifyWnd: the clock lives INSIDE it, so hiding the
                     * container would make "hide the tray icons, keep the clock" impossible. The
                     * parts go one by one instead.
                     */
                    foreach (IntPtr part in ChildrenOf(child)) {
                        string partClass = ClassOf(part);
                        if (partClass == "TrayClockWClass") {
                            if (!showClock) Hide(part);
                            continue;
                        }
                        /** The sliver at the far end is Show Desktop, not a tray icon: leave it. */
                        if (partClass == "TrayShowDesktopButtonWClass") continue;
                        if (!showTray) Hide(part);
                    }
                }
            }

            if (transparent) {
                /**
                 * Only the background goes: the icons that stayed keep painting on top. Layered
                 * window alpha cannot do this -- it fades the window AND its children together, so
                 * "transparent bar with the clock still on it" is unreachable that way.
                 */
                SetAccent(bar, ACCENT_ENABLE_TRANSPARENTGRADIENT, 0);
                AccentChanged = true;
                AccentTarget = bar;
            }

            /** Written last, and only now: before this line there is nothing outstanding to undo. */
            WriteJournal();
        }
    }

    private static void Apply(string line) {
        if (string.IsNullOrEmpty(line)) return;
        string[] parts = line.Trim().Split(' ');
        string verb = parts[0];
        if (verb == "APPLY") { ApplyOverlay(parts); return; }
        if (verb == "RESTORE") { RestoreAll(); return; }
        if (verb == "PROBE") { Console.Out.WriteLine("CAPS " + Capability()); Console.Out.Flush(); return; }
    }

    public static void Run(int parentPid) {
        /**
         * Last line of defence. Whatever unwinds this process -- an unhandled exception, a
         * Environment.Exit from the watch thread, the CLR shutting down -- passes through here.
         */
        AppDomain.CurrentDomain.ProcessExit += delegate(object sender, EventArgs e) { Diag("ProcessExit"); RestoreAll(); };

        /**
         * Parent watch without polling, exactly as mouse-blocker.ps1 does it: a SYNCHRONIZE handle
         * costs nothing while the parent lives and fires the instant it dies. This is the whole
         * crash guarantee -- if Rovyl is killed with the taskbar hidden, THIS is what puts it back.
         */
        Thread parentWatch = new Thread(delegate() {
            try {
                Diag("parentWatch start pid=" + parentPid);
                IntPtr handle = OpenProcess(SYNCHRONIZE, false, parentPid);
                Diag("parentWatch handle=" + handle);
                /** If the handle fails, stdin EOF is still the safety net. */
                if (handle == IntPtr.Zero) return;
                WaitForSingleObject(handle, INFINITE);
                CloseHandle(handle);
            } catch (Exception) {
                /** Any failure watching the parent still means we must not keep the bar hidden. */
            }
            Diag("parentWatch fired");
            RestoreAll();
            Diag("parentWatch exiting");
            Environment.Exit(0);
        });
        parentWatch.IsBackground = true;
        parentWatch.Start();

        /** Before announcing readiness: a previous run may have been killed mid-gesture. */
        ReplayJournal();

        Console.Out.WriteLine("READY");
        Console.Out.Flush();

        /**
         * The read loop is INSIDE the try, and that is the whole point of the shape.
         *
         * Console.ReadLine() does not quietly return null when the parent is killed -- the pipe
         * breaks and it THROWS. With the loop outside a try, that exception escaped Run, took the
         * process down before any restore could run, and left the taskbar empty for good: measured,
         * Start / TrayButton / ReBarWindow32 were still hidden after the parent was killed and the
         * helper was gone. Every exit path has to reach the finally.
         */
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line.Trim() == "EXIT") break;
                try {
                    Apply(line);
                } catch (Exception error) {
                    Console.Error.WriteLine("ERR " + error.Message);
                }
            }
        } catch (Exception error) {
            /** Broken pipe: main died mid-gesture. Nothing to report to, and nothing to do but undo. */
            Diag("read loop threw: " + error.GetType().Name + " " + error.Message);
        } finally {
            Diag("read loop finally");
            RestoreAll();
        }
    }
}
"@

[RovylTaskbarControl]::Run([int]$args[0])
