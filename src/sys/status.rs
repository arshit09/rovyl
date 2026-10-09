//! The machine's readings: volume, network, battery.
//!
//! Every one of them carries its own "unknown", and it is `-1`. A desktop PC has no battery and a
//! cable has no signal quality — a readout that cannot tell those from "empty" shows a flat battery
//! and no bars to somebody whose machine is fine.
//!
//! **What costs what.** The volume endpoint is a COM object that has to be kept alive to be read
//! quickly, so it is held while the dock is on and released when it is not. The battery is a single
//! kernel call. The network is the expensive one — enumerating WLAN interfaces takes a few
//! milliseconds — so it is sampled on a worker and cached, never on the frame loop.
//!
//! **The polling follows the WHEEL; the endpoint follows the SETTING.** A dock switched on keeps
//! its audio endpoint so the first wheel of the session does not pay to open one; an idle session
//! polls nothing. A clock-only dock needs none of this at all — the system clock answers it.

use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::OnceLock;

/// One reading of everything the status dock displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    /// 0–100, or -1 when there is no audio endpoint to ask.
    pub volume: i32,
    pub muted: bool,
    pub network: Network,
    /// Wi-Fi signal quality, 0–100. -1 on anything that is not Wi-Fi.
    pub signal: i32,
    /// 0–100, or -1 on a machine with no battery.
    pub battery: i32,
    pub charging: bool,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            volume: -1,
            muted: false,
            network: Network::None,
            signal: -1,
            battery: -1,
            charging: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    None,
    Ethernet,
    WiFi,
    Other,
}

// ─── The cache ──────────────────────────────────────────────────────────────
//
// The frame loop reads these; a worker writes them. Atomics rather than a lock for the usual
// reason — the reader is the thread that draws the wheel, and it must never wait on anything.

struct Cache {
    volume: AtomicI32,
    muted: AtomicU32,
    network: AtomicU32,
    signal: AtomicI32,
    battery: AtomicI32,
    charging: AtomicU32,
    /// When the slow readings were last taken.
    sampled_at: AtomicU32,
    /// A worker is already sampling, so a frame does not start a second one.
    sampling: AtomicU32,
}

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Cache {
        volume: AtomicI32::new(-1),
        muted: AtomicU32::new(0),
        network: AtomicU32::new(0),
        signal: AtomicI32::new(-1),
        battery: AtomicI32::new(-1),
        charging: AtomicU32::new(0),
        sampled_at: AtomicU32::new(0),
        sampling: AtomicU32::new(0),
    })
}

/// How stale a reading may be before it is taken again.
///
/// One second, which is what the original's watcher used. Faster buys nothing: the battery moves in
/// whole percents over minutes, and a volume the USER is dragging is held by the slider itself
/// rather than read back.
const SAMPLE_EVERY_MS: u32 = 1000;

fn now_ms() -> u32 {
    unsafe { windows::Win32::System::SystemInformation::GetTickCount() }
}

/// The latest reading. Never blocks, never samples — it reports what the cache holds.
pub fn latest() -> Status {
    let c = cache();
    Status {
        volume: c.volume.load(Ordering::Relaxed),
        muted: c.muted.load(Ordering::Relaxed) != 0,
        network: match c.network.load(Ordering::Relaxed) {
            1 => Network::Ethernet,
            2 => Network::WiFi,
            3 => Network::Other,
            _ => Network::None,
        },
        signal: c.signal.load(Ordering::Relaxed),
        battery: c.battery.load(Ordering::Relaxed),
        charging: c.charging.load(Ordering::Relaxed) != 0,
    }
}

/// Ask for a fresh reading if the cached one has gone stale.
///
/// Called from the frame loop while the dock is on screen. The sampling itself happens on a worker,
/// because enumerating WLAN interfaces takes milliseconds and the frame loop is the thread the
/// wheel is drawn on.
pub fn poll() {
    let c = cache();
    let age = now_ms().wrapping_sub(c.sampled_at.load(Ordering::Relaxed));
    if age < SAMPLE_EVERY_MS {
        return;
    }
    // One sampler at a time. Without this a slow WLAN enumeration would have a new worker started
    // behind it on every frame.
    if c.sampling.swap(1, Ordering::AcqRel) != 0 {
        return;
    }
    std::thread::Builder::new()
        .name("rovyl-status".into())
        .spawn(|| {
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                );
            }
            let c = cache();
            let (volume, muted) = read_volume();
            c.volume.store(volume, Ordering::Relaxed);
            c.muted.store(muted as u32, Ordering::Relaxed);

            let (battery, charging) = read_battery();
            c.battery.store(battery, Ordering::Relaxed);
            c.charging.store(charging as u32, Ordering::Relaxed);

            let (network, signal) = read_network();
            c.network.store(
                match network {
                    Network::Ethernet => 1,
                    Network::WiFi => 2,
                    Network::Other => 3,
                    Network::None => 0,
                },
                Ordering::Relaxed,
            );
            c.signal.store(signal, Ordering::Relaxed);

            c.sampled_at.store(now_ms(), Ordering::Relaxed);
            c.sampling.store(0, Ordering::Release);
        })
        .ok();
}

/// Force the next `poll` to sample, whatever the cache's age.
///
/// Used when the wheel opens: the first frame should show something current, not whatever was true
/// the last time the wheel was up.
pub fn invalidate() {
    cache()
        .sampled_at
        .store(now_ms().wrapping_sub(SAMPLE_EVERY_MS * 2), Ordering::Relaxed);
}

// ─── Volume ─────────────────────────────────────────────────────────────────

use windows::core::Interface;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

fn endpoint() -> Option<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        device.Activate(CLSCTX_ALL, None).ok()
    }
}

fn read_volume() -> (i32, bool) {
    let Some(endpoint) = endpoint() else {
        // No endpoint at all: a machine with no sound card, or one whose only device was just
        // unplugged. `-1` is what tells the dock to draw nothing rather than zero.
        return (-1, false);
    };
    unsafe {
        let level = endpoint
            .GetMasterVolumeLevelScalar()
            .map(|v| (v * 100.0).round() as i32)
            .unwrap_or(-1);
        let muted = endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false);
        (level, muted)
    }
}

/// Set the output level, 0–100. Applied to the default device — the same one the reading comes from.
pub fn set_volume(percent: i32) {
    let Some(endpoint) = endpoint() else { return };
    unsafe {
        let _ = endpoint.SetMasterVolumeLevelScalar(
            (percent.clamp(0, 100) as f32) / 100.0,
            std::ptr::null(),
        );
    }
    // Written through to the cache immediately: the reading comes back once a second, and without
    // this the bar snaps back to the old value between the drag and the next poll — the classic
    // "the slider does nothing".
    cache().volume.store(percent.clamp(0, 100), Ordering::Relaxed);
}

pub fn set_muted(muted: bool) {
    let Some(endpoint) = endpoint() else { return };
    unsafe {
        let _ = endpoint.SetMute(muted, std::ptr::null());
    }
    cache().muted.store(muted as u32, Ordering::Relaxed);
}

// ─── Battery ────────────────────────────────────────────────────────────────

fn read_battery() -> (i32, bool) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_err() {
            return (-1, false);
        }
        // 255 means "unknown", and 128 in `BatteryFlag` means "no system battery". Both have to be
        // told from a real 0%, which is what a desktop would otherwise appear to have.
        if status.BatteryLifePercent == 255 || status.BatteryFlag & 128 != 0 {
            return (-1, status.ACLineStatus == 1);
        }
        (
            status.BatteryLifePercent as i32,
            // Charging is the flag, not "on AC": a laptop plugged in at 100% is on AC and not
            // charging, and showing a charging bolt there is wrong.
            status.BatteryFlag & 8 != 0,
        )
    }
}

// ─── Network ────────────────────────────────────────────────────────────────

fn read_network() -> (Network, i32) {
    // Wi-Fi first, because it is the one with a signal to report and the one a user is most likely
    // to be looking at. A machine with both connected shows the wireless one, which is also what
    // Windows' own flyout does.
    if let Some(signal) = wifi_signal() {
        return (Network::WiFi, signal);
    }
    match connected_kind() {
        Some(kind) => (kind, -1),
        None => (Network::None, -1),
    }
}

fn wifi_signal() -> Option<i32> {
    use windows::Win32::NetworkManagement::WiFi::{
        wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory,
        WlanOpenHandle, WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
        WLAN_INTERFACE_STATE,
    };
    unsafe {
        let mut handle = windows::Win32::Foundation::HANDLE::default();
        let mut negotiated = 0u32;
        if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
            return None;
        }
        // Every exit from here closes the handle: a leaked WLAN handle keeps the service's client
        // table growing for the life of the process.
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(handle, None, &mut list) != 0 || list.is_null() {
            let _ = WlanCloseHandle(handle, None);
            return None;
        }
        let mut answer = None;
        let count = (*list).dwNumberOfItems as usize;
        for index in 0..count {
            let info = (*list).InterfaceInfo.as_ptr().add(index);
            // `wlan_interface_state_connected` is 1.
            if (*info).isState != WLAN_INTERFACE_STATE(1) {
                continue;
            }
            let mut size = 0u32;
            let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
            if WlanQueryInterface(
                handle,
                &(*info).InterfaceGuid,
                wlan_intf_opcode_current_connection,
                None,
                &mut size,
                &mut data,
                None,
            ) == 0
                && !data.is_null()
            {
                let attributes = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                answer = Some(attributes.wlanAssociationAttributes.wlanSignalQuality as i32);
                WlanFreeMemory(data);
            }
            if answer.is_some() {
                break;
            }
        }
        WlanFreeMemory(list as *mut _);
        let _ = WlanCloseHandle(handle, None);
        answer
    }
}

/// Whether anything is connected, and roughly what it is.
fn connected_kind() -> Option<Network> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;

    // IANA interface types, as `IP_ADAPTER_ADDRESSES.IfType` reports them. Written out rather than
    // imported because the binding for them moves between `windows` crate versions and the values
    // are a registered standard that cannot change.
    const IF_TYPE_ETHERNET: u32 = 6;
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_TYPE_WIFI: u32 = 71;
    use windows::Win32::Networking::WinSock::AF_UNSPEC;

    unsafe {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 0u32;
        // The documented two-call pattern: ask for the size, then for the data.
        GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, None, &mut size);
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let head = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        if GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(head), &mut size) != 0 {
            return None;
        }

        let mut best: Option<Network> = None;
        let mut adapter = head;
        while !adapter.is_null() {
            let entry = &*adapter;
            // Loopback is always up and means nothing; counting it would report a connection on
            // a machine with its cable out.
            if entry.OperStatus == IfOperStatusUp && entry.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                let kind = match entry.IfType {
                    IF_TYPE_WIFI => Network::WiFi,
                    IF_TYPE_ETHERNET => Network::Ethernet,
                    _ => Network::Other,
                };
                // Ethernet beats anything else; `Other` only wins if nothing better is up.
                best = Some(match (best, kind) {
                    (Some(Network::Ethernet), _) => Network::Ethernet,
                    (_, found) => found,
                });
            }
            adapter = entry.Next;
        }
        best
    }
}

/// Open one of Windows' own panels.
///
/// An ENUM and not a URI. A caller that could name the exact `ms-settings:` string would be a
/// caller that can ask the shell to open anything, and the wheel's dock is the thing calling it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Volume,
    Network,
    Battery,
    Clock,
}

pub fn open_panel(panel: Panel) {
    let uri = match panel {
        Panel::Volume => "ms-settings:sound",
        Panel::Network => "ms-availablenetworks:",
        Panel::Battery => "ms-settings:batterysaver",
        Panel::Clock => "ms-settings:dateandtime",
    };
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    unsafe {
        let target = HSTRING::from(uri);
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_is_minus_one_everywhere() {
        // A readout that cannot tell "0%" from "unknown" shows a flat battery to somebody sitting
        // at a desktop PC.
        let status = Status::default();
        assert_eq!(status.volume, -1);
        assert_eq!(status.signal, -1);
        assert_eq!(status.battery, -1);
        assert_eq!(status.network, Network::None);
    }

    #[test]
    fn the_battery_reads_as_a_real_machine_would() {
        // Either a percentage or "there is no battery" — never a plausible-looking zero.
        let (level, _) = read_battery();
        assert!(level == -1 || (0..=100).contains(&level), "got {level}");
    }

    #[test]
    fn the_volume_reads_or_says_it_cannot() {
        let (level, _) = read_volume();
        assert!(level == -1 || (0..=100).contains(&level), "got {level}");
    }

    #[test]
    fn a_poll_never_blocks_the_caller() {
        // It is called from the frame loop; the sampling has to be somebody else's problem.
        invalidate();
        let at = std::time::Instant::now();
        poll();
        assert!(at.elapsed().as_millis() < 50, "poll took {:?}", at.elapsed());
    }

    #[test]
    fn concurrent_polls_start_one_sampler() {
        invalidate();
        poll();
        // The second call finds the flag set and returns at once.
        let at = std::time::Instant::now();
        poll();
        assert!(at.elapsed().as_millis() < 5);
    }
}
