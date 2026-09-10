Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class ZenithRadialMouseBlocker {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_LBUTTONDBLCLK = 0x0203;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_RBUTTONDBLCLK = 0x0206;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MBUTTONDBLCLK = 0x0209;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int WM_XBUTTONDBLCLK = 0x020D;
    private const int WM_MOUSEHWHEEL = 0x020E;

    private const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const int MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const int MOUSEEVENTF_XDOWN = 0x0080;
    private const int MOUSEEVENTF_XUP = 0x0100;

    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xFFFFFFFF;

    /** Signature on the events we inject ourselves, so the hook does not swallow them again. */
    private const uint SYNTHETIC_TAG = 0x524F5659;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static readonly ConcurrentQueue<int> Passthroughs = new ConcurrentQueue<int>();
    private static readonly ConcurrentQueue<string> Outbound = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent OutboundSignal = new AutoResetEvent(false);
    private static readonly LowLevelMouseProc Callback = HookCallback;
    private static IntPtr Hook = IntPtr.Zero;
    private static volatile bool Blocking;
    private static int Left, Top, Right, Bottom;
    private static int MonitorLeft, MonitorTop, MonitorRight, MonitorBottom;

    /**
     * Offsets of the fields the hook needs to read. `Marshal.PtrToStructure` boxed the whole
     * MSLLHOOKSTRUCT on EVERY event; with a 1000 Hz mouse that is GC garbage on the one thread
     * every mouse event in the system passes through. Reading three loose fields allocates nothing.
     */
    private static readonly int OffsetPoint = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "pt");
    private static readonly int OffsetMouseData = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "mouseData");
    private static readonly int OffsetExtraInfo = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "dwExtraInfo");

    /**
     * Trigger button capture.
     *
     * The detector was a `GetAsyncKeyState` poller in another process, which only WATCHED the
     * button. The event went on intact to the window underneath and, on any scrollable surface,
     * Windows went into autoscroll: aiming with the wheel dragged the page along behind it.
     *
     * A hook that returns 1 swallows the event -- but that also hides the button from
     * `GetAsyncKeyState`, so whoever swallows has to be whoever detects too.
     */
    private static volatile int TriggerButton;      // 0 = off, 4 = middle, 5 = X1, 6 = X2
    private static volatile bool TriggerHoldMode;   // in "click" mode there is never a click to hand back
    private static volatile int TriggerThreshold;   // px; below this the gesture aimed at nothing
    private static int DownX, DownY;
    private static long DownAt;

    /** A press longer than this was intent to open the wheel, not a click. */
    private const long PASSTHROUGH_MAX_MS = 250;

    /**
     * "Click" mode: threshold above which the press is NOT ours.
     *
     * The DOWN was swallowed (see above why it must be), so the window underneath never knew the
     * button went down -- and without that DOWN there is no wheel-press scroll, no terminal paste,
     * no CAD pan. Past the threshold we press the button underneath ourselves and release it when
     * the user lets go of theirs: the gesture reaches the right place, with the threshold's delay.
     *
     * Handing it back only at the end (a DOWN+UP together on release) is no good: the scroll
     * anchors on the DOWN and lives off the movement AFTER it, so delivered at the end there is no
     * movement left -- and in Chrome/Edge a stationary DOWN+UP is precisely the gesture that leaves
     * the scroll stuck to the pointer after the user has already let go.
     *
     * The value comes from main (MMB_CLICK_MAX_MS) in the TRIGGER command; this is only the fallback.
     */
    private const int DEFAULT_CLICK_HOLD_MS = 400;
    private static volatile int ClickHoldMs = DEFAULT_CLICK_HOLD_MS;
    /**
     * Distance that proves the press is NOT a click -- the signal that hands the button back
     * faster than time can.
     *
     * Waiting out the 400 ms was the complaint: pressing the wheel to scroll the page left it
     * sitting still until the threshold passed. But scrolling IS moving: the instant the hand
     * leaves the spot, the press can no longer be a click, and the button can go down already. In
     * practice scrolling starts as soon as there is something to scroll.
     *
     * Well above the tremor of a hand clicking (under 10 px, even at high DPI) and well below any
     * scroll gesture. Not the 6 px TriggerThreshold, which is there to decide whether a short click
     * is handed back: 6 px here stole clicks from shaky hands.
     */
    private const int DEFAULT_CLICK_DRAG_PX = 30;
    private static volatile int ClickDragPx = DEFAULT_CLICK_DRAG_PX;
    /** A "click" mode press is under way: DOWN seen, UP still to come. */
    private static volatile bool ClickPressArmed;
    /** Button whose DOWN we already injected underneath: we owe it the UP. 0 = nothing owed. */
    private static volatile int ClickInjectedButton;

    /**
     * Which halves of the button the passthrough queue should inject. The pair is still the "hold"
     * mode case; the loose halves are "click" mode, where the DOWN goes out mid-press and the UP
     * only when the user lets go.
     */
    private const int PT_PAIR = 0;
    private const int PT_DOWN = 1000;
    private const int PT_UP = 2000;

    /**
     * Writing to stdout from the hook is a real risk: if the parent stops reading, the pipe fills
     * and `Console.WriteLine` BLOCKS -- and the blocked thread is precisely the one serving the
     * hook, i.e. it freezes the whole system's mouse until `LowLevelHooksTimeout`. Enqueue and
     * return is always O(1); a dedicated thread does the writing.
     */
    private static void Emit(string line) {
        Outbound.Enqueue(line);
        OutboundSignal.Set();
    }

    private static void DrainOutbound() {
        string line;
        while (Outbound.TryDequeue(out line)) {
            Console.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool IsBlockedMessage(int message) {
        return message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_LBUTTONDBLCLK ||
               message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_RBUTTONDBLCLK ||
               message == WM_MBUTTONDOWN || message == WM_MBUTTONUP || message == WM_MBUTTONDBLCLK ||
               message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK ||
               message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL;
    }

    /** Which trigger button this message stands for, if any. 0 = none. */
    private static int TriggerFor(int message, uint mouseData, out bool isDown) {
        isDown = false;
        if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP || message == WM_MBUTTONDBLCLK) {
            isDown = (message != WM_MBUTTONUP);
            return 4;
        }
        if (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK) {
            isDown = (message != WM_XBUTTONUP);
            int which = (int)((mouseData >> 16) & 0xFFFF);
            return which == 2 ? 6 : 5;
        }
        return 0;
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode < 0) return CallNextHookEx(Hook, nCode, wParam, lParam);

        int message = wParam.ToInt32();

        /**
         * Every mouse event in the system passes through here, serialized. WM_MOUSEMOVE is the
         * overwhelming majority of them (a 1000 Hz gaming mouse makes a thousand a second) and is
         * NEVER actionable: it is in neither `IsBlockedMessage` nor `TriggerFor`. Leaving before
         * touching lParam saves the marshalling on ~99% of events.
         */
        if (message == WM_MOUSEMOVE) return CallNextHookEx(Hook, nCode, wParam, lParam);

        int trigger = TriggerButton;
        bool blocking = Blocking;
        /** With no trigger armed and no blocking active there is no decision at all to make. */
        if (trigger == 0 && !blocking) return CallNextHookEx(Hook, nCode, wParam, lParam);

        ulong extraInfo = IntPtr.Size == 8
            ? (ulong)Marshal.ReadInt64(lParam, OffsetExtraInfo)
            : (ulong)(uint)Marshal.ReadInt32(lParam, OffsetExtraInfo);

        /** Our own handed-back clicks go through without being reinterpreted. */
        if ((uint)extraInfo == SYNTHETIC_TAG) {
            return CallNextHookEx(Hook, nCode, wParam, lParam);
        }

        int px = Marshal.ReadInt32(lParam, OffsetPoint);
        int py = Marshal.ReadInt32(lParam, OffsetPoint + 4);

        if (trigger != 0) {
            bool isDown;
            uint mouseData = (uint)Marshal.ReadInt32(lParam, OffsetMouseData);
            int which = TriggerFor(message, mouseData, out isDown);
            if (which == trigger) {
                if (isDown) {
                    DownX = px;
                    DownY = py;
                    DownAt = Environment.TickCount;
                    /** Only "click" mode defers the decision; "hold" settles it all on release. */
                    ClickPressArmed = !TriggerHoldMode;
                    Emit("TRIGGER_DOWN");
                } else {
                    int dx = px - DownX;
                    int dy = py - DownY;
                    long held = Environment.TickCount - DownAt;
                    /**
                     * Environment.TickCount is Int32 and wraps at ~24.9 days of uptime. DownAt
                     * still holds the large pre-wrap value, so held comes out around -4.29e9
                     * and ANY "it was short" test started coming out TRUE: a long hold counted
                     * as a click. A duration that cannot be measured counts as a hold, which is
                     * the safe side in both modes.
                     */
                    if (held < 0) held = int.MaxValue;
                    int threshold = TriggerThreshold;
                    if (TriggerHoldMode) {
                        Emit("TRIGGER_UP");
                        /**
                         * Short, stationary click: the user aimed at nothing, they really did want
                         * to middle-click. We hand the click back to the window underneath -- but
                         * outside the hook, because injecting here would reenter it.
                         */
                        if (held <= PASSTHROUGH_MAX_MS &&
                            (dx * dx + dy * dy) <= threshold * threshold) {
                            Passthroughs.Enqueue(PT_PAIR + trigger);
                        }
                    } else {
                        bool armed = ClickPressArmed;
                        ClickPressArmed = false;
                        int injected = ClickInjectedButton;
                        if (injected != 0) {
                            /** The DOWN already went out mid-press: release now what is owed. */
                            ClickInjectedButton = 0;
                            Passthroughs.Enqueue(PT_UP + injected);
                            Emit("TRIGGER_HOLD");
                        } else if (!armed || held >= ClickHoldMs ||
                                   (dx * dx + dy * dy) >= ClickDragPx * ClickDragPx) {
                            /**
                             * A hold with no injected DOWN. Happens when the 15 ms tick has not got
                             * round to injecting yet (a short but already dragged press lets go
                             * inside the 15 ms), and when there was no paired DOWN at all (hook
                             * re-armed with the button already down, on changing button or mode in
                             * settings with the mouse in hand): unknown duration counts as a hold.
                             *
                             * No DOWN is owed, so there is no UP to inject -- and we do not inject
                             * a pair now: a quick drag is nobody's click, and handing it back at
                             * the end would only put a middle click where the hand no longer was.
                             */
                            Emit("TRIGGER_HOLD");
                        } else {
                            Emit("TRIGGER_UP");
                        }
                    }
                }
                return new IntPtr(1);
            }
        }

        if (blocking && IsBlockedMessage(message)) {
            bool insideAllowed = px >= Left && px < Right && py >= Top && py < Bottom;
            bool insideMonitor = px >= MonitorLeft && px < MonitorRight &&
                                 py >= MonitorTop && py < MonitorBottom;
            if (insideMonitor && !insideAllowed) return new IntPtr(1);
        }

        return CallNextHookEx(Hook, nCode, wParam, lParam);
    }

    /**
     * Injects the button we swallowed, tagged so the hook lets it through. The code is PT_PAIR /
     * PT_DOWN / PT_UP added to the button, so a single queue serves all three cases.
     *
     * No MOUSEEVENTF_MOVE and no ABSOLUTE: it comes out wherever the pointer is, which is what we
     * want -- the "click" mode DOWN has to anchor where the hand is when it passes the threshold,
     * not where it was when the button went down.
     */
    private static void SendPassthrough(int code) {
        int trigger = code % 1000;
        int kind = code - trigger;
        uint downFlag, upFlag, data;
        if (trigger == 4) { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; data = 0; }
        else { downFlag = MOUSEEVENTF_XDOWN; upFlag = MOUSEEVENTF_XUP; data = (uint)(trigger == 6 ? 2 : 1); }

        bool wantDown = kind != PT_UP;
        bool wantUp = kind != PT_DOWN;
        int count = (wantDown ? 1 : 0) + (wantUp ? 1 : 0);
        if (count == 0) return;

        var inputs = new INPUT[count];
        int i = 0;
        if (wantDown) {
            inputs[i].type = 0;
            inputs[i].mi = new MOUSEINPUT { dwFlags = downFlag, mouseData = data, dwExtraInfo = new UIntPtr(SYNTHETIC_TAG) };
            i++;
        }
        if (wantUp) {
            inputs[i].type = 0;
            inputs[i].mi = new MOUSEINPUT { dwFlags = upFlag, mouseData = data, dwExtraInfo = new UIntPtr(SYNTHETIC_TAG) };
        }
        SendInput((uint)count, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    /**
     * Safety net for the injected button.
     *
     * Exiting, disarming or re-arming with the injected DOWN still held underneath left the system
     * with the button stuck -- and the user has no way to release it, because their physical button
     * has already been let go. Every exit goes through here. (Kill the process outright and the
     * hook dies with it, and then the next physical click sorts it out on its own.)
     */
    private static void ReleaseInjectedButton() {
        int injected = ClickInjectedButton;
        ClickPressArmed = false;
        if (injected == 0) return;
        ClickInjectedButton = 0;
        SendPassthrough(PT_UP + injected);
    }

    private static void InstallHook() {
        if (Hook != IntPtr.Zero) return;
        using (var process = Process.GetCurrentProcess())
        using (var module = process.MainModule) {
            Hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, GetModuleHandle(module.ModuleName), 0);
        }
    }

    /** The hook stays while there is a reason: radial blocking OR trigger button capture. */
    private static void ReleaseHookIfIdle() {
        if (Blocking || TriggerButton != 0) return;
        if (Hook != IntPtr.Zero) {
            UnhookWindowsHookEx(Hook);
            Hook = IntPtr.Zero;
        }
    }

    private static void DisableBlocking() {
        Blocking = false;
        ReleaseHookIfIdle();
    }

    private static void Apply(string command, ApplicationContext context) {
        var parts = command.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return;

        if (parts.Length == 9 && parts[0] == "BLOCK") {
            int x, y, width, height, monitorX, monitorY, monitorWidth, monitorHeight;
            if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) &&
                int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) &&
                int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out width) &&
                int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out height) &&
                int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorX) &&
                int.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorY) &&
                int.TryParse(parts[7], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorWidth) &&
                int.TryParse(parts[8], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorHeight)) {
                Left = x; Top = y; Right = x + width; Bottom = y + height;
                MonitorLeft = monitorX; MonitorTop = monitorY;
                MonitorRight = monitorX + monitorWidth; MonitorBottom = monitorY + monitorHeight;
                InstallHook();
                Blocking = Hook != IntPtr.Zero;
            }
        } else if (parts[0] == "UNBLOCK") {
            DisableBlocking();
        } else if (parts[0] == "TRIGGER") {
            // TRIGGER <vk 4|5|6> <hold|click> <threshold px> [click hold ms] [click drag px]
            //   |   TRIGGER OFF
            /** Disarming or re-arming mid-press must not leave the button stuck. */
            ReleaseInjectedButton();
            if (parts.Length >= 2 && parts[1] == "OFF") {
                TriggerButton = 0;
                ReleaseHookIfIdle();
                Emit("TRIGGER_OFF");
                return;
            }
            int vk, threshold;
            /**
             * The 5th field is optional on purpose: a 4-field command still arms the trigger and
             * falls back to the default threshold, instead of being dropped in silence -- which is
             * what this parser does to any command with an unexpected number of fields.
             */
            if ((parts.Length >= 4 && parts.Length <= 6) &&
                int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) &&
                int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out threshold)) {
                if (vk != 4 && vk != 5 && vk != 6) vk = 4;
                TriggerHoldMode = parts[2] != "click";
                TriggerThreshold = threshold > 0 ? threshold : 0;
                int clickHold;
                ClickHoldMs = (parts.Length >= 5 &&
                    int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out clickHold) &&
                    clickHold > 0)
                    ? clickHold
                    : DEFAULT_CLICK_HOLD_MS;
                int clickDrag;
                ClickDragPx = (parts.Length >= 6 &&
                    int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out clickDrag) &&
                    clickDrag > 0)
                    ? clickDrag
                    : DEFAULT_CLICK_DRAG_PX;
                InstallHook();
                TriggerButton = Hook != IntPtr.Zero ? vk : 0;
                Emit(TriggerButton != 0 ? "TRIGGER_READY" : "TRIGGER_FAILED");
            }
        } else if (parts.Length == 3 && parts[0] == "WARP") {
            /**
             * Park the pointer (launch with no click). `SetCursorPos` skips the hook and injects no
             * input -- no reentrancy to guard, and it does not wake the trigger. Runs on the timer
             * thread, never inside `HookCallback`, so the system mouse never waits on it.
             */
            int wx, wy;
            if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out wx) &&
                int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out wy)) {
                SetCursorPos(wx, wy);
            }
        } else if (parts[0] == "EXIT") {
            ReleaseInjectedButton();
            TriggerButton = 0;
            DisableBlocking();
            context.ExitThread();
        }
    }

    public static void Run(int parentPid) {
        var context = new ApplicationContext();

        var output = new Thread(() => {
            while (true) {
                OutboundSignal.WaitOne();
                DrainOutbound();
            }
        });
        output.IsBackground = true;
        output.Start();

        var input = new Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) Commands.Enqueue(line);
            Commands.Enqueue("EXIT");
        });
        input.IsBackground = true;
        input.Start();

        /**
         * Parent watch WITHOUT polling.
         *
         * The timer tick called `Process.GetProcessById(parentPid)`. On Windows PowerShell
         * (.NET Framework) that call takes a snapshot of the WHOLE process table: measured
         * ~12 ms with 350 processes -- on a 15 ms timer, that is 80% of the time busy. And the
         * timer runs on the SAME thread that serves the WH_MOUSE_LL hook, where Windows serializes
         * every mouse event in the system. Result: the whole screen stuttered, not just the radial.
         *
         * A SYNCHRONIZE handle plus `WaitForSingleObject` detects the parent's death instantly and
         * costs absolutely nothing while it is alive.
         */
        var parentWatch = new Thread(() => {
            IntPtr handle = OpenProcess(SYNCHRONIZE, false, parentPid);
            /** If the handle fails, stdin EOF is still the safety net. */
            if (handle == IntPtr.Zero) return;
            WaitForSingleObject(handle, INFINITE);
            CloseHandle(handle);
            Commands.Enqueue("EXIT");
        });
        parentWatch.IsBackground = true;
        parentWatch.Start();

        /** Draining queues only: microseconds per tick, unlike the process snapshot. */
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 15;
        timer.Tick += (sender, args) => {
            string command;
            while (Commands.TryDequeue(out command)) Apply(command, context);
            /**
             * "Click" mode: the press can no longer be ours -- press the button underneath NOW,
             * with the user still holding, so that the movement that follows reaches the window and
             * wheel-press scrolling works.
             *
             * Two proofs, and whichever lands first wins. The TIME one covers whoever presses and
             * stays still. The DISTANCE one is what matters to whoever is scrolling: moving the hand
             * already says it is not a click, and there is no reason to wait out the whole time. The
             * pointer is read here, with GetCursorPos, and not in the hook -- the WM_MOUSEMOVE path
             * is ~99% of the system's events and leaves before even touching lParam; put code there
             * and you pay for it on every mouse event in Windows. Here it costs one call every
             * 15 ms, and only while the button is down.
             *
             * This tick runs on the SAME thread that serves the hook (the pump it was installed on),
             * so there is no concurrency at all with the release: either the injection already
             * happened when the UP arrives, or it did not happen at all.
             */
            int armed = TriggerButton;
            if (armed != 0 && !TriggerHoldMode && ClickPressArmed && ClickInjectedButton == 0) {
                long pressed = Environment.TickCount - DownAt;
                bool overdue = pressed < 0 || pressed >= ClickHoldMs;
                if (!overdue) {
                    POINT now;
                    if (GetCursorPos(out now)) {
                        long ddx = now.x - DownX;
                        long ddy = now.y - DownY;
                        long drag = ClickDragPx;
                        overdue = (ddx * ddx + ddy * ddy) >= drag * drag;
                    }
                }
                if (overdue) {
                    ClickInjectedButton = armed;
                    Passthroughs.Enqueue(PT_DOWN + armed);
                }
            }
            int passthrough;
            while (Passthroughs.TryDequeue(out passthrough)) SendPassthrough(passthrough);
        };
        timer.Start();
        Emit("READY");
        Application.Run(context);
        timer.Stop();
        ReleaseInjectedButton();
        TriggerButton = 0;
        DisableBlocking();
        DrainOutbound();
    }
}
"@

[ZenithRadialMouseBlocker]::Run([int]$args[0])
