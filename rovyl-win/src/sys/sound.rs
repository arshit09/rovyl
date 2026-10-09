//! The wheel's sound effects.
//!
//! A short bass note when the wheel opens (and again when the aim comes back to its centre), and
//! another each time the highlight moves to a different item. Both are picked from the same ten.
//!
//! **Synthesised, not sampled.** The original's reason was that a file has to be loaded and decoded
//! before the first note can play, and the wheel's whole argument is that nothing happens between
//! the button and the thing appearing. That reason survives the port: these are a few hundred
//! floating-point operations per millisecond of audio, computed on an audio thread, with nothing to
//! read from disk and nothing to keep resident.
//!
//! **The stream sleeps.** A running audio client keeps an endpoint open and a thread waking every
//! few milliseconds, which is not a cost an idle launcher in the tray gets to charge. The device is
//! opened on the first note and released after [`SLEEP_AFTER_MS`] of silence — long enough to cover
//! a quick reopen, short enough that a session spent not using Rovyl costs nothing.
//!
//! The ten recipes below are ported parameter for parameter from `src/utils/radialSound.ts`. The
//! descriptions are the original's, because they say what the note is MEANT to sound like, which is
//! the only way to tell whether a port of a synthesiser is right.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::OnceLock;

/// The ten, in the order the settings list them — the order they were auditioned in.
pub const CATALOGUE: &[(&str, &str)] = &[
    ("thump", "Thump"),
    ("sub-tick", "Sub Tick"),
    ("knock", "Knock"),
    ("pluck", "Pluck"),
    ("pulse", "Pulse"),
    ("drop", "Drop"),
    ("felt-tap", "Felt Tap"),
    ("rubber", "Rubber"),
    ("reese", "Reese"),
    ("haptic", "Haptic"),
];

/// A config can be hand-edited, and an id from a future version must still play something.
pub fn normalize(value: Option<&str>, fallback: &'static str) -> &'static str {
    let Some(value) = value else { return fallback };
    CATALOGUE
        .iter()
        .find(|(id, _)| *id == value)
        .map(|(id, _)| *id)
        .unwrap_or(fallback)
}

/// How long after the last note the device is released.
const SLEEP_AFTER_MS: u64 = 1500;

/// Master level, with the same soft limiter behind it that the notes were auditioned through.
const MASTER_GAIN: f32 = 0.7;

/// The sample rate everything is synthesised at.
///
/// The device's own rate is whatever the user's endpoint is set to; the mixer resamples by stepping
/// the phase, which for these short notes is inaudible and avoids carrying a resampler.
const SYNTH_RATE: f32 = 48_000.0;

// ─── Building blocks ────────────────────────────────────────────────────────

/// Gain envelope: silence → `peak` over `attack`, then an exponential fall to silence over `decay`.
fn envelope(t: f32, attack: f32, peak: f32, decay: f32) -> f32 {
    if t < 0.0 {
        return 0.0;
    }
    if t < attack {
        return peak * (t / attack.max(1e-6));
    }
    let fell = t - attack;
    if fell >= decay {
        return 0.0;
    }
    // Exponential from `peak` to 0.0001, which is what `exponentialRampToValueAtTime` does — a
    // linear fall on a bass note reads as a click at the end rather than as a decay.
    peak * (0.0001f32 / peak.max(1e-6)).powf(fell / decay.max(1e-6))
}

/// An oscillator's phase, optionally gliding from `from` to `to` over `glide` seconds.
///
/// The glide is exponential in FREQUENCY, matching `exponentialRampToValueAtTime`, and the phase is
/// integrated rather than computed from `f * t`: a frequency that changes while `t` advances makes
/// the second form jump, which on a 110 → 45 Hz sweep is an audible tear.
struct Osc {
    phase: f32,
}

impl Osc {
    fn new() -> Self {
        Self { phase: 0.0 }
    }

    fn advance(&mut self, frequency: f32, dt: f32) -> f32 {
        self.phase += frequency * dt;
        if self.phase >= 1.0 {
            self.phase -= self.phase.floor();
        }
        self.phase
    }
}

fn glide(from: f32, to: f32, t: f32, over: f32) -> f32 {
    if over <= 0.0 || (to - from).abs() < 1e-6 {
        return from;
    }
    let k = (t / over).clamp(0.0, 1.0);
    from * (to / from).powf(k)
}

fn sine(phase: f32) -> f32 {
    (phase * std::f32::consts::TAU).sin()
}

fn triangle(phase: f32) -> f32 {
    4.0 * (phase - (phase + 0.5).floor()).abs() - 1.0
}

fn sawtooth(phase: f32) -> f32 {
    2.0 * (phase - (phase + 0.5).floor())
}

fn square(phase: f32) -> f32 {
    if phase < 0.5 {
        1.0
    } else {
        -1.0
    }
}

/// A one-pole lowpass, which is enough for notes whose whole job is to sound soft.
struct Lowpass {
    state: f32,
}

impl Lowpass {
    fn new() -> Self {
        Self { state: 0.0 }
    }

    fn run(&mut self, input: f32, cutoff: f32, dt: f32) -> f32 {
        let rc = 1.0 / (std::f32::consts::TAU * cutoff.max(20.0));
        let alpha = dt / (rc + dt);
        self.state += alpha * (input - self.state);
        self.state
    }
}

struct Highpass {
    last_in: f32,
    state: f32,
}

impl Highpass {
    fn new() -> Self {
        Self {
            last_in: 0.0,
            state: 0.0,
        }
    }

    fn run(&mut self, input: f32, cutoff: f32, dt: f32) -> f32 {
        let rc = 1.0 / (std::f32::consts::TAU * cutoff.max(20.0));
        let alpha = rc / (rc + dt);
        self.state = alpha * (self.state + input - self.last_in);
        self.last_in = input;
        self.state
    }
}

/// A deterministic noise source.
///
/// Deterministic because a note has to sound the same every time it plays: a launcher whose click
/// is subtly different on each press sounds broken rather than organic.
struct Noise {
    state: u32,
}

impl Noise {
    fn new() -> Self {
        Self { state: 0x2545_F491 }
    }

    fn next(&mut self) -> f32 {
        // xorshift32, which is as much randomness as a 50 ms burst of noise needs.
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        (self.state as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

// ─── The ten ────────────────────────────────────────────────────────────────

/// One note, rendered into a mono buffer at [`SYNTH_RATE`].
pub fn render(id: &str, volume: f32) -> Vec<f32> {
    // Squared, because loudness is heard on a log scale: a linear 50% is only 6 dB down and sounds
    // barely quieter, while the square puts it 12 dB down, near what "half" feels like.
    let gain = MASTER_GAIN * volume * volume;
    let dt = 1.0 / SYNTH_RATE;
    let duration = match id {
        "thump" => 0.14,
        "sub-tick" => 0.09,
        "knock" => 0.09,
        "pluck" => 0.18,
        "pulse" => 0.08,
        "drop" => 0.22,
        "felt-tap" => 0.07,
        "rubber" => 0.13,
        "reese" => 0.12,
        "haptic" => 0.04,
        _ => 0.14,
    };
    let samples = (duration * SYNTH_RATE) as usize;
    let mut out = Vec::with_capacity(samples);

    let mut a = Osc::new();
    let mut b = Osc::new();
    let mut m = Osc::new();
    let mut low = Lowpass::new();
    let mut high = Highpass::new();
    let mut noise = Noise::new();

    for i in 0..samples {
        let t = i as f32 * dt;
        let value = match id {
            // Sine 110 → 45 Hz, 120 ms: a soft kick drum.
            "thump" => {
                let f = glide(110.0, 45.0, t, 0.08);
                sine(a.advance(f, dt)) * envelope(t, 0.002, 0.9, 0.12)
            }
            // Sine 58 Hz with a 2.5 kHz tick on top, so it still reads on small speakers. 75 ms.
            "sub-tick" => {
                let body = sine(a.advance(58.0, dt)) * envelope(t, 0.001, 0.85, 0.07);
                let tick = high.run(noise.next(), 2500.0, dt) * envelope(t, 0.0005, 0.12, 0.006);
                body + tick
            }
            // Triangle 190 → 75 Hz through a 450 Hz lowpass, 75 ms: knuckle on a desk.
            "knock" => {
                let f = glide(190.0, 75.0, t, 0.05);
                low.run(triangle(a.advance(f, dt)), 450.0, dt) * envelope(t, 0.001, 1.0, 0.07)
            }
            // Two saws at 55 Hz through a resonant lowpass snapping 1.4 kHz → 140 Hz, 160 ms.
            "pluck" => {
                let cutoff = glide(1400.0, 140.0, t, 0.12);
                let mixed = sawtooth(a.advance(55.0, dt)) + sawtooth(b.advance(55.4, dt));
                low.run(mixed, cutoff, dt) * envelope(t, 0.002, 0.34, 0.16)
            }
            // Square 82 Hz through a 320 Hz lowpass, 65 ms: an old console menu.
            "pulse" => {
                low.run(square(a.advance(82.0, dt)), 320.0, dt) * envelope(t, 0.004, 0.32, 0.06)
            }
            // Sine 240 → 38 Hz, 200 ms: a falling "bwomp".
            "drop" => {
                let f = glide(240.0, 38.0, t, 0.16);
                sine(a.advance(f, dt)) * envelope(t, 0.003, 0.85, 0.2)
            }
            // Noise under a 220 Hz lowpass with a sine 95 → 70 Hz, 50 ms: a fingertip on felt.
            "felt-tap" => {
                let body = low.run(noise.next(), 220.0, dt) * envelope(t, 0.001, 1.6, 0.045);
                let f = glide(95.0, 70.0, t, 0.04);
                body + sine(a.advance(f, dt)) * envelope(t, 0.001, 0.5, 0.05)
            }
            // Sine 90 → 65 Hz, frequency-modulated at 36 Hz, 115 ms: a bouncy wobble.
            "rubber" => {
                let depth = glide(40.0, 1.0, t, 0.1);
                let modulation = sine(m.advance(36.0, dt)) * depth;
                let f = glide(90.0, 65.0, t, 0.1) + modulation;
                sine(a.advance(f.max(1.0), dt)) * envelope(t, 0.002, 0.85, 0.11)
            }
            // Saws at 55 and 57.2 Hz beating through a 520 Hz lowpass, 105 ms.
            "reese" => {
                let mixed = sawtooth(a.advance(55.0, dt)) + sawtooth(b.advance(57.2, dt));
                low.run(mixed, 520.0, dt) * envelope(t, 0.004, 0.3, 0.1)
            }
            // Saturated sine at 160 Hz, 32 ms: a phone's vibration tap.
            "haptic" => {
                let raw = sine(a.advance(160.0, dt));
                let shaped = (raw * 3.0).tanh() / 3.0f32.tanh();
                // A flat hold then a fall, rather than the usual envelope: the hold is what makes
                // it read as a vibration rather than as a note.
                let level = if t < 0.001 {
                    0.42 * (t / 0.001)
                } else if t < 0.02 {
                    0.42
                } else {
                    envelope(t - 0.02, 0.0, 0.42, 0.012)
                };
                shaped * level
            }
            _ => 0.0,
        };
        // A soft limiter in place of the compressor the original runs everything through. It only
        // ever engages on the two notes that stack a body and a transient.
        out.push((value * gain).clamp(-1.0, 1.0).tanh());
    }
    out
}

// ─── The player ─────────────────────────────────────────────────────────────

/// What the audio thread is told to do.
enum Command {
    Play(Vec<f32>),
    Stop,
}

struct Player {
    tx: Sender<Command>,
    /// Whether a thread is currently running, so a note does not start a second one.
    running: AtomicBool,
    /// The last note's timestamp, for the sleep.
    last: AtomicU32,
}

fn player() -> &'static Player {
    static PLAYER: OnceLock<Player> = OnceLock::new();
    PLAYER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        let player = Player {
            tx,
            running: AtomicBool::new(false),
            last: AtomicU32::new(0),
        };
        std::thread::Builder::new()
            .name("rovyl-audio".into())
            .spawn(move || audio_thread(rx))
            .ok();
        player
    })
}

/// Play a note. Returns immediately; the synthesis happens on the caller's thread and the playback
/// on the audio one.
///
/// Rendering here rather than on the audio thread is deliberate: a note is at most 10,000 samples
/// and takes well under a millisecond, and doing it on the caller keeps the audio thread's only job
/// "write what you were given", which is the one thing it must never be late for.
pub fn play(id: &str, volume: f32) {
    if volume <= 0.0 {
        return;
    }
    let player = player();
    player.last.store(now_ms(), Ordering::Relaxed);
    let _ = player.tx.send(Command::Play(render(id, volume)));
}

/// Release the device. Called when the wheel comes down.
pub fn sleep() {
    let _ = player().tx.send(Command::Stop);
}

fn now_ms() -> u32 {
    unsafe { windows::Win32::System::SystemInformation::GetTickCount() }
}

fn audio_thread(rx: Receiver<Command>) {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    let mut device: Option<Device> = None;
    // Notes still sounding, each with where it has got to.
    let mut voices: Vec<(Vec<f32>, usize)> = Vec::new();

    loop {
        // Block only while there is nothing to play; otherwise poll so the mixer keeps feeding.
        let command = if voices.is_empty() {
            match rx.recv() {
                Ok(command) => Some(command),
                Err(_) => return,
            }
        } else {
            rx.try_recv().ok()
        };

        match command {
            Some(Command::Play(samples)) => {
                if device.is_none() {
                    device = Device::open();
                }
                // The note still sounding is cut by the next: a fast sweep across the wheel must
                // not pile up into mud.
                voices.clear();
                voices.push((samples, 0));
            }
            Some(Command::Stop) => {
                voices.clear();
                device = None;
                continue;
            }
            None => {}
        }

        let Some(active) = device.as_mut() else {
            voices.clear();
            continue;
        };
        if !active.pump(&mut voices) {
            // The endpoint went away — the user unplugged their headphones. Dropping it makes the
            // next note open whatever is the default now.
            device = None;
            voices.clear();
        }
        if voices.is_empty() {
            // Hold the device open briefly, so a quick second note does not pay to reopen it.
            std::thread::sleep(std::time::Duration::from_millis(10));
            if now_ms().wrapping_sub(player().last.load(Ordering::Relaxed)) > SLEEP_AFTER_MS as u32 {
                device = None;
            }
        }
    }
}

// ─── WASAPI ─────────────────────────────────────────────────────────────────

use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

struct Device {
    client: IAudioClient,
    render: IAudioRenderClient,
    frames: u32,
    channels: usize,
    rate: f32,
    started: bool,
}

impl Device {
    fn open() -> Option<Self> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let endpoint = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let client: IAudioClient = endpoint.Activate(CLSCTX_ALL, None).ok()?;
            let format = client.GetMixFormat().ok()?;
            let channels = (*format).nChannels as usize;
            let rate = (*format).nSamplesPerSec as f32;

            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    // Let the engine convert: the mix format can be anything the endpoint likes,
                    // and carrying a resampler for a 100 ms note is not a trade worth making.
                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    // 100,000 of these per second: 20 ms of buffer, which is short enough that a
                    // note starts promptly and long enough that a scheduling hiccup does not
                    // produce a gap.
                    20 * 10_000,
                    0,
                    format,
                    None,
                )
                .ok()?;
            let frames = client.GetBufferSize().ok()?;
            let render: IAudioRenderClient = client.GetService().ok()?;
            windows::Win32::System::Com::CoTaskMemFree(Some(format as *const _));

            Some(Self {
                client,
                render,
                frames,
                channels,
                rate,
                started: false,
            })
        }
    }

    /// Feed whatever space the endpoint has. Returns false when the device has gone.
    fn pump(&mut self, voices: &mut Vec<(Vec<f32>, usize)>) -> bool {
        unsafe {
            let padding = match self.client.GetCurrentPadding() {
                Ok(padding) => padding,
                Err(_) => return false,
            };
            let available = self.frames.saturating_sub(padding);
            if available == 0 {
                std::thread::sleep(std::time::Duration::from_millis(2));
                return true;
            }
            let Ok(buffer) = self.render.GetBuffer(available) else {
                return false;
            };
            let out = std::slice::from_raw_parts_mut(
                buffer as *mut f32,
                available as usize * self.channels,
            );
            // The step is how far through the synthesised note each output frame advances. It is
            // the only resampling here, and for a note of this length a nearest-sample read is
            // indistinguishable from an interpolated one.
            let step = SYNTH_RATE / self.rate;
            for frame in 0..available as usize {
                let mut value = 0.0f32;
                for (samples, position) in voices.iter_mut() {
                    let at = (*position as f32 * step) as usize;
                    if at < samples.len() {
                        value += samples[at];
                        *position += 1;
                    }
                }
                for channel in 0..self.channels {
                    out[frame * self.channels + channel] = value;
                }
            }
            if self.render.ReleaseBuffer(available, 0).is_err() {
                return false;
            }
            voices.retain(|(samples, position)| (*position as f32 * step) < samples.len() as f32);

            if !self.started {
                if self.client.Start().is_err() {
                    return false;
                }
                self.started = true;
            }
            true
        }
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            if self.started {
                let _ = self.client.Stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalogued_note_renders_something_audible() {
        // A silent note is indistinguishable from a broken one at the call site.
        for (id, name) in CATALOGUE {
            let samples = render(id, 1.0);
            assert!(!samples.is_empty(), "{name} rendered nothing");
            let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!(peak > 0.05, "{name} peaks at only {peak}");
            // And nothing clips: the limiter is there so a stacked note cannot.
            assert!(peak <= 1.0, "{name} peaks at {peak}");
        }
    }

    #[test]
    fn notes_are_short() {
        // These punctuate a gesture. Anything approaching a quarter of a second stops being
        // punctuation and becomes a sound the user is waiting out.
        for (id, name) in CATALOGUE {
            let seconds = render(id, 1.0).len() as f32 / SYNTH_RATE;
            assert!(seconds < 0.25, "{name} is {seconds}s");
            assert!(seconds > 0.02, "{name} is {seconds}s");
        }
    }

    #[test]
    fn notes_start_and_end_at_silence() {
        // A note that starts or ends on a non-zero sample clicks.
        for (id, name) in CATALOGUE {
            let samples = render(id, 1.0);
            assert!(samples[0].abs() < 0.02, "{name} starts at {}", samples[0]);
            let last = samples[samples.len() - 1];
            assert!(last.abs() < 0.05, "{name} ends at {last}");
        }
    }

    #[test]
    fn volume_is_perceptual() {
        // Squared, so half reads as half rather than as 6 dB down.
        let full = render("thump", 1.0)
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()));
        let half = render("thump", 0.5)
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(half < full * 0.35, "half={half} full={full}");
        assert!(render("thump", 0.0).iter().all(|s| s.abs() < 1e-6));
    }

    #[test]
    fn an_unknown_id_falls_back_rather_than_going_silent() {
        assert_eq!(normalize(Some("thump"), "sub-tick"), "thump");
        assert_eq!(normalize(Some("from-the-future"), "sub-tick"), "sub-tick");
        assert_eq!(normalize(None, "sub-tick"), "sub-tick");
    }

    #[test]
    fn the_envelope_is_a_real_decay() {
        assert_eq!(envelope(-0.1, 0.01, 1.0, 0.1), 0.0);
        assert!((envelope(0.01, 0.01, 1.0, 0.1) - 1.0).abs() < 1e-5);
        assert!(envelope(0.06, 0.01, 1.0, 0.1) < 0.5, "should have fallen by halfway");
        assert_eq!(envelope(0.2, 0.01, 1.0, 0.1), 0.0);
    }

    #[test]
    fn the_glide_is_exponential_in_frequency() {
        // Linear in frequency sounds like a different sweep entirely on a 110 -> 45 Hz fall.
        let halfway = glide(100.0, 25.0, 0.5, 1.0);
        assert!((halfway - 50.0).abs() < 0.5, "got {halfway}");
        assert_eq!(glide(100.0, 25.0, 0.0, 1.0), 100.0);
        assert!((glide(100.0, 25.0, 2.0, 1.0) - 25.0).abs() < 1e-3);
    }
}
