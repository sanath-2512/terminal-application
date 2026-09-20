import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, resolveMusicDir } from '../src/cli.js';
import { stripAnsi } from '../src/format.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS_DIR = path.join(PROJECT_ROOT, 'songs');

/** Collects everything the CLI writes so it can be asserted on. */
function capture() {
  const chunks = [];
  return {
    stream: { write: (chunk) => chunks.push(chunk) },
    get text() {
      return stripAnsi(chunks.join(''));
    },
  };
}

test('--help prints usage and exits successfully', async () => {
  const out = capture();
  assert.equal(await main(['--help'], { stdout: out.stream }), 0);

  assert.match(out.text, /USAGE/);
  assert.match(out.text, /--shuffle/);
  assert.match(out.text, /CONTROLS/);
  assert.match(out.text, /space/);
});

test('--version prints the package version', async () => {
  const out = capture();
  assert.equal(await main(['--version'], { stdout: out.stream }), 0);

  const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(out.text.trim(), packageJson.version);
});

test('an unknown option is reported rather than crashing', async () => {
  const out = capture();
  assert.equal(await main(['--not-a-real-option'], { stdout: out.stream }), 2);
  assert.match(out.text, /--help/);
});

test('--list shows the bundled demo album', async () => {
  const out = capture();
  assert.equal(await main(['--list', '--dir', SONGS_DIR], { stdout: out.stream }), 0);

  assert.match(out.text, /6 songs/);
  assert.match(out.text, /Night Drive/);
  assert.match(out.text, /Terminal Waves/, 'artist comes from the ID3 tags');
  assert.match(out.text, /First Light/);
});

test('--doctor reports on audio backends', async () => {
  const out = capture();
  const code = await main(['--doctor'], { stdout: out.stream });

  assert.match(out.text, /AUDIO BACKENDS/);
  assert.match(out.text, new RegExp(process.platform));
  // 0 when a backend is installed, 1 with install hints when none is.
  assert.ok(code === 0 || code === 1);
  if (code === 1) assert.match(out.text, /Install any one of these/);
});

test('a missing music folder explains how to fix it', async () => {
  const out = capture();
  const missing = path.join(os.tmpdir(), 'music-player-not-here-xyz');
  assert.equal(await main(['--dir', missing, '--list'], { stdout: out.stream }), 1);

  assert.match(out.text, /Music folder not found/);
  assert.match(out.text, /music-player ~\/Music/);
});

test('a folder with no audio in it says so', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-empty-'));
  try {
    const out = capture();
    assert.equal(await main(['--dir', empty], { stdout: out.stream }), 1);
    assert.match(out.text, /No playable audio files found/);
    assert.match(out.text, /mp3, wav, flac/);
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('an invalid repeat mode warns and falls back to off', async () => {
  const out = capture();
  await main(['--list', '--dir', SONGS_DIR, '--repeat', 'sideways'], { stdout: out.stream });
  assert.match(out.text, /Unknown repeat mode/);
});

test('resolveMusicDir prefers explicit paths over everything else', async () => {
  const positional = await resolveMusicDir({ positionals: ['some/where'], cwd: '/base' });
  assert.deepEqual(positional, [path.resolve('/base/some/where')]);

  const flag = await resolveMusicDir({ dir: 'other', cwd: '/base' });
  assert.deepEqual(flag, [path.resolve('/base/other')]);
});

test('resolveMusicDir falls back to ./songs', async () => {
  const resolved = await resolveMusicDir({ cwd: PROJECT_ROOT });
  assert.deepEqual(resolved, [SONGS_DIR]);
});

test('the bundled songs all parse as real, tagged audio', async () => {
  const { scanLibrary } = await import('../src/library.js');
  const tracks = await scanLibrary(SONGS_DIR);

  assert.equal(tracks.length, 6, 'the demo album has six tracks');
  for (const track of tracks) {
    assert.equal(track.extension, '.mp3');
    assert.ok(track.duration > 20, `${track.title} should have a readable duration`);
    assert.equal(track.artist, 'Terminal Waves');
    assert.equal(track.album, 'Public Domain Demos');
    assert.ok(track.bitrate > 0 && track.sampleRate === 44100);
  }
});
