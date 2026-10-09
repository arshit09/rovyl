//! Text: the fonts the product uses, and a cache of laid-out strings.
//!
//! **Why a cache.** A `IDWriteTextLayout` is the expensive part of drawing text — it does the
//! itemisation, shaping and line breaking — and the wheel draws the same handful of strings on
//! every frame of an animation. The strings change only when the level does, so a layout is built
//! once per (text, style, width) and reused until it is evicted.
//!
//! **Why the fonts are loaded from the image and not by name.** The original asks the browser for
//! "Instrument Sans Variable" and gets it because the fonts are bundled with the renderer. Asking
//! the system for them by name here would find them on the developer's machine and fail on
//! everyone else's, and the fallback — whatever the system picks for a missing family — changes
//! the wheel's metrics, so the labels would be a different size and the pills a different width.
//! The three families are embedded and registered with a private font collection, so the product
//! looks the same on a fresh install as it does here.

use std::cell::RefCell;
use std::collections::HashMap;
use windows::core::{w, HSTRING};
use windows::Win32::Graphics::DirectWrite::{
    IDWriteFactory3, IDWriteFontCollection, IDWriteTextFormat, IDWriteTextFormat3,
    IDWriteTextLayout, DWRITE_FONT_AXIS_TAG_WEIGHT, DWRITE_FONT_AXIS_VALUE, DWRITE_FONT_FEATURE,
    DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_TEXT_ALIGNMENT_LEADING,
    DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE, DWRITE_WORD_WRAPPING_NO_WRAP,
};

/// The three families, by the role they play rather than by name.
///
/// `Radial` is the one the wheel itself uses: labels, the pill, the number badges. It is a separate
/// role from `Ui` because the wheel's text sits over an unknown desktop at small sizes and wants a
/// slightly wider, more open face than a settings row does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    /// Headings and the wordmark.
    Display,
    /// Settings, menus, everything in a window.
    Ui,
    /// The wheel.
    Radial,
    /// Code: the workspace's own JSON, in the editor that shows it.
    ///
    /// A fourth role and not a weight of `Ui`, because the thing that makes it one is the thing no
    /// weight carries: every glyph is the same width. The code editor lays its text on a character
    /// grid — a caret position is a column times one advance, and a click is the inverse — and a
    /// proportional face would put the caret somewhere other than where the glyph it names is
    /// drawn.
    Mono,
}

impl Family {
    /// The embedded face this role is drawn in, by the family name its name table carries.
    ///
    /// `None` for `Mono`: there is no bundled monospace, so that role is asked of the system.
    fn bundled(self) -> Option<&'static str> {
        match self {
            Family::Display => Some("Space Grotesk"),
            Family::Ui => Some("Inter"),
            Family::Radial => Some("Instrument Sans"),
            Family::Mono => None,
        }
    }

    /// The family name to ask DirectWrite for, in order of preference.
    ///
    /// The first is the bundled face. The rest are the system faces to fall back to, listed
    /// explicitly rather than left to DirectWrite's default: the default for a missing family is
    /// whatever the font-fallback chain produces, which on a stripped-down Windows install can be
    /// a face with very different metrics — and the wheel's pills are sized from the text.
    fn candidates(self) -> &'static [&'static str] {
        match self {
            Family::Display => &["Space Grotesk", "Segoe UI Variable Display", "Segoe UI"],
            Family::Ui => &["Inter", "Segoe UI Variable Text", "Segoe UI"],
            Family::Radial => &["Instrument Sans", "Inter", "Segoe UI Variable Text", "Segoe UI"],
            // Consolas FIRST, which is the opposite of the three above. They name the bundled face
            // first and the system ones after it, for the machine where the private collection
            // could not be built; there is no bundled monospace, so the first entry is the one
            // that has to resolve on every machine. Consolas has shipped with every Windows since
            // Vista. Cascadia Mono is the better face and arrived with Windows 11 — it is second
            // rather than first because `build_format` can only ask for one family, and a name
            // that does not resolve is substituted by the fallback chain with whatever it likes,
            // which for a code editor means a proportional face under a grid that assumes
            // otherwise.
            Family::Mono => &["Consolas", "Cascadia Mono", "Courier New"],
        }
    }
}

/// Horizontal alignment within the layout box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Align {
    Leading,
    Center,
    Trailing,
}

/// Everything that changes a layout's metrics. The cache key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Style {
    pub family: Family,
    /// In DIPs. Stored as the raw bits so the key can be hashed — a font size is a value that is
    /// either exactly equal or a different style, so bit equality is the right comparison.
    size_bits: u32,
    pub weight: u16,
    pub align: Align,
    /// Letter spacing in DIPs. The product's type is set slightly tight — `-0.01em` on the
    /// wordmark, `-0.005em` on wheel labels — and without it the pills come out wider than the
    /// originals by a few pixels per word.
    tracking_bits: u32,
    /// Whether the text reads right to left.
    ///
    /// Part of the KEY, not a draw-time flag: it changes the layout's metrics and which end
    /// `Align::Leading` means, so a cache that ignored it would serve a left-to-right layout to a
    /// right-to-left caller and the text would sit on the wrong side of its own box.
    pub rtl: bool,
    /// Every digit the same width, for a number that changes while being looked at.
    ///
    /// None of the three faces is tabular by default — in Space Grotesk a `1` is 435 units and a
    /// `4` is 645 — so a right-aligned readout dragged from 191 to 144 shifts sideways under the
    /// hand. The original asks for `font-variant-numeric: tabular-nums` wherever a number is live;
    /// this is the same request, made of DirectWrite.
    tabular: bool,
}

impl Style {
    pub fn new(family: Family, size: f32, weight: u16, align: Align) -> Self {
        Self {
            family,
            size_bits: size.to_bits(),
            weight,
            align,
            tracking_bits: 0f32.to_bits(),
            rtl: false,
            tabular: false,
        }
    }

    /// Lay this out right to left.
    pub fn rtl(mut self, on: bool) -> Self {
        self.rtl = on;
        self
    }

    /// Set the digits on a fixed pitch. For a number that is watched while it changes.
    pub fn tabular(mut self) -> Self {
        self.tabular = true;
        self
    }

    /// Centre or trail the run instead of leading it.
    ///
    /// A builder rather than a second constructor, so the shared styles in `ui::widgets` can be
    /// defined once and a caller that needs one centred says so at the call site. Without it,
    /// every centred label has to restate the family, size, weight and tracking — which is how a
    /// type scale ends up with two definitions that disagree.
    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    pub fn tracking(mut self, em: f32) -> Self {
        self.tracking_bits = (em * self.size()).to_bits();
        self
    }

    pub fn size(&self) -> f32 {
        f32::from_bits(self.size_bits)
    }

    pub fn tracking_dips(&self) -> f32 {
        f32::from_bits(self.tracking_bits)
    }
}

/// A laid-out string, with the metrics the caller needs to place and size a plate around it.
pub struct Laid {
    pub layout: IDWriteTextLayout,
    /// Tight width of the text, which is what a pill is sized from — not the layout box's width,
    /// which is whatever maximum it was given.
    pub width: f32,
    pub height: f32,
}

pub struct TextCache {
    factory: IDWriteFactory3,
    /// The embedded faces. `None` only where DirectWrite would not build the collection, which
    /// leaves the product on the system families in `Family::candidates`.
    bundled: Option<crate::gfx::fonts::Bundled>,
    formats: RefCell<HashMap<Style, IDWriteTextFormat>>,
    /// Keyed by style and string. Bounded: the wheel draws a few dozen distinct strings, the
    /// settings panel a few hundred, and an unbounded cache over a session that opens the icon
    /// picker would hold a layout per glyph name.
    layouts: RefCell<HashMap<(Style, String), Laid>>,
}

/// Above this many entries the layout cache is emptied.
///
/// A flat clear rather than an LRU, deliberately: the access pattern is bursty and phase-shaped
/// (one wheel level, then another; one settings page, then another), so the cheapest correct policy
/// is to drop everything and let the next few frames rebuild what is actually in use. An LRU here
/// would cost a touch per lookup to approximate the same thing.
const LAYOUT_LIMIT: usize = 512;

impl TextCache {
    pub fn new(factory: IDWriteFactory3) -> Self {
        let bundled = crate::gfx::fonts::load(&factory);
        Self {
            factory,
            bundled,
            formats: RefCell::new(HashMap::with_capacity(16)),
            layouts: RefCell::new(HashMap::with_capacity(64)),
        }
    }

    /// Which family name to ask for, and which collection to ask in.
    ///
    /// The bundled name resolves only inside the private collection; if that could not be built,
    /// the first SYSTEM candidate is used instead. Asking the system for "Inter" and letting it
    /// substitute is the one thing this must not do — a substitution is silent and changes every
    /// measurement the layout is built from.
    fn resolve(&self, family: Family) -> (&'static str, Option<&IDWriteFontCollection>) {
        match (family.bundled(), self.bundled.as_ref()) {
            (Some(name), Some(bundled)) => (name, Some(&*bundled.collection)),
            // Index 1 for a role whose bundled face is unavailable, index 0 for `Mono`, whose
            // first candidate is already a system face.
            (Some(_), None) => (family.candidates()[1], None),
            (None, _) => (family.candidates()[0], None),
        }
    }

    fn format(&self, style: &Style) -> Option<IDWriteTextFormat> {
        if let Some(found) = self.formats.borrow().get(style) {
            return Some(found.clone());
        }
        let format = self.build_format(style)?;
        self.formats
            .borrow_mut()
            .insert(style.clone(), format.clone());
        Some(format)
    }

    fn build_format(&self, style: &Style) -> Option<IDWriteTextFormat> {
        // `CreateTextFormat` succeeds for a family that does not exist — the substitution happens
        // at layout time, silently — so the name and the collection have to be right here rather
        // than probed for afterwards.
        let (family, collection) = self.resolve(style.family);
        let format = unsafe {
            self.factory
                .CreateTextFormat(
                    &HSTRING::from(family),
                    collection,
                    DWRITE_FONT_WEIGHT(style.weight as i32),
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    style.size(),
                    // The locale, and it must be a STRING: `CreateTextFormat` rejects a null
                    // pointer here with `E_INVALIDARG`, and the failure is invisible — every piece
                    // of text in the product simply does not draw, with no error anywhere.
                    //
                    // Empty means "the user's", which is what decides how digits and quotation
                    // marks are shaped. A launcher's labels are the user's own text.
                    w!(""),
                )
                .ok()?
        };
        unsafe {
            // The weight again, this time as a position on the face's own `wght` axis.
            //
            // `CreateTextFormat` picks a face by weight, and against a variable font that means
            // the nearest NAMED instance — 400, 500, 600, 700. The panel's segmented controls are
            // set at 450, which the original renders exactly because a browser interpolates the
            // axis. Without this they would snap to 400 or 500 and the chips would come out a
            // different width. Only the bundled faces are variable; `Mono` has no axis and the
            // call is harmless there.
            if style.family.bundled().is_some() && self.bundled.is_some() {
                if let Ok(axes) = format.cast::<IDWriteTextFormat3>() {
                    let _ = axes.SetFontAxisValues(&[DWRITE_FONT_AXIS_VALUE {
                        axisTag: DWRITE_FONT_AXIS_TAG_WEIGHT,
                        value: style.weight as f32,
                    }]);
                }
            }
            // ALWAYS leading and near — a layout is never aligned by DirectWrite.
            //
            // Alignment is a PLACEMENT decision and is applied by the painter, which offsets the
            // draw origin by the measured width. Letting the layout do it ties the result to the
            // box it was laid out in, and the box is not part of the cache key: the same string
            // measured once against an unbounded width and then drawn into a 60px pill would come
            // back from the cache aligned against the wrong one of the two.
            //
            // Paragraph alignment is the sharper version of the same trap. A layout's height is
            // effectively unbounded here, and `DWRITE_PARAGRAPH_ALIGNMENT_CENTER` against an
            // unbounded height centres the text halfway to infinity — which draws nothing, anywhere
            // on screen, with no error from any call.
            let _ = format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_LEADING);
            let _ = format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
            // The reading direction is deliberately NOT set to right-to-left for Arabic.
            //
            // It is the obvious thing and it loses the text completely. Every layout here is built
            // in a box a million DIPs wide, and alignment is always `LEADING` because the PAINTER
            // does the aligning from the measured width. Flip the reading direction and `LEADING`
            // becomes the right-hand edge of that box -- so the line is laid out a million pixels
            // to the right of where it is drawn, and the panel comes back with furniture on it and
            // no words at all. DirectWrite shapes and bidi-orders an Arabic run correctly from the
            // characters themselves; `Style::rtl` only tells the painter which end to align to.
            // Every string the wheel draws is one line. A label that wrapped would change the
            // pill's height mid-gesture, and the pill is positioned from that height.
            let _ = format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        }
        Some(format)
    }

    /// The box every layout is built in.
    ///
    /// Fixed, and large, so that a layout depends only on its text and its style — which is what
    /// makes `(style, text)` a correct cache key. Word wrapping is off, so the width never clips
    /// anything; it only has to be wider than the longest string the product draws.
    ///
    /// Not `f32::MAX`: DirectWrite does arithmetic on these bounds, and a value that overflows when
    /// something is added to it produces a layout whose metrics are `NaN`.
    const LAYOUT_BOX: f32 = 1.0e6;

    /// Lay out `text`, or return the cached layout for it.
    ///
    /// Read `Laid::width` for the tight width — a pill sized from the layout BOX would be a
    /// kilometre wide.
    pub fn lay_out(&self, text: &str, style: &Style) -> Option<Laid> {
        let key = (style.clone(), text.to_string());
        if let Some(found) = self.layouts.borrow().get(&key) {
            return Some(Laid {
                layout: found.layout.clone(),
                width: found.width,
                height: found.height,
            });
        }

        let format = self.format(style)?;
        let wide: Vec<u16> = text.encode_utf16().collect();
        let layout = unsafe {
            self.factory
                .CreateTextLayout(&wide, &format, Self::LAYOUT_BOX, Self::LAYOUT_BOX)
                .ok()?
        };
        if style.tracking_dips() != 0.0 {
            unsafe {
                if let Ok(typo) = layout.cast::<windows::Win32::Graphics::DirectWrite::IDWriteTextLayout1>() {
                    // Trailing spacing only, with no leading: tracking applied to both sides
                    // shifts the string half a step and un-centres it inside its own plate.
                    let _ = typo.SetCharacterSpacing(
                        0.0,
                        style.tracking_dips(),
                        0.0,
                        windows::Win32::Graphics::DirectWrite::DWRITE_TEXT_RANGE {
                            startPosition: 0,
                            length: wide.len() as u32,
                        },
                    );
                }
            }
        }

        if style.tabular {
            unsafe {
                if let Ok(typography) = self.factory.CreateTypography() {
                    let _ = typography.AddFontFeature(DWRITE_FONT_FEATURE {
                        nameTag: DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES,
                        parameter: 1,
                    });
                    let _ = layout.SetTypography(
                        &typography,
                        DWRITE_TEXT_RANGE {
                            startPosition: 0,
                            length: wide.len() as u32,
                        },
                    );
                }
            }
        }

        let mut metrics = DWRITE_TEXT_METRICS::default();
        unsafe { layout.GetMetrics(&mut metrics).ok()? };

        if self.layouts.borrow().len() >= LAYOUT_LIMIT {
            self.layouts.borrow_mut().clear();
        }
        let laid = Laid {
            layout: layout.clone(),
            width: metrics.width,
            height: metrics.height,
        };
        self.layouts.borrow_mut().insert(
            key,
            Laid {
                layout,
                width: laid.width,
                height: laid.height,
            },
        );
        Some(laid)
    }

    /// What the private collection actually contains, and what each role resolved to.
    ///
    /// For `--probe-fonts`. A family that failed to register is invisible at every other level —
    /// DirectWrite substitutes and draws something — so the only way to know the executable's own
    /// faces are the ones on screen is to ask.
    pub fn report(&self) -> Vec<String> {
        let mut lines = Vec::new();
        match self.bundled.as_ref() {
            None => lines.push("private collection: NOT BUILT".into()),
            Some(bundled) => unsafe {
                let count = bundled.collection.GetFontFamilyCount();
                lines.push(format!("private collection: {count} families"));
                for i in 0..count {
                    let Ok(family) = bundled.collection.GetFontFamily(i) else { continue };
                    let Ok(names) = family.GetFamilyNames() else { continue };
                    let len = names.GetStringLength(0).unwrap_or(0) as usize;
                    let mut buffer = vec![0u16; len + 1];
                    let name = if names.GetString(0, &mut buffer).is_ok() {
                        String::from_utf16_lossy(&buffer[..len])
                    } else {
                        "?".into()
                    };
                    lines.push(format!("  [{i}] {name} — {} faces", family.GetFontCount()));
                }
            },
        }
        for family in [Family::Display, Family::Ui, Family::Radial, Family::Mono] {
            let (name, collection) = self.resolve(family);
            lines.push(format!(
                "{family:?} -> {name:?} ({})",
                if collection.is_some() { "bundled" } else { "system" }
            ));
        }
        lines
    }

    /// Drop everything. Called on device loss and on a DPI change, where every cached layout was
    /// measured against the old scale.
    pub fn clear(&self) {
        self.formats.borrow_mut().clear();
        self.layouts.borrow_mut().clear();
    }
}

use windows::core::Interface;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_is_a_usable_key() {
        // Two styles that differ only in size must not collide, or a 12px label would be drawn
        // from an 11px layout.
        let a = Style::new(Family::Radial, 12.0, 500, Align::Center);
        let b = Style::new(Family::Radial, 11.0, 500, Align::Center);
        assert_ne!(a, b);
        assert_eq!(a, Style::new(Family::Radial, 12.0, 500, Align::Center));
    }

    #[test]
    fn tracking_is_relative_to_the_size() {
        // `-0.005em` has to mean a different number of DIPs at 11px and at 24px.
        let small = Style::new(Family::Radial, 11.0, 500, Align::Center).tracking(-0.005);
        let large = Style::new(Family::Radial, 22.0, 500, Align::Center).tracking(-0.005);
        assert!((large.tracking_dips() - 2.0 * small.tracking_dips()).abs() < 1e-6);
        assert!(small.tracking_dips() < 0.0);
    }

    #[test]
    fn every_family_names_a_system_fallback() {
        // The bundled face may be absent in a partial build; what must never happen is a family
        // list whose last entry is also unavailable, because then the metrics are unpredictable.
        for family in [Family::Display, Family::Ui, Family::Radial] {
            let candidates = family.candidates();
            assert!(candidates.len() >= 2, "{family:?} has no fallback");
            assert_eq!(
                *candidates.last().unwrap(),
                "Segoe UI",
                "{family:?} must end on a face every Windows install has"
            );
        }
    }
}
