//! The GPU objects, created once for the process and shared by every window.
//!
//! **Why DirectComposition and not a layered window.**
//!
//! The wheel is a per-pixel-alpha overlay the size of a monitor. The traditional way to get one on
//! Windows is `WS_EX_LAYERED` plus `UpdateLayeredWindow`, and it is the wrong tool here for a
//! reason that is measurable rather than aesthetic: `UpdateLayeredWindow` takes a CPU-side bitmap
//! and copies it to the compositor on every frame. At 3840×2160 that is 33 MB of traffic per frame,
//! which costs both the copy and the memory for the staging surface — on a window that is on screen
//! for perhaps 600 ms at a time but must be resident for the whole session.
//!
//! A composition swapchain (`WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition`) is
//! handed straight to the DWM as a GPU texture with premultiplied alpha. Nothing crosses the bus,
//! the window has no redirection surface at all, and the per-frame cost is the drawing itself.
//!
//! **Why one device for the process.** Two windows with two D3D devices cannot share a texture
//! without a staging copy, and the icon atlas is uploaded once and drawn by both the wheel and the
//! settings panel's live preview. One device also means one device-lost recovery path instead of
//! two that can disagree about whether the GPU has come back.

use std::cell::RefCell;
use windows::core::{Interface, Result};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Device, ID2D1DeviceContext, ID2D1Factory1,
    D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
    D2D1_DEBUG_LEVEL_NONE, D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_FACTORY_OPTIONS,
    D2D1_FACTORY_TYPE_SINGLE_THREADED,
};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_SINGLETHREADED, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice2, IDCompositionDesktopDevice, IDCompositionTarget,
    IDCompositionVisual2,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory3, DWRITE_FACTORY_TYPE_SHARED,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, IDXGIDevice, IDXGIFactory2, IDXGISurface, IDXGISwapChain2,
    DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT, DXGI_PRESENT_DO_NOT_WAIT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
    DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};

/// How many frames the GPU may be working on while the CPU prepares the next.
///
/// One, not the default two. The wheel is an input-driven surface: the only thing it ever draws is
/// a response to where the hand is, so a frame queued behind another is a frame that shows a stale
/// aim. Latency is the whole product here and throughput is irrelevant — nothing in this program
/// renders two frames' worth of work.
const FRAME_LATENCY: u32 = 1;

/// The process-wide GPU objects.
pub struct Gpu {
    pub d3d: ID3D11Device,
    pub dxgi_factory: IDXGIFactory2,
    pub d2d_factory: ID2D1Factory1,
    pub d2d_device: ID2D1Device,
    /// The one device context. Drawing is single-threaded and strictly one window at a time, so a
    /// context per window would be per-window state for a resource nothing contends for.
    pub d2d: ID2D1DeviceContext,
    pub dwrite: IDWriteFactory3,
    pub dcomp: IDCompositionDesktopDevice,
}

impl Gpu {
    pub fn create() -> Result<Self> {
        let d3d = create_d3d_device()?;
        let dxgi_device: IDXGIDevice = d3d.cast()?;

        let d2d_factory: ID2D1Factory1 = unsafe {
            D2D1CreateFactory(
                D2D1_FACTORY_TYPE_SINGLE_THREADED,
                Some(&D2D1_FACTORY_OPTIONS {
                    // No debug layer in either profile: it is not installed on an end-user machine,
                    // and asking for it there fails the factory creation outright.
                    debugLevel: D2D1_DEBUG_LEVEL_NONE,
                }),
            )?
        };
        let d2d_device = unsafe { d2d_factory.CreateDevice(&dxgi_device)? };
        let d2d = unsafe { d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)? };

        let dwrite: IDWriteFactory3 =
            unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)? };

        // `DCompositionCreateDevice2` takes the D2D device, which is what lets a composition
        // surface be drawn into with D2D directly. The desktop flavour is the one that can make a
        // target for an HWND; the plain `IDCompositionDevice3` cannot.
        let dcomp: IDCompositionDesktopDevice =
            unsafe { DCompositionCreateDevice2(&d2d_device)? };

        let dxgi_factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))? };

        Ok(Self {
            d3d,
            dxgi_factory,
            d2d_factory,
            d2d_device,
            d2d,
            dwrite,
            dcomp,
        })
    }
}

fn create_d3d_device() -> Result<ID3D11Device> {
    // BGRA support is required by D2D interop and is NOT implied: a device created without it
    // yields a D2D factory that refuses every render target, which surfaces as an opaque
    // `E_INVALIDARG` several calls later.
    //
    // SINGLETHREADED removes the device's internal lock. Everything here draws on the UI thread;
    // the only worker thread touches icon DECODING (WIC, which has its own device-independent
    // path) and hands back pixels, never a D3D resource.
    let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_SINGLETHREADED;

    let mut device: Option<ID3D11Device> = None;
    let hardware = unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    };
    if hardware.is_ok() {
        if let Some(device) = device {
            return Ok(device);
        }
    }

    // WARP is the software rasteriser. It is slower than a GPU and far faster than giving up: the
    // configurations that land here are a VM with no 3D, a session whose driver has just been
    // replaced by an update, and a locked-down machine with hardware acceleration disabled by
    // policy. A launcher that refuses to start on any of them is a launcher that cannot be used.
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_WARP,
            None,
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?
    };
    device.ok_or_else(|| windows::core::Error::from_win32())
}

/// One window's composition surface.
///
/// The visual tree is the minimum that works: a target for the HWND, one visual, and the swapchain
/// as its content. Nothing is animated by DirectComposition itself — every transition in this app
/// is drawn, frame by frame, because the wheel's motion has to be able to abort mid-flight when the
/// hand moves and a committed composition animation cannot.
pub struct Surface {
    pub swapchain: IDXGISwapChain2,
    /// Signalled when the compositor is ready for the next frame. Waited on alongside the message
    /// queue, which is what paces rendering to the display without blocking input.
    pub frame_latency_waitable: windows::Win32::Foundation::HANDLE,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual2,
    size: RefCell<(u32, u32)>,
}

impl Surface {
    /// Attach a composition surface to `hwnd`, sized `width` × `height` in PHYSICAL pixels.
    pub fn create(gpu: &Gpu, hwnd: HWND, width: u32, height: u32) -> Result<Self> {
        let (width, height) = (width.max(1), height.max(1));

        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            // Two buffers with FLIP_SEQUENTIAL: the minimum a flip model accepts. A third would
            // buy throughput this program has no use for and cost a monitor-sized texture.
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            // The whole reason for the composition path: the DWM blends this surface itself.
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT.0 as u32,
        };

        let swapchain: IDXGISwapChain2 = unsafe {
            gpu.dxgi_factory
                .CreateSwapChainForComposition(&gpu.d3d, &desc, None)?
                .cast()?
        };
        unsafe { swapchain.SetMaximumFrameLatency(FRAME_LATENCY)? };
        let frame_latency_waitable = unsafe { swapchain.GetFrameLatencyWaitableObject() };

        let target = unsafe { gpu.dcomp.CreateTargetForHwnd(hwnd, true)? };
        let visual = unsafe { gpu.dcomp.CreateVisual()? };
        unsafe {
            visual.SetContent(&swapchain)?;
            target.SetRoot(&visual)?;
            // Nothing is on screen until the commit, and the window is still hidden at this point.
            // That ordering is what replaces the Electron build's first-paint handshake: there, the
            // renderer and the window show were different processes and the window could be
            // revealed over a surface that had never been drawn. Here the first frame is committed
            // before `ShowWindow` is ever called, so there is no stale texture to flash.
            gpu.dcomp.Commit()?;
        }

        Ok(Self {
            swapchain,
            frame_latency_waitable,
            _target: target,
            _visual: visual,
            size: RefCell::new((width, height)),
        })
    }

    pub fn size(&self) -> (u32, u32) {
        *self.size.borrow()
    }

    /// Resize the back buffers. A no-op when the size already matches, because `ResizeBuffers`
    /// discards and reallocates both monitor-sized textures and is called on every window move.
    pub fn resize(&self, width: u32, height: u32) -> Result<()> {
        let (width, height) = (width.max(1), height.max(1));
        if *self.size.borrow() == (width, height) {
            return Ok(());
        }
        unsafe {
            self.swapchain.ResizeBuffers(
                0, // keep the buffer count
                width,
                height,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT,
            )?;
        }
        *self.size.borrow_mut() = (width, height);
        Ok(())
    }

    /// Bind this surface as the device context's target for the duration of one frame.
    ///
    /// The returned guard un-binds it on drop. Leaving a swapchain bitmap bound across frames keeps
    /// a reference on a back buffer, and `ResizeBuffers` then fails with
    /// `DXGI_ERROR_INVALID_CALL` — which looks like a resize bug and is a lifetime bug.
    pub fn begin_frame<'a>(&self, gpu: &'a Gpu, dpi: u32) -> Result<FrameTarget<'a>> {
        let back: IDXGISurface = unsafe { self.swapchain.GetBuffer(0)? };
        let properties = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            // The context is told the monitor's DPI so geometry can be expressed in the DIPs the
            // user's settings are denominated in, and the rasteriser does the scaling. Rounding
            // DIPs to pixels by hand is what produces the half-pixel outlines the original had to
            // snap away from.
            dpiX: dpi as f32,
            dpiY: dpi as f32,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let bitmap = unsafe { gpu.d2d.CreateBitmapFromDxgiSurface(&back, Some(&properties))? };
        unsafe {
            gpu.d2d.SetTarget(&bitmap);
            gpu.d2d.BeginDraw();
        }
        Ok(FrameTarget { gpu })
    }

    /// Hand the frame to the compositor.
    ///
    /// `vsync` is false for a frame that must not wait — the one drawn immediately before the
    /// window is shown. Waiting there would add up to a refresh interval to the gesture's latency,
    /// and the user is still holding the button down.
    pub fn present(&self, vsync: bool) -> Result<()> {
        let flags = if vsync { DXGI_PRESENT(0) } else { DXGI_PRESENT_DO_NOT_WAIT };
        unsafe {
            // `Present` returns a status rather than failing for the cases that matter here —
            // `DXGI_STATUS_OCCLUDED` on a window the user has covered, and `DXGI_ERROR_WAS_STILL_
            // DRAWING` for a non-waiting present. Neither is an error and neither should abort the
            // frame loop.
            let _ = self.swapchain.Present(if vsync { 1 } else { 0 }, flags);
        }
        Ok(())
    }
}

/// Binds the device context's target for one frame and releases it on drop.
pub struct FrameTarget<'a> {
    gpu: &'a Gpu,
}

impl<'a> FrameTarget<'a> {
    pub fn context(&self) -> &ID2D1DeviceContext {
        &self.gpu.d2d
    }
}

impl Drop for FrameTarget<'_> {
    fn drop(&mut self) {
        unsafe {
            // `EndDraw` reports device loss, which is handled by the caller re-creating the `Gpu`
            // on the next frame — there is nothing useful to do about it inside a destructor, and
            // a panic here would take the process down over a driver reset the user would not
            // otherwise have noticed.
            let _ = self.gpu.d2d.EndDraw(None, None);
            self.gpu.d2d.SetTarget(None);
        }
    }
}
