//! Drawing primitives over a Direct2D device context.
//!
//! The whole of the product's painting goes through this. It exists for one reason: a D2D brush,
//! gradient-stop collection or geometry is a COM object, and creating one is a few microseconds —
//! negligible once, ruinous when it is per tile per frame. Everything here is either reused in
//! place (the solid brush, whose colour is set rather than whose instance is replaced) or cached
//! behind a key that changes only when the thing it describes does.
//!
//! The caches are deliberately keyed by VALUE and not by identity. A gradient keyed by "the scrim's
//! current stops" is rebuilt when the dimming slider moves and at no other time; keyed by the frame
//! it would be rebuilt sixty times a second to produce the same object.

use super::device::Gpu;
use super::lucide::GlyphCache;
use super::text::{Align, Style, TextCache};
use std::cell::RefCell;
use std::collections::HashMap;
use windows::core::Interface;
use windows::Foundation::Numerics::Matrix3x2;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_COLOR_F, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_BEGIN_HOLLOW, D2D1_FIGURE_END_CLOSED,
    D2D1_FILL_MODE_WINDING, D2D1_GRADIENT_STOP, D2D_POINT_2F, D2D_RECT_F, D2D_SIZE_F,
};
use windows::Win32::Graphics::Direct2D::{
    ID2D1Bitmap1, ID2D1Brush, ID2D1DeviceContext, ID2D1Effect, ID2D1GradientStopCollection1,
    ID2D1SolidColorBrush, ID2D1StrokeStyle1, D2D1_ANTIALIAS_MODE_ALIASED,
    D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
    D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_LARGE, D2D1_ARC_SIZE_SMALL,
    D2D1_BUFFER_PRECISION_8BPC_UNORM, D2D1_CAP_STYLE_ROUND,
    D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED, D2D1_COLOR_SPACE_SRGB, D2D1_DASH_STYLE_CUSTOM,
    D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ELLIPSE, D2D1_EXTEND_MODE_CLAMP,
    D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LAYER_OPTIONS1_NONE, D2D1_LAYER_PARAMETERS1,
    D2D1_LINE_JOIN_ROUND, D2D1_ROUNDED_RECT, D2D1_STROKE_STYLE_PROPERTIES1,
    D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE,
};
use windows::Win32::Graphics::Direct2D::{CLSID_D2D1Shadow, D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION, D2D1_SHADOW_PROP_COLOR};

/// A rectangle in DIPs, the way everything here passes one around.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Rect {
    pub fn new(left: f32, top: f32, right: f32, bottom: f32) -> Self {
        Self { left, top, right, bottom }
    }

    /// A box of `w` x `h` centred on `(x, y)`.
    pub fn centred(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self {
            left: x - w / 2.0,
            top: y - h / 2.0,
            right: x + w / 2.0,
            bottom: y + h / 2.0,
        }
    }

    pub fn width(&self) -> f32 {
        self.right - self.left
    }

    pub fn height(&self) -> f32 {
        self.bottom - self.top
    }

    pub fn center(&self) -> (f32, f32) {
        ((self.left + self.right) / 2.0, (self.top + self.bottom) / 2.0)
    }

    pub fn inflate(&self, by: f32) -> Self {
        Self {
            left: self.left - by,
            top: self.top - by,
            right: self.right + by,
            bottom: self.bottom + by,
        }
    }

    pub fn offset(&self, dx: f32, dy: f32) -> Self {
        Self {
            left: self.left + dx,
            top: self.top + dy,
            right: self.right + dx,
            bottom: self.bottom + dy,
        }
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    fn raw(&self) -> D2D_RECT_F {
        D2D_RECT_F {
            left: self.left,
            top: self.top,
            right: self.right,
            bottom: self.bottom,
        }
    }
}

/// One gradient stop, in the form the caches key on.
#[derive(Debug, Clone, Copy)]
pub struct Stop {
    pub offset: f32,
    pub color: D2D1_COLOR_F,
}

/// Hashable key for a set of stops. Floats by their bits: a gradient is either exactly the one
/// already built or a different gradient.
#[derive(Debug, PartialEq, Eq, Hash)]
struct StopsKey(Vec<(u32, u32, u32, u32, u32)>);

fn stops_key(stops: &[Stop]) -> StopsKey {
    StopsKey(
        stops
            .iter()
            .map(|s| {
                (
                    s.offset.to_bits(),
                    s.color.r.to_bits(),
                    s.color.g.to_bits(),
                    s.color.b.to_bits(),
                    s.color.a.to_bits(),
                )
            })
            .collect(),
    )
}

pub struct Painter<'a> {
    pub gpu: &'a Gpu,
    pub glyphs: &'a GlyphCache,
    pub text: &'a TextCache,
    /// One brush whose colour is set per draw. A brush per colour would be hundreds of COM objects
    /// for a wheel that never shows more than a dozen distinct colours at once.
    solid: ID2D1SolidColorBrush,
    gradients: RefCell<HashMap<StopsKey, ID2D1GradientStopCollection1>>,
    /// Round caps and joins, which every stroke in the product uses: Lucide's glyphs are drawn with
    /// them, and a square cap on a 1.75-weight stroke at 14px reads as a different icon.
    round_stroke: ID2D1StrokeStyle1,
}

impl<'a> Painter<'a> {
    pub fn new(gpu: &'a Gpu, glyphs: &'a GlyphCache, text: &'a TextCache) -> windows::core::Result<Self> {
        let solid = unsafe { gpu.d2d.CreateSolidColorBrush(&super::palette::rgb(0xFFFFFF), None)? };
        let round_stroke = unsafe {
            gpu.d2d_factory.CreateStrokeStyle(
                &D2D1_STROKE_STYLE_PROPERTIES1 {
                    startCap: D2D1_CAP_STYLE_ROUND,
                    endCap: D2D1_CAP_STYLE_ROUND,
                    dashCap: D2D1_CAP_STYLE_ROUND,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    ..Default::default()
                },
                None,
            )?
        };
        Ok(Self {
            gpu,
            glyphs,
            text,
            solid,
            gradients: RefCell::new(HashMap::with_capacity(8)),
            round_stroke,
        })
    }

    fn ctx(&self) -> &ID2D1DeviceContext {
        &self.gpu.d2d
    }

    fn brush(&self, color: D2D1_COLOR_F) -> &ID2D1SolidColorBrush {
        unsafe { self.solid.SetColor(&color) };
        &self.solid
    }

    // ── Fills and strokes ───────────────────────────────────────────────────

    pub fn fill_rect(&self, rect: Rect, color: D2D1_COLOR_F) {
        unsafe { self.ctx().FillRectangle(&rect.raw(), self.brush(color)) };
    }

    pub fn fill_round_rect(&self, rect: Rect, radius: f32, color: D2D1_COLOR_F) {
        let rr = D2D1_ROUNDED_RECT {
            rect: rect.raw(),
            radiusX: radius,
            radiusY: radius,
        };
        unsafe { self.ctx().FillRoundedRectangle(&rr, self.brush(color)) };
    }

    /// The same shape, filled with a gradient instead of a colour.
    ///
    /// The alternative — fill flat, then paint the gradient over an inset rect — leaves either a
    /// square corner or a seam wherever the gradient has not reached its last stop by the inset.
    pub fn fill_round_rect_with(&self, rect: Rect, radius: f32, brush: &ID2D1Brush) {
        let rr = D2D1_ROUNDED_RECT {
            rect: rect.raw(),
            radiusX: radius,
            radiusY: radius,
        };
        unsafe { self.ctx().FillRoundedRectangle(&rr, brush) };
    }

    /// A stroked rounded rect. `width` is centred on the path, as D2D strokes always are — so a
    /// 1px border on a rect inset by 0.5 lands exactly on the pixel grid.
    pub fn stroke_round_rect(&self, rect: Rect, radius: f32, color: D2D1_COLOR_F, width: f32) {
        let rr = D2D1_ROUNDED_RECT {
            rect: rect.raw(),
            radiusX: radius,
            radiusY: radius,
        };
        unsafe {
            self.ctx()
                .DrawRoundedRectangle(&rr, self.brush(color), width, None)
        };
    }

    pub fn fill_circle(&self, center: (f32, f32), radius: f32, color: D2D1_COLOR_F) {
        let ellipse = D2D1_ELLIPSE {
            point: D2D_POINT_2F { x: center.0, y: center.1 },
            radiusX: radius,
            radiusY: radius,
        };
        unsafe { self.ctx().FillEllipse(&ellipse, self.brush(color)) };
    }

    pub fn stroke_circle(&self, center: (f32, f32), radius: f32, color: D2D1_COLOR_F, width: f32) {
        let ellipse = D2D1_ELLIPSE {
            point: D2D_POINT_2F { x: center.0, y: center.1 },
            radiusX: radius,
            radiusY: radius,
        };
        unsafe {
            self.ctx()
                .DrawEllipse(&ellipse, self.brush(color), width, None)
        };
    }

    pub fn line(&self, from: (f32, f32), to: (f32, f32), color: D2D1_COLOR_F, width: f32) {
        unsafe {
            self.ctx().DrawLine(
                D2D_POINT_2F { x: from.0, y: from.1 },
                D2D_POINT_2F { x: to.0, y: to.1 },
                self.brush(color),
                width,
                &self.round_stroke,
            )
        };
    }

    // ── Gradients ───────────────────────────────────────────────────────────

    fn stop_collection(
        &self,
        stops: &[Stop],
    ) -> Option<ID2D1GradientStopCollection1> {
        let key = stops_key(stops);
        if let Some(found) = self.gradients.borrow().get(&key) {
            return Some(found.clone());
        }
        let raw: Vec<D2D1_GRADIENT_STOP> = stops
            .iter()
            .map(|s| D2D1_GRADIENT_STOP {
                position: s.offset,
                color: s.color,
            })
            .collect();
        let collection = unsafe {
            self.ctx()
                .CreateGradientStopCollection(
                    &raw,
                    // sRGB in and out, interpolated PREMULTIPLIED — which is what a CSS gradient
                    // does, and what the alphas in `sectors.rs` and `scrim.rs` were calibrated
                    // against. Interpolating in linear space instead (D2D's other option) lightens
                    // the middle of every fade, and these fades are most of what the wheel draws.
                    D2D1_COLOR_SPACE_SRGB,
                    D2D1_COLOR_SPACE_SRGB,
                    D2D1_BUFFER_PRECISION_8BPC_UNORM,
                    D2D1_EXTEND_MODE_CLAMP,
                    D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED,
                )
                .ok()?
        };
        self.gradients
            .borrow_mut()
            .insert(key, collection.clone());
        Some(collection)
    }

    /// A radial gradient brush centred on `center` with radius `radius`.
    ///
    /// The brush itself is NOT cached — only its stop collection is, which is the expensive half.
    /// A brush carries the centre and radius, which change with the wheel's position, so caching it
    /// would mean a cache entry per position.
    pub fn radial_brush(
        &self,
        center: (f32, f32),
        radius: f32,
        stops: &[Stop],
    ) -> Option<ID2D1Brush> {
        let collection = self.stop_collection(stops)?;
        let brush = unsafe {
            self.ctx()
                .CreateRadialGradientBrush(
                    &windows::Win32::Graphics::Direct2D::D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES {
                        center: D2D_POINT_2F { x: center.0, y: center.1 },
                        gradientOriginOffset: D2D_POINT_2F { x: 0.0, y: 0.0 },
                        radiusX: radius,
                        radiusY: radius,
                    },
                    None,
                    &collection,
                )
                .ok()?
        };
        Some(brush.cast().ok()?)
    }

    pub fn linear_brush(
        &self,
        from: (f32, f32),
        to: (f32, f32),
        stops: &[Stop],
    ) -> Option<ID2D1Brush> {
        let collection = self.stop_collection(stops)?;
        let brush = unsafe {
            self.ctx()
                .CreateLinearGradientBrush(
                    &windows::Win32::Graphics::Direct2D::D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                        startPoint: D2D_POINT_2F { x: from.0, y: from.1 },
                        endPoint: D2D_POINT_2F { x: to.0, y: to.1 },
                    },
                    None,
                    &collection,
                )
                .ok()?
        };
        Some(brush.cast().ok()?)
    }

    pub fn fill_rect_with(&self, rect: Rect, brush: &ID2D1Brush) {
        unsafe { self.ctx().FillRectangle(&rect.raw(), brush) };
    }

    // ── Glyphs ──────────────────────────────────────────────────────────────

    /// Draw a Lucide glyph, stroked, fitted to `box_size` and centred on `center`.
    ///
    /// `weight` is in the glyph's own 24-unit space, which is what keeps a 24px dock icon and a
    /// 64px tile reading as the same drawing: a constant PIXEL weight would make the small one look
    /// like a different, bolder icon.
    pub fn glyph(
        &self,
        name: &str,
        center: (f32, f32),
        box_size: f32,
        color: D2D1_COLOR_F,
        weight: f32,
    ) {
        let Some(geometry) = self.glyphs.geometry(&self.gpu.d2d_factory, name) else {
            return;
        };
        let scale = box_size / super::lucide_data::VIEWBOX;
        let ctx = self.ctx();
        unsafe {
            let mut saved = windows::Foundation::Numerics::Matrix3x2::identity();
            ctx.GetTransform(&mut saved);
            // Translate so the glyph's own 24x24 box is centred, then scale. The stroke is scaled
            // with it, which is why `weight` is expressed in glyph units.
            let placed = windows::Foundation::Numerics::Matrix3x2 {
                M11: scale,
                M12: 0.0,
                M21: 0.0,
                M22: scale,
                M31: center.0 - box_size / 2.0,
                M32: center.1 - box_size / 2.0,
            };
            ctx.SetTransform(&(placed * saved));
            ctx.DrawGeometry(&geometry, self.brush(color), weight, &self.round_stroke);
            ctx.SetTransform(&saved);
        }
    }

    /// Clip everything drawn from here to `rect`, until the matching `pop_clip`.
    ///
    /// A scroller's overflow. Pushed and popped rather than wrapping a closure, because the thing
    /// being clipped is a whole page of the settings panel laid out by sixty call sites, and a
    /// closure around that borrows the frame those call sites are already holding.
    ///
    /// Aliased, not antialiased: the edge is a viewport boundary that sits on the pixel grid
    /// under a hairline, and a half-covered row of pixels there reads as a blurred seam.
    pub fn push_clip(&self, rect: Rect) {
        unsafe {
            self.ctx()
                .PushAxisAlignedClip(&rect.raw(), D2D1_ANTIALIAS_MODE_ALIASED)
        };
    }

    /// Drop the clip the last `push_clip` pushed. Every push needs exactly one of these before
    /// the frame ends, or D2D fails the whole `EndDraw` and the frame is dropped silently.
    pub fn pop_clip(&self) {
        unsafe { self.ctx().PopAxisAlignedClip() };
    }

    /// Run `body` with everything drawn into `rect`, scaled about `origin`.
    ///
    /// What the settings preview is built on. The point of it is that the preview is a scaled
    /// PHOTOGRAPH of the wheel and not a drawing of one: the geometry is computed at full size
    /// against the real screen, by the same code the wheel uses, and only the last step makes it
    /// small. A second surface with its own constants drifts, and drifts silently.
    pub fn scaled_clip(&self, rect: Rect, scale: f32, origin: (f32, f32), body: impl FnOnce()) {
        let ctx = &self.gpu.d2d;
        unsafe {
            ctx.PushAxisAlignedClip(
                &windows::Win32::Graphics::Direct2D::Common::D2D_RECT_F {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                },
                windows::Win32::Graphics::Direct2D::D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
            );
            let mut saved = windows::Foundation::Numerics::Matrix3x2::default();
            ctx.GetTransform(&mut saved);
            // Scale about `origin`, then put `origin` at the middle of `rect`.
            let centre = rect.center();
            let placed = windows::Foundation::Numerics::Matrix3x2 {
                M11: scale,
                M12: 0.0,
                M21: 0.0,
                M22: scale,
                M31: centre.0 - origin.0 * scale,
                M32: centre.1 - origin.1 * scale,
            };
            ctx.SetTransform(&(placed * saved));
            body();
            ctx.SetTransform(&saved);
            ctx.PopAxisAlignedClip();
        }
    }

    // ── Text ────────────────────────────────────────────────────────────────

    /// Draw `body` inside `rect`, aligned horizontally by the style.
    ///
    /// Vertical placement is the CALLER's: every site here centres the text in a plate it has
    /// already sized from `measure`, and a second opinion about the vertical centre is how a pill's
    /// text ends up one pixel off its own box.
    pub fn text(&self, body: &str, rect: Rect, style: &Style, color: D2D1_COLOR_F) {
        let Some(laid) = self.text.lay_out(body, style) else {
            return;
        };
        // The layout is always leading-aligned in a box far wider than the text, so alignment is
        // an offset applied here rather than a property of the layout. See `text.rs` for why.
        let x = match style.align {
            // "Leading" is the edge the language starts from, which is the right one for Arabic.
            Align::Leading if style.rtl => rect.right - laid.width,
            Align::Leading => rect.left,
            Align::Center => rect.left + (rect.width() - laid.width) / 2.0,
            Align::Trailing => rect.right - laid.width,
        };
        unsafe {
            self.ctx().DrawTextLayout(
                D2D_POINT_2F { x, y: rect.top },
                &laid.layout,
                self.brush(color),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            )
        };
    }

    /// The tight size `body` would take, for sizing a plate around it.
    pub fn measure(&self, body: &str, style: &Style) -> (f32, f32) {
        self.text
            .lay_out(body, style)
            .map(|l| (l.width, l.height))
            .unwrap_or((0.0, 0.0))
    }

    // ── Bitmaps ─────────────────────────────────────────────────────────────

    pub fn bitmap(&self, rect: Rect, bitmap: &ID2D1Bitmap1, opacity: f32) {
        if opacity <= 0.002 {
            return;
        }
        unsafe {
            self.ctx().DrawBitmap(
                bitmap,
                Some(&rect.raw()),
                opacity,
                D2D1_INTERPOLATION_MODE_LINEAR,
                None,
                None,
            )
        };
    }

    /// A bitmap clipped to a rounded rectangle.
    ///
    /// Used for extracted app icons, which are square and may be opaque to their own edges. Without
    /// the clip, an icon drawn to fill a rounded tile has four square corners sticking out of it.
    pub fn bitmap_rounded(&self, rect: Rect, bitmap: &ID2D1Bitmap1, opacity: f32, radius: f32) {
        if opacity <= 0.002 {
            return;
        }
        let Some(clip) = self.rounded_geometry(rect, radius) else {
            self.bitmap(rect, bitmap, opacity);
            return;
        };
        let Ok(mask) = clip.cast::<windows::Win32::Graphics::Direct2D::ID2D1Geometry>() else {
            self.bitmap(rect, bitmap, opacity);
            return;
        };
        unsafe {
            let ctx = self.ctx();
            ctx.PushLayer(
                &D2D1_LAYER_PARAMETERS1 {
                    contentBounds: rect.inflate(1.0).raw(),
                    geometricMask: std::mem::ManuallyDrop::new(Some(mask)),
                    maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                    maskTransform: Matrix3x2::identity(),
                    opacity: 1.0,
                    opacityBrush: std::mem::ManuallyDrop::new(None),
                    layerOptions: D2D1_LAYER_OPTIONS1_NONE,
                },
                None,
            );
            self.bitmap(rect, bitmap, opacity);
            ctx.PopLayer();
        }
    }

    fn rounded_geometry(
        &self,
        rect: Rect,
        radius: f32,
    ) -> Option<windows::Win32::Graphics::Direct2D::ID2D1RoundedRectangleGeometry> {
        unsafe {
            self.gpu
                .d2d_factory
                .CreateRoundedRectangleGeometry(&D2D1_ROUNDED_RECT {
                    rect: rect.raw(),
                    radiusX: radius,
                    radiusY: radius,
                })
                .ok()
        }
    }

    pub fn line_with(&self, from: (f32, f32), to: (f32, f32), brush: &ID2D1Brush, width: f32) {
        unsafe {
            self.ctx().DrawLine(
                D2D_POINT_2F { x: from.0, y: from.1 },
                D2D_POINT_2F { x: to.0, y: to.1 },
                brush,
                width,
                &self.round_stroke,
            )
        };
    }

    /// One annular wedge: filled with `fill`, outlined with `edge`, and multiplied by `mask`.
    ///
    /// The mask is an OPACITY BRUSH on a layer, which is D2D's equivalent of the SVG `mask` the
    /// original used. It is what lets the fill lean along the wedge's bisector while still arriving
    /// at nothing on a circle — see `sectors::beam_stops` for why those cannot be one gradient.
    ///
    /// One layer for the lit wedge, not one per wedge: only ever a single wedge is lit, and the
    /// layer's bounds are the ring's box rather than the window's, so the cost is the wedge's own
    /// area and not the monitor's.
    ///
    /// `full_ring` stitches the shape from two half-arcs: a single arc whose two endpoints coincide
    /// draws nothing at all, so a one-item wheel would otherwise get no area.
    #[allow(clippy::too_many_arguments)]
    pub fn wedge(
        &self,
        center: (f32, f32),
        inner: f32,
        outer: f32,
        start_deg: f32,
        end_deg: f32,
        fill: &ID2D1Brush,
        edge: &ID2D1Brush,
        mask: Option<&ID2D1Brush>,
        stroke_width: f32,
        full_ring: bool,
    ) {
        let Some(geometry) =
            self.wedge_geometry(center, inner, outer, start_deg, end_deg, full_ring)
        else {
            return;
        };
        let bounds = Rect::new(
            center.0 - outer,
            center.1 - outer,
            center.0 + outer,
            center.1 + outer,
        );
        unsafe {
            let ctx = self.ctx();
            let layered = mask.is_some();
            if let Some(mask) = mask {
                ctx.PushLayer(
                    &D2D1_LAYER_PARAMETERS1 {
                        contentBounds: bounds.raw(),
                        geometricMask: std::mem::ManuallyDrop::new(None),
                        maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                        maskTransform: Matrix3x2::identity(),
                        opacity: 1.0,
                        opacityBrush: std::mem::ManuallyDrop::new(Some(mask.clone())),
                        layerOptions: D2D1_LAYER_OPTIONS1_NONE,
                    },
                    None,
                );
            }
            ctx.FillGeometry(&geometry, fill, None);
            // The fill alone made a soft blob: a lit AREA needs the angle it occupies to be
            // visible, and that angle is carried entirely by its edges.
            ctx.DrawGeometry(&geometry, edge, stroke_width, None);
            if layered {
                ctx.PopLayer();
            }
        }
    }

    fn wedge_geometry(
        &self,
        center: (f32, f32),
        inner: f32,
        outer: f32,
        start_deg: f32,
        end_deg: f32,
        full_ring: bool,
    ) -> Option<windows::Win32::Graphics::Direct2D::ID2D1PathGeometry1> {
        use std::f32::consts::PI;
        let at = |radius: f32, deg: f32| {
            let rad = deg * PI / 180.0;
            D2D_POINT_2F {
                x: center.0 + radius * rad.cos(),
                y: center.1 + radius * rad.sin(),
            }
        };
        unsafe {
            let geometry = self.gpu.d2d_factory.CreatePathGeometry().ok()?;
            let sink = geometry.Open().ok()?;
            sink.SetFillMode(D2D1_FILL_MODE_WINDING);
            if full_ring {
                for (radius, direction) in [
                    (outer, D2D1_SWEEP_DIRECTION_CLOCKWISE),
                    (inner, D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE),
                ] {
                    sink.BeginFigure(at(radius, 0.0), D2D1_FIGURE_BEGIN_FILLED);
                    for half in [180.0f32, 360.0] {
                        sink.AddArc(&D2D1_ARC_SEGMENT {
                            point: at(radius, half),
                            size: D2D_SIZE_F { width: radius, height: radius },
                            rotationAngle: 0.0,
                            sweepDirection: direction,
                            arcSize: D2D1_ARC_SIZE_SMALL,
                        });
                    }
                    sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                }
            } else {
                let large = if end_deg - start_deg > 180.0 {
                    D2D1_ARC_SIZE_LARGE
                } else {
                    D2D1_ARC_SIZE_SMALL
                };
                sink.BeginFigure(at(inner, start_deg), D2D1_FIGURE_BEGIN_FILLED);
                sink.AddLine(at(outer, start_deg));
                sink.AddArc(&D2D1_ARC_SEGMENT {
                    point: at(outer, end_deg),
                    size: D2D_SIZE_F { width: outer, height: outer },
                    rotationAngle: 0.0,
                    sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
                    arcSize: large,
                });
                sink.AddLine(at(inner, end_deg));
                sink.AddArc(&D2D1_ARC_SEGMENT {
                    point: at(inner, start_deg),
                    size: D2D_SIZE_F { width: inner, height: inner },
                    rotationAngle: 0.0,
                    sweepDirection: D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE,
                    arcSize: large,
                });
                sink.EndFigure(D2D1_FIGURE_END_CLOSED);
            }
            sink.Close().ok()?;
            Some(geometry)
        }
    }

    /// A rounded rectangle rotated about its own centre.
    pub fn rotated_round_rect(&self, rect: Rect, radius: f32, degrees: f32, color: D2D1_COLOR_F) {
        let (cx, cy) = rect.center();
        unsafe {
            let ctx = self.ctx();
            let mut saved = Matrix3x2::identity();
            ctx.GetTransform(&mut saved);
            let radians = degrees * std::f32::consts::PI / 180.0;
            let (sin, cos) = radians.sin_cos();
            let spin = Matrix3x2 {
                M11: cos,
                M12: sin,
                M21: -sin,
                M22: cos,
                M31: cx - cx * cos + cy * sin,
                M32: cy - cx * sin - cy * cos,
            };
            ctx.SetTransform(&(spin * saved));
            self.fill_round_rect(rect, radius, color);
            ctx.SetTransform(&saved);
        }
    }

    /// A partial stroke along a rounded rectangle's perimeter, starting at TOP-CENTRE.
    ///
    /// Starting at top-centre is the whole reason this is a path rather than a rounded-rect stroke:
    /// a rounded rect's implicit path begins after its top-left corner arc, so a progress ring
    /// built on one filled from an offset that moved with the tile's size — and a clock that does
    /// not start at twelve reads as a bug.
    ///
    /// The partial stroke is a DASH pattern sized from the path's measured length, which is exact
    /// and costs one `ComputeLength` rather than a geometry rebuilt per frame.
    pub fn round_rect_arc(
        &self,
        rect: Rect,
        radius: f32,
        progress: f32,
        color: D2D1_COLOR_F,
        width: f32,
    ) {
        let progress = progress.clamp(0.0, 1.0);
        if progress <= 0.0 || width <= 0.0 {
            return;
        }
        let Some(geometry) = self.arc_geometry(rect, radius) else {
            return;
        };
        unsafe {
            if progress >= 1.0 {
                self.ctx()
                    .DrawGeometry(&geometry, self.brush(color), width, None);
                return;
            }
            let Ok(length) = geometry.ComputeLength(None, 1.0) else {
                return;
            };
            // Dash lengths are in multiples of the stroke width, which is why both terms divide by
            // it. A zero-length dash is invalid, so the floor keeps a just-started arc drawable.
            let on = (length * progress / width).max(0.01);
            let off = (length * (1.0 - progress) / width).max(0.01);
            let Ok(style) = self.gpu.d2d_factory.CreateStrokeStyle(
                &D2D1_STROKE_STYLE_PROPERTIES1 {
                    startCap: D2D1_CAP_STYLE_ROUND,
                    endCap: D2D1_CAP_STYLE_ROUND,
                    dashCap: D2D1_CAP_STYLE_ROUND,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    dashStyle: D2D1_DASH_STYLE_CUSTOM,
                    dashOffset: 0.0,
                    ..Default::default()
                },
                Some(&[on, off]),
            ) else {
                return;
            };
            self.ctx()
                .DrawGeometry(&geometry, self.brush(color), width, &style);
        }
    }

    /// A rounded rectangle whose path STARTS at the top edge's midpoint and runs clockwise.
    fn arc_geometry(
        &self,
        rect: Rect,
        radius: f32,
    ) -> Option<windows::Win32::Graphics::Direct2D::ID2D1PathGeometry1> {
        let r = radius
            .max(0.0)
            .min(rect.width() / 2.0)
            .min(rect.height() / 2.0);
        let (mid_x, _) = rect.center();
        let point = |x: f32, y: f32| D2D_POINT_2F { x, y };
        let arc = |x: f32, y: f32| D2D1_ARC_SEGMENT {
            point: point(x, y),
            size: D2D_SIZE_F { width: r, height: r },
            rotationAngle: 0.0,
            sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
            arcSize: D2D1_ARC_SIZE_SMALL,
        };
        unsafe {
            let geometry = self.gpu.d2d_factory.CreatePathGeometry().ok()?;
            let sink = geometry.Open().ok()?;
            sink.BeginFigure(point(mid_x, rect.top), D2D1_FIGURE_BEGIN_HOLLOW);
            sink.AddLine(point(rect.right - r, rect.top));
            sink.AddArc(&arc(rect.right, rect.top + r));
            sink.AddLine(point(rect.right, rect.bottom - r));
            sink.AddArc(&arc(rect.right - r, rect.bottom));
            sink.AddLine(point(rect.left + r, rect.bottom));
            sink.AddArc(&arc(rect.left, rect.bottom - r));
            sink.AddLine(point(rect.left, rect.top + r));
            sink.AddArc(&arc(rect.left + r, rect.top));
            sink.EndFigure(D2D1_FIGURE_END_CLOSED);
            sink.Close().ok()?;
            Some(geometry)
        }
    }

    pub fn antialias_on(&self) {
        unsafe {
            self.ctx()
                .SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE)
        };
    }

    /// Clear the whole target to transparent.
    ///
    /// Not to any colour: the overlay is a per-pixel-alpha surface and everything outside the scrim
    /// has to be a hole the desktop shows through. Clearing to an opaque colour is how a
    /// composition surface ends up as a black rectangle over the screen.
    pub fn clear(&self) {
        unsafe { self.ctx().Clear(Some(&super::palette::TRANSPARENT)) };
    }
}

/// A pre-rendered soft shadow for one shape, baked once and blitted per use.
///
/// D2D's shadow effect re-runs the blur on every `DrawImage` unless its inputs are unchanged AND
/// the effect's output is cached, and a monitor-sized frame with a dozen tiles would run it a dozen
/// times. The silhouettes here are identical for every tile on the wheel, so the blur is run once
/// per SIZE and the result is a bitmap — one `DrawBitmap` per tile, which is a textured quad.
pub struct ShadowCache {
    baked: RefCell<HashMap<(u32, u32, u32, u32), ID2D1Bitmap1>>,
}

impl ShadowCache {
    pub fn new() -> Self {
        Self {
            baked: RefCell::new(HashMap::with_capacity(4)),
        }
    }

    /// The padding around the silhouette, so the blur has room to fall off inside the bitmap.
    ///
    /// Three standard deviations is where a Gaussian is under 1% — cutting it closer leaves a
    /// visible straight edge where the bitmap ends, which on a shadow reads as a seam under every
    /// tile.
    fn padding(blur: f32) -> f32 {
        (blur * 3.0).ceil()
    }

    /// Bake a rounded-rect shadow, if it is not already baked.
    ///
    /// **Only ever called OUTSIDE a `BeginDraw`/`EndDraw` pair.** Baking re-targets the device
    /// context, and a nested draw on one context fails the whole frame with `D2DERR_WRONG_STATE` —
    /// which, because `EndDraw`'s result is easy to ignore, shows up as a frame that silently did
    /// not draw rather than as an error.
    ///
    /// That is why baking and fetching are two methods instead of one `get_or_insert`. A single
    /// method would be called from inside the frame the moment a size it had not seen came up, and
    /// the sizes DO change mid-frame: a tile is scaled by the bloom, so every frame of an opening
    /// wheel asks for a size no prebake could have predicted. Splitting them makes the nesting
    /// structurally impossible instead of merely avoided.
    pub fn bake_rounded(
        &self,
        gpu: &Gpu,
        size: (f32, f32),
        radius: f32,
        blur: f32,
        color: D2D1_COLOR_F,
    ) {
        let key = Self::key(size, radius, blur);
        if self.baked.borrow().contains_key(&key) {
            return;
        }
        let padding = Self::padding(blur);
        let full = (
            (size.0 + padding * 2.0).ceil() as u32,
            (size.1 + padding * 2.0).ceil() as u32,
        );
        let Some(silhouette) = bake(gpu, full, |p| {
            p.fill_round_rect(
                Rect::new(padding, padding, padding + size.0, padding + size.1),
                radius,
                color,
            );
        }) else {
            return;
        };
        if let Some(blurred) = apply_shadow(gpu, &silhouette, full, blur, color) {
            self.baked.borrow_mut().insert(key, blurred);
        }
    }

    /// Fetch a baked shadow. Never bakes, so it is safe inside a frame.
    ///
    /// A miss returns `None` and the caller simply draws no shadow for that frame. That is the
    /// right failure: the shadow is separation, not information, and one frame without it is
    /// invisible where a dropped frame is not.
    pub fn rounded(
        &self,
        size: (f32, f32),
        radius: f32,
        blur: f32,
    ) -> Option<(ID2D1Bitmap1, f32)> {
        let key = Self::key(size, radius, blur);
        let found = self.baked.borrow().get(&key).cloned()?;
        Some((found, Self::padding(blur)))
    }

    fn key(size: (f32, f32), radius: f32, blur: f32) -> (u32, u32, u32, u32) {
        (
            size.0.to_bits(),
            size.1.to_bits(),
            radius.to_bits(),
            blur.to_bits(),
        )
    }

    pub fn clear(&self) {
        self.baked.borrow_mut().clear();
    }
}

impl Default for ShadowCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Render `draw` into a fresh bitmap of `size` physical pixels.
fn bake(
    gpu: &Gpu,
    size: (u32, u32),
    draw: impl FnOnce(&Painter),
) -> Option<ID2D1Bitmap1> {
    use windows::Win32::Graphics::Direct2D::Common::{
        D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
    };
    use windows::Win32::Graphics::Direct2D::{
        D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN};

    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        // 96 DPI: this bitmap's coordinates are its own pixels, and the caller has already baked
        // the monitor's scale into `size`. A DPI here would scale it twice.
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let _ = DXGI_FORMAT_UNKNOWN;
    unsafe {
        let bitmap = gpu
            .d2d
            .CreateBitmap(
                windows::Win32::Graphics::Direct2D::Common::D2D_SIZE_U {
                    width: size.0,
                    height: size.1,
                },
                None,
                0,
                &properties,
            )
            .ok()?;
        let previous = gpu.d2d.GetTarget().ok();
        gpu.d2d.SetTarget(&bitmap);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&super::palette::TRANSPARENT));
        {
            // A painter with empty caches: baking draws shapes, never glyphs or text.
            let glyphs = GlyphCache::new();
            let text = TextCache::new(gpu.dwrite.clone());
            if let Ok(painter) = Painter::new(gpu, &glyphs, &text) {
                draw(&painter);
            }
        }
        let _ = gpu.d2d.EndDraw(None, None);
        match previous {
            Some(target) => gpu.d2d.SetTarget(&target),
            None => gpu.d2d.SetTarget(None),
        }
        Some(bitmap)
    }
}

/// Run the shadow effect over `source` and bake the result.
fn apply_shadow(
    gpu: &Gpu,
    source: &ID2D1Bitmap1,
    size: (u32, u32),
    blur: f32,
    color: D2D1_COLOR_F,
) -> Option<ID2D1Bitmap1> {
    use windows::Win32::Graphics::Direct2D::Common::{
        D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
    };
    use windows::Win32::Graphics::Direct2D::{
        D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

    unsafe {
        let effect: ID2D1Effect = gpu.d2d.CreateEffect(&CLSID_D2D1Shadow).ok()?;
        effect.SetInput(0, source, true);
        // The standard deviation, not the CSS blur radius: CSS's "blur" is roughly two standard
        // deviations, so passing the CSS number straight through doubles the softness.
        effect
            .SetValue(
                D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION.0 as u32,
                windows::Win32::Graphics::Direct2D::D2D1_PROPERTY_TYPE_FLOAT,
                &(blur / 2.0).to_le_bytes(),
            )
            .ok()?;
        let rgba = [color.r, color.g, color.b, color.a];
        let bytes: Vec<u8> = rgba.iter().flat_map(|c| c.to_le_bytes()).collect();
        effect
            .SetValue(
                D2D1_SHADOW_PROP_COLOR.0 as u32,
                windows::Win32::Graphics::Direct2D::D2D1_PROPERTY_TYPE_VECTOR4,
                &bytes,
            )
            .ok()?;

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
        let out = gpu
            .d2d
            .CreateBitmap(
                windows::Win32::Graphics::Direct2D::Common::D2D_SIZE_U {
                    width: size.0,
                    height: size.1,
                },
                None,
                0,
                &properties,
            )
            .ok()?;
        let previous = gpu.d2d.GetTarget().ok();
        gpu.d2d.SetTarget(&out);
        gpu.d2d.BeginDraw();
        gpu.d2d.Clear(Some(&super::palette::TRANSPARENT));
        let output = effect.GetOutput().ok()?;
        gpu.d2d.DrawImage(
            &output,
            None,
            None,
            D2D1_INTERPOLATION_MODE_LINEAR,
            windows::Win32::Graphics::Direct2D::Common::D2D1_COMPOSITE_MODE_SOURCE_OVER,
        );
        let _ = gpu.d2d.EndDraw(None, None);
        match previous {
            Some(target) => gpu.d2d.SetTarget(&target),
            None => gpu.d2d.SetTarget(None),
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centred_rects_are_centred() {
        let r = Rect::centred(100.0, 50.0, 40.0, 20.0);
        assert_eq!((r.left, r.top, r.right, r.bottom), (80.0, 40.0, 120.0, 60.0));
        assert_eq!(r.center(), (100.0, 50.0));
        assert_eq!((r.width(), r.height()), (40.0, 20.0));
    }

    #[test]
    fn containment_is_half_open() {
        // Half-open on both axes, so two adjacent hit targets cannot both claim a pixel.
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(r.contains(0.0, 0.0));
        assert!(r.contains(9.99, 9.99));
        assert!(!r.contains(10.0, 5.0));
        assert!(!r.contains(5.0, 10.0));
        assert!(!r.contains(-0.01, 5.0));
    }

    #[test]
    fn stop_keys_distinguish_what_matters() {
        let a = [Stop { offset: 0.0, color: super::super::palette::rgba(0xFF0000, 1.0) }];
        let b = [Stop { offset: 0.0, color: super::super::palette::rgba(0xFF0000, 0.5) }];
        assert_ne!(stops_key(&a), stops_key(&b), "alpha must not collide");
        let c = [Stop { offset: 0.5, color: super::super::palette::rgba(0xFF0000, 1.0) }];
        assert_ne!(stops_key(&a), stops_key(&c), "offset must not collide");
        assert_eq!(stops_key(&a), stops_key(&a.clone()));
    }

    #[test]
    fn shadow_padding_clears_the_gaussian() {
        // Cutting closer than three standard deviations leaves a straight edge where the bitmap
        // ends, which under every tile reads as a seam.
        assert_eq!(ShadowCache::padding(10.0), 30.0);
        assert!(ShadowCache::padding(11.0) >= 33.0);
    }
}

impl Painter<'_> {
    /// Run `draw` with every pixel it produces multiplied by `mask`'s alpha.
    ///
    /// D2D's equivalent of an SVG `mask`. The brush's ALPHA channel is what multiplies; its colour
    /// is ignored, which is why the masks in this program are all white.
    pub fn masked(&self, bounds: Rect, mask: &ID2D1Brush, draw: impl FnOnce(&Self)) {
        unsafe {
            let ctx = self.ctx();
            ctx.PushLayer(
                &D2D1_LAYER_PARAMETERS1 {
                    contentBounds: bounds.raw(),
                    geometricMask: std::mem::ManuallyDrop::new(None),
                    maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                    maskTransform: Matrix3x2::identity(),
                    opacity: 1.0,
                    opacityBrush: std::mem::ManuallyDrop::new(Some(mask.clone())),
                    layerOptions: D2D1_LAYER_OPTIONS1_NONE,
                },
                None,
            );
            draw(self);
            ctx.PopLayer();
        }
    }
}
