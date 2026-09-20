/**
 * Command line front end: argument parsing, the one-shot commands
 * (`--list`, `--doctor`) and the hand-off into the interactive app.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { App } from './app.js';
import { detectBackends, installHints, selectBackend } from './backends.js';
import { formatBytes, formatTime, pluralize, truncate } from './format.js';
import { loadTracks } from './library.js';
import { REPEAT_MODES } from './playlist.js';
import { glyphs, style } from './theme.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPTIONS = {
  dir: { type: 'string', short: 'd' },
  list: { type: 'boolean', short: 'l', default: false },
  doctor: { type: 'boolean', default: false },
  shuffle: { type: 'boolean', short: 's', default: false },
  repeat: { type: 'string', short: 'r', default: 'off' },
  volume: { type: 'string', short: 'v', default: '80' },
  track: { type: 'string', short: 't' },
  backend: { type: 'string', short: 'b' },
  silent: { type: 'boolean', default: false },
  'no-autoplay': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/** Read the package version without importing JSON (keeps older Node happy). */
async function readVersion() {
  try {
    const raw = await fs.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function usage(version) {
  const b = style.bold;
  const g = style.gray;
  return `
${style.brightMagenta(glyphs.note)} ${b('terminal-music-player')} ${g(`v${version}`)}
  A music player that lives entirely in your terminal.

${b('USAGE')}
  music-player [options] [files or folders...]

${b('OPTIONS')}
  -d, --dir <path>      Folder to play (default: ./songs)
  -l, --list            List the songs that would be played, then exit
  -t, --track <n>       Start at song number n
  -s, --shuffle         Shuffle the queue
  -r, --repeat <mode>   Repeat mode: ${REPEAT_MODES.join(' | ')} (default: off)
  -v, --volume <0-100>  Starting volume (default: 80)
  -b, --backend <id>    Force an audio backend (mpv, ffplay, mpg123, afplay, ...)
      --silent          Simulate playback with no audio device (for testing)
      --no-autoplay     Start paused instead of playing immediately
      --doctor          Show which audio backends are installed, then exit
  -h, --help            Show this help
      --version         Print the version

${b('CONTROLS')} ${g('(inside the player)')}
  space play/pause  n     next        p     previous    s     stop
  ← / → seek        + / - volume      m     mute        x     shuffle
  ↑ / ↓ select      enter play        1-9   jump        r     repeat
  ?     help        F5    rescan      0     restart     q     quit

${b('EXAMPLES')}
  ${g('$')} music-player                      ${g('# play everything in ./songs')}
  ${g('$')} music-player ~/Music --shuffle    ${g('# shuffle your music folder')}
  ${g('$')} music-player song.mp3             ${g('# play a single file')}
  ${g('$')} music-player --list               ${g('# just show the queue')}
`;
}

/**
 * Work out which folder to play.
 * Explicit input wins, then $MUSIC_PLAYER_DIR, then ./songs, then the copy of
 * songs/ that ships with the project.
 */
export async function resolveMusicDir({ dir, positionals, cwd = process.cwd() } = {}) {
  if (positionals?.length) return positionals.map((entry) => path.resolve(cwd, entry));
  if (dir) return [path.resolve(cwd, dir)];
  if (process.env.MUSIC_PLAYER_DIR) return [path.resolve(cwd, process.env.MUSIC_PLAYER_DIR)];

  const localSongs = path.resolve(cwd, 'songs');
  if (await exists(localSongs)) return [localSongs];

  const bundled = path.join(PACKAGE_ROOT, 'songs');
  if (await exists(bundled)) return [bundled];

  return [localSongs]; // report the miss against the folder the user expected
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** `--list` output. */
function printList(tracks, out) {
  if (tracks.length === 0) {
    out.write(`${style.brightYellow('No songs found.')}\n`);
    return;
  }
  const numberWidth = String(tracks.length).length;
  const total = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);

  out.write(`\n  ${style.bold(pluralize(tracks.length, 'song'))} ${style.gray(`· ${formatTime(total)} total`)}\n\n`);
  tracks.forEach((track, index) => {
    const number = style.gray(String(index + 1).padStart(numberWidth));
    const title = truncate(track.title, 38).padEnd(38);
    const artist = style.gray(truncate(track.artist, 22).padEnd(22));
    const duration = style.gray(formatTime(track.duration).padStart(6));
    const size = style.gray(formatBytes(track.size).padStart(8));
    out.write(`  ${number}. ${title}  ${artist}  ${duration}  ${size}\n`);
  });
  out.write('\n');
}

/** `--doctor` output. */
async function printDoctor(out, { preferred } = {}) {
  const available = await detectBackends();
  out.write(`\n  ${style.bold('AUDIO BACKENDS')}\n\n`);
  out.write(`  ${style.gray('platform')}  ${process.platform} (${process.arch})\n`);
  out.write(`  ${style.gray('node')}      ${process.version}\n\n`);

  if (available.length === 0) {
    out.write(`  ${style.brightRed('No audio backend found.')}\n`);
    out.write(`  ${style.gray('Install any one of these, then run this command again:')}\n\n`);
    for (const { label, hint } of installHints()) {
      out.write(`    ${label.padEnd(26)} ${style.gray(hint)}\n`);
    }
    out.write(
      `\n  ${style.gray('Or use --silent to try the interface without playing audio.')}\n\n`,
    );
    return 1;
  }

  const chosen = selectBackend(available, { preferred });
  for (const backend of available) {
    const mark = backend.id === chosen?.id ? style.brightGreen(glyphs.playing) : ' ';
    const features = [
      backend.supportsSeek ? 'seek' : null,
      backend.supportsVolume ? 'volume' : null,
      backend.supportsSignalPause ? 'instant pause' : 'restart-based pause',
    ]
      .filter(Boolean)
      .join(', ');
    out.write(`  ${mark} ${style.bold(backend.label.padEnd(24))} ${style.gray(backend.executable)}\n`);
    out.write(`    ${style.gray(features)}\n`);
  }
  out.write(`\n  ${style.gray('Using:')} ${style.bold(chosen?.label ?? 'none')}\n\n`);
  return 0;
}

/**
 * Entry point.
 * @param {string[]} argv arguments after `node script.js`
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    stdout.write(`${style.brightRed(error.message)}\n`);
    stdout.write(`${style.gray('Run with --help to see the available options.')}\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  const version = await readVersion();

  if (values.help) {
    stdout.write(usage(version));
    return 0;
  }
  if (values.version) {
    stdout.write(`${version}\n`);
    return 0;
  }
  if (values.doctor) {
    return printDoctor(stdout, { preferred: values.backend });
  }

  const repeat = REPEAT_MODES.includes(values.repeat) ? values.repeat : 'off';
  if (!REPEAT_MODES.includes(values.repeat)) {
    stdout.write(
      `${style.brightYellow(`Unknown repeat mode "${values.repeat}", using "off".`)}\n`,
    );
  }
  const volume = clampNumber(values.volume, 0, 100, 80);

  const targets = await resolveMusicDir({ dir: values.dir, positionals });

  let tracks;
  try {
    tracks = await loadTracks(targets);
  } catch (error) {
    if (error.code === 'ENOENT') {
      stdout.write(`\n  ${style.brightRed(error.message)}\n`);
      stdout.write(
        `  ${style.gray('Create the folder and put some audio files in it, or pass a path:')}\n`,
      );
      stdout.write(`  ${style.gray('  music-player ~/Music')}\n\n`);
      return 1;
    }
    throw error;
  }

  if (values.list) {
    printList(tracks, stdout);
    return 0;
  }

  if (tracks.length === 0) {
    stdout.write(`\n  ${style.brightYellow('No playable audio files found in:')}\n`);
    for (const target of targets) stdout.write(`    ${style.gray(target)}\n`);
    stdout.write(`\n  ${style.gray('Supported: mp3, wav, flac, ogg, m4a, aac, opus')}\n\n`);
    return 1;
  }

  // Pick a backend that can handle the formats actually in the queue.
  const available = values.silent ? [] : await detectBackends();
  const extensions = [...new Set(tracks.map((track) => track.extension))];
  const backend = values.silent ? null : selectBackend(available, {
    extensions,
    preferred: values.backend,
  });

  if (!values.silent && !backend) {
    stdout.write(`\n  ${style.brightRed('No audio backend found, so nothing can be played.')}\n\n`);
    for (const { label, hint } of installHints()) {
      stdout.write(`    ${label.padEnd(26)} ${style.gray(hint)}\n`);
    }
    stdout.write(
      `\n  ${style.gray('Then run')} music-player --doctor ${style.gray('to confirm.')}\n`,
    );
    stdout.write(
      `  ${style.gray('You can still explore the interface with')} music-player --silent\n\n`,
    );
    return 1;
  }

  if (values.backend && backend && backend.id !== values.backend && backend.command !== values.backend) {
    stdout.write(
      `${style.brightYellow(`Backend "${values.backend}" is not available; using ${backend.label}.`)}\n`,
    );
  }

  const startIndex = values.track ? clampNumber(values.track, 1, tracks.length, 1) - 1 : 0;
  const musicDir = targets.length === 1 ? targets[0] : null;

  const app = new App({
    tracks,
    backend,
    musicDir,
    silent: values.silent,
    shuffle: values.shuffle,
    repeat,
    volume,
    startIndex,
    autoplay: !values['no-autoplay'],
    stdout,
  });

  return app.run();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
