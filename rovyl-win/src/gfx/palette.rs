//! Every colour the product paints, in one place.
//!
//! Ported from the design tokens in the original's `src/index.css`. Two rules came with them and
//! are worth keeping where they can be enforced rather than remembered:
//!
//! - **The wheel is monochrome** — white and black, plus the user's hover colour. No new hues. The
//!   update badge is the single deliberate exception, and it is here under its own name so that
//!   being an exception is visible.
//! - **Opacity is not a de-emphasis channel** for anything that carries its own background. Alpha
//!   multiplies the plate too, so a tile at 0.5 stops being an object and becomes a smudge over a
//!   desktop nobody controls. Where something has to read as secondary, the CONTENT's contrast is
//!   lowered and the plate is left alone.

use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;

/// `0xRRGGBB` plus an alpha, as D2D wants it.
///
/// D2D takes straight (non-premultiplied) colour and premultiplies on the way to a premultiplied
/// target, so these are written exactly as the CSS was.
pub const fn rgba(rgb: u32, alpha: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: ((rgb >> 16) & 0xFF) as f32 / 255.0,
        g: ((rgb >> 8) & 0xFF) as f32 / 255.0,
        b: (rgb & 0xFF) as f32 / 255.0,
        a: alpha,
    }
}

pub const fn rgb(value: u32) -> D2D1_COLOR_F {
    rgba(value, 1.0)
}

pub const TRANSPARENT: D2D1_COLOR_F = rgba(0, 0.0);
pub const WHITE: u32 = 0xFF_FF_FF;
pub const BLACK: u32 = 0x00_00_00;

// ─── The wheel ──────────────────────────────────────────────────────────────

/// The scrim's near-black. Not a true 0,0,0: a pure black wash over a saturated wallpaper reads as
/// a hole punched in the screen rather than as shade.
pub const SCRIM: u32 = 0x04_05_07;

/// A tile's plate, which tracks the dimming so the wheel keeps its separation at every setting.
///
/// FULLY opaque, and the reason is a rasterisation one rather than a design one. The overlay is a
/// per-pixel-alpha surface: with alpha below 1 every pixel is premultiplied and requantised to 8
/// bits as the compositor blends it. On the plate's straight sides coverage is 0% or 100% and the
/// error does not exist; on the rounded corners the pixels have partial coverage and the rounding
/// falls now up, now down — the line comes out uneven, with some dots lighter and others gone. At
/// 0.985 the visual difference from opaque is nil; the cost on the edge is not.
pub fn tile_plate(backdrop_opacity: f32) -> D2D1_COLOR_F {
    let level = 12 + (backdrop_opacity * 10.0).round() as u32;
    rgb((level << 16) | (level << 8) | level)
}

/// The idle tile's border. Strong enough to cut the plate out of an unknown desktop without
/// depending on the global scrim or on the wallpaper's contrast.
pub fn tile_border(backdrop_opacity: f32) -> D2D1_COLOR_F {
    rgba(WHITE, 0.28 + backdrop_opacity * 0.08)
}

/// The 1px dark ring OUTSIDE the tile's border.
///
/// A double outline: the light border on the inside, this on the outside. On a light background the
/// ring reads, on a dark one the border does — so the tile separates itself either way.
pub const TILE_RING: D2D1_COLOR_F = rgba(BLACK, 0.5);
pub const TILE_RING_ACTIVE: D2D1_COLOR_F = rgba(BLACK, 0.45);

/// The inset highlight along a tile's top edge.
///
/// One light source for the whole wheel, which is what makes the tiles read as objects rather than
/// as flat patches.
pub const TILE_INSET_LIGHT: D2D1_COLOR_F = rgba(WHITE, 0.08);

/// The tile's soft drop shadow — colour and geometry. Pre-rendered once per size; see `shadow.rs`.
pub const TILE_SHADOW: D2D1_COLOR_F = rgba(BLACK, 0.42);
pub const TILE_SHADOW_ACTIVE: D2D1_COLOR_F = rgba(BLACK, 0.5);
pub const TILE_SHADOW_OFFSET: f32 = 8.0;
pub const TILE_SHADOW_BLUR: f32 = 11.0;
pub const TILE_SHADOW_OFFSET_ACTIVE: f32 = 12.0;
pub const TILE_SHADOW_BLUR_ACTIVE: f32 = 14.0;

/// The tile's corner radius, in DIPs at the reference icon size.
///
/// Scaled with the tile rather than fixed, so a 24px dock icon and a 64px wheel tile read as the
/// same shape. A constant radius makes the small one look almost circular.
pub const TILE_RADIUS_AT_64: f32 = 18.0;

pub fn tile_radius(icon_size: f32) -> f32 {
    (TILE_RADIUS_AT_64 * icon_size / 64.0).clamp(6.0, 22.0)
}

/// The hub's disc.
///
/// No border and no 1px ring, unlike a tile. On a circle a thin high-contrast line is what makes
/// every antialiasing step visible: the eye follows the line and watches it thicken and thin. The
/// disc is defined by its own fill — a filled-to-transparent transition, which is the case the
/// rasteriser handles best — and its separation from the desktop comes from DIFFUSE shadows, which
/// have no edge to jag. The fill is .90 rather than .78 because there is no longer a ring holding
/// the outline over a light wallpaper.
pub const HUB_FILL: D2D1_COLOR_F = rgba(SCRIM, 0.90);
pub const HUB_RING: D2D1_COLOR_F = rgba(WHITE, 0.30);
pub const HUB_RING_WIDTH: f32 = 1.5;
pub const HUB_SHADOW: D2D1_COLOR_F = rgba(BLACK, 0.5);

/// The hub's glyph when it is not active.
pub const HUB_GLYPH: D2D1_COLOR_F = rgba(WHITE, 0.70);
/// The Rovyl mark's own off-white, which is warmer than the UI's pure white.
pub const LOGO: u32 = 0xF4_F2_ED;

/// A label's pill. Opaque on its own: a translucent white wash disappeared over light desktops.
pub const LABEL_PLATE: D2D1_COLOR_F = rgba(0x06_07_09, 0.95);
pub const LABEL_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.2);
pub const LABEL_TEXT: D2D1_COLOR_F = rgba(WHITE, 0.7);
pub const LABEL_RING: D2D1_COLOR_F = rgba(BLACK, 0.45);

/// The chip inside a label — a workspace key, "recents".
pub const CHIP_PLATE: D2D1_COLOR_F = rgba(WHITE, 0.10);
pub const CHIP_TEXT: D2D1_COLOR_F = rgba(WHITE, 0.5);

/// The number badge on a tile.
pub const BADGE_PLATE: D2D1_COLOR_F = rgba(0x06_07_09, 0.95);
pub const BADGE_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.26);
pub const BADGE_TEXT: D2D1_COLOR_F = rgba(WHITE, 0.78);

/// The folder badge: a white disc with two dark dots, ringed in the wheel's own dark so it reads as
/// sitting on the tile rather than in it.
pub const FOLDER_BADGE: D2D1_COLOR_F = rgb(WHITE);
pub const FOLDER_BADGE_RING: D2D1_COLOR_F = rgb(0x1A_1A_1A);
pub const FOLDER_BADGE_DOT: D2D1_COLOR_F = rgb(BLACK);

/// The context pill under the wheel.
pub const PILL_PLATE: D2D1_COLOR_F = rgba(SCRIM, 0.92);
pub const PILL_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.14);
pub const PILL_TEXT: D2D1_COLOR_F = rgba(WHITE, 0.60);
pub const PILL_SEPARATOR: D2D1_COLOR_F = rgba(WHITE, 0.25);
pub const PILL_CHIP_PLATE: D2D1_COLOR_F = rgba(WHITE, 0.09);
pub const PILL_CHIP_TEXT: D2D1_COLOR_F = rgba(WHITE, 0.45);

/// The corner gear, and the dock plates, which share one plate style.
pub const CORNER_PLATE: D2D1_COLOR_F = rgba(0x08_08_0A, 0.72);
pub const CORNER_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.1);
pub const CORNER_GLYPH: D2D1_COLOR_F = rgba(WHITE, 0.55);
pub const CORNER_PLATE_HOVER: D2D1_COLOR_F = rgba(0x14_14_18, 0.88);
pub const CORNER_BORDER_HOVER: D2D1_COLOR_F = rgba(WHITE, 0.2);
pub const CORNER_GLYPH_HOVER: D2D1_COLOR_F = rgba(WHITE, 0.92);

/// A dock tile's states.
pub const DOCK_GLYPH: D2D1_COLOR_F = rgba(WHITE, 0.72);
pub const DOCK_GLYPH_HOVER: D2D1_COLOR_F = rgba(WHITE, 0.96);
pub const DOCK_HOVER_PLATE: D2D1_COLOR_F = rgba(WHITE, 0.08);
pub const DOCK_HOVER_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.16);
pub const DOCK_PRESSED_PLATE: D2D1_COLOR_F = rgba(WHITE, 0.14);
pub const DOCK_IDLE: D2D1_COLOR_F = rgba(WHITE, 0.45);

/// The sustained-aim ring: an opaque dark casing, the light track, then the arc.
///
/// Three layers, for the same reason the tile has a double outline: the ring runs OUTSIDE the
/// tile's opaque plate, so what sits behind it is the scrim and, through it, a wallpaper nobody
/// controls. On its own, white at 30% does not read over a light background — and an invisible
/// progress ring is the only thing warning that something is about to open by itself.
pub const DWELL_CASING: D2D1_COLOR_F = rgba(BLACK, 0.55);
pub const DWELL_TRACK: D2D1_COLOR_F = rgba(WHITE, 0.30);
pub const DWELL_CASING_WIDTH: f32 = 4.5;
pub const DWELL_TRACK_WIDTH: f32 = 2.5;

/// The update badge on the hub. The one deliberate hue in a monochrome wheel: an update is the
/// single thing the wheel says that is not about the user's own shortcuts.
pub const UPDATE_BADGE: D2D1_COLOR_F = rgb(0x0A_84_FF);
pub const UPDATE_BADGE_HOVER: D2D1_COLOR_F = rgb(0x2B_95_FF);

/// The filter readout above the wheel.
pub const FILTER_PLATE: D2D1_COLOR_F = rgba(SCRIM, 0.92);
pub const FILTER_BORDER: D2D1_COLOR_F = rgba(WHITE, 0.1);
pub const FILTER_QUERY: D2D1_COLOR_F = rgba(WHITE, 0.92);
pub const FILTER_COUNT: D2D1_COLOR_F = rgba(WHITE, 0.5);
pub const FILTER_NOTICE: D2D1_COLOR_F = rgba(WHITE, 0.82);
pub const FILTER_HINT: D2D1_COLOR_F = rgba(WHITE, 0.66);

// ─── Windowed surfaces ──────────────────────────────────────────────────────
//
// Settings and the titlebar. The wheel stays dark in both themes: it is an overlay on the desktop,
// not a surface of the product, and a white wheel over a dark wallpaper is a lamp.
//
// One hierarchy, the same steps in both themes:
//   bg -> sunken (chrome/nav) -> surface (content) -> raised (state) -> solid

#[derive(Debug, Clone, Copy)]
pub struct Surface {
    pub bg: D2D1_COLOR_F,
    pub sunken: D2D1_COLOR_F,
    pub surface: D2D1_COLOR_F,
    pub raised: D2D1_COLOR_F,
    pub hover: D2D1_COLOR_F,
    pub pressed: D2D1_COLOR_F,
    pub line: D2D1_COLOR_F,
    pub line_strong: D2D1_COLOR_F,
    pub text: D2D1_COLOR_F,
    pub text_2: D2D1_COLOR_F,
    pub text_3: D2D1_COLOR_F,
    /// The primary action: the same white/black pair as the wheel's active item. The product's
    /// "accent" is the absence of colour.
    pub solid: D2D1_COLOR_F,
    pub on_solid: D2D1_COLOR_F,
    pub focus: D2D1_COLOR_F,
    pub scrim: D2D1_COLOR_F,
    /// The code editor's ink. See `CodeInk`.
    pub code: CodeInk,
}

/// What the workspace's JSON is coloured with, in the dialog's second view.
///
/// Nested in `Surface` rather than spread across it, because these six are a set: they are only
/// legible as a scheme, they are only used in one place, and a panel that offered `theme.key`
/// beside `theme.text_2` would invite a settings row to colour a label with a syntax hue.
///
/// **The one distinction worth a hue** is a key against a value — that is what is actually being
/// read in a configuration file, and the rest of the scheme exists so the keys stand out of
/// something rather than out of a flat wall. So the keys carry the one saturated colour, the
/// values are warm, and the punctuation is quiet enough to read the shape of the nesting through.
///
/// **Both themes are tuned against the box's own fill**, which is `sunken` and not `surface`: the
/// editor is a well in the dialog, so the dark scheme sits on near-black and the light one on an
/// off-white, and the hues are not the same two sets at different lightnesses.
#[derive(Debug, Clone, Copy)]
pub struct CodeInk {
    /// A string with a colon after it.
    pub key: D2D1_COLOR_F,
    /// A string without one.
    pub string: D2D1_COLOR_F,
    pub number: D2D1_COLOR_F,
    /// `true`, `false`, `null`.
    pub word: D2D1_COLOR_F,
    /// Braces, brackets, commas, colons.
    pub punct: D2D1_COLOR_F,
    pub selection: D2D1_COLOR_F,
}

pub const DARK: Surface = Surface {
    bg: rgb(0x15_15_15),
    sunken: rgb(0x11_11_11),
    surface: rgb(0x15_15_15),
    raised: rgba(WHITE, 0.055),
    hover: rgba(WHITE, 0.032),
    pressed: rgba(WHITE, 0.085),
    line: rgba(WHITE, 0.07),
    line_strong: rgba(WHITE, 0.13),
    text: rgba(WHITE, 0.93),
    text_2: rgba(WHITE, 0.55),
    text_3: rgba(WHITE, 0.48),
    solid: rgb(WHITE),
    on_solid: rgb(0x0A_0A_0B),
    focus: rgba(WHITE, 0.55),
    scrim: rgba(0x06_06_08, 0.66),
    code: CodeInk {
        key: rgb(0x9C_C4_FF),
        string: rgb(0xD8_B4_79),
        number: rgb(0xB6_D7_A8),
        word: rgb(0xC9_92_D6),
        punct: rgba(WHITE, 0.42),
        selection: rgba(0x6E_9C_FF, 0.26),
    },
};

pub const LIGHT: Surface = Surface {
    bg: rgb(0xE8_E8_EA),
    sunken: rgb(0xF2_F2_F4),
    surface: rgb(0xFC_FC_FD),
    raised: rgba(BLACK, 0.05),
    hover: rgba(BLACK, 0.028),
    pressed: rgba(BLACK, 0.08),
    line: rgba(BLACK, 0.085),
    line_strong: rgba(BLACK, 0.16),
    text: rgba(BLACK, 0.90),
    text_2: rgba(BLACK, 0.56),
    text_3: rgba(BLACK, 0.48),
    solid: rgb(0x10_10_12),
    on_solid: rgb(WHITE),
    focus: rgba(BLACK, 0.45),
    scrim: rgba(0xE2_E2_E5, 0.7),
    code: CodeInk {
        key: rgb(0x1B_4F_9C),
        string: rgb(0x8A_55_12),
        number: rgb(0x2C_6B_3F),
        word: rgb(0x79_32_8E),
        punct: rgba(BLACK, 0.48),
        selection: rgba(0x2B_6C_D9, 0.20),
    },
};

pub fn surface(theme: crate::config::Theme) -> Surface {
    match theme {
        crate::config::Theme::Black => DARK,
        crate::config::Theme::White => LIGHT,
    }
}

/// The window's close button, which is the one control Windows itself gives a colour.
pub const CLOSE_HOVER: D2D1_COLOR_F = rgb(0xC4_2B_1C);
pub const CLOSE_PRESSED: D2D1_COLOR_F = rgb(0xB0_27_1A);

/// The one warm hue in the panel: a button that destroys something.
///
/// Not in `Surface`, because it does not change with the theme. A destructive action has to read
/// as destructive on a white panel and a black one, and a red that was tuned twice would end up
/// being two different warnings.
pub const DANGER: D2D1_COLOR_F = rgb(0xEF_7C_7C);
pub const DANGER_HOVER: D2D1_COLOR_F = rgb(0xFF_90_90);

/// The two notes the workspace editor puts above a crowded ring.
///
/// Amber while the count is merely worth knowing, red once it is past what the wheel aims at. Both
/// are a tinted plate, a tinted hairline and the ink that reads on them — three values that only
/// make sense together, so they are named together rather than mixed at the call site.
pub const CROWD_NOTE_INK: D2D1_COLOR_F = rgba(0xE9_BD_78, 0.92);
pub const CROWD_NOTE_FILL: D2D1_COLOR_F = rgba(0xE0_A0_3C, 0.07);
pub const CROWD_NOTE_LINE: D2D1_COLOR_F = rgba(0xE0_A0_3C, 0.28);
pub const CROWD_WARN_INK: D2D1_COLOR_F = rgba(0xF4_A8_A8, 0.95);
pub const CROWD_WARN_FILL: D2D1_COLOR_F = rgba(0xEF_7C_7C, 0.08);
pub const CROWD_WARN_LINE: D2D1_COLOR_F = rgba(0xEF_7C_7C, 0.30);

/// How much of its colour a disabled control keeps.
///
/// One number, used by every control that can be switched off, so "off" looks the same whether it
/// is a button, a titlebar arrow or a switch. Picked per control, it becomes six slightly
/// different greys that read as six different states.
pub const DISABLED_DIM: f32 = 0.4;

// ─── The wheel, shown inside the panel ──────────────────────────────────────
//
// Two places in Settings draw the wheel rather than a control: the Appearance preview and the
// Sound page's try-it stage. They are the wheel's surfaces, not the panel's, so they are here
// with the rest of the wheel's colours and they do NOT follow the theme — a white try-wheel would
// be showing something the product never draws.

/// The stand-in desktop under the Appearance preview, as a 135° ramp.
///
/// A wallpaper the wheel can be seen against. Over a flat panel colour the backdrop-dimming
/// slider has nothing to dim, and every value from 0 to 1 produces the same picture.
pub const DESK_RAMP: [(f32, u32); 3] = [(0.0, 0x8D_97_AD), (0.45, 0x6F_78_91), (1.0, 0x4D_54_68)];

/// The try-it stage: the wheel's own near-black, lifted a little at the centre so the box reads
/// as a lit scene rather than a hole.
pub const TRY_STAGE_CENTRE: D2D1_COLOR_F = rgb(0x1C_1E_23);
pub const TRY_STAGE_EDGE: D2D1_COLOR_F = rgb(0x0C_0D_10);

/// Space scale — a 4px base, and no values outside it.
pub const SPACE: [f32; 8] = [4.0, 8.0, 12.0, 16.0, 20.0, 24.0, 32.0, 40.0];

/// Radii, which communicate hierarchy: window > panel > control > chip.
///
/// The window's is 0 because it is opaque and Windows owns its corners — rounded on 11, square on
/// 10 — and a radius of our own would show as a seam inside the system's.
pub const R_WINDOW: f32 = 0.0;
pub const R_PANEL: f32 = 10.0;
pub const R_CONTROL: f32 = 8.0;
pub const R_CHIP: f32 = 6.0;

/// Control and icon heights — one value of each, reused everywhere.
pub const CONTROL_H: f32 = 32.0;
pub const CONTROL_SM_H: f32 = 26.0;
pub const ICON: f32 = 16.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_land_where_css_put_them() {
        let c = rgba(0x80_40_20, 0.5);
        assert!((c.r - 128.0 / 255.0).abs() < 1e-6);
        assert!((c.g - 64.0 / 255.0).abs() < 1e-6);
        assert!((c.b - 32.0 / 255.0).abs() < 1e-6);
        assert_eq!(c.a, 0.5);
    }

    #[test]
    fn the_tile_plate_is_always_opaque() {
        // Alpha below 1 is what makes the rounded corners come out uneven on a premultiplied
        // target. The plate tracks the dimming in LIGHTNESS, never in alpha.
        for dim in [0.0_f32, 0.5, 0.9, 1.0] {
            assert_eq!(tile_plate(dim).a, 1.0);
        }
        // And it does get lighter as the scrim deepens.
        assert!(tile_plate(1.0).r > tile_plate(0.0).r);
    }

    #[test]
    fn the_border_strengthens_with_the_dimming() {
        assert!(tile_border(1.0).a > tile_border(0.0).a);
        // Never past the point where it stops being a border and becomes a frame.
        assert!(tile_border(1.0).a < 0.4);
    }

    #[test]
    fn the_tile_radius_scales_with_the_tile() {
        // A fixed radius makes a small dock icon look almost circular.
        assert!((tile_radius(64.0) - 18.0).abs() < 1e-6);
        assert!(tile_radius(32.0) < tile_radius(64.0));
        // Clamped at both ends, so an extreme icon-size setting cannot invert the shape.
        assert!(tile_radius(8.0) >= 6.0);
        assert!(tile_radius(200.0) <= 22.0);
    }

    #[test]
    fn the_wheel_is_monochrome_but_for_one_badge() {
        // Every wheel colour is a grey, the scrim's near-black, or the logo's off-white.
        let greys = [
            HUB_FILL, HUB_RING, LABEL_PLATE, LABEL_TEXT, BADGE_PLATE, PILL_PLATE, CORNER_PLATE,
            DWELL_CASING, DWELL_TRACK,
        ];
        for colour in greys {
            let spread = colour
                .r
                .max(colour.g)
                .max(colour.b)
                - colour.r.min(colour.g).min(colour.b);
            assert!(spread < 0.02, "{colour:?} is not a grey");
        }
        // The exception, named so that it is visible as one.
        let badge = UPDATE_BADGE;
        assert!(badge.b > badge.r + 0.5, "the update badge is the one hue");
    }

    #[test]
    fn both_themes_define_every_step() {
        // A missing step reads as a control that has no hover state, which looks like a dead button.
        for s in [DARK, LIGHT] {
            assert!(s.hover.a > 0.0);
            assert!(s.pressed.a > s.hover.a, "pressed must read stronger than hover");
            assert!(s.line_strong.a > s.line.a);
            assert!(s.text.a > s.text_2.a);
            assert!(s.text_2.a >= s.text_3.a);
        }
    }

    #[test]
    fn the_space_scale_has_no_values_off_the_grid() {
        for value in SPACE {
            assert_eq!(value % 4.0, 0.0, "{value} is off the 4px base");
        }
    }
}
