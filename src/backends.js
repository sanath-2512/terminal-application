/**
 * Audio backends.
 *
 * Node cannot open a sound card on its own, so the player drives one of the
 * command line audio tools that ship with (or are trivially installed on) each
 * platform. Each descriptor knows how to build an argument list and what the
 * tool is capable of, which is what the UI uses to decide whether seeking or
 * volume control is offered.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

const ALL_FORMATS = null; // null means "anything we are willing to hand it"

/** @type {Array<object>} Ordered best-first; the first available one wins. */
export const BACKENDS = [
  {
    id: 'mpv',
    command: 'mpv',
    label: 'mpv',
    install: { linux: 'sudo apt install mpv', darwin: 'brew install mpv', win32: 'winget install mpv' },
    formats: ALL_FORMATS,
    supportsSeek: true,
    supportsVolume: true,
    buildArgs: ({ file, startAt, volume }) => [
      '--no-video',
      '--no-terminal',
      '--really-quiet',
      `--volume=${Math.round(volume)}`,
      ...(startAt > 0 ? [`--start=${startAt.toFixed(2)}`] : []),
      file,
    ],
  },
  {
    id: 'ffplay',
    command: 'ffplay',
    label: 'ffplay (FFmpeg)',
    install: {
      linux: 'sudo apt install ffmpeg',
      darwin: 'brew install ffmpeg',
      win32: 'winget install Gyan.FFmpeg',
    },
    formats: ALL_FORMATS,
    supportsSeek: true,
    supportsVolume: true,
    buildArgs: ({ file, startAt, volume }) => [
      '-nodisp',
      '-autoexit',
      '-hide_banner',
      '-loglevel',
      'error',
      '-volume',
      String(Math.round(volume)),
      ...(startAt > 0 ? ['-ss', startAt.toFixed(2)] : []),
      file,
    ],
  },
  {
    id: 'mpg123',
    command: 'mpg123',
    label: 'mpg123',
    install: {
      linux: 'sudo apt install mpg123',
      darwin: 'brew install mpg123',
      win32: 'winget install mpg123',
    },
    formats: ['.mp3', '.mp2'],
    supportsSeek: true,
    supportsVolume: true,
    buildArgs: ({ file, startAt, volume, track }) => {
      const sampleRate = track?.sampleRate || 44100;
      const samplesPerFrame = sampleRate >= 32000 ? 1152 : 576;
      const frames = Math.max(0, Math.round((startAt * sampleRate) / samplesPerFrame));
      return [
        '--quiet',
        '--no-control',
        '--scale',
        String(Math.round((volume / 100) * 32768)),
        ...(frames > 0 ? ['-k', String(frames)] : []),
        file,
      ];
    },
  },
  {
    id: 'afplay',
    command: 'afplay',
    label: 'afplay (macOS)',
    platforms: ['darwin'],
    install: { darwin: 'built in to macOS' },
    formats: ALL_FORMATS,
    supportsSeek: false,
    supportsVolume: true,
    buildArgs: ({ file, volume }) => ['-v', (volume / 100).toFixed(3), file],
  },
  {
    id: 'cvlc',
    command: 'cvlc',
    label: 'VLC (cvlc)',
    install: {
      linux: 'sudo apt install vlc',
      darwin: 'brew install --cask vlc',
      win32: 'winget install VideoLAN.VLC',
    },
    formats: ALL_FORMATS,
    supportsSeek: true,
    supportsVolume: true,
    buildArgs: ({ file, startAt, volume }) => [
      '--intf',
      'dummy',
      '--play-and-exit',
      '--quiet',
      `--gain=${(volume / 100).toFixed(2)}`,
      ...(startAt > 0 ? [`--start-time=${startAt.toFixed(2)}`] : []),
      file,
    ],
  },
  {
    id: 'sox',
    command: 'play',
    label: 'SoX (play)',
    install: { linux: 'sudo apt install sox libsox-fmt-all', darwin: 'brew install sox' },
    formats: ALL_FORMATS,
    supportsSeek: true,
    supportsVolume: true,
    buildArgs: ({ file, startAt, volume }) => [
      '-q',
      '-v',
      (volume / 100).toFixed(3),
      file,
      ...(startAt > 0 ? ['trim', startAt.toFixed(2)] : []),
    ],
  },
  {
    id: 'paplay',
    command: 'paplay',
    label: 'PulseAudio (paplay)',
    platforms: ['linux'],
    install: { linux: 'sudo apt install pulseaudio-utils' },
    formats: ['.wav', '.wave', '.flac', '.ogg', '.oga'],
    supportsSeek: false,
    supportsVolume: true,
    buildArgs: ({ file, volume }) => [`--volume=${Math.round((volume / 100) * 65536)}`, file],
  },
  {
    id: 'aplay',
    command: 'aplay',
    label: 'ALSA (aplay)',
    platforms: ['linux'],
    install: { linux: 'sudo apt install alsa-utils' },
    formats: ['.wav', '.wave'],
    supportsSeek: false,
    supportsVolume: false,
    buildArgs: ({ file }) => ['-q', file],
  },
  {
    id: 'powershell',
    command: 'powershell',
    label: 'Windows Media (PowerShell)',
    platforms: ['win32'],
    install: { win32: 'built in to Windows' },
    formats: ALL_FORMATS,
    supportsSeek: true,
    supportsVolume: true,
    // Pausing is done by stopping and restarting at the saved offset, because
    // Windows has no SIGSTOP equivalent.
    supportsSignalPause: false,
    buildArgs: ({ file, startAt, volume }) => {
      const script = [
        'Add-Type -AssemblyName presentationCore;',
        '$p = New-Object System.Windows.Media.MediaPlayer;',
        `$p.Open([uri]::new(${psQuote(file)}));`,
        `$p.Volume = ${(volume / 100).toFixed(3)};`,
        'while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 50 };',
        `$p.Position = [TimeSpan]::FromSeconds(${startAt.toFixed(2)});`,
        '$p.Play();',
        'while ($p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 150 };',
        '$p.Close();',
      ].join(' ');
      return ['-NoProfile', '-NonInteractive', '-Command', script];
    },
  },
];

/** Quote a path for embedding inside a PowerShell single-quoted string. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Look up an executable on PATH without spawning a shell.
 * Returns the absolute path, or null when it is not installed.
 */
export async function findExecutable(command) {
  if (path.isAbsolute(command)) {
    return (await isExecutable(command)) ? command : null;
  }
  const pathValue = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the backend is willing to play files with this extension. */
export function backendSupportsFormat(backend, extension) {
  if (!backend.formats) return true;
  return backend.formats.includes(String(extension).toLowerCase());
}

/** Backends that make sense on the current platform. */
export function candidateBackends(platform = process.platform) {
  return BACKENDS.filter((backend) => !backend.platforms || backend.platforms.includes(platform));
}

/**
 * Probe the system and return every backend that is actually installed,
 * in preference order, each with its resolved executable path.
 */
export async function detectBackends({ platform = process.platform } = {}) {
  const found = [];
  for (const backend of candidateBackends(platform)) {
    const resolved = await findExecutable(backend.command);
    if (resolved) {
      found.push({
        ...backend,
        supportsSignalPause: backend.supportsSignalPause ?? platform !== 'win32',
        executable: resolved,
      });
    }
  }
  return found;
}

/**
 * Choose a backend for the given file extensions.
 *
 * @param {object[]} available result of detectBackends()
 * @param {object}   options
 * @param {string[]} options.extensions extensions the playlist contains
 * @param {string}   options.preferred  backend id the user asked for
 */
export function selectBackend(available, { extensions = [], preferred = null } = {}) {
  if (available.length === 0) return null;

  if (preferred) {
    const match = available.find((b) => b.id === preferred || b.command === preferred);
    if (match) return match;
  }

  const wanted = [...new Set(extensions.map((e) => String(e).toLowerCase()))];
  if (wanted.length > 0) {
    const coversAll = available.find((b) => wanted.every((ext) => backendSupportsFormat(b, ext)));
    if (coversAll) return coversAll;
    const coversSome = available.find((b) => wanted.some((ext) => backendSupportsFormat(b, ext)));
    if (coversSome) return coversSome;
  }
  return available[0];
}

/** Human-readable install hints for when nothing is available. */
export function installHints(platform = process.platform) {
  return candidateBackends(platform)
    .filter((backend) => backend.install?.[platform])
    .map((backend) => ({ label: backend.label, hint: backend.install[platform] }));
}
