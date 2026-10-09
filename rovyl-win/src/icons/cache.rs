//! Turning icon references into GPU bitmaps, without ever blocking the frame.
//!
//! The renderer asks for an icon by reference, once per tile per frame, on the thread that also
//! draws the wheel. That thread must not touch the disk: a cold file read is milliseconds and the
//! wheel is on screen during a gesture the hand is still making.
//!
//! So the answer is always immediate and sometimes `None`:
//!
//! 1. A hit returns the bitmap.
//! 2. A miss enqueues the reference for a worker and returns `None`. The tile draws its glyph —
//!    or, for a `native` item that has a reference but no picture yet, a wait indicator, because a
//!    generic glyph at that moment looks like a WRONG icon rather than a missing one.
//! 3. The worker decodes to premultiplied BGRA and posts the pixels back.
//! 4. The next frame drains the queue and uploads them.
//!
//! The upload has to be on the render thread because a D2D bitmap belongs to the device context,
//! and the device is single-threaded by construction — which is what lets every other draw call in
//! the program skip a lock.

use crate::gfx::device::Gpu;
use crate::gfx::encode;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT, D2D_SIZE_U,
};
use windows::Win32::Graphics::Direct2D::{D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

/// Decoded pixels on their way back from a worker.
struct Decoded {
    reference: String,
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

/// How many decoded icons may be waiting to be uploaded.
///
/// Uploads happen a few per frame rather than all at once, because creating a D2D bitmap is a GPU
/// allocation and a wheel of twenty icons opening for the first time would otherwise spend its
/// first frame doing twenty of them.
const UPLOADS_PER_FRAME: usize = 4;

pub struct IconCache {
    ready: RefCell<HashMap<String, windows::Win32::Graphics::Direct2D::ID2D1Bitmap1>>,
    /// References a worker is already looking at, so a miss on every frame does not enqueue the
    /// same file sixty times a second.
    pending: RefCell<HashSet<String>>,
    /// References that came back as "there is nothing here", so they are never asked for again.
    ///
    /// Without this a reference whose file has been deleted costs a worker round trip per frame
    /// forever — and the symptom is a wheel that is mysteriously busy while sitting still.
    missing: RefCell<HashSet<String>>,
    queue: Arc<Queue>,
    results: Receiver<Decoded>,
}

/// The work list, and the condition the workers sleep on.
struct Queue {
    items: Mutex<VecDeque<String>>,
    wake: Condvar,
    /// Set on shutdown so the workers can leave their wait.
    stop: Mutex<bool>,
}

impl IconCache {
    pub fn new() -> Self {
        let queue = Arc::new(Queue {
            items: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
            stop: Mutex::new(false),
        });
        let (sender, results) = std::sync::mpsc::channel();

        // Two workers. More would not help: the work is a file read and a decode, and the files are
        // small and on the same disk. Two means one can be waiting on I/O while the other decodes,
        // which is the only parallelism available here.
        for index in 0..2 {
            let queue = Arc::clone(&queue);
            let sender = sender.clone();
            std::thread::Builder::new()
                .name(format!("rovyl-icons-{index}"))
                .spawn(move || worker(queue, sender))
                .ok();
        }

        Self {
            ready: RefCell::new(HashMap::with_capacity(64)),
            pending: RefCell::new(HashSet::new()),
            missing: RefCell::new(HashSet::new()),
            queue,
            results,
        }
    }

    /// Take whatever the workers have finished and upload it. Called once per frame, before
    /// drawing.
    pub fn pump(&self, gpu: &Gpu) {
        for _ in 0..UPLOADS_PER_FRAME {
            let Ok(decoded) = self.results.try_recv() else {
                break;
            };
            self.pending.borrow_mut().remove(&decoded.reference);
            if decoded.pixels.is_empty() {
                self.missing.borrow_mut().insert(decoded.reference);
                continue;
            }
            if let Some(bitmap) = upload(gpu, &decoded) {
                self.ready.borrow_mut().insert(decoded.reference, bitmap);
            } else {
                // A failed upload is a device problem, not a file problem: it is NOT recorded as
                // missing, so it will be retried after a device reset.
                self.missing.borrow_mut().remove(&decoded.reference);
            }
        }
    }

    /// Ask the workers for every reference a level is about to draw.
    ///
    /// Called when the level changes rather than per frame, so that opening a folder starts all of
    /// its icons at once instead of discovering them one frame at a time as each tile misses.
    pub fn warm<'a>(&self, references: impl Iterator<Item = &'a str>) {
        for reference in references {
            self.request(reference);
        }
    }

    fn request(&self, reference: &str) {
        if reference.is_empty()
            || self.ready.borrow().contains_key(reference)
            || self.pending.borrow().contains(reference)
            || self.missing.borrow().contains(reference)
        {
            return;
        }
        self.pending.borrow_mut().insert(reference.to_string());
        let mut items = self.queue.items.lock().unwrap();
        items.push_back(reference.to_string());
        self.queue.wake.notify_one();
    }

    /// Drop everything. Called on device loss, where every bitmap belongs to a device that is gone.
    ///
    /// `missing` is cleared too: a reference that failed to upload is not a reference whose file is
    /// absent, and keeping the record would leave those tiles glyph-only until a restart.
    pub fn clear(&self) {
        self.ready.borrow_mut().clear();
        self.missing.borrow_mut().clear();
    }

    pub fn len(&self) -> usize {
        self.ready.borrow().len()
    }
}

impl Default for IconCache {
    fn default() -> Self {
        Self::new()
    }
}

impl crate::wheel::render::IconSource2 for IconCache {
    fn bitmap(&self, reference: &str) -> Option<windows::Win32::Graphics::Direct2D::ID2D1Bitmap1> {
        if let Some(found) = self.ready.borrow().get(reference) {
            return Some(found.clone());
        }
        // A miss asks for it. This is what covers the references `warm` did not know about — a
        // dock icon, the centre button, an MRU entry that arrived after the level was built.
        self.request(reference);
        None
    }

    fn pending(&self, reference: &str) -> bool {
        self.pending.borrow().contains(reference)
    }
}

fn worker(queue: Arc<Queue>, sender: Sender<Decoded>) {
    // COM, for WIC. Multithreaded apartment: this thread owns no windows and nothing here is a
    // single-threaded shell interface.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }

    loop {
        let reference = {
            let mut items = queue.items.lock().unwrap();
            loop {
                if *queue.stop.lock().unwrap() {
                    return;
                }
                match items.pop_front() {
                    Some(reference) => break reference,
                    // Sleeping on a condition rather than polling: a launcher that idles for hours
                    // should cost nothing, and a worker spinning on an empty queue is the most
                    // embarrassing possible way to lose that.
                    None => items = queue.wake.wait(items).unwrap(),
                }
            }
        };

        let decoded = decode(&reference).unwrap_or((Vec::new(), 0, 0));
        if sender
            .send(Decoded {
                reference,
                pixels: decoded.0,
                width: decoded.1,
                height: decoded.2,
            })
            .is_err()
        {
            // The receiver has gone, which means the app is shutting down.
            return;
        }
    }
}

/// Read and decode one reference.
fn decode(reference: &str) -> Option<(Vec<u8>, u32, u32)> {
    if let Some(path) = super::store::path_for(reference) {
        return encode::decode_file(&path).ok();
    }
    // One icon out of a program or a library, for the picker's grid. Already premultiplied BGRA,
    // so there is nothing to decode -- it skips WIC entirely.
    if let Some((file, index)) = super::store::parse_lib_ref(reference) {
        let pixels = super::library::extract(&file, index)?;
        return Some((pixels, super::library::SIZE, super::library::SIZE));
    }
    if let Some((bytes, _)) = super::store::decode_data_url(reference) {
        return encode::decode_bytes(&bytes).ok();
    }
    // An `https:` favicon. Not fetched here: a network read on an icon worker would make the queue
    // unbounded in time, and a launcher must not reach the network to draw a wheel. The fetcher
    // stores it and rewrites the reference, after which this path finds a file.
    None
}

fn upload(
    gpu: &Gpu,
    decoded: &Decoded,
) -> Option<windows::Win32::Graphics::Direct2D::ID2D1Bitmap1> {
    if decoded.width == 0 || decoded.height == 0 {
        return None;
    }
    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            // The decoder was asked for PBGRA, so no conversion happens here: the upload is a
            // straight copy into GPU memory.
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        // 96, because the bitmap's coordinates are its own pixels and the renderer scales it to the
        // tile. A DPI here would scale it twice.
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    unsafe {
        gpu.d2d
            .CreateBitmap(
                D2D_SIZE_U {
                    width: decoded.width,
                    height: decoded.height,
                },
                Some(decoded.pixels.as_ptr() as *const _),
                decoded.width * 4,
                &properties,
            )
            .ok()
    }
}
