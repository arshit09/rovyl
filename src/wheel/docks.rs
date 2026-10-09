//! The things drawn beside the open wheel: two corner docks, the status strip, and the gear.
//!
//! This is the ONLY thing Rovyl paints outside the wheel itself, and everything here is off by
//! default except the gear — a strip appearing in somebody's corner because they updated is a fault
//! report, not a feature arriving.
//!
//! **Why one module for three different things.** They are all placed from the same edges and they
//! can all be asked for the same corner, so left alone they stack on top of one another. A region
//! is therefore ONE shell and whatever lands in it is stacked inside, and anything else placed
//! against that edge — the gear is the only such thing today — steps inboard by exactly what the
//! docks occupy. That number is COMPUTED rather than measured, because the gear is positioned in
//! the same frame the docks are and reading back a measurement would give last frame's answer.
//!
//! **Withdrawn in direction mode.** With click-free launching on, the pointer is hidden and parked
//! at the centre: there is no way to reach a corner, and a click anywhere launches whatever the
//! gesture is pointing at. An icon that cannot be pressed is worse than no icon, and the click that
//! tried would launch the slice it was aiming across.

use super::state::Wheel;
use crate::config::{AppItem, HudPosition, ShortcutDock, StatusDock, UiConfig};
use crate::gfx::painter::{Painter, Rect};
use crate::gfx::palette as pal;
use crate::gfx::text::{Align, Family, Style};
use crate::sys::status::{Network, Panel, Status};

/// Padding inside a dock's plate, top and bottom, plus its 1px border on each side.
const PLATE_PADDING: f32 = 6.0;
const PLATE_BORDER: f32 = 1.0;
/// Height of the name under a shortcut when labels are on.
const SHORTCUT_LABEL_H: f32 = 14.0;
/// Space between two docks that landed in the same region.
const STACK_GAP: f32 = 8.0;
/// Distance from the screen edge to a dock's plate, and to the gear.
const EDGE_PAD: f32 = 20.0;
/// The gear's diameter.
const GEAR_SIZE: f32 = 34.0;

fn plate_height(content: f32) -> f32 {
    content + 2.0 * PLATE_PADDING + 2.0 * PLATE_BORDER
}

pub fn status_dock_height(dock: &StatusDock) -> f32 {
    // The glyphs are the tallest thing on the plate; the readout text is set to fit beside them.
    plate_height((dock.icon_size as f32).max(16.0))
}

pub fn shortcut_dock_height(dock: &ShortcutDock) -> f32 {
    plate_height(dock.icon_size as f32 + if dock.show_labels { SHORTCUT_LABEL_H } else { 0.0 })
}

/// How much room the docks take in one region, for anything else placed against that same edge.
pub fn stack_height(position: HudPosition, status: &StatusDock, shortcuts: &ShortcutDock) -> f32 {
    let mut heights: Vec<f32> = Vec::new();
    if status.is_active() && status.position == position {
        heights.push(status_dock_height(status));
    }
    if shortcuts.is_active() && shortcuts.position == position {
        heights.push(shortcut_dock_height(shortcuts));
    }
    if heights.is_empty() {
        return 0.0;
    }
    heights.iter().sum::<f32>() + (heights.len() as f32 - 1.0) * STACK_GAP
}

/// Where a plate of this size sits, in a region of this viewport.
fn place(position: HudPosition, viewport: (f32, f32), width: f32, height: f32, inset: f32, scale: f32) -> Rect {
    let pad = EDGE_PAD * scale;
    let x = match position {
        HudPosition::TopLeft | HudPosition::BottomLeft => pad,
        HudPosition::TopCenter | HudPosition::BottomCenter => (viewport.0 - width) / 2.0,
        HudPosition::TopRight | HudPosition::BottomRight => viewport.0 - pad - width,
    };
    let y = if position.is_top() {
        pad + inset
    } else {
        viewport.1 - pad - inset - height
    };
    Rect::new(x, y, x + width, y + height)
}

/// What the user pressed, if anything.
#[derive(Debug, Clone, PartialEq)]
pub enum Hit {
    /// A shortcut-dock icon. It is an ordinary item and launches through the wheel's own path —
    /// one launch path means one place where a failure is reported.
    Launch(Box<AppItem>),
    /// A readout was clicked: take the wheel down FIRST, then ask Windows for its panel. A panel
    /// opening behind a wheel that still holds the mouse is a window nobody can reach.
    OpenPanel(Panel),
    /// The volume bar was dragged to this percentage.
    SetVolume(i32),
    ToggleMute,
    OpenSettings,
}

/// One clickable region, and what pressing it means.
#[derive(Debug, Clone)]
pub struct Target {
    pub rect: Rect,
    pub hit: Hit,
}

/// Everything the docks need from the frame.
pub struct DockFrame<'a> {
    pub config: &'a UiConfig,
    pub status: Status,
    pub pointer: Option<(f32, f32)>,
    /// Whether the primary button is held, for the volume bar's drag.
    pub down: bool,
    /// Whether the dock icons' bitmaps are available.
    pub icons: &'a dyn super::render::IconSource2,
}

/// Draw every corner furniture the configuration asks for, and return what can be pressed.
///
/// The TARGETS are returned rather than the hit, and the caller tests a release against them. That
/// is one computation of the geometry rather than two: a separate hit-test function would be a
/// second opinion about where a dock icon is, which is the same defect the wheel's own
/// `resolve_aim` exists to prevent — lighting one thing and launching another.
pub fn draw(p: &Painter, wheel: &Wheel, frame: &DockFrame) -> Vec<Target> {
    let config = frame.config;
    // Withdrawn entirely in direction mode. See the module header.
    if config.direction_mode() {
        return Vec::new();
    }
    let bloom = wheel.bloom();
    if bloom <= 0.01 || wheel.exiting() {
        return Vec::new();
    }

    let status_cfg = config.status_dock_cfg();
    let shortcut_cfg = config.shortcut_dock_cfg();
    let mut targets: Vec<Target> = Vec::new();

    // Two docks can be asked for the same region, so BOTH are drawn: readouts closest to the edge,
    // because they are the smaller and the more glanceable of the two.
    for position in [
        HudPosition::TopLeft,
        HudPosition::TopCenter,
        HudPosition::TopRight,
        HudPosition::BottomLeft,
        HudPosition::BottomCenter,
        HudPosition::BottomRight,
    ] {
        let mut inset = 0.0;
        if status_cfg.is_active() && status_cfg.position == position {
            let height = status_dock_height(&status_cfg) * wheel.scale;
            draw_status(p, wheel, frame, &status_cfg, position, inset, bloom, &mut targets);
            inset += height + STACK_GAP * wheel.scale;
        }
        if shortcut_cfg.is_active() && shortcut_cfg.position == position {
            draw_shortcuts(p, wheel, frame, &shortcut_cfg, position, inset, bloom, &mut targets);
        }
    }

    if config.gear_visible() {
        let corner = config.gear_corner().as_hud();
        // The gear steps inboard by exactly what the docks occupy rather than sharing the spot.
        let dodge = stack_height(corner, &status_cfg, &shortcut_cfg) * wheel.scale;
        let dodge = if dodge > 0.0 { dodge + STACK_GAP * wheel.scale } else { 0.0 };
        draw_gear(p, wheel, frame, corner, dodge, bloom, &mut targets);
    }

    targets
}

/// Which target a point is on, if any.
///
/// Last first, so that a thing drawn over another — the gear, which is drawn after the docks it
/// dodges — wins the press, exactly as it wins the paint.
pub fn hit(targets: &[Target], point: (f32, f32)) -> Option<&Hit> {
    targets
        .iter()
        .rev()
        .find(|target| target.rect.contains(point.0, point.1))
        .map(|target| &target.hit)
}

// ─── The plate ──────────────────────────────────────────────────────────────

fn plate(p: &Painter, rect: Rect, scale: f32, opacity: f32) {
    // No blur anywhere. The overlay is a transparent window, so there is nothing underneath for a
    // backdrop filter to sample — the plates carry their own background, exactly as the wheel's
    // label pills and the gear do.
    p.fill_round_rect(rect, 14.0 * scale, fade(pal::CORNER_PLATE, opacity));
    p.stroke_round_rect(
        rect.inflate(-0.5),
        14.0 * scale,
        fade(pal::CORNER_BORDER, opacity),
        1.0,
    );
}

fn fade(colour: windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F, by: f32) -> windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F {
    windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F {
        a: colour.a * by.clamp(0.0, 1.0),
        ..colour
    }
}

// ─── The status dock ────────────────────────────────────────────────────────

fn draw_status(
    p: &Painter,
    wheel: &Wheel,
    frame: &DockFrame,
    dock: &StatusDock,
    position: HudPosition,
    inset: f32,
    opacity: f32,
    targets: &mut Vec<Target>,
) {
    let s = wheel.scale;
    let icon = dock.icon_size as f32 * s;
    let gap = dock.gap as f32 * s;
    let pad = PLATE_PADDING * s;
    let height = status_dock_height(dock) * s;

    let readout = Style::new(Family::Radial, (icon * 0.72).max(10.0), 600, Align::Leading)
        .tracking(0.01);

    // Measured first, so the plate is the width of its contents rather than a guess.
    let mut cells: Vec<(Cell, f32)> = Vec::new();
    if dock.show_volume && frame.status.volume >= 0 {
        cells.push((Cell::Volume, icon + 6.0 * s + p.measure(&format!("{}%", frame.status.volume), &readout).0));
    }
    if dock.show_network {
        let label = match frame.status.network {
            Network::WiFi if frame.status.signal >= 0 => format!("{}%", frame.status.signal),
            Network::WiFi => "Wi-Fi".into(),
            Network::Ethernet => "Wired".into(),
            Network::Other => "Online".into(),
            Network::None => "Offline".into(),
        };
        cells.push((Cell::Network(label.clone()), icon + 6.0 * s + p.measure(&label, &readout).0));
    }
    if dock.show_battery && frame.status.battery >= 0 {
        cells.push((
            Cell::Battery,
            icon + 6.0 * s + p.measure(&format!("{}%", frame.status.battery), &readout).0,
        ));
    }
    if dock.show_clock {
        let now = clock_text();
        cells.push((Cell::Clock(now.clone()), p.measure(&now, &readout).0 + 6.0 * s));
    }
    if cells.is_empty() {
        return;
    }

    let width: f32 =
        cells.iter().map(|(_, w)| *w + 12.0 * s).sum::<f32>() + gap * (cells.len() as f32 - 1.0) + pad * 2.0;
    let rect = place(position, wheel.viewport, width, height, inset, s);
    plate(p, rect, s, opacity);

    let mut x = rect.left + pad;
    for (cell, content_w) in &cells {
        let cell_rect = Rect::new(x, rect.top + pad, x + content_w + 12.0 * s, rect.bottom - pad);
        let hovered = frame
            .pointer
            .is_some_and(|point| cell_rect.contains(point.0, point.1));
        if hovered {
            p.fill_round_rect(cell_rect, 10.0 * s, fade(pal::DOCK_HOVER_PLATE, opacity));
            p.stroke_round_rect(
                cell_rect.inflate(-0.5),
                10.0 * s,
                fade(pal::DOCK_HOVER_BORDER, opacity),
                1.0,
            );
        }
        let colour = if hovered { pal::DOCK_GLYPH_HOVER } else { pal::DOCK_GLYPH };
        let glyph_at = (cell_rect.left + 6.0 * s + icon / 2.0, cell_rect.center().1);

        match cell {
            Cell::Volume => {
                p.glyph(
                    volume_glyph(frame.status.volume, frame.status.muted),
                    glyph_at,
                    icon,
                    fade(colour, opacity),
                    1.9,
                );
                text_after(p, cell_rect, glyph_at.0 + icon / 2.0 + 6.0 * s, &format!("{}%", frame.status.volume), &readout, fade(colour, opacity));
                // The glyph mutes; the rest of the cell is the bar.
                let glyph_box = Rect::new(
                    cell_rect.left,
                    cell_rect.top,
                    glyph_at.0 + icon / 2.0,
                    cell_rect.bottom,
                );
                targets.push(Target { rect: glyph_box, hit: Hit::ToggleMute });
                targets.push(Target {
                    rect: Rect::new(glyph_box.right, cell_rect.top, cell_rect.right, cell_rect.bottom),
                    hit: Hit::SetVolume(volume_from(cell_rect, frame.pointer, glyph_at.0 + icon)),
                });
                // The bar owns itself while the hand is on it. The reading comes back once a
                // second, and without holding the dragged value the bar snaps back to the old one
                // between the drag and the next poll — the classic "the slider does nothing".
                if hovered && frame.down && frame.pointer.is_some_and(|q| q.0 > glyph_box.right) {
                    crate::sys::status::set_volume(volume_from(
                        cell_rect,
                        frame.pointer,
                        glyph_at.0 + icon,
                    ));
                }
            }
            Cell::Network(label) => {
                p.glyph(
                    network_glyph(frame.status.network, frame.status.signal),
                    glyph_at,
                    icon,
                    fade(colour, opacity),
                    1.9,
                );
                text_after(p, cell_rect, glyph_at.0 + icon / 2.0 + 6.0 * s, label, &readout, fade(colour, opacity));
                targets.push(Target { rect: cell_rect, hit: Hit::OpenPanel(Panel::Network) });
            }
            Cell::Battery => {
                p.glyph(
                    battery_glyph(frame.status.battery, frame.status.charging),
                    glyph_at,
                    icon,
                    fade(
                        // Under twenty per cent the battery is the one readout allowed a colour,
                        // because it is the only one reporting something that will stop working.
                        if frame.status.battery < 20 { pal::rgb(0xF8_71_71) } else { colour },
                        opacity,
                    ),
                    1.9,
                );
                text_after(p, cell_rect, glyph_at.0 + icon / 2.0 + 6.0 * s, &format!("{}%", frame.status.battery), &readout, fade(colour, opacity));
                targets.push(Target { rect: cell_rect, hit: Hit::OpenPanel(Panel::Battery) });
            }
            Cell::Clock(now) => {
                let (_, th) = p.measure(now, &readout);
                p.text(
                    now,
                    Rect::new(cell_rect.left + 6.0 * s, cell_rect.center().1 - th / 2.0, cell_rect.right, cell_rect.bottom),
                    &readout,
                    fade(colour, opacity),
                );
                targets.push(Target { rect: cell_rect, hit: Hit::OpenPanel(Panel::Clock) });
            }
        }
        x = cell_rect.right + gap;
    }
}

enum Cell {
    Volume,
    Network(String),
    Battery,
    Clock(String),
}

fn text_after(
    p: &Painter,
    cell: Rect,
    left: f32,
    text: &str,
    style: &Style,
    colour: windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F,
) {
    let (_, th) = p.measure(text, style);
    p.text(
        text,
        Rect::new(left, cell.center().1 - th / 2.0, cell.right, cell.bottom),
        style,
        colour,
    );
}

fn volume_from(cell: Rect, pointer: Option<(f32, f32)>, track_left: f32) -> i32 {
    let Some((x, _)) = pointer else { return 0 };
    let span = (cell.right - track_left).max(1.0);
    (((x - track_left) / span) * 100.0).round().clamp(0.0, 100.0) as i32
}

fn volume_glyph(level: i32, muted: bool) -> &'static str {
    if muted || level == 0 {
        "VolumeX"
    } else if level < 34 {
        "Volume"
    } else if level < 67 {
        "Volume1"
    } else {
        "Volume2"
    }
}

fn network_glyph(network: Network, signal: i32) -> &'static str {
    match network {
        Network::None => "WifiOff",
        Network::Ethernet => "Cable",
        Network::Other => "Globe",
        // Four states rather than two, because "connected" and "barely connected" are different
        // facts and the strip exists to report them at a glance.
        //
        // The `Signal*` family rather than `Wifi*`: this build of Lucide ships `Wifi` and
        // `WifiOff` and nothing between them, and a strength readout with two states is not a
        // strength readout. The bars read as signal to everyone anyway — it is what every phone
        // draws — and a glyph that exists beats one that is the right name and paints a cube.
        Network::WiFi if signal < 0 => "Wifi",
        Network::WiFi if signal < 25 => "SignalLow",
        Network::WiFi if signal < 55 => "SignalMedium",
        Network::WiFi => "SignalHigh",
    }
}

fn battery_glyph(level: i32, charging: bool) -> &'static str {
    if charging {
        "BatteryCharging"
    } else if level < 20 {
        "BatteryLow"
    } else if level < 60 {
        "BatteryMedium"
    } else {
        "BatteryFull"
    }
}

/// The time, as the user's own locale writes it.
fn clock_text() -> String {
    use windows::Win32::Globalization::{GetTimeFormatEx, TIME_NOSECONDS};
    unsafe {
        let mut buffer = [0u16; 64];
        // The user's locale, not a hardcoded format: a 24-hour clock is the default in most of the
        // world and `h:mm tt` would be wrong there.
        let written = GetTimeFormatEx(
            windows::core::PCWSTR::null(),
            TIME_NOSECONDS,
            None,
            windows::core::PCWSTR::null(),
            Some(&mut buffer),
        );
        if written > 0 {
            String::from_utf16_lossy(&buffer[..written as usize - 1])
        } else {
            String::new()
        }
    }
}

// ─── The shortcut dock ──────────────────────────────────────────────────────

fn draw_shortcuts(
    p: &Painter,
    wheel: &Wheel,
    frame: &DockFrame,
    dock: &ShortcutDock,
    position: HudPosition,
    inset: f32,
    opacity: f32,
    targets: &mut Vec<Target>,
) {
    let s = wheel.scale;
    let icon = dock.icon_size as f32 * s;
    let gap = dock.gap as f32 * s;
    let pad = PLATE_PADDING * s;
    let height = shortcut_dock_height(dock) * s;
    let cell_w = icon + 12.0 * s;
    let count = dock.items.len() as f32;
    let width = count * cell_w + gap * (count - 1.0).max(0.0) + pad * 2.0;
    let rect = place(position, wheel.viewport, width, height, inset, s);
    plate(p, rect, s, opacity);

    let label_style = Style::new(Family::Radial, 10.0 * s, 500, Align::Center);
    let mut x = rect.left + pad;
    for item in &dock.items {
        let cell = Rect::new(x, rect.top + pad, x + cell_w, rect.bottom - pad);
        let hovered = frame
            .pointer
            .is_some_and(|point| cell.contains(point.0, point.1));
        if hovered {
            p.fill_round_rect(cell, 10.0 * s, fade(pal::DOCK_HOVER_PLATE, opacity));
            p.stroke_round_rect(cell.inflate(-0.5), 10.0 * s, fade(pal::DOCK_HOVER_BORDER, opacity), 1.0);
        }
        targets.push(Target { rect: cell, hit: Hit::Launch(Box::new(item.clone())) });

        let art_h = if dock.show_labels { icon } else { cell.height() };
        let art = Rect::centred(cell.center().0, cell.top + art_h / 2.0, icon, icon);
        let drawn = item
            .custom_icon_url
            .as_deref()
            .and_then(|reference| frame.icons.bitmap(reference));
        match drawn {
            Some(bitmap) => p.bitmap_rounded(art, &bitmap, opacity, 6.0 * s),
            None => p.glyph(
                if item.icon_name.is_empty() { crate::gfx::lucide::FALLBACK } else { &item.icon_name },
                art.center(),
                icon * 0.72,
                fade(if hovered { pal::DOCK_GLYPH_HOVER } else { pal::DOCK_GLYPH }, opacity),
                1.75,
            ),
        }

        if dock.show_labels && !item.label.is_empty() {
            let (_, th) = p.measure(&item.label, &label_style);
            p.text(
                &item.label,
                Rect::new(cell.left, cell.bottom - SHORTCUT_LABEL_H * s + (SHORTCUT_LABEL_H * s - th) / 2.0, cell.right, cell.bottom),
                &label_style,
                fade(pal::DOCK_GLYPH, opacity),
            );
        }
        x = cell.right + gap;
    }
}

// ─── The gear ───────────────────────────────────────────────────────────────

fn draw_gear(
    p: &Painter,
    wheel: &Wheel,
    frame: &DockFrame,
    corner: HudPosition,
    dodge: f32,
    opacity: f32,
    targets: &mut Vec<Target>,
) {
    let s = wheel.scale;
    let size = GEAR_SIZE * s;
    let rect = place(corner, wheel.viewport, size, size, dodge, s);
    let hovered = frame
        .pointer
        .is_some_and(|point| rect.contains(point.0, point.1));

    let (fill, border, glyph) = if hovered {
        (pal::CORNER_PLATE_HOVER, pal::CORNER_BORDER_HOVER, pal::CORNER_GLYPH_HOVER)
    } else {
        (pal::CORNER_PLATE, pal::CORNER_BORDER, pal::CORNER_GLYPH)
    };
    p.fill_circle(rect.center(), size / 2.0, fade(fill, opacity));
    p.stroke_circle(rect.center(), size / 2.0 - 0.5, fade(border, opacity), 1.0);
    p.glyph("Settings", rect.center(), 16.0 * s, fade(glyph, opacity), 1.9);
    targets.push(Target { rect, hit: Hit::OpenSettings });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::defaults;

    fn status() -> StatusDock {
        StatusDock { enabled: true, ..defaults::status_dock() }
    }

    fn shortcuts() -> ShortcutDock {
        ShortcutDock {
            enabled: true,
            items: vec![AppItem { id: "a".into(), ..AppItem::default() }],
            ..defaults::shortcut_dock()
        }
    }

    #[test]
    fn an_empty_region_occupies_nothing() {
        // The gear dodging an invisible strip would leave a hole nobody can explain.
        let off = defaults::status_dock();
        let none = defaults::shortcut_dock();
        assert_eq!(stack_height(HudPosition::BottomRight, &off, &none), 0.0);
        // Enabled but with every readout off is also nothing.
        let empty = StatusDock {
            enabled: true,
            show_clock: false,
            show_battery: false,
            show_network: false,
            show_volume: false,
            ..defaults::status_dock()
        };
        assert_eq!(stack_height(empty.position, &empty, &none), 0.0);
    }

    #[test]
    fn two_docks_in_one_region_stack_with_a_gap() {
        let mut status = status();
        let mut shortcuts = shortcuts();
        status.position = HudPosition::BottomLeft;
        shortcuts.position = HudPosition::BottomLeft;
        let both = stack_height(HudPosition::BottomLeft, &status, &shortcuts);
        let expected =
            status_dock_height(&status) + shortcut_dock_height(&shortcuts) + STACK_GAP;
        assert!((both - expected).abs() < 1e-3, "{both} vs {expected}");
        // And a region neither is in stays empty.
        assert_eq!(stack_height(HudPosition::TopRight, &status, &shortcuts), 0.0);
    }

    #[test]
    fn labels_make_the_shortcut_dock_taller() {
        let mut dock = shortcuts();
        let without = shortcut_dock_height(&dock);
        dock.show_labels = true;
        assert!((shortcut_dock_height(&dock) - without - SHORTCUT_LABEL_H).abs() < 1e-3);
    }

    #[test]
    fn regions_place_against_the_right_edges() {
        let viewport = (1000.0, 800.0);
        let top = place(HudPosition::TopLeft, viewport, 100.0, 40.0, 0.0, 1.0);
        assert_eq!((top.left, top.top), (EDGE_PAD, EDGE_PAD));
        let bottom = place(HudPosition::BottomRight, viewport, 100.0, 40.0, 0.0, 1.0);
        assert_eq!(bottom.right, 1000.0 - EDGE_PAD);
        assert_eq!(bottom.bottom, 800.0 - EDGE_PAD);
        let centre = place(HudPosition::TopCenter, viewport, 100.0, 40.0, 0.0, 1.0);
        assert_eq!(centre.center().0, 500.0);
    }

    #[test]
    fn the_inset_moves_inboard_from_the_right_edge() {
        // A dock stacked above another at the bottom has to move UP, not down.
        let viewport = (1000.0, 800.0);
        let first = place(HudPosition::BottomLeft, viewport, 100.0, 40.0, 0.0, 1.0);
        let second = place(HudPosition::BottomLeft, viewport, 100.0, 40.0, 50.0, 1.0);
        assert!(second.top < first.top);
        // And at the top it moves down.
        let first = place(HudPosition::TopLeft, viewport, 100.0, 40.0, 0.0, 1.0);
        let second = place(HudPosition::TopLeft, viewport, 100.0, 40.0, 50.0, 1.0);
        assert!(second.top > first.top);
    }

    #[test]
    fn readout_glyphs_all_resolve() {
        // A dock drawing a fallback cube where the battery should be is the most visible possible
        // regression, and nothing else would catch a renamed glyph.
        for level in [-1, 0, 10, 50, 80, 100] {
            for charging in [true, false] {
                assert!(crate::gfx::lucide::exists(battery_glyph(level, charging)));
            }
            assert!(crate::gfx::lucide::exists(volume_glyph(level, false)));
            assert!(crate::gfx::lucide::exists(volume_glyph(level, true)));
        }
        for network in [Network::None, Network::Ethernet, Network::WiFi, Network::Other] {
            for signal in [-1, 10, 50, 90] {
                assert!(crate::gfx::lucide::exists(network_glyph(network, signal)));
            }
        }
        assert!(crate::gfx::lucide::exists("Settings"));
    }

    #[test]
    fn a_muted_volume_reads_as_muted_whatever_the_level() {
        assert_eq!(volume_glyph(80, true), "VolumeX");
        assert_eq!(volume_glyph(0, false), "VolumeX");
        assert_ne!(volume_glyph(80, false), "VolumeX");
    }

    #[test]
    fn the_clock_says_something() {
        // It comes from the user's locale, so the only thing that can be asserted is that it is
        // not empty — which is exactly the failure worth catching.
        assert!(!clock_text().is_empty());
    }
}
