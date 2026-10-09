//! The wheel, drawn small, beside the sliders that shape it.
//!
//! Orbital radius, icon size, spacing and background dimming had no visible effect until the panel
//! was closed and the wheel triggered — so tuning them meant a round trip per nudge, against a
//! memory of what the last value looked like.
//!
//! **It is a scaled photograph, not a drawing of one.** The layout is computed at FULL SIZE,
//! against the real display, by `wheel::state` and `wheel::render` themselves — the same code the
//! wheel uses — and only the last step, one scale on the whole layer, makes it small. A second
//! surface with its own constants drifts from the first, and drifts silently.
//!
//! **What it deliberately does not show:** hover, dwell, submenus, aiming, and the corner docks.
//! Those are behaviour and furniture, not shape, and a preview that invited you to aim at it would
//! be promising something it cannot do.

use crate::gfx::palette as pal;
use super::Frame;
use crate::config::UiConfig;
use crate::gfx::painter::Rect;

/// How tall the stage is, in DIPs. The original's.
const BOX_H: f32 = 186.0;

/// An icon source that never has one.
///
/// On purpose. The preview is about geometry, and a tile that is waiting for an extraction would
/// draw a spinner here — a progress indicator inside a settings panel, for work that is not
/// happening. Every tile draws its glyph, which is the shape the slider is moving.
struct NoIcons;

impl crate::wheel::render::IconSource2 for NoIcons {
    fn bitmap(&self, _reference: &str) -> Option<windows::Win32::Graphics::Direct2D::ID2D1Bitmap1> {
        None
    }
    fn pending(&self, _reference: &str) -> bool {
        false
    }
}

/// Draw the preview as the next thing in the column.
pub fn draw(f: &mut Frame, config: &UiConfig) {
    let height = f.px(BOX_H);
    let stage = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + height);
    f.y += height;

    // A STAND-IN DESKTOP under it, not a panel surface.
    //
    // The backdrop slider dims whatever is behind the wheel, and over a flat panel colour there
    // is nothing for it to dim: every value from 0 to 1 produced the same picture, which is the
    // one thing that slider exists to show. A wallpaper-coloured gradient gives the scrim
    // something to act on, and gives the tiles' own separation something to be measured against.
    let radius = f.px(pal::R_CONTROL);
    let ramp: Vec<crate::gfx::painter::Stop> = pal::DESK_RAMP
        .iter()
        .map(|&(offset, rgb)| crate::gfx::painter::Stop { offset, color: pal::rgb(rgb) })
        .collect();
    match f.p.linear_brush((stage.left, stage.top), (stage.right, stage.bottom), &ramp) {
        Some(brush) => f.p.fill_round_rect_with(stage, radius, &brush),
        // The middle of the ramp, so a machine that cannot build a gradient still gets a
        // desktop to dim rather than a hole where one should be.
        None => f.p.fill_round_rect(stage, radius, pal::rgb(pal::DESK_RAMP[1].1)),
    }

    // The real display, so the clamp that shrinks icons once the ring outgrows the screen shows
    // here too. Falling back to a common size keeps the preview drawable on a machine where the
    // monitor cannot be resolved rather than leaving an empty box.
    let display = crate::win::monitor::target_display(config.monitor_choice(), config.placement());
    let screen = (
        (display.bounds.right - display.bounds.left).max(640) as f32,
        (display.bounds.bottom - display.bounds.top).max(480) as f32,
    );
    let centre = (screen.0 / 2.0, screen.1 / 2.0);

    // The docks and the gear are furniture, not shape. Turned off for the photograph.
    let mut shown = config.clone();
    shown.status_dock = None;
    shown.shortcut_dock = None;
    shown.show_settings_corner = Some(false);

    let mut wheel = crate::wheel::state::Wheel::new(&shown);
    wheel.open(
        &shown,
        crate::wheel::state::TriggerSource::Shortcut,
        centre,
        screen,
        display.scale(),
    );
    // No bloom: a preview of a half-expanded wheel is a preview of the animation.
    wheel.settle_for_probe();

    // A FIXED zoom, not a fit.
    //
    // Fitting the content to the box is the obvious thing and it is wrong: it normalises away the
    // very change being previewed. Turning the radius up moved the tiles out and shrank them by
    // the same factor, so the picture barely moved -- which is the opposite of what the slider
    // beside it is for. The zoom is therefore a constant: the box always shows the same patch of
    // screen, and every number on this page moves what is inside it.
    //
    // The span is the widest wheel the sliders can make -- the largest orbital radius plus the
    // largest icon, doubled -- so the extreme setting still fits and every smaller one is
    // genuinely smaller.
    const SPAN: f32 = 620.0;
    let scale = stage.height() / SPAN;

    let icons = NoIcons;
    let frame = crate::wheel::render::Frame {
        config: &shown,
        icons: &icons,
        shadows: &crate::gfx::painter::ShadowCache::new(),
        // Off the surface, so nothing reads as hovered: a preview of a hover state is a preview of
        // where the mouse happened to be.
        pointer: Some((-10_000.0, -10_000.0)),
        pointer_down: false,
        status: crate::sys::status::Status::default(),
        update_ready: false,
        discovering: false,
        direction_hint: false,
        // The desk under it has already been painted; a clear would take it away.
        clear_first: false,
    };

    let painter = f.p;
    // NOT prebaked. Baking a shadow re-targets the device context, and this is being drawn INSIDE
    // a frame -- a nested `BeginDraw` fails the whole frame, which showed up as an empty box and a
    // settings panel with nothing else on it. The cache is empty, so every fetch misses and the
    // preview draws without the drop shadows. That is the one thing it is allowed to differ by:
    // a shadow is not a number any slider on this page moves.
    painter.scaled_clip(stage, scale, centre, || {
        let _ = crate::wheel::render::draw(painter, &wheel, &frame);
    });

    // The hairline over the desktop, last, so the wheel cannot paint over it.
    f.p.stroke_round_rect(stage.inflate(-0.5), radius, f.theme.line, 1.0);

    // What the picture is, under it. An empty workspace shows the shipped example shortcuts, and
    // saying so is the difference between "here is your wheel" and "here is a wheel".
    let caption = if wheel.item_count() == 0 {
        "Example shortcuts — this workspace is empty."
    } else {
        "Your own shortcuts, shown smaller than they open."
    };
    let style = crate::ui::widgets::caption_style(f.scale, f.rtl);
    let (_, th) = f.p.measure(caption, &style);
    f.y += f.px(8.0);
    f.p.text(
        caption,
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + th),
        &style,
        f.theme.text_3,
    );
    // The caption belongs to the picture, so the space that separates it from the first group
    // below is added here rather than left for the page to remember.
    f.y += th + f.px(28.0);
}
