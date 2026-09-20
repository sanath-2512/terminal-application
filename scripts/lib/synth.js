/**
 * A tiny offline software synthesiser.
 *
 * Everything the demo tracks are made of lives here: oscillators, envelopes, a
 * Karplus-Strong plucked string, drum voices, a feedback reverb and a limiter.
 * Rendering is entirely offline — buffers of samples in, one mono Float32Array
 * out — so it runs anywhere Node does and needs no audio hardware.
 */

export const SAMPLE_RATE = 44100;

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/** mulberry32: small, fast, and seeded so every run produces identical audio. */
export function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Notes and chords
 * ------------------------------------------------------------------ */

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `A3` / `F#4` / `Bb2` -> MIDI note number. */
export function noteToMidi(name) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(String(name).trim());
  if (!match) throw new Error(`Unrecognised note: ${name}`);
  const [, letter, accidental, octave] = match;
  const offset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return (Number(octave) + 1) * 12 + SEMITONES[letter] + offset;
}

/** MIDI note number -> frequency in Hz (A4 = 440). */
export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function noteToFreq(name) {
  return midiToFreq(noteToMidi(name));
}

const CHORD_SHAPES = {
  '': [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  add9: [0, 4, 7, 14],
};

/**
 * Parse a chord symbol into MIDI note numbers.
 * @param {string} symbol e.g. `Am`, `Fmaj7`, `G7`
 * @param {number} octave octave of the chord root
 */
export function chordNotes(symbol, octave = 3) {
  const match = /^([A-G][#b]?)(.*)$/.exec(String(symbol).trim());
  if (!match) throw new Error(`Unrecognised chord: ${symbol}`);
  const [, root, suffix] = match;
  const shape = CHORD_SHAPES[suffix];
  if (!shape) throw new Error(`Unsupported chord quality: ${symbol}`);
  const rootMidi = noteToMidi(`${root}${octave}`);
  return shape.map((interval) => rootMidi + interval);
}

/* ------------------------------------------------------------------ *
 * Buffers and envelopes
 * ------------------------------------------------------------------ */

/** An empty mono buffer able to hold `seconds` of audio. */
export function createBuffer(seconds) {
  return new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
}

/** Add `source` into `target` starting at `startSeconds`, scaled by `gain`. */
export function mixInto(target, source, startSeconds, gain = 1) {
  const offset = Math.round(startSeconds * SAMPLE_RATE);
  const end = Math.min(target.length, offset + source.length);
  for (let i = Math.max(0, offset); i < end; i += 1) {
    target[i] += source[i - offset] * gain;
  }
}

/**
 * Classic ADSR envelope evaluated at one sample.
 * @param {number} t         seconds since the note started
 * @param {number} duration  total note length in seconds
 */
export function adsr(t, duration, { attack = 0.01, decay = 0.1, sustain = 0.7, release = 0.2 }) {
  if (t < 0) return 0;
  const releaseStart = Math.max(attack + decay, duration - release);
  if (t < attack) return t / attack;
  if (t < attack + decay) return 1 - ((1 - sustain) * (t - attack)) / decay;
  if (t < releaseStart) return sustain;
  const releaseLength = Math.max(1e-4, duration + release - releaseStart);
  const progress = (t - releaseStart) / releaseLength;
  return progress >= 1 ? 0 : sustain * (1 - progress);
}

/* ------------------------------------------------------------------ *
 * Voices
 * ------------------------------------------------------------------ */

/**
 * Additive tone: a few harmonics of a sine, shaped by an envelope.
 * Used for pads and lead lines.
 */
export function renderTone({
  freq,
  duration,
  harmonics = [1, 0.35, 0.18, 0.08],
  envelope = { attack: 0.03, decay: 0.15, sustain: 0.65, release: 0.25 },
  vibrato = 0,
  detune = 0,
}) {
  const tail = envelope.release ?? 0.2;
  const buffer = createBuffer(duration + tail);
  const twoPi = Math.PI * 2;

  for (let i = 0; i < buffer.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const amp = adsr(t, duration, envelope);
    if (amp <= 0) continue;

    const wobble = vibrato ? Math.sin(twoPi * 5.2 * t) * vibrato : 0;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h += 1) {
      const partial = freq * (h + 1) * (1 + wobble + detune);
      sample += harmonics[h] * Math.sin(twoPi * partial * t);
    }
    buffer[i] = sample * amp;
  }
  return buffer;
}

/**
 * Karplus-Strong plucked string: a burst of noise pushed through a short
 * averaging delay line. Cheap, and it sounds like a real plucked instrument.
 */
export function renderPluck({ freq, duration, damping = 0.5, random = Math.random }) {
  const buffer = createBuffer(duration);
  const delayLength = Math.max(2, Math.round(SAMPLE_RATE / freq));
  const line = new Float32Array(delayLength);
  for (let i = 0; i < delayLength; i += 1) line[i] = random() * 2 - 1;

  const feedback = 0.985 - damping * 0.02;
  let index = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const current = line[index];
    const next = line[(index + 1) % delayLength];
    const averaged = (current + next) * 0.5 * feedback;
    line[index] = averaged;
    buffer[i] = current;
    index = (index + 1) % delayLength;
  }

  // Fade the tail so consecutive plucks do not click.
  const fade = Math.min(buffer.length, Math.round(0.02 * SAMPLE_RATE));
  for (let i = 0; i < fade; i += 1) {
    buffer[buffer.length - 1 - i] *= i / fade;
  }
  return buffer;
}

/** Round, slightly saturated bass note. */
export function renderBass({ freq, duration }) {
  const buffer = createBuffer(duration + 0.12);
  const twoPi = Math.PI * 2;
  for (let i = 0; i < buffer.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const amp = adsr(t, duration, { attack: 0.006, decay: 0.08, sustain: 0.8, release: 0.12 });
    if (amp <= 0) continue;
    const fundamental = Math.sin(twoPi * freq * t);
    const octave = Math.sin(twoPi * freq * 2 * t) * 0.18;
    buffer[i] = Math.tanh((fundamental + octave) * 1.6) * amp;
  }
  return buffer;
}

/** Kick drum: a fast downward pitch sweep with a click on the front. */
export function renderKick({ duration = 0.32 } = {}) {
  const buffer = createBuffer(duration);
  const twoPi = Math.PI * 2;
  let phase = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const freq = 110 * Math.exp(-t * 26) + 42;
    phase += (twoPi * freq) / SAMPLE_RATE;
    const body = Math.sin(phase) * Math.exp(-t * 7.5);
    const click = Math.exp(-t * 260) * 0.35;
    buffer[i] = Math.tanh((body + click) * 1.3);
  }
  return buffer;
}

/** Snare: filtered noise plus a little tonal body. */
export function renderSnare({ duration = 0.22, random = Math.random } = {}) {
  const buffer = createBuffer(duration);
  const twoPi = Math.PI * 2;
  let previous = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const white = random() * 2 - 1;
    const highpassed = white - previous * 0.6; // crude high-pass
    previous = white;
    const noise = highpassed * Math.exp(-t * 26);
    const body = Math.sin(twoPi * 190 * t) * Math.exp(-t * 34) * 0.4;
    buffer[i] = (noise * 0.8 + body) * 0.9;
  }
  return buffer;
}

/** Hi-hat: a very short noise burst. */
export function renderHat({ duration = 0.06, random = Math.random, open = false } = {}) {
  const length = open ? duration * 3 : duration;
  const buffer = createBuffer(length);
  const decay = open ? 22 : 90;
  let previous = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const white = random() * 2 - 1;
    const highpassed = white - previous * 0.85;
    previous = white;
    buffer[i] = highpassed * Math.exp(-t * decay) * 0.5;
  }
  return buffer;
}

/* ------------------------------------------------------------------ *
 * Effects and mastering
 * ------------------------------------------------------------------ */

/**
 * Feedback-delay reverb: several detuned taps blurred together. Not a real
 * room model, but it glues the parts together nicely.
 */
export function applyReverb(buffer, { mix = 0.22, delays = [0.031, 0.047, 0.071], feedback = 0.4 }) {
  const wet = new Float32Array(buffer.length);
  for (const delaySeconds of delays) {
    const delaySamples = Math.round(delaySeconds * SAMPLE_RATE);
    if (delaySamples <= 0) continue;
    const line = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      const delayed = i >= delaySamples ? line[i - delaySamples] : 0;
      line[i] = buffer[i] + delayed * feedback;
      wet[i] += delayed;
    }
  }
  const scale = 1 / delays.length;
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] * (1 - mix) + wet[i] * scale * mix;
  }
  return buffer;
}

/** One-pole low-pass, used to take the edge off the mix. */
export function applyLowpass(buffer, cutoffHz = 12000) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);
  let previous = buffer[0] || 0;
  for (let i = 0; i < buffer.length; i += 1) {
    previous += alpha * (buffer[i] - previous);
    buffer[i] = previous;
  }
  return buffer;
}

/** Fade in and out so tracks never start or end with a click. */
export function applyFades(buffer, { fadeIn = 0.05, fadeOut = 1.2 }) {
  const inSamples = Math.min(buffer.length, Math.round(fadeIn * SAMPLE_RATE));
  const outSamples = Math.min(buffer.length, Math.round(fadeOut * SAMPLE_RATE));
  for (let i = 0; i < inSamples; i += 1) buffer[i] *= i / inSamples;
  for (let i = 0; i < outSamples; i += 1) {
    buffer[buffer.length - 1 - i] *= i / outSamples;
  }
  return buffer;
}

/** Soft-clip, then normalise so the loudest peak sits just under full scale. */
export function master(buffer, { peak = 0.89 } = {}) {
  let maximum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.tanh(buffer[i] * 0.85);
    const magnitude = Math.abs(buffer[i]);
    if (magnitude > maximum) maximum = magnitude;
  }
  if (maximum > 0) {
    const gain = peak / maximum;
    for (let i = 0; i < buffer.length; i += 1) buffer[i] *= gain;
  }
  return buffer;
}

/** Float samples in [-1, 1] -> signed 16-bit PCM. */
export function toInt16(buffer) {
  const pcm = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, buffer[i]));
    pcm[i] = Math.round(clamped * 32767);
  }
  return pcm;
}
