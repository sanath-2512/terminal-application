/**
 * Turns a compact song description into audio.
 *
 * A song is a chord progression plus an arrangement: a list of sections that
 * say which layers (pad, arpeggio, bass, drums, lead) are playing. Everything
 * is driven by a seeded RNG, so the same specification always renders to
 * byte-identical audio.
 */

import {
  SAMPLE_RATE,
  applyFades,
  applyLowpass,
  applyReverb,
  chordNotes,
  createBuffer,
  createRandom,
  master,
  midiToFreq,
  mixInto,
  noteToMidi,
  renderBass,
  renderHat,
  renderKick,
  renderPluck,
  renderSnare,
  renderTone,
} from './synth.js';

const BEATS_PER_BAR = 4;

const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** Scale degrees as MIDI numbers across two octaves from `key`. */
function buildScale(key, mode, octave) {
  const root = noteToMidi(`${key}${octave}`);
  const intervals = MODES[mode] || MODES.minor;
  return [
    ...intervals.map((i) => root + i),
    ...intervals.map((i) => root + 12 + i),
  ];
}

/** Expand an arrangement into a per-bar list of active layers. */
function expandArrangement(arrangement, progression) {
  const bars = [];
  for (const section of arrangement) {
    for (let i = 0; i < section.bars; i += 1) {
      bars.push({
        layers: new Set(section.layers),
        chord: progression[bars.length % progression.length],
        section: section.name ?? '',
      });
    }
  }
  return bars;
}

/**
 * Render a song specification to a mono Float32Array.
 * @param {object} spec see scripts/generate-songs.js for the shape
 */
export function composeSong(spec) {
  const random = createRandom(spec.seed);
  const secondsPerBeat = 60 / spec.bpm;
  const barSeconds = secondsPerBeat * BEATS_PER_BAR;
  const bars = expandArrangement(spec.arrangement, spec.progression);
  const tail = Math.max(1.6, barSeconds * 0.75);
  const mix = createBuffer(bars.length * barSeconds + tail);

  const scale = buildScale(spec.key, spec.mode, spec.melodyOctave ?? 4);
  let melodyIndex = Math.floor(random() * scale.length * 0.5) + 2;

  bars.forEach((bar, barIndex) => {
    const barStart = barIndex * barSeconds;
    const chord = chordNotes(bar.chord, spec.chordOctave ?? 3);
    const rootMidi = chord[0];

    /* ---- pad: sustained chord ------------------------------------ */
    if (bar.layers.has('pad')) {
      chord.forEach((midi, voice) => {
        const tone = renderTone({
          freq: midiToFreq(midi),
          duration: barSeconds * 0.95,
          harmonics: [1, 0.22, 0.1, 0.04],
          envelope: { attack: 0.35, decay: 0.4, sustain: 0.55, release: 0.7 },
          detune: (voice - 1) * 0.0012,
        });
        mixInto(mix, tone, barStart, 0.115);
      });
    }

    /* ---- arpeggio: eighth-note plucks ---------------------------- */
    if (bar.layers.has('arp')) {
      const pattern = spec.arpPattern ?? [0, 1, 2, 1, 2, 3, 2, 1];
      for (let step = 0; step < 8; step += 1) {
        const degree = pattern[step % pattern.length];
        const midi = chord[degree % chord.length] + 12 * Math.floor(degree / chord.length);
        const when = barStart + step * secondsPerBeat * 0.5;
        const pluck = renderPluck({
          freq: midiToFreq(midi),
          duration: secondsPerBeat * 0.75,
          damping: 0.45,
          random,
        });
        // Give the off-beats a little less weight so the pattern breathes.
        const accent = step % 2 === 0 ? 0.3 : 0.2;
        mixInto(mix, pluck, when, accent);
      }
    }

    /* ---- bass: root on beats 1 and 3 ----------------------------- */
    if (bar.layers.has('bass')) {
      const bassMidi = rootMidi - 12;
      mixInto(
        mix,
        renderBass({ freq: midiToFreq(bassMidi), duration: secondsPerBeat * 1.4 }),
        barStart,
        0.5,
      );
      mixInto(
        mix,
        renderBass({ freq: midiToFreq(bassMidi), duration: secondsPerBeat * 0.8 }),
        barStart + secondsPerBeat * 2,
        0.4,
      );
      if (random() > 0.55) {
        // Occasional pick-up note into the next bar.
        mixInto(
          mix,
          renderBass({ freq: midiToFreq(bassMidi + 7), duration: secondsPerBeat * 0.45 }),
          barStart + secondsPerBeat * 3.5,
          0.34,
        );
      }
    }

    /* ---- drums --------------------------------------------------- */
    if (bar.layers.has('drums')) {
      mixInto(mix, renderKick(), barStart, 0.62);
      mixInto(mix, renderKick(), barStart + secondsPerBeat * 2, 0.55);
      if (random() > 0.6) {
        mixInto(mix, renderKick(), barStart + secondsPerBeat * 2.75, 0.3);
      }

      mixInto(mix, renderSnare({ random }), barStart + secondsPerBeat, 0.4);
      mixInto(mix, renderSnare({ random }), barStart + secondsPerBeat * 3, 0.42);

      for (let step = 0; step < 8; step += 1) {
        const open = step === 7 && random() > 0.7;
        mixInto(
          mix,
          renderHat({ random, open }),
          barStart + step * secondsPerBeat * 0.5,
          step % 2 === 0 ? 0.22 : 0.13,
        );
      }
    }

    /* ---- lead: a melody that leans on chord tones ---------------- */
    if (bar.layers.has('lead')) {
      const rhythm = spec.leadRhythm ?? [1, 0.5, 0.5, 1, 1];
      let beat = 0;
      for (const length of rhythm) {
        if (beat >= BEATS_PER_BAR) break;

        // Step up or down the scale, and snap to a chord tone on the downbeat.
        const step = random() < 0.62 ? (random() < 0.5 ? -1 : 1) : (random() < 0.5 ? -2 : 2);
        melodyIndex = Math.max(0, Math.min(scale.length - 1, melodyIndex + step));
        let midi = scale[melodyIndex];
        if (beat === 0) {
          const chordPitchClasses = chord.map((note) => note % 12);
          if (!chordPitchClasses.includes(midi % 12)) {
            const target = chordPitchClasses[Math.floor(random() * chordPitchClasses.length)];
            const nearest = scale.findIndex((note, i) => note % 12 === target && i >= melodyIndex - 3);
            if (nearest >= 0) {
              melodyIndex = nearest;
              midi = scale[melodyIndex];
            }
          }
        }

        const noteSeconds = length * secondsPerBeat * 0.9;
        const tone = renderTone({
          freq: midiToFreq(midi),
          duration: noteSeconds,
          harmonics: [1, 0.3, 0.12, 0.05, 0.02],
          envelope: { attack: 0.02, decay: 0.12, sustain: 0.6, release: 0.22 },
          vibrato: 0.0035,
        });
        mixInto(mix, tone, barStart + beat * secondsPerBeat, 0.2);
        beat += length;
      }
    }
  });

  applyReverb(mix, spec.reverb ?? { mix: 0.24, delays: [0.033, 0.051, 0.077], feedback: 0.36 });
  applyLowpass(mix, spec.lowpass ?? 11500);
  applyFades(mix, { fadeIn: 0.08, fadeOut: Math.min(2.2, tail) });
  master(mix);

  return mix;
}

/** Length in seconds of a rendered song, without rendering it. */
export function songDuration(spec) {
  const secondsPerBeat = 60 / spec.bpm;
  const barSeconds = secondsPerBeat * BEATS_PER_BAR;
  const bars = spec.arrangement.reduce((sum, section) => sum + section.bars, 0);
  return bars * barSeconds + Math.max(1.6, barSeconds * 0.75);
}

export { SAMPLE_RATE };
