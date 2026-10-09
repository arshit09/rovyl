//! Reading and writing images through WIC.
//!
//! Three jobs, and they share a factory because creating one is a COM activation:
//! decoding an icon the user chose, decoding the PNGs the icon store holds, and — for the render
//! probe — writing a frame out to a file.
//!
//! Everything here is called from a WORKER, never from the frame loop. Decoding a 256px PNG is a
//! fraction of a millisecond and reading it off disk is not, and the frame loop is the thread the
//! wheel is drawn on.

use windows::core::{Interface, Result, HSTRING};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppPBGRA,
    IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnLoad,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

/// The process-wide WIC factory.
pub fn factory() -> Result<IWICImagingFactory> {
    // Created per call rather than cached in a `static`: a COM pointer is not `Send`, and the
    // callers are on different threads. The activation is a few microseconds against a decode that
    // is a few hundred.
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
}

/// Decode an image file into the pixel format D2D wants.
///
/// Premultiplied BGRA, because that is the swapchain's format: converting at decode time means the
/// per-frame path is a straight upload with no conversion.
pub fn decode_file(path: &std::path::Path) -> Result<(Vec<u8>, u32, u32)> {
    let factory = factory()?;
    unsafe {
        let decoder = factory.CreateDecoderFromFilename(
            &HSTRING::from(path.as_os_str()),
            None,
            windows::Win32::Foundation::GENERIC_READ,
            WICDecodeMetadataCacheOnLoad,
        )?;
        let frame = decoder.GetFrame(0)?;
        convert(&factory, &frame.cast()?)
    }
}

/// Decode an image already in memory — a `data:` URL's bytes, or a favicon that was fetched.
pub fn decode_bytes(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let factory = factory()?;
    unsafe {
        let stream = factory.CreateStream()?;
        stream.InitializeFromMemory(bytes)?;
        let decoder = factory.CreateDecoderFromStream(
            &stream,
            // No preferred vendor: WIC picks the decoder by sniffing the container, which is what
            // is wanted — the bytes can be a PNG, a JPEG, an ICO or a WebP and the caller does not
            // know which.
            std::ptr::null(),
            WICDecodeMetadataCacheOnLoad,
        )?;
        let frame = decoder.GetFrame(0)?;
        convert(&factory, &frame.cast()?)
    }
}

unsafe fn convert(
    factory: &IWICImagingFactory,
    source: &IWICBitmapSource,
) -> Result<(Vec<u8>, u32, u32)> {
    let converter = factory.CreateFormatConverter()?;
    converter.Initialize(
        source,
        &GUID_WICPixelFormat32bppPBGRA,
        WICBitmapDitherTypeNone,
        None,
        0.0,
        WICBitmapPaletteTypeCustom,
    )?;
    let mut width = 0u32;
    let mut height = 0u32;
    converter.GetSize(&mut width, &mut height)?;
    let stride = width * 4;
    let mut pixels = vec![0u8; (stride * height) as usize];
    converter.CopyPixels(std::ptr::null(), stride, &mut pixels)?;
    Ok((pixels, width, height))
}

/// Write premultiplied BGRA pixels out as a PNG.
pub fn save_png(
    path: &std::path::Path,
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<()> {
    let factory = factory()?;
    unsafe {
        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(
            &HSTRING::from(path.as_os_str()),
            windows::Win32::Foundation::GENERIC_WRITE.0,
        )?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, windows::Win32::Graphics::Imaging::WICBitmapEncoderNoCache)?;
        let mut frame: Option<windows::Win32::Graphics::Imaging::IWICBitmapFrameEncode> = None;
        let mut options: Option<windows::Win32::System::Com::StructuredStorage::IPropertyBag2> =
            None;
        encoder.CreateNewFrame(&mut frame, &mut options)?;
        let frame = frame.ok_or_else(windows::core::Error::from_win32)?;
        frame.Initialize(options.as_ref())?;
        frame.SetSize(width, height)?;
        let mut format = GUID_WICPixelFormat32bppPBGRA;
        frame.SetPixelFormat(&mut format)?;
        frame.WritePixels(height, width * 4, pixels)?;
        frame.Commit()?;
        encoder.Commit()?;
        Ok(())
    }
}

/// Encode premultiplied BGRA pixels as PNG, in memory.
///
/// Separate from `save_png` because the icon store names a file by the HASH OF ITS CONTENTS: the
/// bytes have to exist before there is a name to write them under.
pub fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    unsafe {
        let factory = factory()?;
        // A growable in-memory stream. `true` hands the HGLOBAL's lifetime to the stream, so
        // releasing the stream frees it.
        let stream = CreateStreamOnHGlobal(windows::Win32::Foundation::HGLOBAL(std::ptr::null_mut()), true)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, windows::Win32::Graphics::Imaging::WICBitmapEncoderNoCache)?;
        let mut frame: Option<windows::Win32::Graphics::Imaging::IWICBitmapFrameEncode> = None;
        let mut options: Option<windows::Win32::System::Com::StructuredStorage::IPropertyBag2> = None;
        encoder.CreateNewFrame(&mut frame, &mut options)?;
        let frame = frame.ok_or_else(windows::core::Error::from_win32)?;
        frame.Initialize(options.as_ref())?;
        frame.SetSize(width, height)?;
        let mut format = GUID_WICPixelFormat32bppPBGRA;
        frame.SetPixelFormat(&mut format)?;
        frame.WritePixels(height, width * 4, pixels)?;
        frame.Commit()?;
        encoder.Commit()?;

        // Read the stream back from the start.
        let mut stat = windows::Win32::System::Com::STATSTG::default();
        stream.Stat(&mut stat, windows::Win32::System::Com::STATFLAG_NONAME)?;
        let size = stat.cbSize as usize;
        stream.Seek(0, windows::Win32::System::Com::STREAM_SEEK_SET, None)?;
        let mut bytes = vec![0u8; size];
        let mut read = 0u32;
        // `IStream::Read` returns an HRESULT rather than a `Result` in these bindings, so it is
        // checked rather than propagated. A short read is a truncated PNG, which the store would
        // then name by the hash of a broken file.
        let hr = stream.Read(bytes.as_mut_ptr() as *mut _, size as u32, Some(&mut read));
        if hr.is_err() || read as usize != size {
            return Err(windows::core::Error::from_win32());
        }
        Ok(bytes)
    }
}
