//! Painting the wheel.
//!
//! One function, `draw`, called once per frame with the state and a painter. It reads state and
//! never writes it, which is the property that matters: the Electron build's renderer and its
//! aiming were the same component, and the comments on it record the consequences — a highlight
//! that disagreed with what launched, a tile whose hit area sat half a tile off its paint. Here the
//! hit testing is [`super::aim`] and the painting is this file, and both read the same geometry
//! from [`super::sectors`] and [`super::layout`].
//!
//! Draw order is back to front and is load-bearing in three places, each marked below.

use super::aim;
use super::dwell;
use super::layout;
use super::scrim;
use super::sectors;
use super::state::{is_workspace_pick, workspace_pick_index, Wheel};
use crate::config::{self, AppItem, UiConfig};
use crate::gfx::painter::{Painter, Rect, ShadowCache, Stop};
use crate::gfx::palette as pal;
use crate::gfx::text::{Align, Family, Style};
use std::f32::consts::PI;
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;
use windows::Win32::Graphics::Direct2D::ID2D1Bitmap1;

/// Everything the renderer needs that is not in the wheel's own state.
pub struct Frame<'a> {
    pub config: &'a UiConfig,
    /// Extracted app icons, by `custom_icon_url` reference. Absent means the glyph is drawn.
    pub icons: &'a dyn IconSource2,
    pub shadows: &'a ShadowCache,
    /// Where the pointer is, in client pixels, for hover states on the gear and the docks.
    pub pointer: Option<(f32, f32)>,
    /// Whether the primary button is held, for the volume bar's drag.
    pub pointer_down: bool,
    /// The live system readings the status dock displays.
    pub status: crate::sys::status::Status,
    /// An update has been downloaded and is waiting on a restart.
    pub update_ready: bool,
    /// Whether the Start Menu scan is still to come, so an empty wheel can say why.
    pub discovering: bool,
    /// Whether the first-time direction-mode hint should be showing.
    pub direction_hint: bool,
    /// Whether to wipe the surface before drawing.
    ///
    /// True for the overlay, which owns its window and whose per-pixel-alpha surface holds the
    /// last frame until something clears it. False for the settings preview, which draws INTO a
    /// panel that has already painted a stand-in desktop under the wheel — a clear there takes
    /// the desktop with it, and leaves a transparent hole the size of the picture.
    pub clear_first: bool,
}

/// How the renderer asks for a bitmap icon.
///
/// A trait rather than a map, so the extraction pipeline can own its own cache and its own
/// threading without the renderer knowing about either. The renderer's only requirement is that
/// this never BLOCKS: it is called a dozen times per frame on the thread that also services the
/// mouse hook, so a cache miss returns `None` and the glyph is drawn until the real icon arrives.
pub trait IconSource2 {
    fn bitmap(&self, reference: &str) -> Option<ID2D1Bitmap1>;
    /// Whether this reference is being fetched, so a tile can show a wait rather than a wrong icon.
    fn pending(&self, reference: &str) -> bool;
}

/// An icon source that has nothing, for the first frames and for tests.
pub struct NoIcons;

impl IconSource2 for NoIcons {
    fn bitmap(&self, _reference: &str) -> Option<ID2D1Bitmap1> {
        None
    }
    fn pending(&self, _reference: &str) -> bool {
        false
    }
}

/// Build anything that cannot be built inside a frame.
///
/// Baking a shadow re-targets the device context, and a nested `BeginDraw` on one context is
/// invalid — so every shadow the frame will ask for is produced here, BEFORE the frame opens. The
/// caches make this free after the first frame at a given size; it costs something again only when
/// the icon-size slider moves or the wheel lands on a monitor with a different scale factor.
pub fn prebake(p: &Painter, wheel: &Wheel, frame: &Frame) {
    let s = wheel.scale;
    for (size, radius, blur, colour) in shadow_specs(wheel, frame.config, s) {
        frame.shadows.bake_rounded(p.gpu, size, radius, blur, colour);
    }
}

/// Every shadow a frame can ask for, at its NOMINAL size.
///
/// Nominal, because a tile is drawn scaled — by the bloom on the way in, and by 1.06 when it is
/// aimed at — and baking one bitmap per scale would be a blur per frame of every animation. The
/// baked bitmap is stretched to the drawn size instead, which also scales the blur with it: a
/// bigger tile wants a bigger shadow, so the stretch is the correct answer rather than an
/// approximation of one.
fn shadow_specs(
    wheel: &Wheel,
    config: &UiConfig,
    s: f32,
) -> [((f32, f32), f32, f32, D2D1_COLOR_F); 5] {
    let l = wheel.layout();
    let hub = wheel.hub_diameter();
    // The peek's tiles are smaller than the picker's, so they are a size of their own. With no
    // peek up this repeats the ring's spec, which the cache answers from what it already holds —
    // asking for it unconditionally is cheaper than branching on a state that can change between
    // the bake and the draw.
    let peek = wheel
        .peek_shape(config)
        .map(|shape| shape.icon_size)
        .unwrap_or(l.icon_size);
    [
        // The idle tile, and the aimed one — which has a larger, softer shadow, and the highlight
        // can move to any tile without warning.
        (
            (l.icon_size, l.icon_size),
            pal::tile_radius(l.icon_size / s) * s,
            pal::TILE_SHADOW_BLUR * s,
            pal::TILE_SHADOW,
        ),
        (
            (l.icon_size, l.icon_size),
            pal::tile_radius(l.icon_size / s) * s,
            pal::TILE_SHADOW_BLUR_ACTIVE * s,
            pal::TILE_SHADOW_ACTIVE,
        ),
        ((hub, hub), hub / 2.0, 10.0 * s, pal::HUB_SHADOW),
        (
            (peek, peek),
            pal::tile_radius(peek / s) * s,
            pal::TILE_SHADOW_BLUR * s,
            pal::TILE_SHADOW,
        ),
        (
            (peek, peek),
            pal::tile_radius(peek / s) * s,
            pal::TILE_SHADOW_BLUR_ACTIVE * s,
            pal::TILE_SHADOW_ACTIVE,
        ),
    ]
}

/// Draw one frame, and return what on it can be pressed.
///
/// Only the corner furniture produces targets. The wheel's own slices do not: their hit testing is
/// `aim::resolve`, which resolves from the LIVE pointer rather than from anything a frame left
/// behind — see the comment on it for why those cannot be the same mechanism.
pub fn draw(p: &Painter, wheel: &Wheel, frame: &Frame) -> Vec<super::docks::Target> {
    if frame.clear_first {
        p.clear();
    }
    p.antialias_on();

    let config = frame.config;
    let hover = pal::rgb(config.hover_color());
    let hover_text = pal::rgb(config::readable_foreground(config.hover_color()));
    let bloom = wheel.bloom();
    let items = wheel.items();

    draw_scrim(p, wheel, config);

    // 1. ORDER: the wedges go under the tiles. They are a lit region of the desktop, and a tile is
    //    an object sitting on it — drawn over, the wedge's edge gradient crosses the plate.
    if config.area_wedges() && items.len() > 1 {
        draw_wedges(p, wheel, config, items.len(), hover);
    }

    // 2. ORDER: the hub goes under the tiles but over the wedges. On a crowded wheel the innermost
    //    corner of a tile can reach the hub's circle, and the tile is the thing that must win —
    //    it is the target.
    draw_hub(p, wheel, config, frame, bloom, hover, hover_text);

    for (index, item) in items.iter().enumerate() {
        draw_tile(p, wheel, frame, index, item, items.len(), hover, hover_text);
    }

    // 3. ORDER: the peeked workspace's shortcuts over the picker's own tiles. They sit outside the
    //    ring, so there is barely anything to overlap — but what little there is belongs to the
    //    ring that the aim is currently out on, which is the one the hand is reading.
    draw_peek(p, wheel, frame, hover, hover_text);

    // 4. ORDER: labels last, over every tile. A label hangs outside the ring and a dense wheel puts
    //    it across the neighbouring slice; drawn per tile it would be painted over by the next one.
    if config.show_labels {
        for (index, item) in items.iter().enumerate() {
            draw_label(p, wheel, config, index, item, items.len(), hover, hover_text);
        }
        draw_peek_labels(p, wheel, config, hover, hover_text);
    }

    if config.show_pill() {
        draw_pill(p, wheel, config);
    }
    if !wheel.filter().is_empty() {
        draw_filter(p, wheel, items.len());
    } else if items.is_empty() {
        draw_empty_notice(p, wheel, frame);
    } else if frame.direction_hint {
        // Where the filter pill goes, because it is the same kind of thing: one line about what
        // the wheel is doing, in the one place above it that nothing else uses.
        draw_direction_hint(p, wheel, &config.language);
    }

    // 5. ORDER: the corner furniture last, over everything. It is the only thing on screen that
    //    sits outside the wheel, and a label pill from a slice near an edge would otherwise paint
    //    across it.
    super::docks::draw(
        p,
        wheel,
        &super::docks::DockFrame {
            config,
            status: frame.status,
            pointer: frame.pointer,
            down: frame.pointer_down,
            icons: frame.icons,
        },
    )
}

// ─── The scrim ──────────────────────────────────────────────────────────────

fn draw_scrim(p: &Painter, wheel: &Wheel, config: &UiConfig) {
    let fade = wheel.scrim_bloom();
    if fade <= 0.001 {
        return;
    }
    let client = Rect::new(0.0, 0.0, wheel.viewport.0, wheel.viewport.1);
    let stops: Vec<Stop> = scrim::gradient_stops(config.backdrop_opacity)
        .into_iter()
        .map(|(offset, alpha)| Stop {
            offset,
            color: pal::rgba(pal::SCRIM, alpha * fade),
        })
        .collect();

    // Twice the backdrop radius, which is where the lit section of the wheel ends. That is what
    // puts the falloff's visible part ACROSS the ring rather than inside it, and it is the same
    // number the wedges fade against — the two have to agree, or the highlight stops somewhere the
    // dimming does not.
    //
    // Past the last stop a clamped gradient holds its colour, so the `floor` alpha is what the rest
    // of the window gets. That is exactly the behaviour `needs_full_bleed` tests for.
    let radius = wheel.backdrop_radius(config) * 2.0;
    match p.radial_brush(wheel.center, radius, &stops) {
        Some(brush) => p.fill_rect_with(client, &brush),
        // A gradient that cannot be built would leave the desktop undimmed and the wheel floating
        // on it. A flat fill at the peak alpha is wrong but legible; nothing is neither.
        None => {
            let (peak, _) = scrim::alphas(config.backdrop_opacity);
            p.fill_rect(client, pal::rgba(pal::SCRIM, peak * fade));
        }
    }
}

// ─── The wedges ─────────────────────────────────────────────────────────────

/// Area targeting, drawn: the same aim, with the division painted.
///
/// Two conditions decide whether this runs and they are different questions. The MODE says the
/// target is a share of the plane; the SWITCH says whether that share is shown. With the switch off
/// the wheel aims identically and paints nothing, which is what targeting by direction has always
/// looked like and is still the default.
fn draw_wedges(p: &Painter, wheel: &Wheel, config: &UiConfig, count: usize, hover: D2D1_COLOR_F) {
    let fade = wheel.bloom();
    if fade <= 0.001 {
        return;
    }
    let inner = wheel.sector_inner_radius(config);
    let outer = wheel.sector_outer_radius();
    // A ring has to have a ring's shape. A large activation zone on a small wheel can push the dead
    // zone past where the wedges are allowed to end, and an annulus with its radii the wrong way
    // round does not draw a smaller ring — it draws an inside-out path. There is no area to show in
    // that configuration, so nothing is shown.
    if outer <= inner + 8.0 {
        return;
    }

    let inner_stop = inner / outer;
    // The hold ends at the scrim pool's edge, comfortably past the icon ring: everything inside it
    // is the lit section, everything outside is the wedge saying goodbye.
    let falloff = wheel.backdrop_radius(config) / outer;
    let falloff_stop = falloff.max(inner_stop + 0.02).min(0.9);
    let lean = sectors::beam_lean(count);

    // The seams are on from the moment the wheel opens — that is the whole point of the mode.
    // Faint, though: they answer "where does this one end", which the user asks once and never
    // again, and furniture that had to shout would be worse than none.
    //
    // Drawn BEFORE the lit wedge so the wedge does not paint over its own boundaries... except the
    // original draws them after, for exactly the opposite reason: so the lit one does not paint
    // over them. The seams are the weaker mark, so they go last.
    let seam_end = outer * sectors::SEAM_REACH;

    if let Some(active) = wheel.active() {
        let (start, end) = sectors::bounds_deg(active, count);
        let beam_alphas = sectors::beam_alphas(sectors::FILL_ALPHA, count);
        let edge_alphas = sectors::beam_alphas(sectors::EDGE_ALPHA, count);
        let centre = sectors::centre_deg(active, count);

        // The reach, as an opacity mask over the wedge: it depends on nothing but the distance from
        // the hub, so it is zero on the entire rim at once — which is what lets the beam lean
        // without ever leaving alpha standing where the window cuts.
        let reach: Vec<Stop> = sectors::reach_stops(inner_stop, falloff_stop, lean)
            .into_iter()
            .map(|s| Stop {
                offset: s.offset,
                color: pal::rgba(pal::WHITE, s.opacity),
            })
            .collect();
        let beam: Vec<Stop> = sectors::beam_stops(
            inner_stop,
            falloff_stop,
            beam_alphas.0,
            beam_alphas.1,
            lean,
        )
        .into_iter()
        .map(|s| Stop {
            offset: s.offset,
            color: pal::rgba(config.hover_color(), s.opacity * fade),
        })
        .collect();
        let edge: Vec<Stop> = sectors::beam_stops(
            inner_stop,
            falloff_stop,
            edge_alphas.0,
            edge_alphas.1,
            lean,
        )
        .into_iter()
        .map(|s| Stop {
            offset: s.offset,
            color: pal::rgba(config.hover_color(), s.opacity * fade),
        })
        .collect();

        let far = polar(wheel.center, outer, centre);
        if std::env::var_os("ROVYL_TRACE_WEDGE").is_some() {
            println!(
                "wedge: inner={inner:.1} outer={outer:.1} inner_stop={inner_stop:.3}                  falloff_stop={falloff_stop:.3} lean={lean:.3} fade={fade:.3}"
            );
            for (name, stops) in [("reach", &reach), ("beam", &beam)] {
                let shown: Vec<String> = stops
                    .iter()
                    .map(|s| format!("{:.2}:{:.3}", s.offset, s.color.a))
                    .collect();
                println!("  {name}: {}", shown.join(" "));
            }
        }
        if let (Some(reach_brush), Some(beam_brush), Some(edge_brush)) = (
            p.radial_brush(wheel.center, outer, &reach),
            p.linear_brush(wheel.center, far, &beam),
            p.linear_brush(wheel.center, far, &edge),
        ) {
            p.wedge(
                wheel.center,
                inner,
                outer,
                start,
                end,
                &beam_brush,
                &edge_brush,
                Some(&reach_brush),
                1.25,
                count == 1,
            );
        }
        let _ = hover;
    }

    // One seam per wedge — each item's opening edge; the closing one is its neighbour's.
    let seam: Vec<Stop> = sectors::gradient_stops(
        inner_stop / sectors::SEAM_REACH,
        ((falloff * sectors::SEAM_FALLOFF_SCALE) / sectors::SEAM_REACH)
            .max(inner_stop / sectors::SEAM_REACH + 0.02)
            .min(0.9),
        sectors::SEAM_ALPHA.0,
        sectors::SEAM_ALPHA.1,
    )
    .into_iter()
    .map(|s| Stop {
        offset: s.offset,
        // White rather than the hover colour: the seams belong to the wheel and not to the
        // selection, and they are on before anything is aimed at.
        color: pal::rgba(pal::WHITE, s.opacity * fade),
    })
    .collect();

    for index in 0..count {
        let (start, _) = sectors::bounds_deg(index, count);
        let near = polar(wheel.center, inner, start);
        let far = polar(wheel.center, seam_end, start);
        if let Some(brush) = p.linear_brush(wheel.center, far, &seam) {
            p.line_with(near, far, &brush, 1.0);
        }
    }
}

fn polar(center: (f32, f32), radius: f32, deg: f32) -> (f32, f32) {
    let rad = deg * PI / 180.0;
    (
        center.0 + radius * rad.cos(),
        center.1 + radius * rad.sin(),
    )
}

// ─── Tiles ──────────────────────────────────────────────────────────────────

fn draw_tile(
    p: &Painter,
    wheel: &Wheel,
    frame: &Frame,
    index: usize,
    item: &AppItem,
    count: usize,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    let config = frame.config;
    let l = wheel.layout();
    let bloom = wheel.bloom();
    let echo = wheel.echo();

    // During the echo the highlight is the CONFIRMED TARGET, not the aim. The two diverge: the
    // pointer goes on producing events over a wheel that is already leaving, and one of them used
    // to swap the tile's colour halfway through the wave — the confirmed icon lost the highlight
    // and an invisible neighbour got it.
    let is_active = match echo {
        Some((fired, _)) => fired == Some(index),
        None => wheel.active() == Some(index),
    };
    let is_faded = matches!(echo, Some((fired, _)) if fired != Some(index));

    let distance = aim::angular_distance(index, wheel.active(), count);
    let (presence_opacity, presence_scale) = layout::slice_presence(distance);

    let angle = sectors::centre_deg(index, count);
    let target = polar(wheel.center, l.radius, angle);

    // The tiles mount collapsed at the hub and expand from there: the open reads as a bloom out of
    // the point the gesture happened at, not as a ring fading in.
    let travel = bloom;
    let scale_now = if is_active && echo.is_some() {
        // The confirmed one stays FIXED at the point it was already at — moving it would ask the
        // eye to follow it at the exact moment it has to identify it.
        layout::FIRED_SLICE_SCALE
    } else if is_faded {
        presence_scale * 0.88
    } else {
        0.2 + (presence_scale - 0.2) * travel
    };
    let center = (
        wheel.center.0 + (target.0 - wheel.center.0) * travel,
        wheel.center.1 + (target.1 - wheel.center.1) * travel,
    );

    let echo_fade = match echo {
        Some((fired, progress)) if fired == Some(index) => 1.0,
        Some((_, progress)) => (1.0 - progress * 2.0).max(0.0),
        None => 1.0,
    };
    let opacity = presence_opacity * travel * echo_fade;
    if opacity <= 0.004 {
        return;
    }

    let (plate, radius) = paint_tile(
        p,
        wheel,
        frame,
        item,
        center,
        l.icon_size * scale_now,
        l.icon_size,
        is_active,
        opacity,
        hover,
        hover_text,
    );

    // The number badge, top-left — because bottom-right is the folder badge's and the two would sit
    // on top of each other on any folder in the first nine positions.
    //
    // It carries the tile's own plate and border rather than floating glyph-on-wallpaper: the wheel
    // opens over a desktop nobody controls, and a bare digit disappears on a light one.
    if config.number_badges() && index < 9 {
        draw_number_badge(p, wheel, plate, index + 1, is_active, hover, hover_text, opacity);
    }

    // The sustained-aim arc. It runs OUTSIDE the plate, so nothing of it is lost behind the tile.
    if let Some((arc_index, elapsed, _attempt)) = wheel.dwell_arc() {
        if arc_index == index && dwell::arc_worth_drawing(config.dwell_ms()) {
            draw_dwell_arc(p, wheel, plate, radius, elapsed, config, hover, opacity);
        }
    }

    // The launch wave: two offset rings, not one. A single ring reads as an outline that grew; two
    // read as something that CAME OUT of the icon. The second leaves halfway through the first,
    // which is the gap in which the eye is still following the first and gets continuity rather
    // than repetition.
    if let Some((fired, progress)) = echo {
        if fired == Some(index) {
            draw_launch_wave(p, wheel, plate, radius, progress, hover);
        }
    }
}

/// The tile itself: shadow, plate, outlines, art, folder badge. Returns the plate and its corner
/// radius, for whatever the caller hangs on it.
///
/// One function, because the picker's ring and a peeked workspace's ring draw the same OBJECT at
/// different places and sizes. Two copies of this would mean two tile appearances on one wheel,
/// drifting apart a highlight colour at a time — and the peek exists to show what a workspace
/// holds, which only works if its icons look like the icons it is showing.
///
/// `nominal` is the unscaled tile size: the drop shadow is baked at that size and stretched, so a
/// tile mid-bloom gets a shadow that grows with it rather than one blur per frame.
#[allow(clippy::too_many_arguments)]
fn paint_tile(
    p: &Painter,
    wheel: &Wheel,
    frame: &Frame,
    item: &AppItem,
    center: (f32, f32),
    size: f32,
    nominal: f32,
    is_active: bool,
    opacity: f32,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) -> (Rect, f32) {
    let config = frame.config;
    let radius = pal::tile_radius(size / wheel.scale) * wheel.scale;
    let plate = Rect::centred(center.0, center.1, size, size);
    let scale_now = if nominal > 0.0 { size / nominal } else { 1.0 };

    // The soft drop shadow, baked at the nominal size and stretched to the drawn one. One light
    // source for the whole wheel, from above.
    let (shadow_offset, shadow_blur) = if is_active {
        (
            pal::TILE_SHADOW_OFFSET_ACTIVE * wheel.scale,
            pal::TILE_SHADOW_BLUR_ACTIVE * wheel.scale,
        )
    } else {
        (
            pal::TILE_SHADOW_OFFSET * wheel.scale,
            pal::TILE_SHADOW_BLUR * wheel.scale,
        )
    };
    if let Some((bitmap, padding)) = frame.shadows.rounded(
        (nominal, nominal),
        pal::tile_radius(nominal / wheel.scale) * wheel.scale,
        shadow_blur,
    ) {
        // The padding scales with the tile, so the blur grows with it rather than staying a fixed
        // number of pixels around a shape that changed size.
        let grown = padding * (size / nominal);
        p.bitmap(
            plate.inflate(grown).offset(0.0, shadow_offset * scale_now),
            &bitmap,
            opacity,
        );
    }

    // The active tile's glow: a wash of the hover colour outside the plate, which is what the
    // original's `0 0 22px <hover>38` does. Drawn before the plate so it reads as light coming off
    // the tile rather than as a ring around it.
    if is_active {
        let glow = pal::rgba(config.hover_color(), 0.22 * opacity);
        p.stroke_round_rect(
            plate.inflate(2.5 * wheel.scale),
            radius + 2.5 * wheel.scale,
            glow,
            4.0 * wheel.scale,
        );
    }

    // The outer dark ring, then the plate, then the light border: a double outline, so the tile
    // separates itself from the desktop on a light background (the ring reads) and on a dark one
    // (the border does) without depending on the global scrim.
    let ring = if is_active {
        pal::TILE_RING_ACTIVE
    } else {
        pal::TILE_RING
    };
    p.stroke_round_rect(
        plate.inflate(0.5),
        radius + 0.5,
        fade(ring, opacity),
        1.0,
    );

    let plate_colour = if is_active {
        hover
    } else {
        pal::tile_plate(config.backdrop_opacity)
    };
    p.fill_round_rect(plate, radius, fade(plate_colour, opacity));

    let border = if is_active {
        hover
    } else {
        pal::tile_border(config.backdrop_opacity)
    };
    p.stroke_round_rect(
        plate.inflate(-0.5),
        radius - 0.5,
        fade(border, opacity),
        1.0,
    );

    if !is_active {
        // The inset highlight along the top edge only. A full inset ring would read as a bevel.
        p.line(
            (plate.left + radius * 0.6, plate.top + 0.5),
            (plate.right - radius * 0.6, plate.top + 0.5),
            fade(pal::TILE_INSET_LIGHT, opacity),
            1.0,
        );
    }

    // The icon. A bitmap Rovyl extracted, or the glyph.
    let content_colour = if is_active { hover_text } else { pal::rgb(pal::WHITE) };
    draw_item_art(p, frame, item, center, size, opacity, content_colour, radius);

    if item.is_folder() {
        draw_folder_badge(p, wheel, plate, opacity);
    }

    (plate, radius)
}

fn draw_item_art(
    p: &Painter,
    frame: &Frame,
    item: &AppItem,
    center: (f32, f32),
    size: f32,
    opacity: f32,
    colour: D2D1_COLOR_F,
    radius: f32,
) {
    // A bitmap icon fills most of the tile; a glyph is drawn much smaller, because a stroked
    // outline at the same size as a full-colour app icon reads as oversized.
    if let Some(reference) = item.custom_icon_url.as_deref() {
        if let Some(bitmap) = frame.icons.bitmap(reference) {
            // 0.88 of the tile, which is the reference scale the original's `SmartIcon` uses: an
            // extracted icon usually has its own margin, and filling the plate edge to edge makes
            // the ones that do not look cropped.
            let art = size * 0.88;
            p.bitmap_rounded(
                Rect::centred(center.0, center.1, art, art),
                &bitmap,
                opacity,
                radius,
            );
            return;
        }
        // Unresolved: a native item with a command but still no image. It happens right after a
        // restore or the first discovery, while the extractor works — and a generic glyph at that
        // moment looks like a WRONG icon, not a missing one.
        if frame.icons.pending(reference) {
            draw_spinner(p, center, size * 0.3, opacity);
            return;
        }
    }

    let glyph = if item.icon_name.is_empty() {
        crate::gfx::lucide::FALLBACK
    } else {
        &item.icon_name
    };
    // A monochrome glyph has no colour of its own holding it up: legibility comes entirely from the
    // stroke, so it is heavier than an app icon's, which arrives with its own shape and colour.
    p.glyph(glyph, center, size * 0.55, fade(colour, opacity), 1.75);
}

fn draw_spinner(p: &Painter, center: (f32, f32), size: f32, opacity: f32) {
    // A wait is said with an indicator, not with an icon that is not the app's. Static rather than
    // spinning: the extraction is fast enough that a rotation would be a flicker, and a frame
    // clock running for an icon is a frame clock running while the wheel is otherwise still.
    p.stroke_circle(
        center,
        size / 2.0,
        fade(pal::rgba(pal::WHITE, 0.15), opacity),
        2.0,
    );
    p.stroke_circle(
        center,
        size / 2.0,
        fade(pal::rgba(pal::WHITE, 0.55), opacity),
        2.0,
    );
}

fn draw_number_badge(
    p: &Painter,
    wheel: &Wheel,
    plate: Rect,
    digit: usize,
    is_active: bool,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
    opacity: f32,
) {
    let s = wheel.scale;
    let size = 18.0 * s;
    let at = (plate.left + 2.0 * s, plate.top + 2.0 * s);
    let badge = Rect::centred(at.0, at.1, size, size);
    let (fill, border, text) = if is_active {
        (hover, hover, hover_text)
    } else {
        (pal::BADGE_PLATE, pal::BADGE_BORDER, pal::BADGE_TEXT)
    };
    p.stroke_round_rect(badge.inflate(0.5), size / 2.0, fade(pal::TILE_RING, opacity), 1.0);
    p.fill_round_rect(badge, size / 2.0, fade(fill, opacity));
    p.stroke_round_rect(badge.inflate(-0.5), size / 2.0, fade(border, opacity), 1.0);

    let style = Style::new(Family::Radial, 11.0 * s, 600, Align::Center).tracking(-0.01);
    let label = digit.to_string();
    let (_, height) = p.measure(&label, &style);
    p.text(
        &label,
        Rect::new(badge.left, at.1 - height / 2.0, badge.right, badge.bottom),
        &style,
        fade(text, opacity),
    );
}

fn draw_folder_badge(p: &Painter, wheel: &Wheel, plate: Rect, opacity: f32) {
    let s = wheel.scale;
    let size = 20.0 * s;
    let at = (plate.right - 2.0 * s, plate.bottom - 2.0 * s);
    // Ringed in the wheel's own dark so it reads as sitting ON the tile rather than in it.
    p.fill_circle(at, size / 2.0, fade(pal::FOLDER_BADGE_RING, opacity));
    p.fill_circle(at, size / 2.0 - 2.0 * s, fade(pal::FOLDER_BADGE, opacity));
    let dot = 2.0 * s;
    p.fill_circle((at.0 - dot * 1.2, at.1), dot / 2.0, fade(pal::FOLDER_BADGE_DOT, opacity));
    p.fill_circle((at.0 + dot * 1.2, at.1), dot / 2.0, fade(pal::FOLDER_BADGE_DOT, opacity));
}

fn draw_dwell_arc(
    p: &Painter,
    wheel: &Wheel,
    plate: Rect,
    radius: f32,
    elapsed_ms: f32,
    config: &UiConfig,
    hover: D2D1_COLOR_F,
    opacity: f32,
) {
    let s = wheel.scale;
    // Concentric with the tile. What has to be concentric is the stroke's CENTRE LINE, not its
    // outer edge: the rect is inset by half the stroke, so the centre line runs that far outside
    // the plate and the right radius is the tile's plus that inset.
    let inset = 7.0 * s - pal::DWELL_TRACK_WIDTH * s / 2.0;
    let ring = plate.inflate(inset);
    let ring_radius = radius + inset;

    p.stroke_round_rect(ring, ring_radius, fade(pal::DWELL_CASING, opacity), pal::DWELL_CASING_WIDTH * s);
    p.stroke_round_rect(ring, ring_radius, fade(pal::DWELL_TRACK, opacity), pal::DWELL_TRACK_WIDTH * s);

    let progress = (elapsed_ms / config.dwell_ms().max(1.0)).clamp(0.0, 1.0);
    // The arc starts at top-centre. A rounded rect's implicit path begins after the top-left
    // corner, so an un-rotated sweep filled from an offset that moved with the icon size — and a
    // clock that does not start at twelve reads as a bug.
    p.round_rect_arc(
        ring,
        ring_radius,
        progress,
        fade(hover, opacity),
        pal::DWELL_TRACK_WIDTH * s,
    );
}

fn draw_launch_wave(
    p: &Painter,
    wheel: &Wheel,
    plate: Rect,
    radius: f32,
    progress: f32,
    hover: D2D1_COLOR_F,
) {
    let s = wheel.scale;
    for (phase, delay) in [(0.0f32, 0.0f32), (1.0, 0.5)] {
        let _ = phase;
        let local = ((progress - delay) / (1.0 - delay)).clamp(0.0, 1.0);
        if local <= 0.0 || local >= 1.0 {
            continue;
        }
        // Born with the TILE's shape, not as a circle: it comes out of the silhouette of the icon
        // the user just aimed at, and it is that continuity that makes it read as "this came from
        // here" rather than as an effect pasted on top. As it grows the radius grows with it, so
        // the shape opens into an ever rounder square.
        let grow = 1.0 + local * 0.6;
        let size = (plate.width() + 6.0 * s) * grow;
        let alpha = (1.0 - local) * 0.8;
        let (cx, cy) = plate.center();
        p.stroke_round_rect(
            Rect::centred(cx, cy, size, size),
            (radius + 3.0 * s) * grow,
            fade(hover, alpha),
            2.0 * s,
        );
    }
}

// ─── Labels ─────────────────────────────────────────────────────────────────

fn draw_label(
    p: &Painter,
    wheel: &Wheel,
    config: &UiConfig,
    index: usize,
    item: &AppItem,
    count: usize,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    if item.label.is_empty() {
        return;
    }
    // A peeked workspace does not wear its own pill. The fan is the information now, and the pill
    // hangs OUTSIDE the tile — straight into the arc of shortcuts it just opened. This also holds
    // with "always show labels" on, which is the point: the label would be across the fan.
    //
    // An EMPTY workspace is peeked like any other and draws nothing, so it keeps its label: taking
    // it away there would leave an unnamed slice saying nothing at all.
    let fanned = wheel
        .peek_items()
        .filter(|(_, items, _)| !items.is_empty())
        .map(|(slice, _, _)| slice);
    if fanned == Some(index) {
        return;
    }
    let bloom = wheel.bloom();
    let echo = wheel.echo();
    let is_active = match echo {
        Some((fired, _)) => fired == Some(index),
        None => wheel.active() == Some(index),
    };
    let always = config.always_show_app_labels;

    // The label's plate has its own background too: dimming it to 0.72 faded the TEXT, not the
    // highlight. So an unaimed label is either fully present or not drawn at all.
    let base_opacity = if always {
        if is_active { 1.0 } else { 0.9 }
    } else if is_active {
        1.0
    } else {
        0.0
    };
    let echo_fade = match echo {
        Some((fired, progress)) if fired == Some(index) => (1.0 - progress).max(0.0),
        Some((_, progress)) => (1.0 - progress * 2.0).max(0.0),
        None => 1.0,
    };
    let opacity = base_opacity * bloom * echo_fade;
    if opacity <= 0.01 {
        return;
    }

    let l = wheel.layout();
    let angle = sectors::centre_deg(index, count);
    let tile = polar(wheel.center, l.radius * bloom, angle);
    // The chip: a workspace's own key, which was previously invisible. Read from the WORKSPACE and
    // not from the slice — the id holds the real index, and since a key can be recorded, the digit
    // that position would have had is no longer necessarily the key that switches to it.
    let chip = workspace_chip(config, item);
    paint_label(
        p,
        wheel,
        &item.label,
        chip.as_deref(),
        tile,
        angle,
        l.icon_size,
        is_active,
        always,
        opacity,
        hover,
        hover_text,
    );
}

/// One label pill, drawn beside a tile. Shared by the picker's ring and a peeked workspace's.
///
/// `grown` is whether the pill is one of the always-on ones: an idle label that is always present
/// sits very slightly smaller than the aimed one, which is the whole of its idle state — never
/// alpha, which would take the plate with it.
#[allow(clippy::too_many_arguments)]
fn paint_label(
    p: &Painter,
    wheel: &Wheel,
    label: &str,
    chip: Option<&str>,
    tile: (f32, f32),
    angle: f32,
    icon_size: f32,
    is_active: bool,
    always: bool,
    opacity: f32,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    let s = wheel.scale;
    let ((dx, dy), (anchor_x, anchor_y)) = layout::label_placement(angle, icon_size);

    let style = Style::new(Family::Radial, 12.0 * s, 500, Align::Leading).tracking(-0.005);
    let (text_w, text_h) = p.measure(label, &style);
    let chip_style = Style::new(Family::Radial, 10.0 * s, 500, Align::Center);
    let chip_w = chip
        .map(|c| p.measure(c, &chip_style).0 + 10.0 * s)
        .unwrap_or(0.0);

    let pad_left = 12.0 * s;
    let pad_right = if chip.is_some() { 8.0 * s } else { 12.0 * s };
    let gap = if chip.is_some() { 6.0 * s } else { 0.0 };
    let pill_w = pad_left + text_w + gap + chip_w + pad_right;
    let pill_h = text_h.max(14.0 * s) + 12.0 * s;

    let scale = if always {
        if is_active { 1.0 } else { 0.94 }
    } else if is_active {
        1.0
    } else {
        0.9
    };
    let (w, h) = (pill_w * scale, pill_h * scale);
    let left = tile.0 + dx * s + anchor_x * w;
    let top = tile.1 + dy * s + anchor_y * h;
    let pill = Rect::new(left, top, left + w, top + h);

    let (plate, border, text_colour) = if is_active {
        (hover, hover, hover_text)
    } else {
        (pal::LABEL_PLATE, pal::LABEL_BORDER, pal::LABEL_TEXT)
    };
    p.stroke_round_rect(pill.inflate(0.5), h / 2.0, fade(pal::LABEL_RING, opacity), 1.0);
    p.fill_round_rect(pill, h / 2.0, fade(plate, opacity));
    p.stroke_round_rect(pill.inflate(-0.5), h / 2.0, fade(border, opacity), 1.0);

    let text_top = pill.top + (h - text_h * scale) / 2.0;
    p.text(
        label,
        Rect::new(pill.left + pad_left * scale, text_top, pill.right, pill.bottom),
        &style,
        fade(text_colour, opacity),
    );

    if let Some(chip) = chip {
        let chip_h = 16.0 * s * scale;
        let chip_left = pill.right - pad_right * scale - chip_w * scale;
        let chip_rect = Rect::new(
            chip_left,
            pill.top + (h - chip_h) / 2.0,
            chip_left + chip_w * scale,
            pill.top + (h + chip_h) / 2.0,
        );
        let chip_plate = if is_active {
            // Over the hover colour, the chip's own wash has to come from whichever side reads:
            // a light hover takes a dark chip and a dark one takes a light chip.
            if hover_text.r < 0.5 {
                pal::rgba(pal::BLACK, 0.08)
            } else {
                pal::rgba(pal::WHITE, 0.14)
            }
        } else {
            pal::CHIP_PLATE
        };
        p.fill_round_rect(chip_rect, pal::R_CHIP * s * 0.85, fade(chip_plate, opacity));
        let (_, ch) = p.measure(chip, &chip_style);
        p.text(
            chip,
            Rect::new(
                chip_rect.left,
                chip_rect.top + (chip_h - ch) / 2.0,
                chip_rect.right,
                chip_rect.bottom,
            ),
            &chip_style,
            fade(if is_active { hover_text } else { pal::CHIP_TEXT }, opacity),
        );
    }
}

/// One number per slice, and it is the one that does something.
///
/// The label's chip is the WORKSPACE's own hotkey; the tile's badge is the slice's POSITION. They
/// are not the same count — a disabled workspace is skipped by the picker but keeps its hotkey — so
/// on a wheel where the two disagree, showing both puts two different digits on one tile and only
/// the badge's is the key being pressed. The badge therefore wins, and this returns `None` whenever
/// numbers are on.
fn workspace_chip(config: &UiConfig, item: &AppItem) -> Option<String> {
    if config.number_badges() {
        return None;
    }
    if !is_workspace_pick(&item.id) {
        return None;
    }
    let index = workspace_pick_index(&item.id)?;
    let workspace = config.workspaces.get(index)?;
    let key = config::workspace_key_at(workspace, index);
    (!key.is_empty()).then_some(key)
}

// ─── The peek ───────────────────────────────────────────────────────────────

/// A peeked workspace's shortcuts, on their own ring outside the picker.
///
/// The tiles bloom out of the WORKSPACE, not out of the hub, and that is the one thing this draws
/// differently from the picker's ring. The hub is where a level comes from; a peek is not a level —
/// it belongs to the slice the hand is resting on, and coming out of that slice is what says so.
fn draw_peek(
    p: &Painter,
    wheel: &Wheel,
    frame: &Frame,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    let Some(shape) = wheel.peek_shape(frame.config) else {
        return;
    };
    let Some((slice, items, bloom)) = wheel.peek_items() else {
        return;
    };

    let from = peek_origin(wheel, slice);
    let echo = wheel.echo();
    let fired = wheel.peek_echo();

    for (index, item) in items.iter().enumerate().take(shape.count) {
        let Some((center, size, opacity, is_active)) =
            peek_tile_geometry(wheel, &shape, from, bloom, index, echo, fired)
        else {
            continue;
        };
        let (plate, radius) = paint_tile(
            p,
            wheel,
            frame,
            item,
            center,
            size,
            shape.icon_size,
            is_active,
            opacity,
            hover,
            hover_text,
        );
        if let Some((fired_index, progress)) = fired {
            if fired_index == index {
                draw_launch_wave(p, wheel, plate, radius, progress, hover);
            }
        }
    }
}

/// The same ring's labels, after every tile on it — the reason given at order note 4.
fn draw_peek_labels(
    p: &Painter,
    wheel: &Wheel,
    config: &UiConfig,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    let Some(shape) = wheel.peek_shape(config) else {
        return;
    };
    let Some((slice, items, bloom)) = wheel.peek_items() else {
        return;
    };

    let from = peek_origin(wheel, slice);
    let echo = wheel.echo();
    let fired = wheel.peek_echo();
    let always = config.always_show_app_labels;

    for (index, item) in items.iter().enumerate().take(shape.count) {
        if item.label.is_empty() {
            continue;
        }
        let Some((center, _, tile_opacity, is_active)) =
            peek_tile_geometry(wheel, &shape, from, bloom, index, echo, fired)
        else {
            continue;
        };
        // An idle label is either fully present or not drawn at all, which is the rule the
        // picker's own labels follow: dimming the pill fades the TEXT, not the highlight.
        let base = if always {
            if is_active {
                1.0
            } else {
                0.9
            }
        } else if is_active {
            1.0
        } else {
            0.0
        };
        let opacity = base * tile_opacity;
        if opacity <= 0.01 {
            continue;
        }
        paint_label(
            p,
            wheel,
            &item.label,
            // No chip: a chip is a workspace's own switch key, and these are shortcuts.
            None,
            center,
            shape.angle_of(index),
            shape.icon_size,
            is_active,
            always,
            opacity,
            hover,
            hover_text,
        );
    }
}

/// Where a peek's tiles travel out from: the workspace's own tile, at the point it is drawn.
fn peek_origin(wheel: &Wheel, slice: usize) -> (f32, f32) {
    let l = wheel.layout();
    let angle = sectors::centre_deg(slice, wheel.item_count());
    polar(wheel.center, l.radius * wheel.bloom(), angle)
}

/// One peeked tile's place, size, opacity and highlight — read by the tile and by its label, so the
/// two cannot disagree about where the pill goes or whether it is lit.
#[allow(clippy::too_many_arguments)]
fn peek_tile_geometry(
    wheel: &Wheel,
    shape: &super::peek::Shape,
    from: (f32, f32),
    bloom: f32,
    index: usize,
    echo: Option<(Option<usize>, f32)>,
    fired: Option<(usize, f32)>,
) -> Option<((f32, f32), f32, f32, bool)> {
    // During the echo the highlight is the CONFIRMED shortcut, not the aim — the same divergence
    // the picker's tiles guard against: the pointer goes on moving over a wheel already leaving.
    let is_active = match fired {
        Some((fired_index, _)) => fired_index == index,
        None => wheel.peek_active() == Some(index),
    };
    // Binary, through the same curve the picker's ring reads: lit, or one of the rest. Distance
    // from the aim is deliberately not a channel here — the fan is already a short arc, and
    // shading it by distance would read as several shortcuts being partly chosen.
    let (presence_opacity, presence_scale) =
        layout::slice_presence(Some(if is_active { 0 } else { 1 }));

    let echo_fade = match (fired, echo) {
        // The one that was launched holds, whatever else the wheel is doing.
        (Some((fired_index, _)), _) if fired_index == index => 1.0,
        // Anything else confirmed on this wheel takes the whole fan with it, at twice the rate —
        // including a launch off the picker itself, which the peek is not part of.
        (_, Some((_, progress))) => (1.0 - progress * 2.0).max(0.0),
        _ => 1.0,
    };

    let scale_now = if is_active && fired.is_some() {
        layout::FIRED_SLICE_SCALE
    } else {
        0.2 + (presence_scale - 0.2) * bloom
    };
    let opacity = presence_opacity * bloom * echo_fade;
    if opacity <= 0.004 {
        return None;
    }

    let target = shape.point_of(wheel.center, index);
    let center = (
        from.0 + (target.0 - from.0) * bloom,
        from.1 + (target.1 - from.1) * bloom,
    );
    Some((center, shape.icon_size * scale_now, opacity, is_active))
}

// ─── The hub ────────────────────────────────────────────────────────────────

fn draw_hub(
    p: &Painter,
    wheel: &Wheel,
    config: &UiConfig,
    frame: &Frame,
    _bloom: f32,
    hover: D2D1_COLOR_F,
    hover_text: D2D1_COLOR_F,
) {
    let grow = wheel.hub_bloom();
    if grow <= 0.001 {
        return;
    }
    let echo = wheel.echo();
    let center_fired = wheel.echo_is_center();
    let active = wheel.center_active();

    // A slice launching fades the hub, just as it fades the other slices: the echo isolates what
    // was chosen, and the hub is the part of the wheel that would compete hardest with it — it is
    // the only other large opaque object on screen.
    let opacity = match echo {
        Some((_, progress)) if !center_fired => (1.0 - progress * 3.0).max(0.0),
        _ => 1.0,
    } * grow;
    if opacity <= 0.004 {
        return;
    }

    let s = wheel.scale;
    let scale = 0.82 + ((if active { 1.06 } else { 1.0 }) - 0.82) * grow;
    let diameter = wheel.hub_diameter() * scale;
    let r = diameter / 2.0;
    let center = wheel.center;

    let nominal = wheel.hub_diameter();
    if let Some((bitmap, padding)) =
        frame
            .shadows
            .rounded((nominal, nominal), nominal / 2.0, 10.0 * s)
    {
        let grown = padding * (diameter / nominal);
        p.bitmap(
            Rect::centred(center.0, center.1 + 4.0 * s, diameter, diameter).inflate(grown),
            &bitmap,
            opacity,
        );
    }

    if active {
        p.fill_circle(center, r + 3.0 * s, fade(pal::rgba(config.hover_color(), 0.24), opacity));
    }

    let fill = if active { hover } else { pal::HUB_FILL };
    p.fill_circle(center, r, fade(fill, opacity));

    // The ring is a stroked circle and not a rounded-rect border, and the difference is visible.
    // A box's border is drawn as four corner arcs stitched around a rectangle, and it is at those
    // seams — and in the fractional width — that the steps and the wobbling thickness show up. One
    // circular path is stroked in a single pass, with coverage computed from the real distance to
    // the arc, the same all the way round.
    let ring = if active { hover } else { pal::HUB_RING };
    p.stroke_circle(
        center,
        r - pal::HUB_RING_WIDTH * s / 2.0,
        fade(ring, opacity),
        pal::HUB_RING_WIDTH * s,
    );

    let glyph_colour = if active { hover_text } else { pal::HUB_GLYPH };
    if wheel.is_root() {
        // The mark's own off-white when idle, the hover's readable foreground when the hub is
        // aimed at. It sits at 0.7 unaimed, which is the one place the product does de-emphasise
        // with alpha — and it is allowed to, because the mark has no plate of its own: it is drawn
        // directly on the hub's disc, so the alpha blends it with a known colour rather than with
        // an unknown desktop.
        let mark = if active { hover_text } else { pal::rgb(pal::LOGO) };
        draw_logo(
            p,
            center,
            (wheel.layout().icon_size * 0.64).round(),
            fade(mark, opacity * if active { 1.0 } else { 0.7 }),
            fade(fill, opacity),
        );
    } else {
        // Inside a folder the centre is the explicit Back control.
        p.glyph(
            "CornerUpLeft",
            (center.0, center.1 - 2.0 * s),
            (wheel.layout().icon_size * 0.45).round(),
            fade(glyph_colour, opacity),
            1.5,
        );
        // One dot per level entered, so the depth is visible without reading the pill.
        if !active {
            let depth = wheel.breadcrumb(config).len();
            let dot = 2.0 * s;
            let span = (depth as f32 - 1.0) * dot * 2.0;
            for i in 0..depth {
                p.fill_circle(
                    (
                        center.0 - span / 2.0 + i as f32 * dot * 2.0,
                        center.1 + r * 0.42,
                    ),
                    dot / 2.0,
                    fade(pal::rgba(pal::WHITE, 0.4), opacity),
                );
            }
        }
    }

    if frame.update_ready {
        draw_update_badge(p, wheel, center, diameter, opacity);
    }

    if center_fired {
        if let Some((_, progress)) = echo {
            // The same wave as a tile's, around the hub — circular, because the hub is circular, so
            // it still comes out of the silhouette of what was confirmed.
            for delay in [0.0f32, 0.5] {
                let local = ((progress - delay) / (1.0 - delay)).clamp(0.0, 1.0);
                if local <= 0.0 || local >= 1.0 {
                    continue;
                }
                p.stroke_circle(
                    center,
                    (r + 3.0 * s) * (1.0 + local * 0.6),
                    fade(hover, (1.0 - local) * 0.8),
                    2.0 * s,
                );
            }
        }
    }
}

/// The Rovyl mark: three destinations arranged around a central hub, the asymmetric upper module
/// and lower diagonals making an abstract "R".
///
/// Drawn from its own geometry rather than from a Lucide glyph, because it is the product's mark
/// and not an icon — and as three rounded bars with the hub punched out of them, which is exactly
/// what the source SVG's mask does.
///
/// `behind` is what the punched centre is filled with. It has to be passed in rather than assumed:
/// the hub is dark when idle and the hover colour when it is aimed at, and a hole filled with the
/// wrong one of those is a dark dot in the middle of a lit button.
fn draw_logo(
    p: &Painter,
    center: (f32, f32),
    size: f32,
    colour: D2D1_COLOR_F,
    behind: D2D1_COLOR_F,
) {
    // The mark is authored in a 512 box; everything below is that box's units scaled to `size`.
    let k = size / 512.0;
    let at = |x: f32, y: f32| (center.0 + (x - 256.0) * k, center.1 + (y - 256.0) * k);

    // Three bars, each a rounded rect rotated about the pivot the source gives it — which happens
    // to be its own centre in all three cases, but is written as the geometry rather than assumed.
    for (x, y, w, h, radius, degrees) in [
        (112.0f32, 104.0f32, 320.0f32, 112.0f32, 50.0f32, 30.0f32),
        (70.0, 286.0, 202.0, 112.0, 48.0, -30.0),
        (267.0, 286.0, 202.0, 112.0, 48.0, 58.0),
    ] {
        let pivot = at(x + w / 2.0, y + h / 2.0);
        p.rotated_round_rect(
            Rect::centred(pivot.0, pivot.1, w * k, h * k),
            radius * k,
            degrees,
            colour,
        );
    }
    // The bars meet at the centre and a disc separates them, which is what makes the mark read as
    // three destinations around a hub rather than as one shape.
    p.fill_circle(center, 54.0 * k, behind);
}

fn draw_update_badge(p: &Painter, wheel: &Wheel, center: (f32, f32), diameter: f32, opacity: f32) {
    let s = wheel.scale;
    let size = (diameter * 0.32).round();
    let at = (
        center.0 + diameter / 2.0 - size * 0.4,
        center.1 - diameter / 2.0 + size * 0.4,
    );
    // A ring in the background colour separates it from the hub without adding a new outline.
    p.fill_circle(at, size / 2.0, fade(pal::rgb(0x0A_0A_0A), opacity));
    let inset = (diameter * 0.026).max(2.0);
    p.fill_circle(at, size / 2.0 - inset, fade(pal::UPDATE_BADGE, opacity));
    // The arrow is drawn, not a typographic glyph: a glyph brings its own side bearings and
    // baseline, and in a small circle that is enough to set it crooked.
    let a = size * 0.26;
    let white = fade(pal::rgb(pal::WHITE), opacity);
    p.line((at.0, at.1 - a), (at.0, at.1 + a * 0.3), white, 1.7 * s);
    p.line((at.0 - a * 0.52, at.1 - a * 0.2), (at.0, at.1 + a * 0.3), white, 1.7 * s);
    p.line((at.0 + a * 0.52, at.1 - a * 0.2), (at.0, at.1 + a * 0.3), white, 1.7 * s);
    p.line((at.0 - a * 0.72, at.1 + a * 0.72), (at.0 + a * 0.72, at.1 + a * 0.72), white, 1.7 * s);
}

// ─── The pill, the filter, the empty notice ─────────────────────────────────

fn draw_pill(p: &Painter, wheel: &Wheel, config: &UiConfig) {
    let bloom = wheel.bloom();
    // Where you are in the wheel stops being information the moment you leave it.
    let opacity = match wheel.echo() {
        Some((_, progress)) => (1.0 - progress * 4.0).max(0.0),
        None => 1.0,
    } * bloom;
    if opacity <= 0.01 {
        return;
    }

    let s = wheel.scale;
    let l = wheel.layout();
    let crumbs = wheel.breadcrumb(config);
    let chip = wheel.center_label(config);

    let style = Style::new(Family::Radial, 11.0 * s, 500, Align::Leading);
    let chip_style = Style::new(Family::Radial, 10.0 * s, 500, Align::Center);

    let sep = " / ";
    let text = crumbs.join(sep);
    let (text_w, text_h) = p.measure(&text, &style);
    let (chip_w, chip_h) = p.measure(chip, &chip_style);

    let pad = 12.0 * s;
    let gap = 8.0 * s;
    let chip_box_w = chip_w + 12.0 * s;
    let w = pad + text_w + gap + chip_box_w + pad;
    let h = text_h.max(14.0 * s) + 12.0 * s;

    let y = wheel.center.1 + (l.radius + l.icon_size * 0.75 + 34.0 * s);
    let pill = Rect::centred(wheel.center.0, y + h / 2.0, w, h);

    p.fill_round_rect(pill, h / 2.0, fade(pal::PILL_PLATE, opacity));
    p.stroke_round_rect(pill.inflate(-0.5), h / 2.0, fade(pal::PILL_BORDER, opacity), 1.0);

    p.text(
        &text,
        Rect::new(
            pill.left + pad,
            pill.top + (h - text_h) / 2.0,
            pill.right,
            pill.bottom,
        ),
        &style,
        fade(pal::PILL_TEXT, opacity),
    );

    let chip_rect = Rect::new(
        pill.right - pad - chip_box_w,
        pill.top + (h - chip_h - 8.0 * s) / 2.0,
        pill.right - pad,
        pill.top + (h + chip_h + 8.0 * s) / 2.0,
    );
    p.fill_round_rect(chip_rect, pal::R_CHIP * s * 0.85, fade(pal::PILL_CHIP_PLATE, opacity));
    p.text(
        chip,
        Rect::new(
            chip_rect.left,
            chip_rect.top + (chip_rect.height() - chip_h) / 2.0,
            chip_rect.right,
            chip_rect.bottom,
        ),
        &chip_style,
        fade(pal::PILL_CHIP_TEXT, opacity),
    );
}

fn draw_filter(p: &Painter, wheel: &Wheel, matches: usize) {
    let s = wheel.scale;
    let l = wheel.layout();
    let opacity = wheel.bloom();
    let query = wheel.filter();
    let count = if matches == 1 {
        "1 match".to_string()
    } else {
        format!("{matches} matches")
    };

    let query_style = Style::new(Family::Radial, 15.0 * s, 600, Align::Leading).tracking(-0.01);
    let count_style = Style::new(Family::Radial, 11.0 * s, 450, Align::Leading);
    let (qw, qh) = p.measure(query, &query_style);
    let (cw, ch) = p.measure(&count, &count_style);

    let pad = 18.0 * s;
    let gap = 10.0 * s;
    let w = pad + qw + gap + cw + pad;
    let h = qh.max(ch).max(16.0 * s) + 16.0 * s;
    let y = wheel.center.1 - (l.radius + l.icon_size * 0.75 + 34.0 * s) - h;
    let plate = Rect::centred(wheel.center.0, y + h / 2.0, w, h);

    p.fill_round_rect(plate, h / 2.0, fade(pal::FILTER_PLATE, opacity));
    p.stroke_round_rect(plate.inflate(-0.5), h / 2.0, fade(pal::FILTER_BORDER, opacity), 1.0);
    p.text(
        query,
        Rect::new(plate.left + pad, plate.top + (h - qh) / 2.0, plate.right, plate.bottom),
        &query_style,
        fade(pal::FILTER_QUERY, opacity),
    );
    p.text(
        &count,
        Rect::new(
            plate.right - pad - cw,
            plate.top + (h - ch) / 2.0,
            plate.right,
            plate.bottom,
        ),
        &count_style,
        fade(pal::FILTER_COUNT, opacity),
    );
}

/// What to do, the first few times direction mode is on.
///
/// Direction mode has no pointer to follow: you push and let go, and nothing on screen says so.
/// Somebody meeting it for the first time moves the mouse, sees the highlight change, and has no
/// idea the gesture ends by releasing rather than by clicking. One sentence fixes that, and it is
/// spent once it has been read -- `has_seen_direction_hint` is what stops it being furniture.
fn draw_direction_hint(p: &Painter, wheel: &Wheel, language: &str) {
    let s = wheel.scale;
    let l = wheel.layout();
    let opacity = wheel.bloom();
    let message = crate::i18n::strings::text(
        crate::i18n::strings::WHEEL,
        "menu.direction_hint",
        language,
    );
    let suffix = " \u{2014} Esc closes the wheel";

    let style = Style::new(Family::Radial, 12.5 * s, 500, Align::Leading);
    let (tw, th) = p.measure(message, &style);
    let (sw, sh) = p.measure(suffix, &style);

    let pad = 18.0 * s;
    let w = pad + tw + sw + pad;
    let h = th.max(sh).max(16.0 * s) + 16.0 * s;
    let y = wheel.center.1 - (l.radius + l.icon_size * 0.75 + 34.0 * s) - h;
    let plate = Rect::centred(wheel.center.0, y + h / 2.0, w, h);

    p.fill_round_rect(plate, h / 2.0, fade(pal::FILTER_PLATE, opacity));
    p.stroke_round_rect(plate.inflate(-0.5), h / 2.0, fade(pal::FILTER_BORDER, opacity), 1.0);
    p.text(
        message,
        Rect::new(plate.left + pad, plate.top + (h - th) / 2.0, plate.right, plate.bottom),
        &style,
        fade(pal::FILTER_QUERY, opacity),
    );
    p.text(
        suffix,
        Rect::new(
            plate.left + pad + tw,
            plate.top + (h - sh) / 2.0,
            plate.right,
            plate.bottom,
        ),
        &style,
        fade(pal::FILTER_COUNT, opacity),
    );
}

/// An empty wheel is otherwise indistinguishable from one that has lost its shortcuts, and at login
/// the Start Menu scan is deferred.
fn draw_empty_notice(p: &Painter, wheel: &Wheel, frame: &Frame) {
    let s = wheel.scale;
    let l = wheel.layout();
    let opacity = wheel.bloom();
    let message = if frame.discovering {
        "Finding your apps\u{2026}"
    } else {
        "Nothing here yet \u{2014} open Settings to add a shortcut"
    };
    let style = Style::new(Family::Radial, 12.5 * s, 500, Align::Center);
    let (w, h) = p.measure(message, &style);
    let pad = 18.0 * s;
    let y = wheel.center.1 - (l.radius * 0.5) - h - 24.0 * s;
    let plate = Rect::centred(wheel.center.0, y + h / 2.0, w + pad * 2.0, h + 20.0 * s);
    p.fill_round_rect(plate, plate.height() / 2.0, fade(pal::FILTER_PLATE, opacity));
    p.stroke_round_rect(
        plate.inflate(-0.5),
        plate.height() / 2.0,
        fade(pal::FILTER_BORDER, opacity),
        1.0,
    );
    p.text(
        message,
        Rect::new(
            plate.left,
            plate.top + (plate.height() - h) / 2.0,
            plate.right,
            plate.bottom,
        ),
        &style,
        fade(pal::FILTER_NOTICE, opacity),
    );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Multiply a colour's alpha.
///
/// Used everywhere instead of a layer, because every object the wheel fades carries its own
/// background and a layer would fade the composite — which is the thing the palette's rule about
/// opacity is about. Fading the COLOURS keeps each object's internal contrast intact.
fn fade(colour: D2D1_COLOR_F, by: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        a: colour.a * by.clamp(0.0, 1.0),
        ..colour
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::defaults;

    #[test]
    fn fade_scales_only_alpha() {
        let c = pal::rgba(0x804020, 0.8);
        let f = fade(c, 0.5);
        assert!((f.a - 0.4).abs() < 1e-6);
        assert_eq!((f.r, f.g, f.b), (c.r, c.g, c.b));
        // Clamped, so a bloom value slightly past 1 cannot produce alpha above 1.
        assert_eq!(fade(c, 2.0).a, 0.8);
        assert_eq!(fade(c, -1.0).a, 0.0);
    }

    #[test]
    fn the_badge_wins_over_the_workspace_chip() {
        // Two different digits on one tile, where only one is the key being pressed.
        let mut config = defaults::ui_config();
        let item = AppItem {
            id: "__zenith_ws_pick__0".into(),
            label: "Main".into(),
            ..AppItem::default()
        };
        config.radial_number_launch = Some(false);
        assert_eq!(workspace_chip(&config, &item).as_deref(), Some("1"));
        config.radial_number_launch = Some(true);
        config.radial_number_labels = Some(true);
        assert_eq!(workspace_chip(&config, &item), None);
    }

    #[test]
    fn a_plain_shortcut_has_no_chip() {
        let config = defaults::ui_config();
        let item = AppItem { id: "plain".into(), label: "Thing".into(), ..AppItem::default() };
        assert_eq!(workspace_chip(&config, &item), None);
    }

    #[test]
    fn polar_puts_item_zero_straight_up() {
        let (x, y) = polar((100.0, 100.0), 50.0, sectors::centre_deg(0, 8));
        assert!((x - 100.0).abs() < 1e-4);
        assert!((y - 50.0).abs() < 1e-4, "got {y}");
    }
}

/// Draw the mark anywhere, in any colour — the titlebar's wordmark uses this.
///
/// `behind` is what the punched centre is filled with, and it has to be the colour actually behind
/// the mark: the hub is dark when idle and the hover colour when aimed at, and the titlebar is the
/// sunken surface.
pub fn draw_logo_probe_at(
    p: &Painter,
    center: (f32, f32),
    size: f32,
    colour: D2D1_COLOR_F,
    behind: D2D1_COLOR_F,
) {
    draw_logo(p, center, size, colour, behind);
}

/// Draw the mark on its own, for `--probe-logo`.
///
/// It exists because the mark is 37px on a real wheel, where a half-pixel error in a rotated bar is
/// invisible until somebody looks at a screenshot and cannot say why it reads wrong. At 300px it is
/// obvious.
pub fn draw_logo_probe(p: &Painter, center: (f32, f32), size: f32) {
    draw_logo(
        p,
        center,
        size,
        pal::rgb(pal::LOGO),
        pal::rgb(0x10_10_12),
    );
}
