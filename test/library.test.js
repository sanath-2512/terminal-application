import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AUDIO_EXTENSIONS, isAudioFile, loadTracks, scanLibrary, titleFromFilename } from '../src/library.js';
import { encodeWav } from '../scripts/lib/encode.js';
import { SAMPLE_RATE, toInt16 } from '../scripts/lib/synth.js';

let tmpDir;

/** Write a real (if very short) WAV file so the scanner has something to probe. */
async function writeWav(filePath, seconds = 1) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 330 * i) / SAMPLE_RATE) * 0.3;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encodeWav(toInt16(samples), { sampleRate: SAMPLE_RATE, channels: 1 }));
}

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-lib-'));
  await writeWav(path.join(tmpDir, '02 - Second Song.wav'));
  await writeWav(path.join(tmpDir, '10 - Tenth Song.wav'));
  await writeWav(path.join(tmpDir, '01 - Artist Name - First Song.wav'));
  await writeWav(path.join(tmpDir, 'nested', 'Deep Cut.wav'));
  await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'not audio');
  await fs.writeFile(path.join(tmpDir, '.hidden.wav'), 'hidden');
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('isAudioFile accepts known extensions and skips junk', () => {
  assert.equal(isAudioFile('song.mp3'), true);
  assert.equal(isAudioFile('song.FLAC'), true, 'case insensitive');
  assert.equal(isAudioFile('notes.txt'), false);
  assert.equal(isAudioFile('.hidden.mp3'), false, 'dotfiles are skipped');
  assert.equal(isAudioFile('._resource.mp3'), false, 'macOS resource forks are skipped');
  assert.ok(AUDIO_EXTENSIONS.includes('.mp3'));
});

test('titleFromFilename splits track numbers and artist names', () => {
  assert.deepEqual(titleFromFilename('03 - Miles Away - Night Drive.mp3'), {
    track: '03',
    artist: 'Miles Away',
    title: 'Night Drive',
  });
  assert.deepEqual(titleFromFilename('Artist - Tune.mp3'), {
    artist: 'Artist',
    title: 'Tune',
  });
  assert.deepEqual(titleFromFilename('my_song.wav'), { title: 'my song' });
  assert.deepEqual(titleFromFilename('07. Seven.mp3'), { track: '07', title: 'Seven' });
});

test('scanLibrary finds audio files, sorts them naturally and reads durations', async () => {
  const tracks = await scanLibrary(tmpDir);
  const names = tracks.map((track) => track.fileName);

  assert.equal(tracks.length, 4, 'three top-level files plus one nested');
  assert.ok(!names.some((name) => name.endsWith('.txt')), 'non-audio is ignored');
  assert.ok(!names.some((name) => name.startsWith('.')), 'hidden files are ignored');

  // "10" must sort after "02", which a plain string sort would get wrong.
  assert.deepEqual(names.slice(0, 3), [
    '01 - Artist Name - First Song.wav',
    '02 - Second Song.wav',
    '10 - Tenth Song.wav',
  ]);

  for (const track of tracks) {
    assert.ok(Math.abs(track.duration - 1) < 0.05, `${track.fileName} should be ~1s`);
    assert.ok(track.size > 0);
  }
});

test('filename metadata is used when a file carries no tags', async () => {
  const tracks = await scanLibrary(tmpDir);
  const first = tracks.find((track) => track.fileName.startsWith('01'));

  assert.equal(first.title, 'First Song');
  assert.equal(first.artist, 'Artist Name');
  assert.equal(first.trackNumber, '01');

  const plain = tracks.find((track) => track.fileName === '02 - Second Song.wav');
  assert.equal(plain.artist, 'Unknown artist', 'falls back rather than showing nothing');
});

test('scanning can be limited to the top level', async () => {
  const shallow = await scanLibrary(tmpDir, { recursive: false });
  assert.equal(shallow.length, 3, 'the nested folder is skipped');
});

test('scanning a single file returns just that track', async () => {
  const file = path.join(tmpDir, '02 - Second Song.wav');
  const tracks = await scanLibrary(file);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, 'Second Song');
});

test('scanning a missing folder reports ENOENT with a readable message', async () => {
  await assert.rejects(() => scanLibrary(path.join(tmpDir, 'does-not-exist')), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /Music folder not found/);
    return true;
  });
});

test('an empty folder yields an empty list rather than an error', async () => {
  const empty = path.join(tmpDir, 'empty');
  await fs.mkdir(empty, { recursive: true });
  assert.deepEqual(await scanLibrary(empty), []);
});

test('loadTracks merges several inputs and removes duplicates', async () => {
  const file = path.join(tmpDir, '02 - Second Song.wav');
  const tracks = await loadTracks([file, file, path.join(tmpDir, 'nested')]);

  assert.equal(tracks.length, 2, 'the repeated file appears once');
  assert.deepEqual(
    tracks.map((track) => track.title).sort(),
    ['Deep Cut', 'Second Song'],
  );
});
