//! Pictures the compositor animates on its own clock.
//!
//! **The problem this exists for.** Every animation in this program is drawn frame by frame, and
//! a frame is only on screen once the GPU has finished drawing it. When something else has the
//! GPU, that stops being a formality: measured on a GTX 1660 with an image generator holding it at
//! 100%, the wheel's frames — under a millisecond of work each — waited a median of 6 ms and up to
//! 17 ms for a turn on the GPU, so they reached the screen 4 to 25 ms apart instead of every
//! refresh, and the launch echo's rings grew in visible steps. Raising the process's GPU priority
//! did not change those numbers. The compositor itself, measured at the same moment, was still
//! putting a frame on the 240 Hz display almost every 4.2 ms.
//!
//! So the launch echo is handed to the compositor. It is the one animation that can be: it is the
//! only one that cannot be redirected mid-flight, because by the time it starts the launch has
//! been decided. Its parts are painted ONCE, a picture per group that fades at one rate, and the
//! compositor is given each picture with a curve for its opacity — and, for the rings, its scale.
//! It samples those curves when it composes, which is every refresh, however busy the GPU is with
//! someone else's work: the wheel draws nothing more until the echo has finished.
//!
//! **The swap is one commit.** The pictures replace the window's own frames in a single
//! transaction: they are added and the swapchain is taken off the window together. Showing the
//! pictures over the last frame first, even for a refresh, would show every translucent pixel of
//! the wheel twice; taking the frame away first would show nothing at all.

use super::device::{Gpu, Surface};
use windows::core::{Interface, Result};
use windows::Foundation::Numerics::Matrix3x2;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_PIXEL_FORMAT, D2D_RECT_F,
};
use windows::Win32::Graphics::Direct2D::{
    ID2D1CommandList, D2D1_ANTIALIAS_MODE_ALIASED, D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
    D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1, D2D1_INTERPOLATION_MODE_LINEAR,
};
use windows::Win32::Graphics::DirectComposition::{
    IDCompositionAnimation, IDCompositionSurface, IDCompositionVisual, IDCompositionVisual2,
    IDCompositionVisual3, DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR,
    DCOMPOSITION_BORDER_MODE_SOFT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM};
use windows::Win32::Graphics::Dxgi::IDXGISurface;

/// A value that holds at `before` until `start`, then moves in a straight line from `from` to
/// `to`, arriving at `end` and staying there. Times in seconds from the commit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ramp {
    pub before: f32,
    pub from: f32,
    pub to: f32,
    pub start: f64,
    pub end: f64,
}

impl Ramp {
    /// The value at `t` seconds, as the compositor will evaluate it.
    #[cfg(test)]
    pub fn at(&self, t: f64) -> f32 {
        if t < self.start {
            self.before
        } else if t >= self.end {
            self.to
        } else {
            let k = (t - self.start) / (self.end - self.start).max(1e-9);
            self.from + (self.to - self.from) * k as f32
        }
    }

    fn animation(&self, gpu: &Gpu) -> Result<IDCompositionAnimation> {
        unsafe {
            let animation = gpu.dcomp.CreateAnimation()?;
            if self.start > 0.0 {
                animation.AddCubic(0.0, self.before, 0.0, 0.0, 0.0)?;
            }
            let span = (self.end - self.start).max(1e-6);
            let slope = ((self.to - self.from) as f64 / span) as f32;
            animation.AddCubic(self.start, self.from, slope, 0.0, 0.0)?;
            animation.End(self.end, self.to)?;
            Ok(animation)
        }
    }
}

/// One picture: what to show, in the window's own coordinates, and how it moves.
pub struct Layer {
    pub image: ID2D1CommandList,
    pub opacity: Option<Ramp>,
    /// A uniform scale and the point it is about, in the window's coordinates.
    pub scale: Option<(Ramp, (f32, f32))>,
}

/// Pictures on screen in place of a surface's frames. Dropped by [`Composition::dismiss`].
pub struct Composition {
    root: IDCompositionVisual2,
    content: windows::core::IUnknown,
    _layers: Vec<IDCompositionVisual2>,
}

impl Composition {
    /// Put `layers` on screen in place of `surface`'s frames, back to front, in one commit.
    ///
    /// `viewport` is the window's size in the coordinates the layers were drawn in, and `dpi` the
    /// one the window's own frames are drawn at, so a picture lands on exactly the pixels the frame
    /// it replaces covered. Nothing is committed unless every picture was made.
    pub fn show(
        gpu: &Gpu,
        surface: &Surface,
        layers: &[Layer],
        viewport: (f32, f32),
        dpi: u32,
    ) -> Result<Self> {
        let ppd = pixels_per_dip(gpu);
        let window = (
            (viewport.0 * ppd).round() as i32,
            (viewport.1 * ppd).round() as i32,
        );

        let mut visuals = Vec::with_capacity(layers.len());
        for layer in layers {
            let Some(pixels) = pixel_bounds(gpu, &layer.image, ppd, window)? else {
                continue;
            };
            let picture = paint(gpu, &layer.image, pixels, ppd, dpi)?;
            visuals.push(place(gpu, layer, &picture, pixels, ppd)?);
        }

        let root = surface.visual().clone();
        let content: windows::core::IUnknown = surface.swapchain.cast()?;
        let mut previous: Option<IDCompositionVisual> = None;
        let attached = (|| -> Result<()> {
            unsafe {
                for visual in &visuals {
                    // Each in front of the one before. With no reference the two orders the call
                    // can mean are the same: the root has no other children.
                    root.AddVisual(visual, windows::Win32::Foundation::BOOL::from(true), previous.as_ref())?;
                    previous = Some(visual.cast()?);
                }
                root.SetContent(None::<&windows::core::IUnknown>)?;
                gpu.dcomp.Commit()
            }
        })();
        if let Err(error) = attached {
            // Undone before anything else commits: the device is shared, and a later commit from
            // another window would otherwise carry these half-made changes to the screen.
            unsafe {
                let _ = root.RemoveAllVisuals();
                let _ = root.SetContent(&content);
            }
            return Err(error);
        }
        Ok(Self {
            root,
            content,
            _layers: visuals,
        })
    }

    /// Give the window its own frames back.
    ///
    /// Only while the window is hidden. The swapchain still holds the frame from before the echo,
    /// and putting it back on a visible window shows that frame again.
    pub fn dismiss(self, gpu: &Gpu) {
        unsafe {
            let _ = self.root.RemoveAllVisuals();
            let _ = self.root.SetContent(&self.content);
            let _ = gpu.dcomp.Commit();
        }
    }
}

fn pixels_per_dip(gpu: &Gpu) -> f32 {
    let (mut x, mut y) = (96.0, 96.0);
    unsafe { gpu.d2d.GetDpi(&mut x, &mut y) };
    (x / 96.0).max(0.25)
}

/// What a picture covers, in window pixels, or `None` if it draws nothing on the window.
///
/// Measured from what was actually drawn rather than worked out from the layout: a picture is a
/// GPU allocation for as long as it is on screen, and most of them are a few tiles on a window the
/// size of a monitor.
fn pixel_bounds(
    gpu: &Gpu,
    image: &ID2D1CommandList,
    ppd: f32,
    window: (i32, i32),
) -> Result<Option<windows::Win32::Foundation::RECT>> {
    let bounds = unsafe { gpu.d2d.GetImageWorldBounds(image)? };
    if !(bounds.left.is_finite() && bounds.top.is_finite() && bounds.right.is_finite() && bounds.bottom.is_finite()) {
        return Ok(None);
    }
    // A pixel of margin each way: antialiasing reaches half a pixel past a shape's edge.
    let rect = windows::Win32::Foundation::RECT {
        left: ((bounds.left * ppd).floor() as i32 - 1).max(0),
        top: ((bounds.top * ppd).floor() as i32 - 1).max(0),
        right: ((bounds.right * ppd).ceil() as i32 + 1).min(window.0),
        bottom: ((bounds.bottom * ppd).ceil() as i32 + 1).min(window.1),
    };
    Ok((rect.right > rect.left && rect.bottom > rect.top).then_some(rect))
}

/// Draw `image` into a new composition surface covering `pixels`.
fn paint(
    gpu: &Gpu,
    image: &ID2D1CommandList,
    pixels: windows::Win32::Foundation::RECT,
    ppd: f32,
    dpi: u32,
) -> Result<IDCompositionSurface> {
    let (width, height) = (
        (pixels.right - pixels.left) as u32,
        (pixels.bottom - pixels.top) as u32,
    );
    unsafe {
        let picture = gpu.dcomp.CreateSurface(
            width,
            height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_ALPHA_MODE_PREMULTIPLIED,
        )?;
        let mut offset = POINT::default();
        let target: IDXGISurface = picture.BeginDraw(None, &mut offset)?;
        let drawn = (|| -> Result<()> {
            // The same properties as a frame's own target, so the context maps the picture's
            // coordinates exactly as it maps the frame's.
            let properties = D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                },
                dpiX: dpi as f32,
                dpiY: dpi as f32,
                bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                colorContext: std::mem::ManuallyDrop::new(None),
            };
            let bitmap = gpu.d2d.CreateBitmapFromDxgiSurface(&target, Some(&properties))?;
            gpu.d2d.SetTarget(&bitmap);
            gpu.d2d.BeginDraw();
            // The surface handed back is a region of a shared texture, at `offset`. Window
            // coordinates are moved onto that region, and everything is clipped to it: the rest
            // of the texture is somebody else's picture.
            let shift = (
                offset.x as f32 / ppd - pixels.left as f32 / ppd,
                offset.y as f32 / ppd - pixels.top as f32 / ppd,
            );
            gpu.d2d.SetTransform(&Matrix3x2::translation(shift.0, shift.1));
            let region = D2D_RECT_F {
                left: pixels.left as f32 / ppd,
                top: pixels.top as f32 / ppd,
                right: pixels.right as f32 / ppd,
                bottom: pixels.bottom as f32 / ppd,
            };
            gpu.d2d.PushAxisAlignedClip(&region, D2D1_ANTIALIAS_MODE_ALIASED);
            gpu.d2d.Clear(Some(&super::palette::TRANSPARENT));
            gpu.d2d.DrawImage(
                image,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
            gpu.d2d.PopAxisAlignedClip();
            gpu.d2d.SetTransform(&Matrix3x2::identity());
            let ended = gpu.d2d.EndDraw(None, None);
            gpu.d2d.SetTarget(None);
            ended
        })();
        // Always ended, so a failed draw does not leave the surface open for good.
        let closed = picture.EndDraw();
        drawn?;
        closed?;
        Ok(picture)
    }
}

/// A visual showing `picture` where it was drawn, with the layer's motion on it.
fn place(
    gpu: &Gpu,
    layer: &Layer,
    picture: &IDCompositionSurface,
    pixels: windows::Win32::Foundation::RECT,
    ppd: f32,
) -> Result<IDCompositionVisual2> {
    unsafe {
        let visual = gpu.dcomp.CreateVisual()?;
        visual.SetContent(picture)?;
        visual.SetOffsetX2(pixels.left as f32)?;
        visual.SetOffsetY2(pixels.top as f32)?;
        if let Some(ramp) = layer.opacity {
            let animated: IDCompositionVisual3 = visual.cast()?;
            animated.SetOpacity(&ramp.animation(gpu)?)?;
        }
        if let Some((ramp, about)) = layer.scale {
            // A picture that changes size is resampled every frame: linear, so it does not shimmer,
            // and with soft edges, so its outline stays antialiased at every scale.
            visual.SetBitmapInterpolationMode(DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR)?;
            visual.SetBorderMode(DCOMPOSITION_BORDER_MODE_SOFT)?;
            let scale = gpu.dcomp.CreateScaleTransform()?;
            // About a point in the visual's own pixels, which start at its offset.
            scale.SetCenterX2(about.0 * ppd - pixels.left as f32)?;
            scale.SetCenterY2(about.1 * ppd - pixels.top as f32)?;
            let animation = ramp.animation(gpu)?;
            scale.SetScaleX(&animation)?;
            scale.SetScaleY(&animation)?;
            visual.SetTransform(&scale)?;
        }
        Ok(visual)
    }
}

/// Record a picture: `draw` paints into it, in the window's coordinates, as into a frame.
pub fn record(gpu: &Gpu, draw: impl FnOnce()) -> Result<ID2D1CommandList> {
    unsafe {
        let list = gpu.d2d.CreateCommandList()?;
        gpu.d2d.SetTarget(&list);
        gpu.d2d.BeginDraw();
        draw();
        let ended = gpu.d2d.EndDraw(None, None);
        gpu.d2d.SetTarget(None);
        ended?;
        list.Close()?;
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ramp_holds_then_moves_then_holds() {
        let ramp = Ramp { before: 0.0, from: 0.8, to: 0.0, start: 0.1, end: 0.3 };
        assert_eq!(ramp.at(0.0), 0.0);
        assert_eq!(ramp.at(0.099), 0.0);
        assert!((ramp.at(0.1) - 0.8).abs() < 1e-6);
        assert!((ramp.at(0.2) - 0.4).abs() < 1e-6);
        assert_eq!(ramp.at(0.3), 0.0);
        assert_eq!(ramp.at(5.0), 0.0);
    }
}
