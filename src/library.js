/**
 * Library scanning: turn a folder of audio files into an ordered track list.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { probe } from './metadata.js';

/** Extensions the player is willing to hand to an audio backend. */
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.wave',
  '.flac',
  '.ogg',
  '.oga',
  '.m4a',
  '.aac',
  '.opus',
  '.wma',
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** True when the filename looks like audio and is not a hidden/resource file. */
export function isAudioFile(filePath, extensions = AUDIO_EXTENSIONS) {
  const base = path.basename(filePath);
  if (base.startsWith('.') || base.startsWith('._')) return false;
  return extensions.includes(path.extname(base).toLowerCase());
}

/**
 * Derive a display title (and possibly artist) from a filename.
 * `03 - Miles Away - Night Drive.mp3` -> { track: '03', artist: 'Miles Away', title: 'Night Drive' }
 */
export function titleFromFilename(fileName) {
  let base = path.basename(fileName, path.extname(fileName));
  const result = {};

  const leadingTrack = base.match(/^\s*(\d{1,3})\s*[-._)]\s*(.+)$/);
  if (leadingTrack) {
    result.track = leadingTrack[1];
    base = leadingTrack[2];
  }

  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    result.artist = parts[0].trim();
    result.title = parts.slice(1).join(' - ').trim();
  } else {
    result.title = base.replace(/[_]+/g, ' ').trim();
  }

  if (!result.title) result.title = base || fileName;
  return result;
}

/** Run `worker` over `items` with a bounded number of in-flight promises. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Recursively collect audio file paths under `dir`. */
async function collectFiles(dir, { recursive, extensions, depth = 0 }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      const err = new Error(`Music folder not found: ${dir}`);
      err.code = 'ENOENT';
      throw err;
    }
    throw error;
  }

  const files = [];
  const subdirs = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        subdirs.push(full);
      }
    } else if (entry.isFile() && isAudioFile(full, extensions)) {
      files.push(full);
    }
  }

  files.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
  subdirs.sort(collator.compare);

  if (recursive && depth < 8) {
    for (const sub of subdirs) {
      files.push(...(await collectFiles(sub, { recursive, extensions, depth: depth + 1 })));
    }
  }
  return files;
}

/** Build a track record for a single file path. */
export async function readTrack(filePath, { baseDir = null } = {}) {
  const absolute = path.resolve(filePath);
  const fileName = path.basename(absolute);
  const fromName = titleFromFilename(fileName);

  let size = 0;
  try {
    size = (await fs.stat(absolute)).size;
  } catch {
    size = 0;
  }

  const info = await probe(absolute);
  const tags = info.tags || {};

  return {
    path: absolute,
    relativePath: baseDir ? path.relative(baseDir, absolute) : fileName,
    fileName,
    extension: path.extname(absolute).toLowerCase(),
    title: tags.title || fromName.title,
    artist: tags.artist || fromName.artist || 'Unknown artist',
    album: tags.album || '',
    trackNumber: tags.track || fromName.track || '',
    year: tags.year || '',
    genre: tags.genre || '',
    duration: info.duration,
    bitrate: info.bitrate ?? null,
    sampleRate: info.sampleRate ?? null,
    channels: info.channels ?? null,
    size,
  };
}

/**
 * Scan `dir` and return the tracks it contains, metadata included.
 * Throws with code ENOENT when the folder does not exist.
 */
export async function scanLibrary(dir, { recursive = true, extensions = AUDIO_EXTENSIONS } = {}) {
  const baseDir = path.resolve(dir);
  const stat = await fs.stat(baseDir).catch((error) => {
    if (error.code === 'ENOENT') {
      const err = new Error(`Music folder not found: ${baseDir}`);
      err.code = 'ENOENT';
      throw err;
    }
    throw error;
  });

  if (stat.isFile()) {
    return isAudioFile(baseDir, extensions)
      ? [await readTrack(baseDir, { baseDir: path.dirname(baseDir) })]
      : [];
  }

  const files = await collectFiles(baseDir, { recursive, extensions });
  return mapWithConcurrency(files, 8, (file) => readTrack(file, { baseDir }));
}

/** Build tracks from an explicit list of files or folders. */
export async function loadTracks(inputs, options = {}) {
  const tracks = [];
  const seen = new Set();
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const found = await scanLibrary(resolved, options);
    for (const track of found) {
      if (!seen.has(track.path)) {
        seen.add(track.path);
        tracks.push(track);
      }
    }
  }
  return tracks;
}
