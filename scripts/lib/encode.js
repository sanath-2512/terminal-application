/**
 * Encoders for the generated demo tracks: RIFF/WAVE, MP3 (via lamejs) and
 * ID3v2.3 tag writing, so the player has real tagged files to read.
 */

import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * WAV
 * ------------------------------------------------------------------ */

/**
 * Wrap 16-bit PCM in a RIFF/WAVE container.
 * @param {Int16Array} pcm
 * @param {object} [options]
 */
export function encodeWav(pcm, { sampleRate = 44100, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize, 40);

  const body = Buffer.alloc(dataSize);
  for (let i = 0; i < pcm.length; i += 1) body.writeInt16LE(pcm[i], i * bytesPerSample);

  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------ *
 * MP3
 * ------------------------------------------------------------------ */

let cachedLame;

/**
 * Load lamejs. Its published entry point is broken under Node, so the prebuilt
 * browser bundle is evaluated in a sandbox and the encoder pulled out of it.
 * @returns {object|null} null when the dev dependency is not installed
 */
export function loadLame() {
  if (cachedLame !== undefined) return cachedLame;
  try {
    const bundlePath = require.resolve('lamejs/lame.min.js');
    const code = fs.readFileSync(bundlePath, 'utf8');
    cachedLame = vm.runInNewContext(`${code}\n;lamejs;`, {
      Int8Array,
      Int16Array,
      Int32Array,
      Float32Array,
      Math,
      Date,
      console,
    });
  } catch {
    cachedLame = null;
  }
  return cachedLame;
}

/**
 * Encode 16-bit PCM to MP3.
 * @param {Int16Array} pcm
 * @returns {Buffer|null} null when lamejs is unavailable
 */
export function encodeMp3(pcm, { sampleRate = 44100, channels = 1, bitrate = 96 } = {}) {
  const lame = loadLame();
  if (!lame) return null;

  const encoder = new lame.Mp3Encoder(channels, sampleRate, bitrate);
  const blockSize = 1152;
  const chunks = [];

  for (let offset = 0; offset < pcm.length; offset += blockSize) {
    const block = pcm.subarray(offset, Math.min(offset + blockSize, pcm.length));
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length > 0) chunks.push(Buffer.from(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) chunks.push(Buffer.from(flushed));

  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * ID3v2.3 tags
 * ------------------------------------------------------------------ */

const TAG_FRAMES = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  track: 'TRCK',
  year: 'TYER',
  genre: 'TCON',
  comment: 'TXXX',
};

/** Encode a 4-byte synchsafe integer (7 bits per byte), as ID3v2 requires. */
function writeSynchsafe(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** Build one ID3v2.3 text frame with ISO-8859-1 payload. */
function textFrame(id, value) {
  const text = Buffer.from(String(value), 'latin1');
  const payload = Buffer.concat([Buffer.from([0x00]), text]); // 0x00 = ISO-8859-1
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8); // no frame flags
  return Buffer.concat([header, payload]);
}

/**
 * Build a complete ID3v2.3 tag.
 * @param {object} tags {title, artist, album, track, year, genre}
 * @param {number} [padding] bytes of zero padding after the frames
 */
export function buildId3v2(tags, { padding = 128 } = {}) {
  const frames = [];
  for (const [key, id] of Object.entries(TAG_FRAMES)) {
    if (key === 'comment') continue;
    const value = tags[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      frames.push(textFrame(id, value));
    }
  }

  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00]), // version 2.3.0
    Buffer.from([0x00]), // no flags
    writeSynchsafe(body.length),
  ]);
  return Buffer.concat([header, body]);
}

/** Prepend an ID3v2.3 tag to an MP3 buffer. */
export function tagMp3(mp3Buffer, tags) {
  return Buffer.concat([buildId3v2(tags), mp3Buffer]);
}
