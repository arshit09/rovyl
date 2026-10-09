//! Offscreen rendering, for looking at what the wheel actually draws.
//!
//! A screenshot can only show the wheel over whatever happens to be behind it, at whatever size the
//! monitor is, and only while the program is running. This draws the same frame to a bitmap against
//! a chosen backdrop and writes it to a file — which is how a detail like a glyph's stroke weight or
//! a badge's digit can be checked without a window, and how a change can be compared against the
//! frame before it.
//!
//! It runs the REAL renderer against the REAL state machine. A probe that drew its own
//! approximation of the wheel would be a second opinion about what the product looks like, which is
//! the thing this whole port is careful not to have anywhere else.

use crate::config::{self, UiConfig};
use crate::gfx::device::Gpu;
use crate::gfx::encode;
use crate::gfx::lucide::GlyphCache;
use crate::gfx::painter::{Painter, Rect, ShadowCache};
use crate::gfx::text::TextCache;
use crate::icons::cache::IconCache;
use crate::wheel::render::{self, Frame};
use crate::wheel::state::{TriggerSource, Wheel};
use std::path::Path;
use windows::core::Result;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT, D2D_SIZE_U,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1_BITMAP_OPTIONS_CPU_READ, D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_OPTIONS_TARGET,
    D2D1_BITMAP_PROPERTIES1, D2D1_MAP_OPTIONS_READ,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

/// What the frame is drawn over.
///
/// The wheel is a per-pixel-alpha overlay, so a probe on transparency shows the alpha but not what
/// the user sees. A mid grey is the harshest honest test: it is where a dark plate's edge and a
/// light glyph's stroke are both only just distinguishable, so anything that reads there reads
/// anywhere.
#[derive(Clone, Copy)]
pub enum Backdrop {
    Transparent,
    Grey,
    Light,
    Dark,
}

impl Backdrop {
    fn parse(value: &str) -> Self {
        match value {
            "grey" | "gray" => Backdrop::Grey,
            "light" => Backdrop::Light,
            "dark" => Backdrop::Dark,
            _ => Backdrop::Transparent,
        }
    }

    fn colour(self) -> windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F {
        use crate::gfx::palette as pal;
        match self {
            Backdrop::Transparent => pal::TRANSPARENT,
            Backdrop::Grey => pal::rgb(0x80_80_80),
            Backdrop::Light => pal::rgb(0xF2_F2_F4),
            Backdrop::Dark => pal::rgb(0x1E_1E_1E),
        }
    }
}

pub struct Options {
    pub out: std::path::PathBuf,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub backdrop: Backdrop,
    /// Which slice is aimed at, so the active state can be inspected. `None` aims at the hub.
    pub active: Option<usize>,
    /// What has been typed on the wheel, for the filter readout.
    pub filter: String,
    /// Enter this folder before drawing, by index at the root.
    pub enter: Vec<usize>,
    /// Force both corner docks on.
    pub docks: bool,
    /// Rest on the aimed workspace until its shortcuts fan out around it.
    pub peek: bool,
    /// Which layout to draw them in, when the frame should not use the saved one.
    pub peek_style: Option<crate::config::PeekStyle>,
    /// And then aim at this one of them.
    pub peek_at: Option<usize>,
}

impl Options {
    /// Parse `--probe <out.png>` and the flags that follow it.
    pub fn from_args(args: &[String]) -> Option<Self> {
        let at = args.iter().position(|a| a == "--probe")?;
        let out = args.get(at + 1)?.clone();
        let flag = |name: &str| -> Option<&String> {
            let at = args.iter().position(|a| a == name)?;
            args.get(at + 1)
        };
        Some(Self {
            out: std::path::PathBuf::from(out),
            width: flag("--w").and_then(|v| v.parse().ok()).unwrap_or(1000),
            height: flag("--h").and_then(|v| v.parse().ok()).unwrap_or(1000),
            scale: flag("--scale").and_then(|v| v.parse().ok()).unwrap_or(1.0),
            backdrop: flag("--bg").map(|v| Backdrop::parse(v)).unwrap_or(Backdrop::Dark),
            active: flag("--active").and_then(|v| v.parse().ok()),
            filter: flag("--filter").cloned().unwrap_or_default(),
            enter: flag("--enter")
                .map(|v| v.split(',').filter_map(|part| part.trim().parse().ok()).collect())
                .unwrap_or_default(),
            docks: args.iter().any(|a| a == "--docks"),
            peek: args.iter().any(|a| a == "--peek") || args.iter().any(|a| a == "--peek-at"),
            // `--peek` takes an optional style. Matched against the two names rather than taken
            // as "whatever follows", or a bare `--peek --active 1` would read `--active` as one.
            peek_style: match flag("--peek").map(String::as_str) {
                Some("fan") => Some(crate::config::PeekStyle::Fan),
                Some("ring") => Some(crate::config::PeekStyle::Ring),
                _ => None,
            },
            peek_at: flag("--peek-at").and_then(|v| v.parse().ok()),
        })
    }
}

/// Draw one frame of the wheel to a PNG.
pub fn render_to_file(options: &Options, config: &UiConfig) -> Result<()> {
    let gpu = Gpu::create()?;
    let glyphs = GlyphCache::new();
    let text = TextCache::new(gpu.dwrite.clone());
    let shadows = ShadowCache::new();

    let mut config = config.clone();
    // `--docks` turns both corner docks on for the frame. They are off in every real profile — a
    // strip appearing in somebody's corner because they updated is a fault report — so a probe
    // that only drew what the config says would never exercise them.
    if options.docks {
        let mut status = config.status_dock_cfg();
        status.enabled = true;
        config.status_dock = Some(status);
        let mut shortcuts = config.shortcut_dock_cfg();
        shortcuts.enabled = true;
        shortcuts.show_labels = true;
        if shortcuts.items.is_empty() {
            // The active workspace's first few shortcuts, so the dock is drawn with real icons
            // and real names rather than placeholders.
            shortcuts.items = config
                .active_workspace()
                .map(|w| w.apps.iter().take(5).cloned().collect())
                .unwrap_or_default();
        }
        config.shortcut_dock = Some(shortcuts);
    }
    // `--peek` turns the feature on for the frame, for the same reason `--docks` does: it is off
    // in every real profile, so a probe that only drew what the config says could never show it.
    if options.peek {
        config.radial_workspace_peek = Some(true);
        if let Some(style) = options.peek_style {
            config.radial_workspace_peek_style = Some(style);
        }
    }
    let mut wheel = Wheel::new(&config);
    wheel.open(
        &config,
        TriggerSource::Shortcut,
        (options.width as f32 / 2.0, options.height as f32 / 2.0),
        (options.width as f32, options.height as f32),
        options.scale,
    );
    // `--enter 2,3` walks down two levels. One number stopped being enough the moment the root
    // became the workspace picker: everything inside a workspace is two steps away.
    for index in &options.enter {
        if let crate::wheel::state::Action::FetchRecents(item) = wheel.activate(&mut config, *index)
        {
            // The real list, read on this thread. A probe is not paced by anything, and a picture
            // of an empty ring would be a picture of the probe rather than of the product.
            let found = crate::sys::recents::fetch(&item.label, &item.command);
            println!("recents {} for {}", found.len(), item.label);
            wheel.recents_arrived(&config, &item, found);
        }
    }
    for ch in options.filter.chars() {
        wheel.type_char(&config, ch);
    }
    // Aim by pointing at the slice's own direction from the centre, so the aim resolves through
    // exactly the path a real gesture would rather than by setting the highlight directly.
    let mut aimed_at = None;
    if let Some(index) = options.active {
        let count = wheel.item_count().max(1);
        let deg = crate::wheel::sectors::centre_deg(index, count) * std::f32::consts::PI / 180.0;
        let reach = wheel.layout().radius;
        let point = (
            wheel.center.0 + deg.cos() * reach,
            wheel.center.1 + deg.sin() * reach,
        );
        wheel.pointer_moved(&config, point);
        aimed_at = Some(point);
    }
    // The fan is EARNED by resting, so the probe rests — against the product's own clock rather
    // than by reaching into the state and declaring a peek open. A probe that set the state would
    // be a second opinion about when the thing appears.
    if options.peek {
        if let Some(point) = aimed_at {
            std::thread::sleep(std::time::Duration::from_millis(
                config.peek_delay_ms() as u64 + 20,
            ));
            wheel.pointer_moved(&config, point);
            if let Some(index) = options.peek_at {
                if let Some(shape) = wheel.peek_shape(&config) {
                    wheel.pointer_moved(&config, shape.point_of(wheel.center, index));
                }
            }
            match wheel.peek_items() {
                Some((slice, items, _)) => {
                    println!("peek on slice {slice}: {} shortcuts", items.len())
                }
                // Said out loud, because an unpeeked frame and a peeked one with an empty
                // workspace are the same picture.
                None => println!("peek did not open \u{2014} is --active on a workspace?"),
            }
        } else {
            println!("--peek needs --active <slice>: a peek hangs off a workspace");
        }
    }
    // The bloom is skipped: a probe of a half-expanded wheel measures the animation, not the frame.
    wheel.settle_for_probe();

    // The probe waits for the icons rather than drawing the first frame without them: it is not
    // paced by a display and a picture of the fallback glyphs is not what anybody wants to look at.
    let icons = IconCache::new();
    icons.warm(
        config
            .shortcut_dock_cfg()
            .items
            .iter()
            .filter_map(|item| item.custom_icon_url.as_deref())
            .collect::<Vec<_>>()
            .into_iter(),
    );
    icons.warm(
        wheel
            .items()
            .iter()
            .filter_map(|item| item.custom_icon_url.as_deref())
            .collect::<Vec<_>>()
            .into_iter(),
    );
    // The peeked workspace's own icons. They are not on the level, so `items()` does not reach
    // them — and a fan of fallback glyphs is a picture of the extractor, not of the feature.
    let peeked: Vec<String> = wheel
        .peek_items()
        .map(|(_, items, _)| {
            items
                .iter()
                .filter_map(|i| i.custom_icon_url.clone())
                .collect()
        })
        .unwrap_or_default();
    icons.warm(peeked.iter().map(|s| s.as_str()));
    let wanted = wheel
        .items()
        .iter()
        .filter(|i| i.custom_icon_url.is_some())
        .count()
        + peeked.len();
    for _ in 0..200 {
        icons.pump(&gpu);
        if icons.len() >= wanted {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Reported, because the difference between "the icon is wrong" and "the icon never loaded" is
    // not visible in the picture: both come out as a glyph.
    println!("icons {}/{} resolved", icons.len(), wanted);

    let frame = Frame {
        config: &config,
        icons: &icons,
        shadows: &shadows,
        // A pointer parked off the surface, so nothing in the corners reads as hovered: a probe of
        // a hover state is a probe of where the mouse happened to be.
        pointer: Some((-1000.0, -1000.0)),
        pointer_down: false,
        // A plausible reading rather than the machine's own, so the dock's layout is exercised on
        // every host — including one with no battery, where the real reading draws nothing.
        status: crate::sys::status::Status {
            volume: 42,
            muted: false,
            network: crate::sys::status::Network::WiFi,
            signal: 78,
            battery: 61,
            charging: false,
        },
        update_ready: false,
        discovering: false,
        // Computed, not assumed: the hint is the one thing on the wheel whose visibility depends
        // on configuration the probe is being pointed at.
        direction_hint: wheel.direction_hint_visible(&config),
        clear_first: true,
    };
    let painter = Painter::new(&gpu, &glyphs, &text)?;
    render::prebake(&painter, &wheel, &frame);

    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let size = D2D_SIZE_U {
        width: options.width,
        height: options.height,
    };

    unsafe {
        let target = gpu.d2d.CreateBitmap(size, None, 0, &properties)?;
        gpu.d2d.SetTarget(&target);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&options.backdrop.colour()));
        render::draw(&painter, &wheel, &frame);
        gpu.d2d.EndDraw(None, None)?;
        gpu.d2d.SetTarget(None);

        // A target bitmap cannot be mapped, so the frame is copied into one that can be. This is
        // the only place in the program that reads pixels back off the GPU, and it is a probe.
        let readback = gpu.d2d.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_NONE
                    | windows::Win32::Graphics::Direct2D::D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                ..properties
            },
        )?;
        readback.CopyFromBitmap(None, &target, None)?;
        let mapped = readback.Map(D2D1_MAP_OPTIONS_READ)?;

        let stride = mapped.pitch as usize;
        let row = options.width as usize * 4;
        let mut pixels = Vec::with_capacity(row * options.height as usize);
        for y in 0..options.height as usize {
            let start = y * stride;
            let slice = std::slice::from_raw_parts(mapped.bits.add(start), row);
            pixels.extend_from_slice(slice);
        }
        readback.Unmap()?;
        encode::save_png(&options.out, &pixels, options.width, options.height)?;
    }
    Ok(())
}

/// Run the probe and report, with a console attached so the report is visible.
pub fn run(args: &[String]) {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
    let Some(options) = Options::from_args(args) else {
        println!("usage: rovyl --probe <out.png> [--w N] [--h N] [--scale F]");
        println!("              [--bg transparent|grey|light|dark] [--active N]");
        println!("              [--filter TEXT] [--enter N]");
        return;
    };
    let config = config::store::load().config;
    match render_to_file(&options, &config) {
        Ok(()) => println!("wrote {}", options.out.display()),
        Err(error) => println!("probe failed: {error}"),
    }
}

/// Also used by `--probe-logo`, which draws the mark on its own, large.
pub fn run_logo(args: &[String]) {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
    let at = args.iter().position(|a| a == "--probe-logo");
    let out = at
        .and_then(|at| args.get(at + 1))
        .cloned()
        .unwrap_or_else(|| "logo.png".into());
    let side = 512u32;

    let Ok(gpu) = Gpu::create() else {
        println!("no device");
        return;
    };
    let glyphs = GlyphCache::new();
    let text = TextCache::new(gpu.dwrite.clone());
    let Ok(painter) = Painter::new(&gpu, &glyphs, &text) else {
        return;
    };

    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let size = D2D_SIZE_U { width: side, height: side };
    unsafe {
        let Ok(target) = gpu.d2d.CreateBitmap(size, None, 0, &properties) else {
            return;
        };
        gpu.d2d.SetTarget(&target);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&crate::gfx::palette::rgb(0x10_10_12)));
        // The mark on its own, plus a line of text, so both can be checked at a size where a
        // half-pixel is visible.
        render::draw_logo_probe(&painter, (256.0, 220.0), 300.0);
        painter.text(
            "Rovyl 0123456789",
            Rect::new(0.0, 400.0, 512.0, 460.0),
            &crate::gfx::text::Style::new(
                crate::gfx::text::Family::Radial,
                28.0,
                500,
                crate::gfx::text::Align::Center,
            ),
            crate::gfx::palette::rgb(0xFF_FF_FF),
        );
        let _ = gpu.d2d.EndDraw(None, None);
        gpu.d2d.SetTarget(None);

        let Ok(readback) = gpu.d2d.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ
                    | windows::Win32::Graphics::Direct2D::D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                ..properties
            },
        ) else {
            return;
        };
        let _ = readback.CopyFromBitmap(None, &target, None);
        let Ok(mapped) = readback.Map(D2D1_MAP_OPTIONS_READ) else {
            return;
        };
        let stride = mapped.pitch as usize;
        let row = side as usize * 4;
        let mut pixels = Vec::with_capacity(row * side as usize);
        for y in 0..side as usize {
            pixels.extend_from_slice(std::slice::from_raw_parts(mapped.bits.add(y * stride), row));
        }
        let _ = readback.Unmap();
        match encode::save_png(Path::new(&out), &pixels, side, side) {
            Ok(()) => println!("wrote {out}"),
            Err(error) => println!("failed: {error}"),
        }
    }
}

/// Three test fills, side by side, to tell a broken gradient from a broken layer.
///
/// It exists because "the wedge does not fade" has two possible causes that look identical on
/// screen — the radial brush not varying, or the opacity-mask layer not multiplying — and guessing
/// between them costs more than drawing both.
///
/// Left: the reach gradient on its own. Middle: the beam gradient on its own. Right: the beam
/// inside a layer masked by the reach. The right panel must be dimmer than the middle one
/// everywhere, and black in its lower-right corner.
/// Print what the bundled faces resolved to, and the measured width of a line in each role.
///
/// `rovyl.exe --probe-fonts`. A missing family is not an error anywhere in DirectWrite — it is a
/// substitution, made silently at layout time — so "the heading looks a bit different" is the only
/// symptom a failed registration has. This asks the collection directly.
pub fn run_fonts() {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
    let Ok(gpu) = Gpu::create() else {
        println!("no device");
        return;
    };
    let text = TextCache::new(gpu.dwrite.clone());
    for line in text.report() {
        println!("{line}");
    }
    // A width per role, so a substitution that got the family name right and the face wrong still
    // shows up as a number that moved.
    use crate::gfx::text::{Align, Family, Style};
    const SAMPLE: &str = "Handgloves 0123456789";
    for family in [Family::Display, Family::Ui, Family::Radial, Family::Mono] {
        for weight in [400u16, 450, 500, 600] {
            let style = Style::new(family, 16.0, weight, Align::Leading);
            let width = text.lay_out(SAMPLE, &style).map(|l| l.width).unwrap_or(-1.0);
            println!("{family:?} {weight} -> {width:.2}px");
        }
    }
}

pub fn run_brush(args: &[String]) {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
    let at = args.iter().position(|a| a == "--probe-brush");
    let out = at
        .and_then(|at| args.get(at + 1))
        .cloned()
        .unwrap_or_else(|| "brush.png".into());

    let Ok(gpu) = Gpu::create() else { return };
    let glyphs = GlyphCache::new();
    let text = TextCache::new(gpu.dwrite.clone());
    let Ok(p) = Painter::new(&gpu, &glyphs, &text) else { return };

    let (w, h) = (900u32, 300u32);
    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let size = D2D_SIZE_U { width: w, height: h };
    unsafe {
        let Ok(target) = gpu.d2d.CreateBitmap(size, None, 0, &properties) else { return };
        gpu.d2d.SetTarget(&target);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&crate::gfx::palette::rgb(0x00_00_00)));

        use crate::gfx::painter::Stop;
        use crate::gfx::palette as pal;
        // A radial fade, 1 at the origin to 0 at 300px — the shape the reach mask has.
        let reach: Vec<Stop> = (0..=8)
            .map(|i| {
                let t = i as f32 / 8.0;
                Stop { offset: t, color: pal::rgba(pal::WHITE, 1.0 - t) }
            })
            .collect();
        // A flat white, so anything the mask does is the only variation in the right panel.
        let flat: Vec<Stop> = vec![
            Stop { offset: 0.0, color: pal::rgba(pal::WHITE, 0.8) },
            Stop { offset: 1.0, color: pal::rgba(pal::WHITE, 0.8) },
        ];

        if let Some(b) = p.radial_brush((0.0, 0.0), 300.0, &reach) {
            p.fill_rect_with(Rect::new(0.0, 0.0, 300.0, 300.0), &b);
        } else {
            println!("radial brush FAILED");
        }
        if let Some(b) = p.linear_brush((300.0, 0.0), (600.0, 300.0), &flat) {
            p.fill_rect_with(Rect::new(300.0, 0.0, 600.0, 300.0), &b);
        } else {
            println!("linear brush FAILED");
        }
        if let (Some(flat_brush), Some(mask)) = (
            p.linear_brush((600.0, 0.0), (900.0, 300.0), &flat),
            p.radial_brush((600.0, 0.0), 300.0, &reach),
        ) {
            p.masked(Rect::new(600.0, 0.0, 900.0, 300.0), &mask, |p| {
                p.fill_rect_with(Rect::new(600.0, 0.0, 900.0, 300.0), &flat_brush);
            });
        }

        let _ = gpu.d2d.EndDraw(None, None);
        gpu.d2d.SetTarget(None);

        let Ok(readback) = gpu.d2d.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ
                    | windows::Win32::Graphics::Direct2D::D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                ..properties
            },
        ) else { return };
        let _ = readback.CopyFromBitmap(None, &target, None);
        let Ok(mapped) = readback.Map(D2D1_MAP_OPTIONS_READ) else { return };
        let stride = mapped.pitch as usize;
        let row = w as usize * 4;
        let mut pixels = Vec::with_capacity(row * h as usize);
        for y in 0..h as usize {
            pixels.extend_from_slice(std::slice::from_raw_parts(mapped.bits.add(y * stride), row));
        }
        let _ = readback.Unmap();

        // The three panels, sampled at the same offset within each, so the numbers can be compared
        // directly rather than eyeballed.
        let at = |x: usize, y: usize| {
            let i = y * row + x * 4;
            (pixels[i + 2], pixels[i + 1], pixels[i])
        };
        for (name, base) in [("reach", 0usize), ("flat", 300), ("masked", 600)] {
            println!(
                "{name:>7}: near={:?} mid={:?} far={:?}",
                at(base + 10, 10),
                at(base + 150, 150),
                at(base + 290, 290)
            );
        }
        let _ = encode::save_png(Path::new(&out), &pixels, w, h);
        println!("wrote {out}");
    }
}


/// Render one settings page offscreen.
///
/// The same reason the wheel has a probe: a screenshot of a window is a screenshot of whatever is
/// behind it too, at whatever size it happens to be, and only while the app is running. This draws
/// the real panel against the real configuration at a chosen size and writes it out — which is how
/// six pages can be checked in one command rather than six clicks.
pub fn run_settings(args: &[String]) {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
    let at = args.iter().position(|a| a == "--probe-settings");
    let out = at
        .and_then(|at| args.get(at + 1))
        .cloned()
        .unwrap_or_else(|| "settings.png".into());
    let flag = |name: &str| -> Option<&String> {
        let at = args.iter().position(|a| a == name)?;
        args.get(at + 1)
    };
    let section = match flag("--section").map(String::as_str) {
        Some("activation") => crate::ui::settings::Section::Activation,
        Some("sound") => crate::ui::settings::Section::Sound,
        Some("advanced") => crate::ui::settings::Section::Advanced,
        Some("appearance") => crate::ui::settings::Section::Appearance,
        Some("general") => crate::ui::settings::Section::General,
        _ => crate::ui::settings::Section::Workspaces,
    };
    let width: u32 = flag("--w").and_then(|v| v.parse().ok()).unwrap_or(960);
    let height: u32 = flag("--h").and_then(|v| v.parse().ok()).unwrap_or(900);
    let scroll: f32 = flag("--scroll").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    // `--drag x,y` puts a drag over that point, which is the only way to photograph the drop
    // sheet: it is raised by OLE telling the window a drag has crossed it, and no click can
    // reach that path.
    let drag_at: Option<(f32, f32)> = flag("--drag").and_then(|value| {
        let (x, y) = value.split_once(',')?;
        Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
    });

    let Ok(gpu) = Gpu::create() else {
        println!("no device");
        return;
    };
    let glyphs = GlyphCache::new();
    let text = TextCache::new(gpu.dwrite.clone());
    let Ok(painter) = Painter::new(&gpu, &glyphs, &text) else { return };

    let mut config = config::store::load().config;
    let mut ui = crate::ui::Ui::new();
    let mut state = crate::ui::settings::SettingsUi { section, ..Default::default() };

    // `--workspace N` opens the editor for that workspace, which is otherwise only reachable by
    // clicking -- and a page that cannot be probed is a page whose layout is checked by hand.
    if let Some(index) = flag("--workspace").and_then(|v| v.parse::<usize>().ok()) {
        state.editing_workspace = Some(index);
    }
    // `--search <term>` puts the panel on its results page, which is otherwise only reachable
    // by typing into a field -- and a page that cannot be probed is a page checked by hand.
    if let Some(term) = flag("--search") {
        state.search = term.clone();
    }

    // `--code` opens that workspace's editor on its JSON rather than its controls, and
    // `--code-text <file>` puts the contents of a file in the box instead of the workspace's own
    // text. The second is how the broken-text face is photographed: it is a state nobody can reach
    // without typing, and it is the state the status line exists for.
    if args.iter().any(|a| a == "--code") {
        let index = state.editing_workspace.unwrap_or(0);
        state.editing_workspace = Some(index);
        if let Some(workspace) = config.workspaces.get(index) {
            let mut buffer = crate::ui::code::Buffer::open(workspace);
            if let Some(path) = flag("--code-text") {
                match std::fs::read_to_string(path) {
                    Ok(text) => buffer.replace_all(&text),
                    Err(error) => println!("--code-text {path}: {error}"),
                }
            }
            // `--scroll` means lines here, not pixels: the code view is the one surface in the
            // panel that is not a column of rows, and the dialog's own offset moves nothing in it.
            if scroll > 0.0 {
                buffer.scroll_to(scroll as usize, 0);
            }
            if let Some(col) = flag("--code-col").and_then(|v| v.parse::<usize>().ok()) {
                buffer.scroll_to(scroll.max(0.0) as usize, col);
            }
            state.code = Some(buffer);
        }
    }

    // `--confirming <key>` puts a destructive action on its second press -- "reset" for Restore
    // defaults, "ws:<workspace id>" for a workspace card. These faces are a frame of their own
    // and are otherwise only reachable by clicking the thing they are warning about.
    if let Some(key) = flag("--confirming") {
        state.confirming = Some(key.clone());
    }

    // `--rail` collapses the sidebar, which is the other half of a layout that has two.
    if args.iter().any(|a| a == "--rail") {
        state.nav_collapsed = true;
    }

    // `--dock` opens the shortcut dock's own list, which is a page of Appearance.
    if args.iter().any(|a| a == "--dock") {
        state.section = crate::ui::settings::Section::Appearance;
        state.editing_dock = true;
    }
    // `--add app|url|folder|file|command` opens that add panel.
    state.add_mode = match flag("--add").map(String::as_str) {
        Some("app") => Some(crate::ui::workspace::AddMode::App),
        Some("url") => Some(crate::ui::workspace::AddMode::Url),
        Some("folder") => Some(crate::ui::workspace::AddMode::Folder),
        Some("file") => Some(crate::ui::workspace::AddMode::File),
        Some("command") => Some(crate::ui::workspace::AddMode::Command),
        _ => None,
    };
    if state.add_mode == Some(crate::ui::workspace::AddMode::App) {
        // The real list, so the probe shows what the user would see rather than a spinner. This
        // is the one place the scan runs on the calling thread, and it is a diagnostic.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            );
        }
        state.installed = crate::sys::discovery::installed()
            .iter()
            .map(|app| {
                let item = crate::sys::discovery::to_item(app);
                crate::ui::workspace::Installed {
                    id: item.id,
                    label: item.label,
                    command: item.command,
                }
            })
            .collect();

        // `--multi [n]` turns multi-select on and ticks the first n rows, which is the only way
        // to photograph the footer: it exists only while something is selected, and a selection
        // is made by clicking rows the probe draws once and never presses.
        if let Some(at) = args.iter().position(|a| a == "--multi") {
            state.multi_select = true;
            let n: usize = args
                .get(at + 1)
                .and_then(|v| v.parse().ok())
                .unwrap_or(3);
            state.selected_apps = state
                .installed
                .iter()
                .take(n)
                .map(|app| app.command.clone())
                .collect();
        }
    }
    // `--edit-item N` expands that shortcut's row.
    if let (Some(index), Some(at)) = (
        state.editing_workspace,
        flag("--edit-item").and_then(|v| v.parse::<usize>().ok()),
    ) {
        state.editing_item = config
            .workspaces
            .get(index)
            .and_then(|w| w.apps.get(at))
            .map(|item| item.id.clone());
    }
    // `--icon-library <file>` opens the picker on that program's icons, which is the one part of
    // the picker that needs a file dialog to reach by hand.
    if let Some(at) = args.iter().position(|a| a == "--icon-library") {
        let file = args.get(at + 1).cloned().unwrap_or_default();
        let path = crate::sys::picker::windows_library(&file)
            .unwrap_or_else(|| std::path::PathBuf::from(&file));
        let total = crate::icons::library::count(&path);
        println!("{} holds {total} icons", path.display());
        if total > 0 {
            state.icon_library = Some((path, total));
        }
    }
    // `--icons` opens the glyph picker over whatever else is showing.
    if args.iter().any(|a| a == "--icons") {
        state.icon_picker = Some(match flag("--edit-item") {
            Some(_) => crate::ui::workspace::IconTarget::Item(
                state.editing_item.clone().unwrap_or_default(),
            ),
            None => crate::ui::workspace::IconTarget::Workspace,
        });
        // `--icon-search <term>` fills the box, which is how the keyword search is photographed:
        // the grid it produces is a function of the term and nothing else can set one.
        if let Some(term) = flag("--icon-search") {
            state.icon_search = term.clone();
        }
    }
    // A pointer parked off the panel, so nothing reads as hovered: a probe of a hover state is a
    // probe of where the mouse happened to be.
    //
    // `--click X Y` moves it there and presses instead. The frames run before the one that is
    // drawn, so the picture is of the panel AFTER the click -- which is how a coordinate can be
    // checked without a window, a mouse, or a guess about where a control ended up.
    //
    // Points separated by `;` are pressed in order, which is what it takes to reach anything that
    // is only there because something else was clicked first -- an item in a dropdown exists for
    // exactly as long as the list is open, and the list opens on a click of its own.
    let clicks: Vec<(f32, f32)> = flag("--click")
        .map(|v| {
            v.split(';')
                .filter_map(|point| {
                    let mut parts = point.split(',');
                    let x: f32 = parts.next()?.trim().parse().ok()?;
                    let y: f32 = parts.next()?.trim().parse().ok()?;
                    Some((x, y))
                })
                .collect()
        })
        .unwrap_or_default();
    let input = crate::ui::Input {
        pointer: clicks.last().copied().unwrap_or((-100.0, -100.0)),
        ..Default::default()
    };

    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let size = D2D_SIZE_U { width, height };
    unsafe {
        let Ok(target) = gpu.d2d.CreateBitmap(size, None, 0, &properties) else { return };
        gpu.d2d.SetTarget(&target);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&crate::gfx::palette::rgb(0xFF_00_FF)));
        let theme = crate::gfx::palette::surface(config.theme());
        let bounds = Rect::new(0.0, 0.0, width as f32, height as f32);

        // The panel draws bitmaps in exactly one place -- the icon picker's library grid -- and
        // they arrive on a worker. A probe is not paced by anything, so it waits: a picture of a
        // grid of placeholders is a picture of the probe.
        let icons = IconCache::new();
        if let Some((path, total)) = state.icon_library.clone() {
            let wanted = (total as usize).min(120);
            let references: Vec<String> = (0..wanted as u32)
                .map(|index| crate::icons::store::lib_ref(&path, index))
                .collect();
            icons.warm(references.iter().map(String::as_str));
            for _ in 0..600 {
                icons.pump(&gpu);
                if icons.len() >= wanted {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            println!("library thumbnails {}/{}", icons.len(), wanted);
        }

        // The click, as three frames: the hover that an immediate-mode widget needs in order to
        // know it is under the pointer, then the press, then the release that commits it. Drawn
        // to a throwaway target, because only the LAST frame is the picture.
        for at in clicks.iter().copied() {
            let before = format!("{config:?}");
            // A fourth, quiet frame after the release: a dropdown's list is drawn downstream of
            // the row that owns it, so what was picked reaches that row on the frame after the
            // click. Without the settle frame the probe would report every pick as no change.
            for stage in 0..4 {
                let input = crate::ui::Input {
                    pointer: at,
                    down: stage == 1,
                    pressed: stage == 1,
                    released: stage == 2,
                    ..Default::default()
                };
                let mut frame =
                    crate::ui::Frame::new(&painter, &mut ui, &input, theme, 1.0, bounds).with_icons(&icons);
                let _ = crate::ui::settings::draw(&mut frame, &mut state, &mut config, "1.19.0");
            }
            println!(
                "click ({}, {}): config {}, recording {:?}, editing {:?}, add {:?}",
                at.0,
                at.1,
                if format!("{config:?}") == before { "unchanged" } else { "CHANGED" },
                state.recording,
                state.editing_workspace,
                state.add_mode,
            );
        }
        {
            // `--card` draws the launch-failure card instead of the panel, centred in the same
            // target. It is the one surface that appears only when something has gone wrong,
            // which makes it the one surface nobody looks at until it is too late to fix how it
            // reads.
            if args.iter().any(|a| a == "--card") {
                let item = crate::config::AppItem {
                    id: "item-probe".into(),
                    label: flag("--label").cloned().unwrap_or_else(|| "Figma".into()),
                    command: r"C:\Users\You\AppData\Local\Figma\Figma.exe".into(),
                    ..Default::default()
                };
                let outcome = crate::launch::Outcome::probe_failure();
                let fault = crate::ui::fault::from_launch(&item, &outcome, Some(2));
                let card = Rect::centred(
                    width as f32 / 2.0,
                    height as f32 / 2.0,
                    crate::win::card::CARD_W,
                    crate::win::card::CARD_H,
                );
                let mut frame =
                    crate::ui::Frame::new(&painter, &mut ui, &input, theme, 1.0, card);
                crate::ui::fault::draw(&mut frame, &fault, false);
            } else {
                // A quiet settle pass before the picture. A surface that measures itself -- the
                // workspace dialog is sized by what is in it -- reports that measurement at the
                // END of a frame and uses it on the next one. Without a pass to throw away, the
                // probe photographs every such surface one frame before it is right.
                for _ in 0..2 {
                    let mut frame =
                        crate::ui::Frame::new(&painter, &mut ui, &input, theme, 1.0, bounds)
                            .with_icons(&icons)
                            .with_drag(drag_at);
                    if scroll > 0.0 {
                        // Whichever is actually scrolling. A dialog takes the wheel off the page
                        // underneath it, so pointing `--scroll` at the page would move nothing.
                        let id = if state.editing_workspace.is_some() || state.editing_dock {
                            "ws-editor".to_string()
                        } else {
                            format!("content:{section:?}")
                        };
                        frame.ui.set_scroll(&id, scroll);
                    }
                    let _ = crate::ui::settings::draw(&mut frame, &mut state, &mut config, "1.19.0");
                }
                let mut frame =
                    crate::ui::Frame::new(&painter, &mut ui, &input, theme, 1.0, bounds).with_icons(&icons);
                let bar = Rect::new(0.0, 0.0, width as f32, crate::win::settings::TITLEBAR_H);
                crate::ui::settings::window_buttons(&mut frame, bar, false);
            }
        }
        let _ = gpu.d2d.EndDraw(None, None);
        gpu.d2d.SetTarget(None);

        let Ok(readback) = gpu.d2d.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ
                    | windows::Win32::Graphics::Direct2D::D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                ..properties
            },
        ) else { return };
        let _ = readback.CopyFromBitmap(None, &target, None);
        let Ok(mapped) = readback.Map(D2D1_MAP_OPTIONS_READ) else { return };
        let stride = mapped.pitch as usize;
        let row = width as usize * 4;
        let mut pixels = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            pixels.extend_from_slice(std::slice::from_raw_parts(mapped.bits.add(y * stride), row));
        }
        let _ = readback.Unmap();
        match encode::save_png(Path::new(&out), &pixels, width, height) {
            Ok(()) => println!("wrote {out}"),
            Err(error) => println!("failed: {error}"),
        }
    }
}
