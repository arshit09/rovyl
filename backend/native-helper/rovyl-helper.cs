using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Rovyl.NativeHelper {
    public struct ROVYLRECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

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
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr min, IntPtr max);
    }

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

            return bounds + "|" + exe + "|" + caption;
        }
    }

    public static class RovylForegroundFocus {
        public static string InvokeForegroundSteal(string rawHandle) {
            long value = 0;
            if (!long.TryParse(rawHandle, out value) || value == 0) return "BADHWND";
            IntPtr target = new IntPtr(value);
            if (!RovylForeground.IsWindowVisible(target)) return "HIDDEN";
            if (RovylForeground.GetForegroundWindow() == target) return "ALREADY";

            IntPtr foreground = RovylForeground.GetForegroundWindow();
            uint foregroundThread = RovylForeground.GetWindowThreadProcessId(foreground, IntPtr.Zero);
            uint targetThread = RovylForeground.GetWindowThreadProcessId(target, IntPtr.Zero);
            uint selfThread = RovylForeground.GetCurrentThreadId();

            bool attachedForeground = false;
            bool attachedTarget = false;
            try {
                if (foregroundThread != 0 && foregroundThread != selfThread) {
                    attachedForeground = RovylForeground.AttachThreadInput(selfThread, foregroundThread, true);
                }
                if (targetThread != 0 && targetThread != selfThread) {
                    attachedTarget = RovylForeground.AttachThreadInput(selfThread, targetThread, true);
                }

                RovylForeground.ShowWindow(target, 5);
                RovylForeground.BringWindowToTop(target);
                RovylForeground.SetForegroundWindow(target);
                RovylForeground.SetFocus(target);
            } finally {
                if (attachedTarget) RovylForeground.AttachThreadInput(selfThread, targetThread, false);
                if (attachedForeground) RovylForeground.AttachThreadInput(selfThread, foregroundThread, false);
            }

            if (RovylForeground.GetForegroundWindow() == target) return "OK";
            return "MISS";
        }

        public static void Run() {
            RovylSnapshot.MatchElectronDpiAwareness();
            Console.WriteLine("READY");

            string line;
            while ((line = Console.ReadLine()) != null) {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                if (line == "EXIT") break;
                if (line == "FG") {
                    try {
                        Console.WriteLine("FG|" + RovylSnapshot.Snapshot());
                    } catch {
                        Console.WriteLine("FG|||");
                    }
                    continue;
                }
                string[] parts = line.Split(' ');
                if (parts[0] == "TRIM") {
                    try {
                        List<int> pids = new List<int>();
                        if (parts.Length > 1 && !string.IsNullOrEmpty(parts[1])) {
                            foreach (string s in parts[1].Split(',')) {
                                int p;
                                if (int.TryParse(s.Trim(), out p)) pids.Add(p);
                            }
                        }
                        int trimmed = RovylSnapshot.TrimProcesses(pids.ToArray());
                        RovylSnapshot.TrimProcessMemory(Process.GetCurrentProcess().Id);
                        Console.WriteLine("TRIM|OK|" + trimmed);
                    } catch (Exception ex) {
                        Console.WriteLine("TRIM|ERR|" + ex.Message);
                    }
                    continue;
                }
                if (parts[0] != "FOCUS" || parts.Length < 2) continue;
                try {
                    Console.WriteLine(InvokeForegroundSteal(parts[1]));
                } catch (Exception ex) {
                    Console.WriteLine("ERR " + ex.Message);
                }
            }
        }
    }

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

        private const int MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const int MOUSEEVENTF_LEFTUP = 0x0004;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const int MOUSEEVENTF_RIGHTUP = 0x0010;
        private const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const int MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const int MOUSEEVENTF_XDOWN = 0x0080;
        private const int MOUSEEVENTF_XUP = 0x0100;

        private const uint SYNCHRONIZE = 0x00100000;
        private const uint INFINITE = 0xFFFFFFFF;
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
        [DllImport("user32.dll")]
        private static extern short GetKeyState(int nVirtKey);
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int nVirtKey);

        private const int VK_LBUTTON = 0x01;
        private const int VK_RBUTTON = 0x02;
        private const int VK_MBUTTON = 0x04;
        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;

        private static int GetCurrentModifierMask() {
            int mask = 0;
            if ((GetKeyState(VK_CONTROL) & 0x8000) != 0) mask |= 1;
            if ((GetKeyState(VK_MENU) & 0x8000) != 0) mask |= 2;
            if ((GetKeyState(VK_SHIFT) & 0x8000) != 0) mask |= 4;
            if (((GetKeyState(VK_LWIN) & 0x8000) != 0) || ((GetKeyState(VK_RWIN) & 0x8000) != 0)) mask |= 8;
            return mask;
        }

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
         * One-shot: "tell me when no mouse button is held any more".
         *
         * Polled rather than hooked, because the asker is the tray menu and the hook is not even
         * installed while the app idles. `GetAsyncKeyState` reads the PHYSICAL buttons, so a
         * swapped-buttons mouse needs no special case as long as all three are watched.
         */
        private static volatile bool AwaitingButtonsUp;
        /** `Environment.TickCount` at which the wait gives up and answers anyway. */
        private static volatile int ButtonsUpDeadline;

        private static volatile bool RecordingMode;
        private static volatile int ShortcutTriggerButton;
        private static volatile int ShortcutTriggerModMask;
        private static volatile bool ShortcutTriggerActive;

        private static readonly int OffsetPoint = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "pt");
        private static readonly int OffsetMouseData = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "mouseData");
        private static readonly int OffsetExtraInfo = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "dwExtraInfo");

        private static volatile int TriggerButton;
        private static volatile bool TriggerHoldMode;
        private static volatile int TriggerThreshold;
        /**
         * The modifiers that have to be held for the press to be Rovyl's, and whether the press
         * that IS Rovyl's is still down.
         *
         * Both exist for the same reason: left and right are only bindable with a modifier, and a
         * modifier is a key the hand lets go of. The mask is checked on the DOWN alone; from there
         * the flag decides the UP, so releasing Ctrl mid-gesture ends the gesture cleanly instead
         * of leaking a stray button-up into the window underneath.
         */
        private static volatile int TriggerModMask;
        private static volatile bool TriggerPressed;
        private static int DownX, DownY;
        private static long DownAt;

        private const long PASSTHROUGH_MAX_MS = 250;
        private const int DEFAULT_CLICK_HOLD_MS = 400;
        private static volatile int ClickHoldMs = DEFAULT_CLICK_HOLD_MS;
        private const int DEFAULT_CLICK_DRAG_PX = 30;
        private static volatile int ClickDragPx = DEFAULT_CLICK_DRAG_PX;
        private static volatile bool ClickPressArmed;
        private static volatile int ClickInjectedButton;

        private const int PT_PAIR = 0;
        private const int PT_DOWN = 1000;
        private const int PT_UP = 2000;

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

        private static int TriggerFor(int message, uint mouseData, out bool isDown) {
            isDown = false;
            if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_LBUTTONDBLCLK) {
                isDown = (message != WM_LBUTTONUP);
                return 1;
            }
            if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_RBUTTONDBLCLK) {
                isDown = (message != WM_RBUTTONUP);
                return 2;
            }
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
            if (message == WM_MOUSEMOVE) return CallNextHookEx(Hook, nCode, wParam, lParam);

            int trigger = TriggerButton;
            bool blocking = Blocking;
            int shortcutTrigger = ShortcutTriggerButton;
            bool recording = RecordingMode;
            if (trigger == 0 && !blocking && shortcutTrigger == 0 && !recording) return CallNextHookEx(Hook, nCode, wParam, lParam);

            ulong extraInfo = IntPtr.Size == 8
                ? (ulong)Marshal.ReadInt64(lParam, OffsetExtraInfo)
                : (ulong)(uint)Marshal.ReadInt32(lParam, OffsetExtraInfo);

            if ((uint)extraInfo == SYNTHETIC_TAG) {
                return CallNextHookEx(Hook, nCode, wParam, lParam);
            }

            if (recording) {
                if (message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN || message == WM_RBUTTONDOWN) {
                    string btnName = null;
                    if (message == WM_MBUTTONDOWN) {
                        btnName = "Middle";
                    } else if (message == WM_XBUTTONDOWN) {
                        uint mouseData = (uint)Marshal.ReadInt32(lParam, OffsetMouseData);
                        int xwhich = (int)((mouseData >> 16) & 0xFFFF);
                        btnName = (xwhich == 2 ? "Mouse5" : "Mouse4");
                    } else if (message == WM_RBUTTONDOWN) {
                        int mods = GetCurrentModifierMask();
                        if (mods != 0) btnName = "RightClick";
                    }

                    if (btnName != null) {
                        int mods = GetCurrentModifierMask();
                        Emit("RECORD_MOUSE " + btnName + " " + mods);
                        return new IntPtr(1);
                    }
                }
            }

            if (shortcutTrigger != 0) {
                bool isDown = false;
                bool isUp = false;
                int which = 0;
                if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) {
                    which = 4;
                    isDown = (message == WM_MBUTTONDOWN);
                    isUp = (message == WM_MBUTTONUP);
                } else if (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP) {
                    uint mouseData = (uint)Marshal.ReadInt32(lParam, OffsetMouseData);
                    int xwhich = (int)((mouseData >> 16) & 0xFFFF);
                    which = (xwhich == 2 ? 6 : 5);
                    isDown = (message == WM_XBUTTONDOWN);
                    isUp = (message == WM_XBUTTONUP);
                } else if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) {
                    which = 2;
                    isDown = (message == WM_RBUTTONDOWN);
                    isUp = (message == WM_RBUTTONUP);
                }

                if (which == shortcutTrigger) {
                    if (isDown) {
                        int mods = GetCurrentModifierMask();
                        if (mods == ShortcutTriggerModMask) {
                            ShortcutTriggerActive = true;
                            Emit("SHORTCUT_DOWN");
                            return new IntPtr(1);
                        }
                    } else if (isUp && ShortcutTriggerActive) {
                        ShortcutTriggerActive = false;
                        Emit("SHORTCUT_UP");
                        return new IntPtr(1);
                    }
                }
            }

            int px = Marshal.ReadInt32(lParam, OffsetPoint);
            int py = Marshal.ReadInt32(lParam, OffsetPoint + 4);

            if (trigger != 0) {
                bool isDown;
                uint mouseData = (uint)Marshal.ReadInt32(lParam, OffsetMouseData);
                int which = TriggerFor(message, mouseData, out isDown);
                if (which == trigger) {
                    /**
                     * With modifiers bound, a press without them is not the trigger at all: it is
                     * the ordinary click of an ordinary button and has to reach the window under
                     * the pointer untouched. The release is answered by whether WE took the press,
                     * never by the mask — the hand has usually let the modifier go by then.
                     */
                    if (isDown && TriggerModMask != 0 && GetCurrentModifierMask() != TriggerModMask) {
                        return CallNextHookEx(Hook, nCode, wParam, lParam);
                    }
                    if (!isDown && !TriggerPressed) {
                        return CallNextHookEx(Hook, nCode, wParam, lParam);
                    }
                    TriggerPressed = isDown;
                    if (isDown) {
                        DownX = px;
                        DownY = py;
                        DownAt = Environment.TickCount;
                        ClickPressArmed = !TriggerHoldMode;
                        Emit("TRIGGER_DOWN");
                    } else {
                        int dx = px - DownX;
                        int dy = py - DownY;
                        long held = Environment.TickCount - DownAt;
                        if (held < 0) held = int.MaxValue;
                        int threshold = TriggerThreshold;
                        if (TriggerHoldMode) {
                            Emit("TRIGGER_UP");
                            if (held <= PASSTHROUGH_MAX_MS &&
                                (dx * dx + dy * dy) <= threshold * threshold) {
                                Passthroughs.Enqueue(PT_PAIR + trigger);
                            }
                        } else {
                            bool armed = ClickPressArmed;
                            ClickPressArmed = false;
                            int injected = ClickInjectedButton;
                            if (injected != 0) {
                                ClickInjectedButton = 0;
                                Passthroughs.Enqueue(PT_UP + injected);
                                Emit("TRIGGER_HOLD");
                            } else if (!armed || held >= ClickHoldMs ||
                                       (dx * dx + dy * dy) >= ClickDragPx * ClickDragPx) {
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

        private static void SendPassthrough(int code) {
            int trigger = code % 1000;
            int kind = code - trigger;
            uint downFlag, upFlag, data;
            if (trigger == 1) { downFlag = MOUSEEVENTF_LEFTDOWN; upFlag = MOUSEEVENTF_LEFTUP; data = 0; }
            else if (trigger == 2) { downFlag = MOUSEEVENTF_RIGHTDOWN; upFlag = MOUSEEVENTF_RIGHTUP; data = 0; }
            else if (trigger == 4) { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; data = 0; }
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

        private static void ReleaseHookIfIdle() {
            if (Blocking || TriggerButton != 0 || ShortcutTriggerButton != 0 || RecordingMode) return;
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
                ReleaseInjectedButton();
                TriggerPressed = false;
                if (parts.Length >= 2 && parts[1] == "OFF") {
                    TriggerButton = 0;
                    TriggerModMask = 0;
                    ReleaseHookIfIdle();
                    Emit("TRIGGER_OFF");
                    return;
                }
                int vk, threshold;
                if ((parts.Length >= 4 && parts.Length <= 7) &&
                    int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) &&
                    int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out threshold)) {
                    /**
                     * Left (1) and right (2) join the three side buttons. They are only sent here
                     * with a modifier mask — main refuses them bare — so the hook never holds the
                     * system's primary click or context menu on its own.
                     */
                    if (vk != 1 && vk != 2 && vk != 4 && vk != 5 && vk != 6) vk = 4;
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
                    int triggerMods;
                    TriggerModMask = (parts.Length >= 7 &&
                        int.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out triggerMods) &&
                        triggerMods > 0)
                        ? triggerMods
                        : 0;
                    InstallHook();
                    TriggerButton = Hook != IntPtr.Zero ? vk : 0;
                    Emit(TriggerButton != 0 ? "TRIGGER_READY" : "TRIGGER_FAILED");
                }
            } else if (parts[0] == "RECORD") {
                if (parts.Length >= 2 && parts[1] == "ON") {
                    RecordingMode = true;
                    InstallHook();
                    Emit("RECORD_READY");
                } else {
                    RecordingMode = false;
                    ReleaseHookIfIdle();
                    Emit("RECORD_OFF");
                }
            } else if (parts[0] == "SHORTCUT_TRIGGER") {
                if (parts.Length >= 2 && parts[1] == "OFF") {
                    ShortcutTriggerButton = 0;
                    ShortcutTriggerModMask = 0;
                    ShortcutTriggerActive = false;
                    ReleaseHookIfIdle();
                    Emit("SHORTCUT_TRIGGER_OFF");
                    return;
                }
                int vk, modMask;
                if (parts.Length >= 3 &&
                    int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) &&
                    int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out modMask)) {
                    ShortcutTriggerButton = vk;
                    ShortcutTriggerModMask = modMask;
                    ShortcutTriggerActive = false;
                    InstallHook();
                    Emit(Hook != IntPtr.Zero ? "SHORTCUT_TRIGGER_READY" : "SHORTCUT_TRIGGER_FAILED");
                }
            } else if (parts[0] == "BUTTONS_UP") {
                /**
                 * One-shot wait, answered on the timer thread. The tray menu asks for it before it
                 * steals the foreground: taking it while the button is still down cancels the
                 * notification area's own click and the taskbar pops ITS menu on the release.
                 */
                int timeoutMs;
                if (parts.Length < 2 ||
                    !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out timeoutMs) ||
                    timeoutMs <= 0) {
                    timeoutMs = 400;
                }
                ButtonsUpDeadline = Environment.TickCount + timeoutMs;
                AwaitingButtonsUp = true;
            } else if (parts.Length == 3 && parts[0] == "WARP") {
                int wx, wy;
                if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out wx) &&
                    int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out wy)) {
                    SetCursorPos(wx, wy);
                }
            } else if (parts[0] == "EXIT") {
                AwaitingButtonsUp = false;
                ReleaseInjectedButton();
                TriggerButton = 0;
                TriggerModMask = 0;
                TriggerPressed = false;
                ShortcutTriggerButton = 0;
                ShortcutTriggerModMask = 0;
                ShortcutTriggerActive = false;
                RecordingMode = false;
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

            var parentWatch = new Thread(() => {
                IntPtr handle = OpenProcess(SYNCHRONIZE, false, parentPid);
                if (handle == IntPtr.Zero) return;
                WaitForSingleObject(handle, INFINITE);
                CloseHandle(handle);
                Commands.Enqueue("EXIT");
            });
            parentWatch.IsBackground = true;
            parentWatch.Start();

            var timer = new System.Windows.Forms.Timer();
            timer.Interval = 15;
            timer.Tick += (sender, args) => {
                string command;
                while (Commands.TryDequeue(out command)) Apply(command, context);

                if (AwaitingButtonsUp) {
                    bool anyDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 ||
                                   (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0 ||
                                   (GetAsyncKeyState(VK_MBUTTON) & 0x8000) != 0;
                    /** Subtraction, not `>`: TickCount wraps every 49 days and a wrap must not hang the wait. */
                    if (!anyDown || Environment.TickCount - ButtonsUpDeadline >= 0) {
                        AwaitingButtonsUp = false;
                        Emit("BUTTONS_UP");
                    }
                }

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

    /// <summary>
    /// The window the user looks at while an update installs.
    ///
    /// WHY IT IS HERE AND NOT A BrowserWindow
    ///
    /// The install replaces the contents of the install folder, and a running Rovyl.exe holds
    /// handles on the very files being replaced -- which is why nsis/installer.nsh opens by killing
    /// it. An Electron splash would either die mid-install, leaving the blank screen this exists to
    /// remove, or survive and break the install. So the window belongs to a process that is not
    /// Rovyl and owns nothing inside the install folder: electron-main.js copies this helper (and
    /// the logo) into the temp folder and starts the copy, so not one handle points at the
    /// directory NSIS is rewriting.
    ///
    /// WHY THE ANIMATION IS BUILT THE WAY IT IS
    ///
    /// The bar is the only moving thing on screen, so any hitch in it is the whole impression. Two
    /// rules follow. First, position comes from a Stopwatch rather than from counting ticks: a late
    /// frame then lands where it belongs instead of dragging the whole animation behind it. Second,
    /// nothing slow is allowed on the UI thread -- watching for the installer and for the relaunched
    /// app means enumerating processes, which takes tens of milliseconds, so it runs on a timer of
    /// its own and only the result is marshalled back.
    ///
    /// Frames are requested from a threading timer rather than a WinForms one. A WinForms Timer
    /// rides on WM_TIMER, which is posted at the system's ~15.6 ms tick, is coalesced, and is
    /// processed only when nothing else is queued: it cannot hold 60 fps, and what it does hold
    /// visibly stutters.
    /// </summary>
    public class RovylUpdateSplash : Form {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        // Design sizes, in the 96-DPI units the layout was drawn at; everything is multiplied by
        // Scale so the splash is the same physical size on a 150% display.
        const int BaseWidth = 400;
        const int BaseHeight = 196;
        const int BaseLogo = 46;
        const int BaseBarWidth = 232;
        const int BaseBarHeight = 3;
        const int BaseBarTop = 150;
        const int BaseCorner = 22;
        // Wide enough that the gradient reads as a travelling highlight rather than a moving block.
        const int BaseSlice = 116;
        const double CycleMs = 1150.0;

        // The product's own palette (src/index.css): Rovyl's accent is the absence of colour --
        // white on near-black, one step of elevation, no hue anywhere.
        static readonly Color Bg = Color.FromArgb(21, 21, 21);
        static readonly Color Line = Color.FromArgb(38, 38, 38);
        static readonly Color TextColor = Color.FromArgb(237, 237, 237);
        static readonly Color MutedColor = Color.FromArgb(138, 138, 138);
        static readonly Color TrackColor = Color.FromArgb(36, 36, 36);

        readonly int installerPid;
        readonly string installerName;
        readonly string versionText;
        readonly string logoPath;

        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly DateTime startedAt = DateTime.Now;

        System.Threading.Timer frameTimer;
        System.Threading.Timer watchTimer;
        /// <summary>0 while no repaint is in flight. Stops a slow frame from queueing up behind it.</summary>
        int framePending;

        float scale = 1f;
        Rectangle barRect;
        int slice;
        GraphicsPath shape;
        Image logo;
        Font headFont;
        Font statusFont;

        Process installer;
        bool installerSeen;
        bool starting;
        DateTime startingAt;
        DateTime? appSeenAt;
        string statusText;

        public RovylUpdateSplash(int installerPid, string installerName, string version, string logoPath) {
            this.installerPid = installerPid;
            this.installerName = installerName ?? "";
            this.versionText = version ?? "";
            this.logoPath = logoPath ?? "";
            this.statusText = this.versionText.Length > 0
                ? "Installing version " + this.versionText
                : "Installing the latest version";

            // Every pixel is painted here, into one back buffer: no flicker, and no child controls
            // to invalidate behind the bar.
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                     | ControlStyles.OptimizedDoubleBuffer, true);
            FormBorderStyle = FormBorderStyle.None;
            // Placed by hand in OnLoad. CenterScreen is resolved when the handle is created, which
            // here is before ClientSize has been set, so the window ends up centred for WinForms'
            // default 300x300 -- fifty pixels right of centre and fifty above it.
            StartPosition = FormStartPosition.Manual;
            BackColor = Bg;
            TopMost = true;
            ShowInTaskbar = true;
            Text = "Rovyl";

            // The desktop's DC, not this form's: CreateGraphics() would realise the handle, which is
            // the very thing the comment above is about.
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;

            ClientSize = new Size(Px(BaseWidth), Px(BaseHeight));
            barRect = new Rectangle(
                (Px(BaseWidth) - Px(BaseBarWidth)) / 2, Px(BaseBarTop),
                Px(BaseBarWidth), Math.Max(2, Px(BaseBarHeight)));
            slice = Px(BaseSlice);

            // Rounded corners cut out of the window itself: a borderless square reads as a crash
            // dialog, not as part of the app.
            int r = Px(BaseCorner);
            shape = new GraphicsPath();
            shape.AddArc(0, 0, r, r, 180, 90);
            shape.AddArc(ClientSize.Width - r - 1, 0, r, r, 270, 90);
            shape.AddArc(ClientSize.Width - r - 1, ClientSize.Height - r - 1, r, r, 0, 90);
            shape.AddArc(0, ClientSize.Height - r - 1, r, r, 90, 90);
            shape.CloseFigure();
            Region = new Region(shape);

            headFont = new Font("Segoe UI Semibold", 12f, FontStyle.Regular, GraphicsUnit.Point);
            statusFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);

            if (logoPath.Length > 0) {
                try {
                    // Through a copy in memory, never Image.FromFile: that holds the file open for
                    // the life of the image, and the one rule this process has is that it holds
                    // nothing open.
                    byte[] bytes = File.ReadAllBytes(logoPath);
                    using (var ms = new MemoryStream(bytes)) logo = new Bitmap(ms);
                } catch { logo = null; }
            }

            if (installerPid > 0) {
                try { installer = Process.GetProcessById(installerPid); } catch { installer = null; }
            }
        }

        int Px(int design) { return (int)Math.Round(design * scale); }

        protected override void OnLoad(EventArgs e) {
            base.OnLoad(e);
            // On the screen the user just clicked on, not always the primary one, and inside the
            // working area so it never sits under the taskbar.
            Screen screen;
            try { screen = Screen.FromPoint(Cursor.Position); } catch { screen = Screen.PrimaryScreen; }
            Rectangle area = screen.WorkingArea;
            Location = new Point(
                area.X + (area.Width - Width) / 2,
                area.Y + (area.Height - Height) / 2);
        }

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            // ~8 ms asks for more frames than the screen can show, on purpose: the surplus absorbs
            // jitter, and the Stopwatch means an early or late frame still draws the right pixel.
            frameTimer = new System.Threading.Timer(OnFrame, null, 0, 8);
            watchTimer = new System.Threading.Timer(OnWatch, null, 200, 300);
        }

        void OnFrame(object state) {
            if (Interlocked.CompareExchange(ref framePending, 1, 0) != 0) return;
            try {
                BeginInvoke((MethodInvoker)delegate {
                    Interlocked.Exchange(ref framePending, 0);
                    Invalidate(barRect);
                });
            } catch {
                // The window is closing; there is nothing left to draw on.
                Interlocked.Exchange(ref framePending, 0);
            }
        }

        /// <summary>
        /// Runs on a pool thread, never on the UI one. Process enumeration costs tens of
        /// milliseconds and would show up in the bar as a stumble every time it ran.
        /// </summary>
        void OnWatch(object state) {
            try {
                // An install cannot take five minutes, but a splash with no way out is a window
                // somebody has to kill from Task Manager.
                if ((DateTime.Now - startedAt).TotalMinutes > 5) { CloseFromWatcher(); return; }

                if (!starting) {
                    if (IsInstallerRunning()) { installerSeen = true; return; }
                    // Never seen at all yet: an elevated install arrives by way of elevate.exe, so
                    // the installer may simply not exist yet. Giving up on the first look would
                    // close the splash before the install had begun.
                    if (!installerSeen && (DateTime.Now - startedAt).TotalSeconds < 8) return;
                    starting = true;
                    startingAt = DateTime.Now;
                    SetStatus("Starting Rovyl");
                    return;
                }

                if (appSeenAt.HasValue) {
                    // A beat after the process appears, so the splash hands over to a window rather
                    // than to a gap -- and it is TopMost, so it must not sit on top of the app it
                    // just spent ten seconds waiting for.
                    if ((DateTime.Now - appSeenAt.Value).TotalMilliseconds > 900) CloseFromWatcher();
                    return;
                }

                if (IsAppRelaunched()) { appSeenAt = DateTime.Now; return; }

                // The install finished and nothing came back: it failed, or NSIS declined to
                // relaunch. Either way this window has nothing left to say.
                if ((DateTime.Now - startingAt).TotalSeconds > 25) CloseFromWatcher();
            } catch {
                // A watchdog that throws must not take the window with it.
            }
        }

        bool IsInstallerRunning() {
            // The cached handle first: HasExited on a Process we already opened is a single cheap
            // call, where looking the name up again walks every process on the machine.
            if (installer != null) {
                try { if (!installer.HasExited) return true; } catch { }
            }
            if (installerName.Length > 0) {
                string bare = Path.GetFileNameWithoutExtension(installerName);
                if (bare.Length > 0) {
                    try { if (Process.GetProcessesByName(bare).Length > 0) return true; } catch { }
                }
            }
            return false;
        }

        /// <summary>
        /// Only a Rovyl that started AFTER this window did counts. The process that spawned the
        /// splash is itself a Rovyl.exe on its way out, and mistaking it for the relaunched app
        /// would close the splash in the first second of the install.
        /// </summary>
        bool IsAppRelaunched() {
            try {
                foreach (Process p in Process.GetProcessesByName("Rovyl")) {
                    try { if (p.StartTime > startedAt) return true; } catch { }
                }
            } catch { }
            return false;
        }

        void SetStatus(string text) {
            try {
                BeginInvoke((MethodInvoker)delegate { statusText = text; Invalidate(); });
            } catch { }
        }

        void CloseFromWatcher() {
            try { BeginInvoke((MethodInvoker)delegate { Close(); }); } catch { }
        }

        protected override void OnPaint(PaintEventArgs e) {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var bg = new SolidBrush(Bg)) g.FillRectangle(bg, e.ClipRectangle);

            // Only the bar is invalid on an animation frame; the rest is already in the buffer.
            bool full = e.ClipRectangle.Width > barRect.Width || e.ClipRectangle.Height > barRect.Height * 4;
            if (full) {
                using (var pen = new Pen(Line, 1f)) g.DrawPath(pen, shape);

                if (logo != null) {
                    int size = Px(BaseLogo);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(logo, new Rectangle((ClientSize.Width - size) / 2, Px(32), size, size));
                }

                // Grayscale antialiasing, not ClearType: subpixel rendering fringes light text on a
                // near-black ground with colour that has no business being in this palette.
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                using (var fmt = new StringFormat { Alignment = StringAlignment.Center })
                using (var text = new SolidBrush(TextColor))
                using (var muted = new SolidBrush(MutedColor)) {
                    g.DrawString("Updating Rovyl", headFont, text,
                        new RectangleF(0, Px(92), ClientSize.Width, Px(26)), fmt);
                    g.DrawString(statusText, statusFont, muted,
                        new RectangleF(0, Px(120), ClientSize.Width, Px(20)), fmt);
                }
            }

            using (var track = new SolidBrush(TrackColor)) g.FillRectangle(track, barRect);

            // Time, not tick count: a frame that arrives late still draws where the eye expects it.
            double t = (clock.Elapsed.TotalMilliseconds % CycleMs) / CycleMs;
            float x = (float)(barRect.Left - slice + (barRect.Width + slice) * t);

            var travel = new RectangleF(x, barRect.Top, slice, barRect.Height);
            g.SetClip(barRect);
            using (var brush = new LinearGradientBrush(
                       new RectangleF(x - 1, barRect.Top, slice + 2, barRect.Height),
                       Color.Transparent, Color.Transparent, LinearGradientMode.Horizontal)) {
                // Transparent at both ends, solid through the middle: the highlight has no edges to
                // catch the eye as it enters and leaves the track.
                var blend = new ColorBlend(4);
                blend.Colors = new Color[] {
                    Color.FromArgb(0, 255, 255, 255),
                    Color.FromArgb(235, 255, 255, 255),
                    Color.FromArgb(235, 255, 255, 255),
                    Color.FromArgb(0, 255, 255, 255),
                };
                blend.Positions = new float[] { 0f, 0.42f, 0.58f, 1f };
                brush.InterpolationColors = blend;
                g.FillRectangle(brush, travel);
            }
            g.ResetClip();
        }

        protected override void OnFormClosed(FormClosedEventArgs e) {
            if (frameTimer != null) { frameTimer.Dispose(); frameTimer = null; }
            if (watchTimer != null) { watchTimer.Dispose(); watchTimer = null; }
            base.OnFormClosed(e);
        }

        public static void Run(string[] args) {
            int pid = 0;
            string name = "", version = "", logo = "";
            for (int i = 1; i < args.Length; i++) {
                string a = args[i];
                if (a == "--pid" && i + 1 < args.Length) { int.TryParse(args[++i], out pid); }
                else if (a == "--name" && i + 1 < args.Length) name = args[++i];
                else if (a == "--version" && i + 1 < args.Length) version = args[++i];
                else if (a == "--logo" && i + 1 < args.Length) logo = args[++i];
            }

            // Without this the whole window is bitmap-stretched on a scaled display, and a splash
            // that is visibly blurrier than the app it is installing is worse than none.
            try { SetProcessDPIAware(); } catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new RovylUpdateSplash(pid, name, version, logo)) Application.Run(form);
        }
    }

    /// <summary>
    /// The readings behind the system dock: output volume, the network, and the battery.
    ///
    /// WHY IT IS A LONG-LIVED PROCESS AND NOT A SPAWN PER READING
    ///
    /// The dock is drawn the instant the wheel opens, which is the one moment in Rovyl that has a
    /// frame budget. Starting a process to answer "what is the volume" costs more than the whole
    /// open gesture does, and the answer would arrive after the dock had already painted a blank.
    /// So this stays up for as long as the dock is switched on, and main talks to it over stdin
    /// exactly as it does to the mouse hook.
    ///
    /// WHY IT ONLY POLLS WHILE THE WHEEL IS UP
    ///
    /// Nothing here is event-driven -- volume has an IAudioEndpointVolumeCallback, the network has
    /// NetworkChange, the battery has WM_POWERBROADCAST, and wiring three notification sources
    /// would buy nothing, because nobody is looking at the readouts unless the wheel is open.
    /// WATCH &lt;ms&gt; turns the poll on and WATCH 0 turns it off, so an idle session costs a
    /// sleeping thread. A poll emits STATUS only when something actually moved.
    ///
    /// WHY EVERY READING CARRIES ITS OWN "UNKNOWN"
    ///
    /// -1, not 0. A desktop PC has no battery and a cable has no signal quality, and a readout that
    /// cannot tell those from "empty" and "no bars" shows a flat battery and a dead connection to
    /// someone whose machine is fine.
    /// </summary>
    public static class RovylSystemStatus {
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint INFINITE = 0xFFFFFFFF;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        /* ---- Core Audio ------------------------------------------------------
           Declared in vtable order, every slot present. A missing method is not a
           compile error, it is a silent one-slot shift that calls the neighbour --
           here, SetMute where GetMasterVolumeLevelScalar was meant. */

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumerator { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice {
            [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                [MarshalAs(UnmanagedType.IUnknown)] out object iface);
            [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out int state);
        }

        [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioEndpointVolume {
            [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
            [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
            [PreserveSig] int GetChannelCount(out int count);
            [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid eventContext);
            [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
            [PreserveSig] int GetMasterVolumeLevel(out float level);
            [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
            [PreserveSig] int SetChannelVolumeLevel(int channel, float level, ref Guid eventContext);
            [PreserveSig] int SetChannelVolumeLevelScalar(int channel, float level, ref Guid eventContext);
            [PreserveSig] int GetChannelVolumeLevel(int channel, out float level);
            [PreserveSig] int GetChannelVolumeLevelScalar(int channel, out float level);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
            [PreserveSig] int GetVolumeStepInfo(out int step, out int stepCount);
            [PreserveSig] int VolumeStepUp(ref Guid eventContext);
            [PreserveSig] int VolumeStepDown(ref Guid eventContext);
            [PreserveSig] int QueryHardwareSupport(out int mask);
            [PreserveSig] int GetVolumeRange(out float min, out float max, out float increment);
        }

        private static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        private static Guid EventContext = Guid.Empty;

        /// <summary>
        /// The endpoint is re-fetched whenever it is gone, not cached forever: the default output
        /// device changes under us when headphones are plugged in, and the stale interface then
        /// reports the volume of something nobody is listening to.
        /// </summary>
        private static IAudioEndpointVolume endpoint;
        private static int endpointFailures;

        private static IAudioEndpointVolume Endpoint() {
            if (endpoint != null) return endpoint;
            /* Three consecutive failures is a machine with no audio endpoint at all (a server
               core, a VM with no device). Retrying every poll would be a COM activation per
               second, forever, for a readout that will never appear. */
            if (endpointFailures >= 3) return null;
            try {
                var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
                IMMDevice device;
                /* eRender (0), eMultimedia (1) -- the device the volume key moves. */
                if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) {
                    endpointFailures++;
                    return null;
                }
                object raw;
                /* CLSCTX_INPROC_SERVER */
                if (device.Activate(ref IID_IAudioEndpointVolume, 1, IntPtr.Zero, out raw) != 0 || raw == null) {
                    endpointFailures++;
                    return null;
                }
                endpoint = (IAudioEndpointVolume)raw;
                endpointFailures = 0;
                return endpoint;
            } catch {
                endpointFailures++;
                return null;
            }
        }

        private static void DropEndpoint() {
            endpoint = null;
        }

        /* ---- Wi-Fi ----------------------------------------------------------
           NetworkInterface says a wireless adapter is up; only wlanapi says how
           well. The layout below is read no further than wlanSignalQuality, so
           the security attributes that follow it are deliberately not declared. */

        [StructLayout(LayoutKind.Sequential)]
        private struct WLAN_INTERFACE_INFO_LIST_HEADER {
            public uint dwNumberOfItems;
            public uint dwIndex;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WLAN_INTERFACE_INFO {
            public Guid InterfaceGuid;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strInterfaceDescription;
            public uint isState;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DOT11_SSID {
            public uint uSSIDLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] ucSSID;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WLAN_ASSOCIATION_ATTRIBUTES {
            public DOT11_SSID dot11Ssid;
            public uint dot11BssType;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] dot11Bssid;
            public uint dot11PhyType;
            public uint uDot11PhyIndex;
            public uint wlanSignalQuality;
            public uint ulRxRate;
            public uint ulTxRate;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WLAN_CONNECTION_ATTRIBUTES {
            public uint isState;
            public uint wlanConnectionMode;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strProfileName;
            public WLAN_ASSOCIATION_ATTRIBUTES wlanAssociationAttributes;
        }

        [DllImport("wlanapi.dll")]
        private static extern uint WlanOpenHandle(uint clientVersion, IntPtr reserved,
            out uint negotiatedVersion, out IntPtr handle);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
        [DllImport("wlanapi.dll")]
        private static extern uint WlanQueryInterface(IntPtr handle, ref Guid interfaceGuid, uint opCode,
            IntPtr reserved, out uint dataSize, out IntPtr data, IntPtr valueType);
        [DllImport("wlanapi.dll")]
        private static extern void WlanFreeMemory(IntPtr memory);

        private const uint WLAN_INTERFACE_STATE_CONNECTED = 1;
        private const uint WLAN_INTF_OPCODE_CURRENT_CONNECTION = 7;

        /// <summary>Signal quality 0-100 of the first connected Wi-Fi adapter, or -1 for none.</summary>
        private static int WifiSignal() {
            IntPtr client = IntPtr.Zero;
            IntPtr list = IntPtr.Zero;
            try {
                uint negotiated;
                /* Client version 2 is Vista and later; every Windows this app runs on. */
                if (WlanOpenHandle(2, IntPtr.Zero, out negotiated, out client) != 0) return -1;
                if (WlanEnumInterfaces(client, IntPtr.Zero, out list) != 0 || list == IntPtr.Zero) return -1;

                var header = (WLAN_INTERFACE_INFO_LIST_HEADER)Marshal.PtrToStructure(
                    list, typeof(WLAN_INTERFACE_INFO_LIST_HEADER));
                int stride = Marshal.SizeOf(typeof(WLAN_INTERFACE_INFO));
                int first = 8; /* the two ULONGs of the header */

                for (int i = 0; i < header.dwNumberOfItems; i++) {
                    var info = (WLAN_INTERFACE_INFO)Marshal.PtrToStructure(
                        new IntPtr(list.ToInt64() + first + (long)i * stride), typeof(WLAN_INTERFACE_INFO));
                    if (info.isState != WLAN_INTERFACE_STATE_CONNECTED) continue;

                    uint size;
                    IntPtr data;
                    Guid guid = info.InterfaceGuid;
                    if (WlanQueryInterface(client, ref guid, WLAN_INTF_OPCODE_CURRENT_CONNECTION,
                            IntPtr.Zero, out size, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) {
                        continue;
                    }
                    try {
                        var conn = (WLAN_CONNECTION_ATTRIBUTES)Marshal.PtrToStructure(
                            data, typeof(WLAN_CONNECTION_ATTRIBUTES));
                        long quality = conn.wlanAssociationAttributes.wlanSignalQuality;
                        /* Out of range means the layout read something that is not a quality.
                           Reporting "unknown" is the honest answer; reporting 0 would draw an
                           empty set of bars over a connection that works. */
                        if (quality < 0 || quality > 100) return -1;
                        return (int)quality;
                    } finally {
                        WlanFreeMemory(data);
                    }
                }
                return -1;
            } catch {
                return -1;
            } finally {
                if (list != IntPtr.Zero) { try { WlanFreeMemory(list); } catch { } }
                if (client != IntPtr.Zero) { try { WlanCloseHandle(client, IntPtr.Zero); } catch { } }
            }
        }

        /* ---- One reading ---------------------------------------------------- */

        private struct Reading {
            public int Volume;
            public bool Muted;
            public string Network;
            public int Signal;
            public int Battery;
            public bool Charging;

            public string Line() {
                return "STATUS " + Volume + " " + (Muted ? 1 : 0) + " " + Network + " "
                    + Signal + " " + Battery + " " + (Charging ? 1 : 0);
            }
        }

        private static string NetworkKind() {
            try {
                bool wifi = false, ethernet = false, other = false;
                foreach (var nic in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()) {
                    if (nic.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                    var type = nic.NetworkInterfaceType;
                    if (type == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
                    if (type == System.Net.NetworkInformation.NetworkInterfaceType.Tunnel) continue;
                    if (type == System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211) wifi = true;
                    else if (type == System.Net.NetworkInformation.NetworkInterfaceType.Ethernet
                          || type == System.Net.NetworkInformation.NetworkInterfaceType.GigabitEthernet
                          || type == System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetT
                          || type == System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetFx) ethernet = true;
                    else other = true;
                }
                /* Ethernet wins: a laptop docked with Wi-Fi still enabled is on the cable. */
                if (ethernet) return "ethernet";
                if (wifi) return "wifi";
                if (other) return "other";
                return "none";
            } catch {
                return "none";
            }
        }

        private static Reading Read() {
            var reading = new Reading();

            reading.Volume = -1;
            reading.Muted = false;
            var volume = Endpoint();
            if (volume != null) {
                try {
                    float scalar;
                    bool muted;
                    if (volume.GetMasterVolumeLevelScalar(out scalar) == 0) {
                        reading.Volume = (int)Math.Round(Math.Max(0f, Math.Min(1f, scalar)) * 100f);
                    }
                    if (volume.GetMute(out muted) == 0) reading.Muted = muted;
                } catch {
                    /* The default device went away mid-read; the next poll fetches a new one. */
                    DropEndpoint();
                }
            }

            reading.Network = NetworkKind();
            reading.Signal = reading.Network == "wifi" ? WifiSignal() : -1;

            reading.Battery = -1;
            reading.Charging = false;
            try {
                var power = SystemInformation.PowerStatus;
                bool none = (power.BatteryChargeStatus
                    & BatteryChargeStatus.NoSystemBattery) == BatteryChargeStatus.NoSystemBattery;
                bool unknown = (power.BatteryChargeStatus
                    & BatteryChargeStatus.Unknown) == BatteryChargeStatus.Unknown;
                if (!none && !unknown) {
                    float life = power.BatteryLifePercent;
                    if (life >= 0f && life <= 1f) reading.Battery = (int)Math.Round(life * 100f);
                }
                reading.Charging = power.PowerLineStatus == PowerLineStatus.Online;
            } catch {
                /* leave it unknown */
            }

            return reading;
        }

        /* ---- The loop -------------------------------------------------------- */

        private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
        private static readonly AutoResetEvent Wake = new AutoResetEvent(false);

        private static void Emit(string line) {
            try {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            } catch {
                /* main is gone; the parent watch is about to end this process anyway */
            }
        }

        private static void SetVolume(int percent) {
            var volume = Endpoint();
            if (volume == null) return;
            try {
                float scalar = Math.Max(0, Math.Min(100, percent)) / 100f;
                volume.SetMasterVolumeLevelScalar(scalar, ref EventContext);
                /* Setting a level on a muted endpoint leaves it muted and silent, which reads as
                   the slider doing nothing. Dragging it is an instruction to be heard. */
                if (percent > 0) volume.SetMute(false, ref EventContext);
            } catch {
                DropEndpoint();
            }
        }

        private static void SetMuted(int mode) {
            var volume = Endpoint();
            if (volume == null) return;
            try {
                bool next;
                if (mode == 2) {
                    bool current;
                    if (volume.GetMute(out current) != 0) return;
                    next = !current;
                } else {
                    next = mode == 1;
                }
                volume.SetMute(next, ref EventContext);
            } catch {
                DropEndpoint();
            }
        }

        public static void Run(int parentPid) {
            var input = new Thread(() => {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    Commands.Enqueue(line);
                    Wake.Set();
                }
                Commands.Enqueue("EXIT");
                Wake.Set();
            });
            input.IsBackground = true;
            input.Start();

            if (parentPid > 0) {
                var parentWatch = new Thread(() => {
                    IntPtr handle = OpenProcess(SYNCHRONIZE, false, parentPid);
                    if (handle == IntPtr.Zero) return;
                    WaitForSingleObject(handle, INFINITE);
                    CloseHandle(handle);
                    Commands.Enqueue("EXIT");
                    Wake.Set();
                });
                parentWatch.IsBackground = true;
                parentWatch.Start();
            }

            Emit("READY");

            int interval = 0;
            string last = null;
            bool running = true;

            while (running) {
                /* No poll asked for: sleep until a command arrives. An idle session costs nothing. */
                Wake.WaitOne(interval > 0 ? interval : Timeout.Infinite);

                bool forced = false;
                string command;
                while (Commands.TryDequeue(out command)) {
                    if (command == null) continue;
                    string text = command.Trim();
                    if (text.Length == 0) continue;
                    string[] parts = text.Split(' ');
                    string verb = parts[0].ToUpperInvariant();

                    if (verb == "EXIT") { running = false; break; }
                    if (verb == "POLL") { forced = true; continue; }
                    if (verb == "WATCH" && parts.Length > 1) {
                        int ms;
                        if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out ms)) continue;
                        /* Under 250ms is a poll nobody can read; over 10s is not a live readout. */
                        interval = ms <= 0 ? 0 : Math.Max(250, Math.Min(10000, ms));
                        /* Starting to watch is itself a request for a reading: the dock is about to
                           be drawn and must not paint a blank for one whole interval. */
                        if (interval > 0) forced = true;
                        continue;
                    }
                    if (verb == "VOL" && parts.Length > 1) {
                        int percent;
                        if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out percent)) {
                            SetVolume(percent);
                            forced = true;
                        }
                        continue;
                    }
                    if (verb == "MUTE" && parts.Length > 1) {
                        int mode;
                        if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out mode)) {
                            SetMuted(mode);
                            forced = true;
                        }
                        continue;
                    }
                }
                if (!running) break;
                if (interval <= 0 && !forced) continue;

                string line = Read().Line();
                /* Only what changed goes over the pipe. A parked wheel with a steady battery and a
                   steady volume produces one line per open, not one per second. */
                if (forced || line != last) {
                    last = line;
                    Emit(line);
                }
            }
        }
    }

    class Program {
        [STAThread]
        static void Main(string[] args) {
            try {
                RovylForeground.SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1));
            } catch { }

            if (args.Length > 0 && args[0] == "mouse-blocker") {
                int parentPid = 0;
                if (args.Length > 1) int.TryParse(args[1], out parentPid);
                ZenithRadialMouseBlocker.Run(parentPid);
                return;
            }

            if (args.Length > 0 && args[0] == "foreground-focus") {
                RovylForegroundFocus.Run();
                return;
            }

            if (args.Length > 0 && args[0] == "update-splash") {
                RovylUpdateSplash.Run(args);
                return;
            }

            if (args.Length > 0 && args[0] == "system-status") {
                int parentPid = 0;
                if (args.Length > 1) int.TryParse(args[1], out parentPid);
                RovylSystemStatus.Run(parentPid);
                return;
            }

            Console.WriteLine("Usage: rovyl-helper.exe [mouse-blocker <parentPid> | foreground-focus"
                + " | system-status <parentPid>"
                + " | update-splash --pid <n> --name <installer.exe> --version <v> --logo <path>]");
        }
    }
}
