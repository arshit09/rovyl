//! The global mouse and keyboard hooks, and the trigger state machine that lives in them.
//!
//! **Why a hook and not a poll.** An earlier version of the original polled `GetAsyncKeyState`
//! every 16 ms, which only ever *observed* the button — the event still reached the window
//! underneath, so on any scrollable surface Windows started autoscroll and aiming at the wheel
//! dragged the page behind it. Swallowing the event requires returning 1 from a low-level hook, and
//! a swallowed button also disappears from `GetAsyncKeyState`. Whatever swallows the event must
//! therefore also be what detects it.
//!
//! **Why a dedicated thread.** A `WH_MOUSE_LL` callback is delivered on the thread that installed
//! the hook, through that thread's message loop. A thread that stalls therefore stalls the mouse
//! *for the whole system* until `LowLevelHooksTimeout` elapses. The UI thread draws, loads icons'
//! metadata and talks to the shell, and any one of those can block for longer than a user would
//! tolerate their pointer freezing — so the hooks get a thread that does nothing else. It services
//! the callbacks, writes to atomics, and posts to the UI thread; it never waits on it.
//!
//! **Why this replaces three things the Electron build needed.** The hook is in-process, so it
//! shares one coordinate space with the renderer — which closes `docs/ARCHITECTURE.md`'s known
//! mixed-DPI defect, where DIP rectangles were compared against raw hook points by a DPI-unaware
//! PowerShell process. It is also the only mouse input the wheel uses, so there is no second path
//! through real window messages that could disagree with it, and nothing has to steal the
//! foreground to receive a keystroke.

use super::trigger::{Button, Trigger};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyState, SendInput, INPUT, INPUT_0, INPUT_MOUSE,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
    VIRTUAL_KEY, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN,
    VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, PostMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
    WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON2,
};

// ─── Tuning ─────────────────────────────────────────────────────────────────

/// A press longer than this was intent to open the wheel, not a click.
const PASSTHROUGH_MAX_MS: u32 = 250;

/// Below this much travel, a short press aimed at nothing and really was a click.
///
/// Six pixels, which is the tremor of a hand clicking. It is NOT the 30px drag threshold below:
/// that one decides whether a *click-mode* press has stopped being a click, and six pixels there
/// stole clicks from shaky hands.
const PASSTHROUGH_SLOP_PX: i32 = 6;

/// "Click" mode: the time above which the press is NOT ours.
///
/// The DOWN was swallowed — it has to be, or the window underneath starts autoscrolling under the
/// wheel — and without that DOWN there is no wheel-press scroll, no terminal paste, no CAD pan.
/// Past this threshold the button is pressed underneath on the user's behalf and released when
/// they let go: the gesture reaches the right place, with this much delay.
///
/// Handing it back only at the END (a DOWN+UP together on release) does not work: the scroll
/// anchors on the DOWN and lives off the movement AFTER it, so delivered at the end there is no
/// movement left — and in Chromium a stationary DOWN+UP is precisely the gesture that leaves the
/// scroll stuck to the pointer after the user has already let go.
const CLICK_HOLD_MS: u32 = 400;

/// Distance that proves a click-mode press is NOT a click — the signal that hands the button back
/// faster than time can.
///
/// Waiting out the 400 ms was the complaint: pressing the wheel to scroll the page left it sitting
/// still until the threshold passed. But scrolling IS moving — the instant the hand leaves the
/// spot, the press can no longer be a click, and the button can go down already.
///
/// Well above the tremor of a hand clicking (under 10px, even at high DPI) and well below any
/// scroll gesture.
const CLICK_DRAG_PX: i32 = 30;

/// How often the click-mode press is re-examined while the button is held.
///
/// 15 ms rather than a hook-side check, because `WM_MOUSEMOVE` is ~99% of the system's mouse
/// events and the callback leaves before even touching `lParam`. Code on that path is paid for on
/// every mouse event in Windows; this costs one `GetCursorPos` every 15 ms, and only while a
/// button is down.
const CLICK_TICK_MS: u32 = 15;

/// Signature on the events injected by this module, so the hook does not swallow them again.
///
/// 'ROVY' as bytes. Any value works as long as nothing else in the system uses it; a recognisable
/// one makes an `ETW` mouse trace readable.
const SYNTHETIC_TAG: usize = 0x524F_5659;

// ─── Messages posted to the UI thread ───────────────────────────────────────

use windows::Win32::UI::WindowsAndMessaging::WM_APP;

/// The trigger went down. `lParam` carries the point.
pub const MSG_TRIGGER_DOWN: u32 = WM_APP + 1;
/// The trigger came up and the press was a CLICK: in click mode this toggles the wheel, in hold
/// mode it means the gesture aimed at nothing and the real click has been handed back.
pub const MSG_TRIGGER_CLICK: u32 = WM_APP + 2;
/// The trigger came up after a genuine HOLD: confirm whatever is aimed at.
pub const MSG_TRIGGER_HOLD_END: u32 = WM_APP + 3;
/// A mouse button or the wheel, while the wheel is open. `wParam` is a [`PointerEvent`].
pub const MSG_POINTER: u32 = WM_APP + 4;
/// A key, while the wheel is open. `wParam` is the virtual-key code, `lParam` the modifier mask.
pub const MSG_KEY_DOWN: u32 = WM_APP + 5;
/// The recorder saw a mouse button. `wParam` is a [`Button`] ordinal, `lParam` the modifier mask.
pub const MSG_RECORD_MOUSE: u32 = WM_APP + 6;
/// Every mouse button has been released — the tray menu waits for this before it opens.
pub const MSG_BUTTONS_UP: u32 = WM_APP + 7;

/// What a [`MSG_POINTER`] message says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PointerEvent {
    LeftDown = 1,
    LeftUp = 2,
    RightDown = 3,
    WheelUp = 4,
    WheelDown = 5,
}

impl PointerEvent {
    pub fn from_wparam(value: WPARAM) -> Option<Self> {
        Some(match value.0 as u32 {
            1 => PointerEvent::LeftDown,
            2 => PointerEvent::LeftUp,
            3 => PointerEvent::RightDown,
            4 => PointerEvent::WheelUp,
            5 => PointerEvent::WheelDown,
            _ => return None,
        })
    }
}

/// Pack a screen point into an `LPARAM`.
///
/// Both halves are full `i32`s, not the `i16`s `MAKELPARAM` would give: a point on a monitor left
/// of the primary is negative, and on a wide multi-monitor desktop the coordinates comfortably
/// exceed 32767. The classic `LOWORD`/`HIWORD` packing silently wraps there.
pub fn pack_point(point: POINT) -> LPARAM {
    LPARAM(((point.x as u32 as isize) | ((point.y as u32 as isize) << 32)) as isize)
}

pub fn unpack_point(value: LPARAM) -> POINT {
    POINT {
        x: (value.0 as u64 & 0xFFFF_FFFF) as u32 as i32,
        y: ((value.0 as u64 >> 32) & 0xFFFF_FFFF) as u32 as i32,
    }
}

// ─── Modifier mask ──────────────────────────────────────────────────────────

pub const MOD_CTRL: u32 = 1;
pub const MOD_ALT: u32 = 2;
pub const MOD_SHIFT: u32 = 4;
pub const MOD_WIN: u32 = 8;

fn modifier_mask() -> u32 {
    let down = |vk: VIRTUAL_KEY| unsafe { (GetKeyState(vk.0 as i32) as u16 & 0x8000) != 0 };
    let mut mask = 0;
    if down(VK_CONTROL) {
        mask |= MOD_CTRL;
    }
    if down(VK_MENU) {
        mask |= MOD_ALT;
    }
    if down(VK_SHIFT) {
        mask |= MOD_SHIFT;
    }
    if down(VK_LWIN) || down(VK_RWIN) {
        mask |= MOD_WIN;
    }
    mask
}

// ─── Shared state ───────────────────────────────────────────────────────────
//
// Read by the hook callbacks on the input thread and written by the UI thread. Atomics rather than
// a lock, and the reason is not performance: a hook callback that waits on a mutex held by a
// stalled UI thread freezes the mouse for the entire system. There is no lock here that could be
// contended, so there is no way for that to happen.

struct State {
    /// Where the UI thread's messages go. Zero until the window exists.
    target: AtomicIsize,
    /// The input thread's id, for `PostThreadMessageW`. Zero until the thread is up.
    thread_id: AtomicU32,

    /// The armed trigger, packed by [`pack_trigger`]. Zero means no mouse trigger at all.
    armed: AtomicU32,
    /// Whether the armed trigger is in hold mode.
    hold_mode: AtomicBool,

    /// The wheel is open: swallow buttons on its monitor and forward them instead.
    blocking: AtomicBool,
    /// The monitor the wheel is on, in physical pixels. Events outside it are left alone, so a
    /// click on the second screen still reaches the app that is there.
    block_rect: [AtomicI64; 2],

    /// The settings panel is recording a trigger button.
    recording: AtomicBool,

    /// Latest cursor position, packed. Read once per frame by the renderer rather than posted per
    /// move: a 1000 Hz mouse would otherwise cost a thousand messages a second to tell the wheel
    /// something it can only act on once per refresh.
    cursor: AtomicI64,

    /// Where and when the trigger went down, for the click/hold decision.
    down_point: AtomicI64,
    down_at: AtomicU32,
    /// A click-mode press is under way: DOWN seen, UP still to come.
    click_armed: AtomicBool,
    /// Button whose DOWN has already been injected underneath; the UP is owed. 0 = nothing owed.
    click_injected: AtomicU32,
    /// The tray menu is waiting for every button to be released.
    awaiting_buttons_up: AtomicBool,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| State {
        target: AtomicIsize::new(0),
        thread_id: AtomicU32::new(0),
        armed: AtomicU32::new(0),
        hold_mode: AtomicBool::new(false),
        blocking: AtomicBool::new(false),
        block_rect: [AtomicI64::new(0), AtomicI64::new(0)],
        recording: AtomicBool::new(false),
        cursor: AtomicI64::new(0),
        down_point: AtomicI64::new(0),
        down_at: AtomicU32::new(0),
        click_armed: AtomicBool::new(false),
        click_injected: AtomicU32::new(0),
        awaiting_buttons_up: AtomicBool::new(false),
    })
}

fn pack_i64(x: i32, y: i32) -> i64 {
    (x as u32 as i64) | ((y as u32 as i64) << 32)
}

fn unpack_i64(value: i64) -> (i32, i32) {
    ((value as u64 & 0xFFFF_FFFF) as u32 as i32, ((value as u64 >> 32) & 0xFFFF_FFFF) as u32 as i32)
}

/// A trigger as one word, so the hook can read it without a lock.
///
/// Button in the low byte (1-based, so 0 can mean "nothing armed"), modifier mask above it.
fn pack_trigger(t: &Trigger) -> u32 {
    let button = match t.button {
        Button::Left => 1u32,
        Button::Right => 2,
        Button::Middle => 3,
        Button::X1 => 4,
        Button::X2 => 5,
    };
    let mut mods = 0;
    if t.ctrl {
        mods |= MOD_CTRL;
    }
    if t.alt {
        mods |= MOD_ALT;
    }
    if t.shift {
        mods |= MOD_SHIFT;
    }
    if t.meta {
        mods |= MOD_WIN;
    }
    button | (mods << 8)
}

/// Milliseconds since an arbitrary origin, as a wrapping `u32`.
///
/// Deliberately matching the OS tick width so the arithmetic below is the same arithmetic the
/// original had to get right: `GetTickCount` wraps at ~49.7 days of uptime, and a subtraction
/// across the wrap used to come out hugely negative — which made every "was it short?" test come
/// out TRUE, so a long hold counted as a click. `wrapping_sub` on unsigned gives the correct
/// elapsed time across the wrap, which removes the failure rather than guarding against it.
fn now_ms() -> u32 {
    unsafe { windows::Win32::System::SystemInformation::GetTickCount() }
}

// ─── Public control surface ─────────────────────────────────────────────────

/// Where to post input events. Called once, as soon as the message window exists.
pub fn set_target(hwnd: HWND) {
    state().target.store(hwnd.0 as isize, Ordering::Release);
}

fn target() -> Option<HWND> {
    let raw = state().target.load(Ordering::Acquire);
    (raw != 0).then_some(HWND(raw as _))
}

fn post(message: u32, w: WPARAM, l: LPARAM) {
    if let Some(hwnd) = target() {
        unsafe {
            // A failed post means the window has gone, which happens during shutdown. There is
            // nothing to recover and nothing to report: the event simply has no destination.
            let _ = PostMessageW(hwnd, message, w, l);
        }
    }
}

/// Arm the mouse trigger, or disarm it with `None`.
///
/// Disarming or re-arming mid-press must not leave the injected button stuck down — the user has
/// already let go of their physical button and has no way to release ours.
pub fn arm(binding: Option<&Trigger>, hold: bool) {
    release_injected_button();
    let s = state();
    match binding {
        Some(t) => {
            s.armed.store(pack_trigger(t), Ordering::Release);
            s.hold_mode.store(hold, Ordering::Release);
        }
        None => s.armed.store(0, Ordering::Release),
    }
    refresh_hooks();
}

/// The wheel is open on this monitor: swallow buttons and the wheel there, and forward them.
///
/// The rectangle is the MONITOR, in physical pixels, and the whole of it. The Electron build also
/// carried an "allowed" sub-rectangle, because its renderer needed real clicks to reach the window
/// for the gear and the docks. Here nothing does: the wheel hit-tests those itself from the
/// forwarded events, so there is exactly one input path and no second one to disagree with it.
/// That is also what removes the two-screen failure the original documented, where the allowed rect
/// could fail to intersect the blocked monitor and every click was swallowed.
pub fn begin_blocking(monitor: RECT) {
    let s = state();
    s.block_rect[0].store(pack_i64(monitor.left, monitor.top), Ordering::Relaxed);
    s.block_rect[1].store(pack_i64(monitor.right, monitor.bottom), Ordering::Relaxed);
    s.blocking.store(true, Ordering::Release);
    refresh_hooks();
}

pub fn end_blocking() {
    state().blocking.store(false, Ordering::Release);
    refresh_hooks();
}

pub fn set_recording(on: bool) {
    state().recording.store(on, Ordering::Release);
    refresh_hooks();
}

/// The freshest cursor position the hook has seen.
///
/// Falls back to `GetCursorPos` before the first move, so an open that happens before the mouse has
/// moved at all still knows where the pointer is.
pub fn cursor() -> POINT {
    let packed = state().cursor.load(Ordering::Relaxed);
    if packed == 0 {
        let mut point = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut point);
        }
        return point;
    }
    let (x, y) = unpack_i64(packed);
    POINT { x, y }
}

/// Ask to be told when no mouse button is held any more.
///
/// Polled by the tick rather than hooked, because the asker is the tray menu and the hook may not
/// be installed at all while the app idles. `GetAsyncKeyState` reads the PHYSICAL buttons, so a
/// swapped-buttons mouse needs no special case as long as all three are watched.
pub fn notify_on_buttons_up() {
    state().awaiting_buttons_up.store(true, Ordering::Release);
    wake_input_thread();
}

// ─── The hooks ──────────────────────────────────────────────────────────────

static MOUSE_HOOK: AtomicIsize = AtomicIsize::new(0);
static KEYBOARD_HOOK: AtomicIsize = AtomicIsize::new(0);

/// Whether the mouse hook has any reason to be installed.
///
/// It is released when it has none. A low-level hook is a system-wide tax — every mouse event in
/// Windows is marshalled to this thread — and a launcher that idles for hours between gestures has
/// no business charging it while nothing is armed.
fn mouse_hook_wanted() -> bool {
    let s = state();
    s.armed.load(Ordering::Acquire) != 0
        || s.blocking.load(Ordering::Acquire)
        || s.recording.load(Ordering::Acquire)
}

/// The keyboard hook exists only while the wheel is open.
///
/// This is what replaces the Electron build's foreground stealing. The overlay never takes focus —
/// it cannot, it is `WS_EX_NOACTIVATE` — so filtering, the number keys and Escape arrive through
/// here instead, and the window that had focus keeps it. Nothing has to be wrestled away from the
/// app the user was using, and nothing has to be given back.
fn keyboard_hook_wanted() -> bool {
    state().blocking.load(Ordering::Acquire)
}

unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    let chain = || CallNextHookEx(None, code, w, l);
    if code < 0 {
        return chain();
    }
    let message = w.0 as u32;
    let s = state();

    // Every mouse event in the system passes through here, serialised. `WM_MOUSEMOVE` is the
    // overwhelming majority of them — a 1000 Hz gaming mouse makes a thousand a second — so it
    // takes the shortest possible path: record the point and leave. No allocation, no branch on
    // the trigger, no posted message.
    if message == WM_MOUSEMOVE {
        let data = &*(l.0 as *const MSLLHOOKSTRUCT);
        s.cursor
            .store(pack_i64(data.pt.x, data.pt.y), Ordering::Relaxed);
        return chain();
    }

    let armed = s.armed.load(Ordering::Acquire);
    let blocking = s.blocking.load(Ordering::Acquire);
    let recording = s.recording.load(Ordering::Acquire);
    // With nothing armed, nothing blocked and nothing recording there is no decision to make.
    if armed == 0 && !blocking && !recording {
        return chain();
    }

    let data = &*(l.0 as *const MSLLHOOKSTRUCT);
    // Our own handed-back clicks go through without being reinterpreted.
    if data.dwExtraInfo == SYNTHETIC_TAG {
        return chain();
    }

    let point = data.pt;
    s.cursor.store(pack_i64(point.x, point.y), Ordering::Relaxed);

    let (button, is_down) = classify(message, data.mouseData);

    if recording {
        if let (Some(button), true) = (button, is_down) {
            let mods = modifier_mask();
            // A bare left or right is refused by `trigger::reject`, but it must still not be
            // SWALLOWED while recording: the user needs their primary click to press Cancel.
            let bare_primary =
                matches!(button, Button::Left | Button::Right) && mods == 0;
            if !bare_primary {
                post(
                    MSG_RECORD_MOUSE,
                    WPARAM(button_ordinal(button) as usize),
                    LPARAM(mods as isize),
                );
                return LRESULT(1);
            }
        }
    }

    if armed != 0 {
        let want_button = armed & 0xFF;
        let want_mods = (armed >> 8) & 0xFF;
        if let Some(button) = button {
            if button_ordinal(button) == want_button {
                if is_down {
                    // The modifiers are only checked on the DOWN. Checking them on the UP as well
                    // would lose the release of anybody who let go of Ctrl before the button, and
                    // the swallowed DOWN would then never be answered.
                    if modifier_mask() == want_mods {
                        return on_trigger_down(point);
                    }
                } else if s.click_armed.load(Ordering::Acquire)
                    || s.click_injected.load(Ordering::Acquire) != 0
                    || s.hold_mode.load(Ordering::Acquire)
                {
                    return on_trigger_up(point);
                }
            }
        }
    }

    if blocking && is_blocked_message(message) {
        let (left, top) = unpack_i64(s.block_rect[0].load(Ordering::Relaxed));
        let (right, bottom) = unpack_i64(s.block_rect[1].load(Ordering::Relaxed));
        let inside = point.x >= left && point.x < right && point.y >= top && point.y < bottom;
        if inside {
            // Forward the ones the wheel acts on; swallow all of them either way, so nothing
            // reaches the app underneath while the wheel is over it.
            if let Some(event) = pointer_event(message, data.mouseData) {
                post(MSG_POINTER, WPARAM(event as u32 as usize), pack_point(point));
            }
            return LRESULT(1);
        }
    }

    chain()
}

fn button_ordinal(button: Button) -> u32 {
    match button {
        Button::Left => 1,
        Button::Right => 2,
        Button::Middle => 3,
        Button::X1 => 4,
        Button::X2 => 5,
    }
}

/// Which button a message is about, and whether it went down.
///
/// A double-click message counts as a DOWN: the system sends `WM_xBUTTONDBLCLK` *instead of* the
/// second `WM_xBUTTONDOWN`, so treating it as anything else loses every other press when the user
/// triggers the wheel twice quickly.
fn classify(message: u32, mouse_data: u32) -> (Option<Button>, bool) {
    match message {
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => (Some(Button::Left), true),
        WM_LBUTTONUP => (Some(Button::Left), false),
        WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => (Some(Button::Right), true),
        WM_RBUTTONUP => (Some(Button::Right), false),
        WM_MBUTTONDOWN | WM_MBUTTONDBLCLK => (Some(Button::Middle), true),
        WM_MBUTTONUP => (Some(Button::Middle), false),
        WM_XBUTTONDOWN | WM_XBUTTONDBLCLK | WM_XBUTTONUP => {
            let which = (mouse_data >> 16) & 0xFFFF;
            let button = if which == XBUTTON2 as u32 {
                Button::X2
            } else {
                Button::X1
            };
            (Some(button), message != WM_XBUTTONUP)
        }
        _ => (None, false),
    }
}

fn is_blocked_message(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONDOWN
            | WM_LBUTTONUP
            | WM_LBUTTONDBLCLK
            | WM_RBUTTONDOWN
            | WM_RBUTTONUP
            | WM_RBUTTONDBLCLK
            | WM_MBUTTONDOWN
            | WM_MBUTTONUP
            | WM_MBUTTONDBLCLK
            | WM_XBUTTONDOWN
            | WM_XBUTTONUP
            | WM_XBUTTONDBLCLK
            | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
    )
}

fn pointer_event(message: u32, mouse_data: u32) -> Option<PointerEvent> {
    Some(match message {
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => PointerEvent::LeftDown,
        WM_LBUTTONUP => PointerEvent::LeftUp,
        WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => PointerEvent::RightDown,
        WM_MOUSEWHEEL => {
            // The delta is the high word, signed: a positive turn is away from the user.
            let delta = ((mouse_data >> 16) & 0xFFFF) as u16 as i16;
            if delta > 0 {
                PointerEvent::WheelUp
            } else {
                PointerEvent::WheelDown
            }
        }
        _ => return None,
    })
}

fn on_trigger_down(point: POINT) -> LRESULT {
    let s = state();
    s.down_point
        .store(pack_i64(point.x, point.y), Ordering::Relaxed);
    s.down_at.store(now_ms(), Ordering::Relaxed);
    // Only click mode defers the decision; hold mode settles it all on release.
    s.click_armed
        .store(!s.hold_mode.load(Ordering::Acquire), Ordering::Release);
    post(MSG_TRIGGER_DOWN, WPARAM(0), pack_point(point));
    wake_input_thread();
    LRESULT(1)
}

fn on_trigger_up(point: POINT) -> LRESULT {
    let s = state();
    let (down_x, down_y) = unpack_i64(s.down_point.load(Ordering::Relaxed));
    let dx = point.x - down_x;
    let dy = point.y - down_y;
    let held = now_ms().wrapping_sub(s.down_at.load(Ordering::Relaxed));
    let armed_button = s.armed.load(Ordering::Acquire) & 0xFF;

    if s.hold_mode.load(Ordering::Acquire) {
        post(MSG_TRIGGER_HOLD_END, WPARAM(0), pack_point(point));
        // Short, stationary click: the user aimed at nothing and really did want to middle-click.
        // The click is handed back to the window underneath — but outside the hook, because
        // injecting here would re-enter it.
        if held <= PASSTHROUGH_MAX_MS
            && dx * dx + dy * dy <= PASSTHROUGH_SLOP_PX * PASSTHROUGH_SLOP_PX
        {
            queue_passthrough(Passthrough::Pair, armed_button);
        }
        return LRESULT(1);
    }

    let was_armed = s.click_armed.swap(false, Ordering::AcqRel);
    let injected = s.click_injected.swap(0, Ordering::AcqRel);
    if injected != 0 {
        // The DOWN already went out mid-press: release now what is owed.
        queue_passthrough(Passthrough::Up, injected);
        post(MSG_TRIGGER_HOLD_END, WPARAM(0), pack_point(point));
    } else if !was_armed || held >= CLICK_HOLD_MS || dx * dx + dy * dy >= CLICK_DRAG_PX * CLICK_DRAG_PX
    {
        // A hold with no injected DOWN. Two ways to get here: the 15 ms tick has not run yet (a
        // short but already dragged press lets go inside the interval), and there was no paired
        // DOWN at all — the hook re-armed with the button already held, which is what happens when
        // the trigger button or mode is changed in Settings with the mouse in hand. An unknown
        // duration counts as a hold, which is the safe side.
        //
        // No DOWN is owed, so there is no UP to inject — and a pair is not injected now either: a
        // quick drag is nobody's click, and handing it back at the end would only put a middle
        // click where the hand no longer is.
        post(MSG_TRIGGER_HOLD_END, WPARAM(0), pack_point(point));
    } else {
        post(MSG_TRIGGER_CLICK, WPARAM(0), pack_point(point));
    }
    LRESULT(1)
}

unsafe extern "system" fn keyboard_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    let chain = || CallNextHookEx(None, code, w, l);
    if code < 0 || !state().blocking.load(Ordering::Acquire) {
        return chain();
    }
    let message = w.0 as u32;
    if message != WM_KEYDOWN && message != WM_SYSKEYDOWN {
        // Key-ups are left alone. The wheel acts on presses, and swallowing the UP of a key whose
        // DOWN reached an application leaves that application with the key stuck down.
        if message == WM_KEYUP || message == WM_SYSKEYUP {
            return chain();
        }
        return chain();
    }
    let data = &*(l.0 as *const KBDLLHOOKSTRUCT);
    let vk = data.vkCode;
    let mods = modifier_mask();

    // The modifier keys themselves pass through: the wheel never acts on one alone, and swallowing
    // Alt's DOWN while leaving its UP is how an application ends up stuck in a menu-bar state.
    if matches!(
        vk,
        0x10..=0x12 /* Shift, Ctrl, Alt */ | 0x5B | 0x5C /* Win */ | 0xA0..=0xA5
    ) {
        return chain();
    }

    // Anything with Ctrl, Alt or Win held belongs to the system or to the app underneath. The
    // wheel's own keys are bare, and the global shortcut that OPENS it is registered separately —
    // if it were swallowed here, the shortcut could never close the wheel it opened.
    if mods & (MOD_CTRL | MOD_ALT | MOD_WIN) != 0 {
        return chain();
    }

    post(MSG_KEY_DOWN, WPARAM(vk as usize), LPARAM(mods as isize));
    // Swallowed. A wheel that is up has the keyboard: a letter typed at it filters, and letting
    // that letter also reach the editor behind it is how a gesture leaves text in a document.
    LRESULT(1)
}

// ─── Passthrough injection ──────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum Passthrough {
    /// DOWN and UP together — the hold-mode click handed back on release.
    Pair,
    /// DOWN only, mid-press, so the movement that follows reaches the window underneath.
    Down,
    /// The UP owed for a DOWN already injected.
    Up,
}

/// Queued and flushed from the input thread's loop rather than sent here.
///
/// `SendInput` from inside a hook callback re-enters the hook, and the re-entrant call sees the
/// synthetic tag and passes it on — but the stack is already one hook deep and the system's
/// re-entrancy guarantees for low-level hooks are not something to build on.
static PENDING: AtomicU32 = AtomicU32::new(0);

fn queue_passthrough(kind: Passthrough, button: u32) {
    let code = match kind {
        Passthrough::Pair => 0,
        Passthrough::Down => 1000,
        Passthrough::Up => 2000,
    } + button;
    PENDING.store(code, Ordering::Release);
    wake_input_thread();
}

fn flush_passthrough() {
    let code = PENDING.swap(0, Ordering::AcqRel);
    if code == 0 {
        return;
    }
    let button = code % 1000;
    let want_down = code < 2000;
    let want_up = code < 1000 || code >= 2000;

    // No `MOUSEEVENTF_MOVE` and no `ABSOLUTE`: the event comes out wherever the pointer is now,
    // which is what is wanted — the click-mode DOWN has to anchor where the hand is when it passes
    // the threshold, not where it was when the button went down.
    let (down_flag, up_flag, data) = match button {
        3 => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
        4 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1),
        5 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2),
        // Left and right are click-only bindings and never reach the passthrough path: there is no
        // hold mode for them to hand a click back from.
        _ => return,
    };

    let make = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: SYNTHETIC_TAG,
            },
        },
    };
    let mut inputs: Vec<INPUT> = Vec::with_capacity(2);
    if want_down {
        inputs.push(make(down_flag));
    }
    if want_up {
        inputs.push(make(up_flag));
    }
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Safety net for the injected button.
///
/// Exiting, disarming or re-arming with the injected DOWN still held underneath left the system
/// with the button stuck — and the user has no way to release it, because their physical button has
/// already been let go. Every exit path goes through here.
fn release_injected_button() {
    let s = state();
    s.click_armed.store(false, Ordering::Release);
    let injected = s.click_injected.swap(0, Ordering::AcqRel);
    if injected != 0 {
        queue_passthrough(Passthrough::Up, injected);
    }
}

// ─── The input thread ───────────────────────────────────────────────────────

/// Sent to the input thread to make it re-evaluate everything.
///
/// One message rather than several: the thread's job is to reconcile the hooks and the queues with
/// whatever the atomics currently say, and a wake-up carries no information the atomics do not
/// already hold. That is also why a lost wake-up is harmless — the tick will catch it.
const WM_INPUT_WAKE: u32 = WM_APP + 100;

fn wake_input_thread() {
    let id = state().thread_id.load(Ordering::Acquire);
    if id != 0 {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                id,
                WM_INPUT_WAKE,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

fn refresh_hooks() {
    wake_input_thread();
}

/// Install or release the hooks to match what is currently wanted. Runs only on the input thread.
fn reconcile_hooks() {
    unsafe {
        let want_mouse = mouse_hook_wanted();
        let have_mouse = MOUSE_HOOK.load(Ordering::Relaxed);
        if want_mouse && have_mouse == 0 {
            // A NULL module with a thread id of 0 is the documented form for a low-level hook: the
            // callback lives in this process and the system marshals every event to this thread.
            if let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                MOUSE_HOOK.store(hook.0 as isize, Ordering::Relaxed);
            }
        } else if !want_mouse && have_mouse != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(have_mouse as _));
            MOUSE_HOOK.store(0, Ordering::Relaxed);
        }

        let want_keys = keyboard_hook_wanted();
        let have_keys = KEYBOARD_HOOK.load(Ordering::Relaxed);
        if want_keys && have_keys == 0 {
            if let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0) {
                KEYBOARD_HOOK.store(hook.0 as isize, Ordering::Relaxed);
            }
        } else if !want_keys && have_keys != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(have_keys as _));
            KEYBOARD_HOOK.store(0, Ordering::Relaxed);
        }
    }
}

/// Everything the 15 ms tick has to do.
fn tick() {
    let s = state();

    if s.awaiting_buttons_up.load(Ordering::Acquire) {
        let held = |vk: VIRTUAL_KEY| unsafe {
            (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0
        };
        if !held(VK_LBUTTON) && !held(VK_RBUTTON) && !held(VK_MBUTTON) {
            s.awaiting_buttons_up.store(false, Ordering::Release);
            post(MSG_BUTTONS_UP, WPARAM(0), LPARAM(0));
        }
    }

    // Click mode: the press can no longer be ours — press the button underneath NOW, with the user
    // still holding, so that the movement that follows reaches the window and wheel-press scrolling
    // works.
    //
    // Two proofs, and whichever lands first wins. The TIME one covers whoever presses and stays
    // still. The DISTANCE one is what matters to whoever is scrolling: moving the hand already says
    // it is not a click, and there is no reason to wait out the whole interval.
    let armed = s.armed.load(Ordering::Acquire) & 0xFF;
    if armed != 0
        && !s.hold_mode.load(Ordering::Acquire)
        && s.click_armed.load(Ordering::Acquire)
        && s.click_injected.load(Ordering::Acquire) == 0
    {
        let held_ms = now_ms().wrapping_sub(s.down_at.load(Ordering::Relaxed));
        let mut overdue = held_ms >= CLICK_HOLD_MS;
        if !overdue {
            let now = cursor();
            let (down_x, down_y) = unpack_i64(s.down_point.load(Ordering::Relaxed));
            let (dx, dy) = (now.x - down_x, now.y - down_y);
            overdue = dx * dx + dy * dy >= CLICK_DRAG_PX * CLICK_DRAG_PX;
        }
        if overdue {
            s.click_injected.store(armed, Ordering::Release);
            queue_passthrough(Passthrough::Down, armed);
        }
    }

    flush_passthrough();
}

/// Whether the tick has anything to watch. Timers cost wake-ups, and a launcher that idles for
/// hours should idle at zero.
fn tick_wanted() -> bool {
    let s = state();
    s.awaiting_buttons_up.load(Ordering::Acquire)
        || s.click_armed.load(Ordering::Acquire)
        || s.click_injected.load(Ordering::Acquire) != 0
        || PENDING.load(Ordering::Acquire) != 0
}

/// Start the input thread. Returns once the thread has its message queue up.
pub fn start() {
    std::thread::Builder::new()
        .name("rovyl-input".into())
        .spawn(input_thread)
        .expect("the input thread is required for the mouse trigger");
}

fn input_thread() {
    use windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer, WM_TIMER};

    const TIMER_ID: usize = 1;
    unsafe {
        // Giving the thread a queue before publishing its id: a `PostThreadMessageW` that arrives
        // before the first `GetMessageW` is discarded, and the wake-up it carried is lost.
        let mut msg = MSG::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::PeekMessageW(
            &mut msg,
            None,
            0,
            0,
            windows::Win32::UI::WindowsAndMessaging::PM_NOREMOVE,
        );
    }
    state().thread_id.store(
        unsafe { windows::Win32::System::Threading::GetCurrentThreadId() },
        Ordering::Release,
    );
    reconcile_hooks();

    let mut timer_on = false;
    loop {
        unsafe {
            let mut msg = MSG::default();
            let got = GetMessageW(&mut msg, None, 0, 0);
            if got.0 <= 0 {
                break;
            }
            match msg.message {
                WM_INPUT_WAKE => {
                    reconcile_hooks();
                    flush_passthrough();
                }
                WM_TIMER => tick(),
                _ => {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }

            let want_timer = tick_wanted();
            if want_timer && !timer_on {
                SetTimer(None, TIMER_ID, CLICK_TICK_MS, None);
                timer_on = true;
            } else if !want_timer && timer_on {
                let _ = KillTimer(None, TIMER_ID);
                timer_on = false;
            }
        }
    }

    release_injected_button();
    flush_passthrough();
}

/// Release everything on the way out, so a quit never leaves a button stuck or a hook installed.
pub fn shutdown() {
    release_injected_button();
    flush_passthrough();
    state().armed.store(0, Ordering::Release);
    state().blocking.store(false, Ordering::Release);
    state().recording.store(false, Ordering::Release);
    wake_input_thread();
}

#[cfg(test)]
mod tests {
    use super::super::trigger;
    use super::*;

    #[test]
    fn points_survive_negative_coordinates() {
        // A monitor left of or above the primary has negative coordinates, and a wide desktop
        // exceeds 32767 — both of which the classic LOWORD/HIWORD packing wraps silently.
        for point in [
            POINT { x: 0, y: 0 },
            POINT { x: -1920, y: -300 },
            POINT { x: 40000, y: -40000 },
            POINT { x: i32::MIN, y: i32::MAX },
        ] {
            let back = unpack_point(pack_point(point));
            assert_eq!((back.x, back.y), (point.x, point.y), "{point:?}");
        }
    }

    #[test]
    fn trigger_packing_round_trips() {
        for spelling in ["middle", "x1", "x2", "Ctrl+left", "Ctrl+Alt+Shift+Super+x2"] {
            let t = trigger::parse(Some(spelling)).unwrap();
            let packed = pack_trigger(&t);
            assert_eq!(packed & 0xFF, button_ordinal(t.button), "{spelling}");
            let mods = (packed >> 8) & 0xFF;
            assert_eq!(mods & MOD_CTRL != 0, t.ctrl, "{spelling}");
            assert_eq!(mods & MOD_ALT != 0, t.alt, "{spelling}");
            assert_eq!(mods & MOD_SHIFT != 0, t.shift, "{spelling}");
            assert_eq!(mods & MOD_WIN != 0, t.meta, "{spelling}");
        }
        // Zero is reserved for "nothing armed", so no real binding may pack to it.
        for spelling in ["middle", "x1", "x2", "Ctrl+left", "Alt+right"] {
            assert_ne!(pack_trigger(&trigger::parse(Some(spelling)).unwrap()), 0);
        }
    }

    #[test]
    fn a_double_click_counts_as_a_press() {
        // The system sends DBLCLK *instead of* the second DOWN; anything else loses every other
        // press when the wheel is triggered twice quickly.
        assert_eq!(classify(WM_MBUTTONDBLCLK, 0), (Some(Button::Middle), true));
        assert_eq!(classify(WM_MBUTTONUP, 0), (Some(Button::Middle), false));
        let x2 = (XBUTTON2 as u32) << 16;
        assert_eq!(classify(WM_XBUTTONDBLCLK, x2), (Some(Button::X2), true));
        assert_eq!(classify(WM_XBUTTONUP, x2), (Some(Button::X2), false));
    }

    #[test]
    fn side_buttons_are_told_apart() {
        assert_eq!(classify(WM_XBUTTONDOWN, 1 << 16).0, Some(Button::X1));
        assert_eq!(classify(WM_XBUTTONDOWN, 2 << 16).0, Some(Button::X2));
    }

    #[test]
    fn the_wheel_direction_is_signed() {
        // The delta is a signed high word; read unsigned, every turn looks like one direction.
        let up = pointer_event(WM_MOUSEWHEEL, (120u32 & 0xFFFF) << 16);
        let down = pointer_event(WM_MOUSEWHEEL, ((-120i32) as u32 & 0xFFFF) << 16);
        assert_eq!(up, Some(PointerEvent::WheelUp));
        assert_eq!(down, Some(PointerEvent::WheelDown));
    }

    #[test]
    fn elapsed_time_survives_the_tick_wrap() {
        // The original's bug: a subtraction across the wrap came out hugely negative, so every
        // "was it short?" test said yes and a long hold counted as a click.
        let before_wrap = u32::MAX - 100;
        let after_wrap = 150u32;
        assert_eq!(after_wrap.wrapping_sub(before_wrap), 251);
        assert!(after_wrap.wrapping_sub(before_wrap) > PASSTHROUGH_MAX_MS);
    }

    #[test]
    fn movement_is_never_a_blocked_message() {
        // It is the ~99% case and takes the short path; treating it as blockable would swallow
        // every mouse move in Windows while the wheel is up.
        assert!(!is_blocked_message(WM_MOUSEMOVE));
        assert!(is_blocked_message(WM_LBUTTONDOWN));
        assert!(is_blocked_message(WM_MOUSEWHEEL));
    }
}
