import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildId3v2, encodeMp3, encodeWav, loadLame, tagMp3 } from '../scripts/lib/encode.js';
import { SAMPLE_RATE, toInt16 } from '../scripts/lib/synth.js';
import { id3v2Size, parseFrameHeader, parseId3v1, parseId3v2, probe } from '../src/metadata.js';

/** A mono sine wave of the requested length, as 16-bit PCM. */
function tone(seconds, freq = 440) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.5;
  }
  return toInt16(samples);
}

let tmpDir;
test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-meta-'));
});
test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('WAV duration is read from the header', async () => {
  const file = path.join(tmpDir, 'tone.wav');
  await fs.writeFile(file, encodeWav(tone(2.5), { sampleRate: SAMPLE_RATE, channels: 1 }));

  const info = await probe(file);
  assert.ok(Math.abs(info.duration - 2.5) < 0.01, `expected ~2.5s, got ${info.duration}`);
  assert.equal(info.sampleRate, SAMPLE_RATE);
  assert.equal(info.channels, 1);
});

test('MP3 duration and ID3v2 tags survive a round trip', async (t) => {
  if (!loadLame()) {
    t.skip('lamejs is not installed (run npm install)');
    return;
  }

  const file = path.join(tmpDir, 'tagged.mp3');
  const mp3 = encodeMp3(tone(3), { sampleRate: SAMPLE_RATE, channels: 1, bitrate: 96 });
  await fs.writeFile(
    file,
    tagMp3(mp3, {
      title: 'Round Trip',
      artist: 'Test Artist',
      album: 'Test Album',
      track: '2/6',
      year: '2026',
      genre: 'Electronic',
    }),
  );

  const info = await probe(file);
  assert.ok(Math.abs(info.duration - 3) < 0.15, `expected ~3s, got ${info.duration}`);
  assert.equal(info.bitrate, 96000);
  assert.equal(info.sampleRate, SAMPLE_RATE);
  assert.equal(info.tags.title, 'Round Trip');
  assert.equal(info.tags.artist, 'Test Artist');
  assert.equal(info.tags.album, 'Test Album');
  assert.equal(info.tags.track, '2/6');
  assert.equal(info.tags.year, '2026');
  assert.equal(info.tags.genre, 'Electronic');
});

test('an ID3v2 tag reports its own size so audio parsing can skip it', () => {
  const tag = buildId3v2({ title: 'Hello', artist: 'World' }, { padding: 64 });
  assert.equal(tag.toString('latin1', 0, 3), 'ID3');
  assert.equal(tag[3], 0x03, 'version 2.3');
  assert.equal(id3v2Size(tag), tag.length);
  assert.deepEqual(parseId3v2(tag), { title: 'Hello', artist: 'World' });
});

test('id3v2Size returns 0 when there is no tag', () => {
  assert.equal(id3v2Size(Buffer.from('not a tag at all')), 0);
  assert.equal(id3v2Size(Buffer.alloc(4)), 0);
});

test('ID3v1 trailers are parsed and trimmed', () => {
  const block = Buffer.alloc(128);
  block.write('TAG', 0, 'latin1');
  block.write('Legacy Title', 3, 'latin1');
  block.write('Legacy Artist', 33, 'latin1');
  block.write('2001', 93, 'latin1');

  const tags = parseId3v1(block);
  assert.equal(tags.title, 'Legacy Title');
  assert.equal(tags.artist, 'Legacy Artist');
  assert.equal(tags.year, '2001');
});

test('parseFrameHeader decodes a known MPEG-1 Layer III header', () => {
  // FF FB 90 44 -> MPEG1 Layer III, 128 kbps, 44.1 kHz, joint stereo.
  const frame = parseFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x44]));
  assert.ok(frame, 'header should be recognised');
  assert.equal(frame.version, 1);
  assert.equal(frame.layer, 3);
  assert.equal(frame.bitrate, 128000);
  assert.equal(frame.sampleRate, 44100);
  assert.equal(frame.samplesPerFrame, 1152);
  assert.equal(frame.frameLength, 417);
});

test('parseFrameHeader rejects bad sync words and reserved values', () => {
  assert.equal(parseFrameHeader(Buffer.from([0x00, 0x00, 0x00, 0x00])), null);
  assert.equal(parseFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x44])), null, 'bad bitrate index');
  assert.equal(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x44])), null, 'reserved sample rate');
  assert.equal(parseFrameHeader(Buffer.from([0xff])), null, 'truncated buffer');
});

test('probing a missing or unsupported file reports nothing rather than throwing', async () => {
  assert.deepEqual(await probe(path.join(tmpDir, 'nope.mp3')), { duration: null, tags: {} });

  const textFile = path.join(tmpDir, 'notes.txt');
  await fs.writeFile(textFile, 'this is not audio');
  assert.deepEqual(await probe(textFile), { duration: null, tags: {} });
});

test('a truncated MP3 does not crash the probe', async () => {
  const file = path.join(tmpDir, 'garbage.mp3');
  await fs.writeFile(file, Buffer.alloc(2048, 0x11));
  const info = await probe(file);
  assert.equal(info.duration, null);
});
