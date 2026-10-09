/**
 * The wheel's sound effects: a short bass note when it opens (and again when the aim comes back to
 * its centre), and another each time the highlight moves to a different item. Both are picked from
 * the same ten.
 *
 * Synthesized with Web Audio rather than shipped as files: a few nodes per note, nothing to load
 * or decode before the first one, and nothing added to the bytes the wheel parses before it can
 * paint (`verify-renderer-budget`).
 *
 * The context is a module singleton on purpose. `RadialMenu` is remounted on every open, and a
 * context created per mount would pay Chromium's audio-stream start-up on every open — the one
 * moment the note has to be instant.
 *
 * It is suspended while the wheel is down. A running context keeps an output stream open and an
 * audio thread waking every few milliseconds, which is not a cost an idle launcher in the tray gets
 * to charge. Opening resumes it well before the bloom that the opening note is timed to.
 */

import type { UIConfig } from '../types';

export type RadialSoundId =
  | 'thump'
  | 'sub-tick'
  | 'knock'
  | 'pluck'
  | 'pulse'
  | 'drop'
  | 'felt-tap'
  | 'rubber'
  | 'reese'
  | 'haptic';

type Voice = (c: BaseAudioContext, out: AudioNode, t: number) => void;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** The note still sounding, so the next one can cut it: a fast sweep must not pile up into mud. */
let lastVoice: GainNode | null = null;
let sleepTimer: number | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** How long after the last use the stream is released. Covers a quick reopen. */
const SLEEP_AFTER_MS = 1500;
/** Master level, with a limiter behind it; the same chain the sounds were auditioned through. */
const MASTER_GAIN = 0.7;
/** The Volume setting, 0–1. At 1 the notes play at `MASTER_GAIN`, the level they were tuned at. */
let volume = 1;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 4;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  master = ctx.createGain();
  master.gain.value = masterGain();
  master.connect(limiter).connect(ctx.destination);
  return ctx;
}

/**
 * Squared, because loudness is heard on a log scale: a linear 50% is only 6 dB down and sounds
 * barely quieter, while the square puts it 12 dB down, near what "half" feels like.
 */
function masterGain(): number {
  return MASTER_GAIN * volume * volume;
}

/* -- Building blocks ------------------------------------------------------ */

/** Gain envelope: silence → `peak` over `attack`, then an exponential fall to silence over `decay`. */
function envelope(c: BaseAudioContext, t: number, attack: number, peak: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

/** An oscillator, optionally gliding from `from` to `to` over `glide` seconds. */
function tone(c: BaseAudioContext, type: OscillatorType, from: number, to: number, t: number, glide: number) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + glide);
  return o;
}

function lowpass(c: BaseAudioContext, frequency: number, q = 0.7): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

function noise(c: BaseAudioContext): AudioBufferSourceNode {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    noiseBuffer = c.createBuffer(1, Math.ceil(c.sampleRate * 0.25), c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const source = c.createBufferSource();
  source.buffer = noiseBuffer;
  return source;
}

function run(nodes: AudioScheduledSourceNode[], t: number, duration: number): void {
  for (const node of nodes) {
    node.start(t);
    node.stop(t + duration);
  }
}

/* -- The ten -------------------------------------------------------------- */

const VOICES: Record<RadialSoundId, Voice> = {
  /** Sine 110 → 45 Hz, 120 ms: a soft kick drum. */
  thump(c, out, t) {
    const o = tone(c, 'sine', 110, 45, t, 0.08);
    o.connect(envelope(c, t, 0.002, 0.9, 0.12)).connect(out);
    run([o], t, 0.14);
  },
  /** Sine 58 Hz with a 2.5 kHz tick on top, so it still reads on small speakers. 75 ms. */
  'sub-tick'(c, out, t) {
    const o = tone(c, 'sine', 58, 58, t, 0);
    o.connect(envelope(c, t, 0.001, 0.85, 0.07)).connect(out);
    const n = noise(c);
    const highpass = c.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 2500;
    n.connect(highpass).connect(envelope(c, t, 0.0005, 0.12, 0.006)).connect(out);
    run([o, n], t, 0.09);
  },
  /** Triangle 190 → 75 Hz through a 450 Hz lowpass, 75 ms: knuckle on a desk. */
  knock(c, out, t) {
    const o = tone(c, 'triangle', 190, 75, t, 0.05);
    o.connect(lowpass(c, 450, 1)).connect(envelope(c, t, 0.001, 1.0, 0.07)).connect(out);
    run([o], t, 0.09);
  },
  /** Two saws at 55 Hz through a resonant lowpass snapping 1.4 kHz → 140 Hz, 160 ms. */
  pluck(c, out, t) {
    const a = tone(c, 'sawtooth', 55, 55, t, 0);
    const b = tone(c, 'sawtooth', 55.4, 55.4, t, 0);
    const f = lowpass(c, 1400, 6);
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(140, t + 0.12);
    a.connect(f);
    b.connect(f);
    f.connect(envelope(c, t, 0.002, 0.34, 0.16)).connect(out);
    run([a, b], t, 0.18);
  },
  /** Square 82 Hz through a 320 Hz lowpass, 65 ms: an old console menu. */
  pulse(c, out, t) {
    const o = tone(c, 'square', 82, 82, t, 0);
    o.connect(lowpass(c, 320, 0.7)).connect(envelope(c, t, 0.004, 0.32, 0.06)).connect(out);
    run([o], t, 0.08);
  },
  /** Sine 240 → 38 Hz, 200 ms: a falling "bwomp". */
  drop(c, out, t) {
    const o = tone(c, 'sine', 240, 38, t, 0.16);
    o.connect(envelope(c, t, 0.003, 0.85, 0.2)).connect(out);
    run([o], t, 0.22);
  },
  /** Noise under a 220 Hz lowpass with a sine 95 → 70 Hz, 50 ms: a fingertip on felt. */
  'felt-tap'(c, out, t) {
    const n = noise(c);
    n.connect(lowpass(c, 220, 1.2)).connect(envelope(c, t, 0.001, 1.6, 0.045)).connect(out);
    const o = tone(c, 'sine', 95, 70, t, 0.04);
    o.connect(envelope(c, t, 0.001, 0.5, 0.05)).connect(out);
    run([n, o], t, 0.07);
  },
  /** Sine 90 → 65 Hz, frequency-modulated at 36 Hz, 115 ms: a bouncy wobble. */
  rubber(c, out, t) {
    const o = tone(c, 'sine', 90, 65, t, 0.1);
    const m = tone(c, 'sine', 36, 36, t, 0);
    const depth = c.createGain();
    depth.gain.setValueAtTime(40, t);
    depth.gain.exponentialRampToValueAtTime(1, t + 0.1);
    m.connect(depth).connect(o.frequency);
    o.connect(envelope(c, t, 0.002, 0.85, 0.11)).connect(out);
    run([o, m], t, 0.13);
  },
  /** Saws at 55 and 57.2 Hz beating through a 520 Hz lowpass, 105 ms. */
  reese(c, out, t) {
    const a = tone(c, 'sawtooth', 55, 55, t, 0);
    const b = tone(c, 'sawtooth', 57.2, 57.2, t, 0);
    const f = lowpass(c, 520, 2);
    a.connect(f);
    b.connect(f);
    f.connect(envelope(c, t, 0.004, 0.3, 0.1)).connect(out);
    run([a, b], t, 0.12);
  },
  /** Saturated sine at 160 Hz, 32 ms: a phone's vibration tap. */
  haptic(c, out, t) {
    const o = tone(c, 'sine', 160, 160, t, 0);
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh((i / 127.5 - 1) * 3) / Math.tanh(3);
    shaper.curve = curve;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.001);
    g.gain.setValueAtTime(0.42, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
    o.connect(shaper).connect(g).connect(out);
    run([o], t, 0.04);
  },
};

/** In the order the settings list them — the order they were auditioned in. */
export const RADIAL_SOUNDS: ReadonlyArray<{ id: RadialSoundId; name: string }> = [
  { id: 'thump', name: 'Thump' },
  { id: 'sub-tick', name: 'Sub Tick' },
  { id: 'knock', name: 'Knock' },
  { id: 'pluck', name: 'Pluck' },
  { id: 'pulse', name: 'Pulse' },
  { id: 'drop', name: 'Drop' },
  { id: 'felt-tap', name: 'Felt Tap' },
  { id: 'rubber', name: 'Rubber' },
  { id: 'reese', name: 'Reese' },
  { id: 'haptic', name: 'Haptic' },
];

/** A config can be hand-edited, and an id from a future version must still play something. */
export function normalizeRadialSound(value: unknown, fallback: RadialSoundId): RadialSoundId {
  return typeof value === 'string' && value in VOICES ? (value as RadialSoundId) : fallback;
}

/** The Volume setting as a whole percent; a missing or hand-edited value plays at full. */
export function normalizeRadialVolume(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 100;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/* -- Which note, when ----------------------------------------------------- */

/** What each moment plays, with `null` for a moment that is switched off. */
export interface RadialSounds {
  open: RadialSoundId | null;
  hover: RadialSoundId | null;
}

/** The three switches and two picks, read the one way both the wheel and Settings read them. */
export function resolveRadialSounds(config: Pick<UIConfig,
  'radialSounds' | 'radialOpenSound' | 'radialOpenSoundId' | 'radialHoverSound' | 'radialHoverSoundId'
>): RadialSounds {
  const on = config.radialSounds !== false;
  return {
    open: on && config.radialOpenSound !== false ? normalizeRadialSound(config.radialOpenSoundId, 'sub-tick') : null,
    hover: on && config.radialHoverSound !== false ? normalizeRadialSound(config.radialHoverSoundId, 'thump') : null,
  };
}

/** The centre, as a highlight. Everything else that can be lit is an item, named by its id. */
export const HUB_TARGET = '__hub__';

/** How long after the opening note a highlight change stays silent — about the note's own length. */
export const HIGHLIGHT_QUIET_MS = 150;

/**
 * The note for a highlight that has just landed on `target`, or null for silence. The wheel and the
 * practice wheel in Settings both ask this, so the one you try is the one you get.
 *
 * An item plays the hover note. The centre plays the OPENING note — it is where the wheel starts,
 * and aiming back at it is going back to that start — but only once the aim has been out to an
 * item since the wheel opened. Before that the pointer is simply where the wheel put it, and the
 * centre lighting up is the opening itself, which has already been heard.
 *
 * Nothing plays within `HIGHLIGHT_QUIET_MS` of the opening: a wheel that opens with the pointer
 * off to one side lights that item on its first frames, and a note there landed on top of the
 * opening one and cut it off.
 */
export function noteForHighlight(
  target: string | null,
  aimedAway: boolean,
  msSinceOpen: number,
  sounds: RadialSounds,
): RadialSoundId | null {
  if (target === null || msSinceOpen < HIGHLIGHT_QUIET_MS) return null;
  if (target === HUB_TARGET) return aimedAway ? sounds.open : null;
  return sounds.hover;
}

/* -- Playback ------------------------------------------------------------- */

/**
 * One level for both notes. Each window — the wheel, Settings — has its own copy of this module,
 * so each sets it from its own config.
 */
export function setRadialSoundVolume(percent: unknown): void {
  volume = normalizeRadialVolume(percent) / 100;
  if (master) master.gain.value = masterGain();
}

/** Called when the wheel opens with a sound on, so the stream is up before the first note. */
export function wakeRadialSound(): void {
  if (sleepTimer !== null) {
    window.clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  const c = context();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
}

/** Releases the stream shortly after the last use. Calling it again restarts the wait. */
export function sleepRadialSound(): void {
  if (!ctx) return;
  if (sleepTimer !== null) window.clearTimeout(sleepTimer);
  sleepTimer = window.setTimeout(() => {
    sleepTimer = null;
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
  }, SLEEP_AFTER_MS);
}

export function playRadialSound(id: RadialSoundId): void {
  const c = context();
  if (!c || !master) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const t = c.currentTime + 0.005;
  if (lastVoice) lastVoice.gain.setTargetAtTime(0, t, 0.006);
  const voice = c.createGain();
  voice.connect(master);
  (VOICES[id] ?? VOICES.thump)(c, voice, t);
  lastVoice = voice;
  window.setTimeout(() => voice.disconnect(), 400);
}

/** One note from outside the wheel — Settings — releasing the stream again once it has played. */
export function previewRadialSound(id: RadialSoundId): void {
  playRadialSound(id);
  sleepRadialSound();
}
