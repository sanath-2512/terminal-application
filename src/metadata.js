/**
 * Audio metadata reader.
 *
 * Everything here works on raw bytes with no native dependencies: durations and
 * tags are parsed straight out of the container headers. Only the few kilobytes
 * that matter are read, never the whole file, so scanning a large library stays
 * fast.
 *
 * Supported: MP3 (ID3v2/ID3v1 tags, CBR + Xing/VBRI VBR), WAV, FLAC, Ogg Vorbis.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * MPEG audio frame tables
 * ------------------------------------------------------------------ */

const BITRATES = {
  // [version][layer] -> kbps by index
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

/**
 * Decode a 4-byte MPEG frame header.
 * Returns null when the bytes are not a valid frame.
 */
export function parseFrameHeader(buf, offset = 0) {
  if (offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buf[offset + 1] >> 3) & 0x03;
  const layerBits = (buf[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buf[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buf[offset + 2] >> 2) & 0x03;
  const padding = (buf[offset + 2] >> 1) & 0x01;
  const channelMode = (buf[offset + 3] >> 6) & 0x03;

  if (versionBits === 0x01 || layerBits === 0x00) return null;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null;
  if (sampleRateIndex === 0x03) return null;

  const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : 2.5;
  const layer = 4 - layerBits; // 0b01 -> layer 3, 0b10 -> layer 2, 0b11 -> layer 1
  const tableKey = `${version === 1 ? 1 : 2}-${layer}`;

  const bitrate = BITRATES[tableKey][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  if (!bitrate || !sampleRate) return null;

  const channels = channelMode === 0x03 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;

  const frameLength =
    layer === 1
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;

  return {
    version,
    layer,
    bitrate,
    sampleRate,
    channels,
    samplesPerFrame,
    frameLength,
    padding,
  };
}

/** Read a 4-byte synchsafe integer (7 usable bits per byte) as used by ID3v2. */
function readSynchsafe(buf, offset) {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

/** Size in bytes of the leading ID3v2 tag, or 0 when there is none. */
export function id3v2Size(buf) {
  if (buf.length < 10) return 0;
  if (buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const hasFooter = (buf[5] & 0x10) !== 0;
  return 10 + readSynchsafe(buf, 6) + (hasFooter ? 10 : 0);
}

/** Decode an ID3v2 text frame payload according to its encoding byte. */
function decodeTextFrame(payload) {
  if (payload.length === 0) return '';
  const encoding = payload[0];
  const body = payload.subarray(1);
  let text;
  switch (encoding) {
    case 0x01: // UTF-16 with BOM
      text = body.toString('utf16le').replace(/^﻿/, '');
      if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
        // Big-endian BOM: swap byte order before decoding.
        const swapped = Buffer.from(body.subarray(2));
        swapped.swap16();
        text = swapped.toString('utf16le');
      }
      break;
    case 0x02: { // UTF-16BE without BOM
      const swapped = Buffer.from(body);
      if (swapped.length % 2 === 0) swapped.swap16();
      text = swapped.toString('utf16le');
      break;
    }
    case 0x03:
      text = body.toString('utf8');
      break;
    default:
      text = body.toString('latin1');
  }
  return text.replace(/\u0000+$/, '').trim();
}

const ID3_FRAME_MAP = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
  TCON: 'genre',
  TCO: 'genre',
  TRCK: 'track',
  TRK: 'track',
  TYER: 'year',
  TDRC: 'year',
  TYE: 'year',
};

/** Parse the text frames of an ID3v2 tag held in `buf`. */
export function parseId3v2(buf) {
  const tags = {};
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return tags;

  const majorVersion = buf[3];
  const tagSize = readSynchsafe(buf, 6);
  const end = Math.min(buf.length, 10 + tagSize);
  const frameIdLength = majorVersion === 2 ? 3 : 4;
  const frameHeaderLength = majorVersion === 2 ? 6 : 10;

  let offset = 10;
  // An extended header, when present, sits before the first frame.
  if (majorVersion >= 3 && (buf[5] & 0x40) !== 0 && offset + 4 <= end) {
    const extendedSize =
      majorVersion === 4 ? readSynchsafe(buf, offset) : buf.readUInt32BE(offset) + 4;
    offset += extendedSize;
  }

  while (offset + frameHeaderLength <= end) {
    const id = buf.toString('latin1', offset, offset + frameIdLength);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached

    let size;
    if (majorVersion === 2) {
      size = (buf[offset + 3] << 16) | (buf[offset + 4] << 8) | buf[offset + 5];
    } else if (majorVersion === 4) {
      size = readSynchsafe(buf, offset + 4);
    } else {
      size = buf.readUInt32BE(offset + 4);
    }

    const start = offset + frameHeaderLength;
    if (size <= 0 || start + size > end) break;

    const field = ID3_FRAME_MAP[id];
    if (field && !tags[field]) {
      const value = decodeTextFrame(buf.subarray(start, start + size));
      if (value) tags[field] = value;
    }
    offset = start + size;
  }
  return tags;
}

/** Parse the legacy 128-byte ID3v1 block found at the end of some MP3 files. */
export function parseId3v1(buf) {
  if (buf.length < 128 || buf.toString('latin1', 0, 3) !== 'TAG') return {};
  const field = (start, end) => buf.toString('latin1', start, end).replace(/\u0000.*$/, '').trim();
  const tags = {};
  const title = field(3, 33);
  const artist = field(33, 63);
  const album = field(63, 93);
  const year = field(93, 97);
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (year) tags.year = year;
  return tags;
}

/* ------------------------------------------------------------------ *
 * Per-format probes
 * ------------------------------------------------------------------ */

async function probeMp3(handle, size) {
  const headBytes = Math.min(size, 128 * 1024);
  const head = Buffer.alloc(headBytes);
  await handle.read(head, 0, headBytes, 0);

  const tags = parseId3v2(head);
  let offset = id3v2Size(head);

  // ID3v1 lives in the final 128 bytes and must not be counted as audio.
  let audioEnd = size;
  if (size >= 128) {
    const tail = Buffer.alloc(128);
    await handle.read(tail, 0, 128, size - 128);
    const v1 = parseId3v1(tail);
    if (Object.keys(v1).length > 0 || tail.toString('latin1', 0, 3) === 'TAG') {
      audioEnd = size - 128;
      for (const [key, value] of Object.entries(v1)) {
        if (!tags[key]) tags[key] = value;
      }
    }
  }

  // Locate the first real frame; some files carry junk between tag and audio.
  let frame = null;
  const searchLimit = Math.min(head.length - 4, offset + 64 * 1024);
  for (let i = Math.min(offset, head.length - 4); i <= searchLimit; i += 1) {
    const candidate = parseFrameHeader(head, i);
    if (candidate) {
      // Confirm by checking that the next frame lands on a sync word too.
      const next = i + candidate.frameLength;
      if (next + 4 > head.length || parseFrameHeader(head, next)) {
        frame = candidate;
        offset = i;
        break;
      }
    }
  }

  if (!frame) return { duration: null, tags };

  // Xing/Info (VBR) headers sit in the side-information area of frame one.
  const sideInfo =
    frame.version === 1 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const xingOffset = offset + 4 + sideInfo;
  let frameCount = null;

  if (xingOffset + 12 <= head.length) {
    const magic = head.toString('latin1', xingOffset, xingOffset + 4);
    if (magic === 'Xing' || magic === 'Info') {
      const flags = head.readUInt32BE(xingOffset + 4);
      if (flags & 0x01) frameCount = head.readUInt32BE(xingOffset + 8);
    }
  }
  if (frameCount === null && offset + 4 + 32 + 4 <= head.length) {
    const vbriOffset = offset + 4 + 32;
    if (head.toString('latin1', vbriOffset, vbriOffset + 4) === 'VBRI') {
      frameCount = head.readUInt32BE(vbriOffset + 14);
    }
  }

  const duration =
    frameCount && frameCount > 0
      ? (frameCount * frame.samplesPerFrame) / frame.sampleRate
      : ((audioEnd - offset) * 8) / frame.bitrate;

  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    tags,
    bitrate: frame.bitrate,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    vbr: frameCount !== null,
  };
}

async function probeWav(handle, size) {
  const headBytes = Math.min(size, 64 * 1024);
  const head = Buffer.alloc(headBytes);
  await handle.read(head, 0, headBytes, 0);
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
    return { duration: null, tags: {} };
  }

  let offset = 12;
  let byteRate = null;
  let sampleRate = null;
  let channels = null;
  let dataSize = null;

  while (offset + 8 <= head.length) {
    const chunkId = head.toString('latin1', offset, offset + 4);
    const chunkSize = head.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 16 <= head.length) {
      channels = head.readUInt16LE(offset + 10);
      sampleRate = head.readUInt32LE(offset + 12);
      byteRate = head.readUInt32LE(offset + 16);
    } else if (chunkId === 'data') {
      // A streamed WAV may declare size 0; fall back to what is really there.
      dataSize = chunkSize > 0 ? Math.min(chunkSize, size - offset - 8) : size - offset - 8;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word aligned
    if (chunkSize < 0) break;
  }

  const duration = byteRate && dataSize ? dataSize / byteRate : null;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    tags: {},
    sampleRate,
    channels,
    bitrate: byteRate ? byteRate * 8 : undefined,
  };
}

async function probeFlac(handle, size) {
  const head = Buffer.alloc(Math.min(size, 8192));
  await handle.read(head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'fLaC' || head.length < 42) {
    return { duration: null, tags: {} };
  }
  // STREAMINFO is always the first metadata block; bytes 18..21 hold the
  // sample rate (20 bits) and the 36-bit total sample count.
  const s = head.readUInt32BE(18);
  const sampleRate = s >>> 12;
  const channels = ((s >>> 9) & 0x07) + 1;
  const totalSamples = (s & 0x0f) * 2 ** 32 + head.readUInt32BE(22);
  const duration = sampleRate ? totalSamples / sampleRate : null;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    tags: {},
    sampleRate,
    channels,
  };
}

async function probeOgg(handle, size) {
  const head = Buffer.alloc(Math.min(size, 8192));
  await handle.read(head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'OggS') return { duration: null, tags: {} };

  // Identification header: 0x01 "vorbis", version, channels, sample rate (LE).
  const idIndex = head.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
  if (idIndex < 0 || idIndex + 16 > head.length) return { duration: null, tags: {} };
  const channels = head[idIndex + 11];
  const sampleRate = head.readUInt32LE(idIndex + 12);

  // The granule position on the final page is the total sample count.
  const tailBytes = Math.min(size, 64 * 1024);
  const tail = Buffer.alloc(tailBytes);
  await handle.read(tail, 0, tailBytes, size - tailBytes);
  const lastPage = tail.lastIndexOf(Buffer.from('OggS', 'latin1'));
  if (lastPage < 0 || lastPage + 14 > tail.length || !sampleRate) {
    return { duration: null, tags: {}, sampleRate, channels };
  }
  const granule = Number(tail.readBigUInt64LE(lastPage + 6));
  const duration = granule / sampleRate;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    tags: {},
    sampleRate,
    channels,
  };
}

const PROBES = {
  '.mp3': probeMp3,
  '.mp2': probeMp3,
  '.wav': probeWav,
  '.wave': probeWav,
  '.flac': probeFlac,
  '.ogg': probeOgg,
  '.oga': probeOgg,
};

/**
 * Read duration and tags for one file.
 * Never throws: an unreadable or unsupported file simply reports nulls.
 */
export async function probe(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const probeFn = PROBES[ext];
  const empty = { duration: null, tags: {} };
  if (!probeFn) return empty;

  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size < 16) return empty;
    return await probeFn(handle, size);
  } catch {
    return empty;
  } finally {
    await handle?.close().catch(() => {});
  }
}
