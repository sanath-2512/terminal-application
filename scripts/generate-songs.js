#!/usr/bin/env node
/**
 * Generates the demo tracks in songs/.
 *
 * The music is synthesised from scratch by this repository, so the files are
 * original works with no third-party rights attached — they are released into
 * the public domain (CC0) along with the rest of the project. Nothing is
 * downloaded, and rendering is fully deterministic: the same seed always
 * produces the same audio.
 *
 *   npm run generate-songs                 # write MP3s into songs/
 *   node scripts/generate-songs.js --format wav
 *   node scripts/generate-songs.js --only night-drive --out /tmp/demo
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { composeSong, songDuration } from './lib/compose.js';
import { encodeMp3, encodeWav, loadLame, tagMp3 } from './lib/encode.js';
import { SAMPLE_RATE, toInt16 } from './lib/synth.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALBUM = 'Public Domain Demos';
const ARTIST = 'Terminal Waves';
const YEAR = '2026';

/**
 * The demo album. Each entry is a complete song specification — progression,
 * tempo, arrangement and the seed that drives every random choice.
 */
export const SONGS = [
  {
    slug: 'night-drive',
    title: 'Night Drive',
    genre: 'Synthwave',
    seed: 1041,
    bpm: 96,
    key: 'A',
    mode: 'minor',
    progression: ['Am', 'F', 'C', 'G'],
    arpPattern: [0, 1, 2, 1, 3, 2, 1, 0],
    arrangement: [
      { name: 'intro', bars: 2, layers: ['pad', 'arp'] },
      { name: 'verse', bars: 4, layers: ['pad', 'arp', 'bass'] },
      { name: 'build', bars: 4, layers: ['pad', 'arp', 'bass', 'drums'] },
      { name: 'chorus', bars: 4, layers: ['pad', 'arp', 'bass', 'drums', 'lead'] },
      { name: 'outro', bars: 2, layers: ['pad', 'arp'] },
    ],
  },
  {
    slug: 'copper-sky',
    title: 'Copper Sky',
    genre: 'Ambient',
    seed: 2209,
    bpm: 78,
    key: 'C',
    mode: 'major',
    chordOctave: 3,
    melodyOctave: 4,
    progression: ['C', 'G', 'Am', 'Fmaj7'],
    arpPattern: [0, 2, 1, 3, 2, 1],
    leadRhythm: [2, 1, 1],
    lowpass: 9000,
    reverb: { mix: 0.34, delays: [0.041, 0.063, 0.089], feedback: 0.45 },
    arrangement: [
      { name: 'intro', bars: 3, layers: ['pad'] },
      { name: 'verse', bars: 4, layers: ['pad', 'arp'] },
      { name: 'swell', bars: 4, layers: ['pad', 'arp', 'bass', 'lead'] },
      { name: 'outro', bars: 2, layers: ['pad', 'arp'] },
    ],
  },
  {
    slug: 'neon-alley',
    title: 'Neon Alley',
    genre: 'Electronic',
    seed: 3317,
    bpm: 112,
    key: 'E',
    mode: 'minor',
    progression: ['Em', 'C', 'G', 'D'],
    arpPattern: [0, 2, 1, 2, 3, 2, 1, 2],
    leadRhythm: [0.5, 0.5, 1, 1, 1],
    arrangement: [
      { name: 'intro', bars: 2, layers: ['arp', 'drums'] },
      { name: 'verse', bars: 4, layers: ['pad', 'arp', 'bass', 'drums'] },
      { name: 'chorus', bars: 6, layers: ['pad', 'arp', 'bass', 'drums', 'lead'] },
      { name: 'break', bars: 2, layers: ['pad', 'arp'] },
      { name: 'outro', bars: 4, layers: ['pad', 'arp', 'bass', 'drums'] },
    ],
  },
  {
    slug: 'paper-boats',
    title: 'Paper Boats',
    genre: 'Lo-Fi',
    seed: 4423,
    bpm: 72,
    key: 'D',
    mode: 'dorian',
    progression: ['Dm', 'Bb', 'F', 'C'],
    arpPattern: [0, 1, 2, 3, 2, 1],
    leadRhythm: [1, 1, 2],
    lowpass: 7800,
    reverb: { mix: 0.3, delays: [0.037, 0.059, 0.083], feedback: 0.42 },
    arrangement: [
      { name: 'intro', bars: 2, layers: ['pad', 'arp'] },
      { name: 'verse', bars: 4, layers: ['pad', 'arp', 'bass', 'drums'] },
      { name: 'bridge', bars: 4, layers: ['pad', 'arp', 'bass', 'drums', 'lead'] },
      { name: 'outro', bars: 2, layers: ['pad'] },
    ],
  },
  {
    slug: 'signal-lost',
    title: 'Signal Lost',
    genre: 'Electronic',
    seed: 5531,
    bpm: 124,
    key: 'G',
    mode: 'minor',
    progression: ['Gm', 'Eb', 'Bb', 'F'],
    arpPattern: [0, 3, 2, 1, 2, 3],
    leadRhythm: [0.5, 0.5, 0.5, 0.5, 1, 1],
    arrangement: [
      { name: 'intro', bars: 4, layers: ['arp', 'bass', 'drums'] },
      { name: 'verse', bars: 6, layers: ['pad', 'arp', 'bass', 'drums'] },
      { name: 'chorus', bars: 8, layers: ['pad', 'arp', 'bass', 'drums', 'lead'] },
      { name: 'outro', bars: 4, layers: ['pad', 'arp', 'bass'] },
    ],
  },
  {
    slug: 'first-light',
    title: 'First Light',
    genre: 'Electronic',
    seed: 6637,
    bpm: 88,
    key: 'F',
    mode: 'mixolydian',
    progression: ['F', 'C', 'Dm', 'Bb'],
    arpPattern: [0, 2, 3, 2, 1, 2],
    leadRhythm: [1, 0.5, 0.5, 2],
    arrangement: [
      { name: 'intro', bars: 2, layers: ['pad', 'arp'] },
      { name: 'verse', bars: 4, layers: ['pad', 'arp', 'bass'] },
      { name: 'lift', bars: 4, layers: ['pad', 'arp', 'bass', 'drums'] },
      { name: 'chorus', bars: 4, layers: ['pad', 'arp', 'bass', 'drums', 'lead'] },
      { name: 'outro', bars: 2, layers: ['pad', 'arp'] },
    ],
  },
];

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f', default: 'mp3' },
  bitrate: { type: 'string', short: 'b', default: '96' },
  only: { type: 'string' },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `
Generate the public-domain demo tracks used to try out the player.

  node scripts/generate-songs.js [options]

  -o, --out <dir>       Output folder (default: songs/)
  -f, --format <fmt>    mp3 (default) or wav
  -b, --bitrate <kbps>  MP3 bitrate (default: 96)
      --only <slug>     Render a single song, e.g. --only night-drive
      --force           Re-render even if the file already exists
  -h, --help            Show this help
`;

/** Two-digit track number prefix keeps the files in album order on disk. */
function fileNameFor(song, index, extension) {
  const number = String(index + 1).padStart(2, '0');
  return `${number} - ${ARTIST} - ${song.title}.${extension}`;
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: OPTIONS });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const format = values.format.toLowerCase();
  if (!['mp3', 'wav'].includes(format)) {
    process.stderr.write(`Unknown format "${values.format}". Use mp3 or wav.\n`);
    return 2;
  }
  if (format === 'mp3' && !loadLame()) {
    process.stderr.write(
      'The MP3 encoder (lamejs) is not installed.\n' +
        'Run `npm install` first, or render WAV instead with --format wav.\n',
    );
    return 1;
  }

  const outDir = path.resolve(values.out ? values.out : path.join(PROJECT_ROOT, 'songs'));
  await fs.mkdir(outDir, { recursive: true });

  const selected = values.only
    ? SONGS.filter((song) => song.slug === values.only || song.title === values.only)
    : SONGS;

  if (selected.length === 0) {
    process.stderr.write(`No song matches "${values.only}".\n`);
    process.stderr.write(`Available: ${SONGS.map((s) => s.slug).join(', ')}\n`);
    return 1;
  }

  process.stdout.write(`\nRendering ${selected.length} track(s) into ${outDir}\n\n`);
  const bitrate = Number(values.bitrate) || 96;

  for (const song of selected) {
    const index = SONGS.indexOf(song);
    const fileName = fileNameFor(song, index, format);
    const target = path.join(outDir, fileName);

    if (!values.force && (await fileExists(target))) {
      process.stdout.write(`  skip   ${fileName} (already exists, use --force)\n`);
      continue;
    }

    const started = Date.now();
    const samples = composeSong(song);
    const pcm = toInt16(samples);

    let buffer;
    if (format === 'wav') {
      buffer = encodeWav(pcm, { sampleRate: SAMPLE_RATE, channels: 1 });
    } else {
      const mp3 = encodeMp3(pcm, { sampleRate: SAMPLE_RATE, channels: 1, bitrate });
      buffer = tagMp3(mp3, {
        title: song.title,
        artist: ARTIST,
        album: ALBUM,
        track: `${index + 1}/${SONGS.length}`,
        year: YEAR,
        genre: song.genre,
      });
    }

    await fs.writeFile(target, buffer);
    const seconds = songDuration(song);
    process.stdout.write(
      `  wrote  ${fileName.padEnd(44)} ${seconds.toFixed(1)}s  ` +
        `${(buffer.length / 1024).toFixed(0)} KB  (${Date.now() - started} ms)\n`,
    );
  }

  process.stdout.write('\nDone. Try them with:  npm start\n\n');
  return 0;
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// Only render when run as a script; importing this file (for tests, or to
// reuse SONGS elsewhere) must not have side effects.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`\ngenerate-songs: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}

export { main };
