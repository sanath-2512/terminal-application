import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKENDS,
  backendSupportsFormat,
  candidateBackends,
  findExecutable,
  installHints,
  selectBackend,
} from '../src/backends.js';

const backend = (id) => BACKENDS.find((entry) => entry.id === id);

test('every backend descriptor is complete', () => {
  for (const entry of BACKENDS) {
    assert.ok(entry.id, 'needs an id');
    assert.ok(entry.command, `${entry.id} needs a command`);
    assert.ok(entry.label, `${entry.id} needs a label`);
    assert.equal(typeof entry.buildArgs, 'function', `${entry.id} needs buildArgs`);
    assert.equal(typeof entry.supportsSeek, 'boolean');
    assert.equal(typeof entry.supportsVolume, 'boolean');
  }
});

test('candidateBackends filters by platform', () => {
  const mac = candidateBackends('darwin').map((entry) => entry.id);
  assert.ok(mac.includes('afplay'), 'afplay is a macOS backend');
  assert.ok(!mac.includes('aplay'), 'ALSA is Linux only');

  const windows = candidateBackends('win32').map((entry) => entry.id);
  assert.ok(windows.includes('powershell'));
  assert.ok(!windows.includes('afplay'));

  const linux = candidateBackends('linux').map((entry) => entry.id);
  assert.ok(linux.includes('aplay') && linux.includes('mpg123'));
  assert.ok(!linux.includes('powershell'));
});

test('format support is respected', () => {
  assert.equal(backendSupportsFormat(backend('mpv'), '.flac'), true, 'mpv plays anything');
  assert.equal(backendSupportsFormat(backend('aplay'), '.wav'), true);
  assert.equal(backendSupportsFormat(backend('aplay'), '.mp3'), false, 'ALSA cannot decode mp3');
  assert.equal(backendSupportsFormat(backend('mpg123'), '.mp3'), true);
  assert.equal(backendSupportsFormat(backend('mpg123'), '.flac'), false);
  assert.equal(backendSupportsFormat(backend('mpv'), '.MP3'), true, 'case insensitive');
});

test('selectBackend prefers a backend that covers every format in the queue', () => {
  const available = [backend('aplay'), backend('mpv')];
  assert.equal(selectBackend(available, { extensions: ['.mp3', '.wav'] }).id, 'mpv');
  assert.equal(selectBackend(available, { extensions: ['.wav'] }).id, 'aplay', 'first match wins');
});

test('selectBackend honours an explicit choice when it is installed', () => {
  const available = [backend('mpv'), backend('ffplay'), backend('sox')];
  assert.equal(selectBackend(available, { preferred: 'ffplay' }).id, 'ffplay');
  assert.equal(selectBackend(available, { preferred: 'play' }).id, 'sox', 'matches by command too');
});

test('selectBackend falls back when the requested backend is missing', () => {
  const available = [backend('mpv'), backend('ffplay')];
  assert.equal(
    selectBackend(available, { preferred: 'sox' }).id,
    'mpv',
    'falls back rather than failing',
  );
});

test('selectBackend returns null when nothing is installed', () => {
  assert.equal(selectBackend([], { extensions: ['.mp3'] }), null);
});

test('findExecutable finds a real binary and misses a fake one', async () => {
  assert.ok(await findExecutable('node'), 'node must be on PATH to run these tests');
  assert.equal(await findExecutable('definitely-not-a-real-binary-xyz'), null);
});

test('findExecutable accepts an absolute path', async () => {
  assert.equal(await findExecutable(process.execPath), process.execPath);
  assert.equal(await findExecutable('/no/such/binary'), null);
});

test('install hints are offered for the current platform', () => {
  const hints = installHints('linux');
  assert.ok(hints.length > 0);
  for (const hint of hints) {
    assert.ok(hint.label && hint.hint);
  }
});

test('ffplay arguments include seek and volume', () => {
  const args = backend('ffplay').buildArgs({ file: '/m/a.mp3', startAt: 42.5, volume: 60 });
  assert.ok(args.includes('-nodisp') && args.includes('-autoexit'));
  assert.deepEqual(args.slice(-3), ['-ss', '42.50', '/m/a.mp3']);
  assert.equal(args[args.indexOf('-volume') + 1], '60');
});

test('ffplay omits the seek flag when starting from zero', () => {
  const args = backend('ffplay').buildArgs({ file: '/m/a.mp3', startAt: 0, volume: 100 });
  assert.ok(!args.includes('-ss'));
});

test('mpg123 converts a seek offset into frames', () => {
  const args = backend('mpg123').buildArgs({
    file: '/m/a.mp3',
    startAt: 30,
    volume: 80,
    track: { sampleRate: 44100 },
  });
  // 30s at 44.1 kHz with 1152 samples per frame -> 1148 frames.
  assert.equal(args[args.indexOf('-k') + 1], '1148');
  assert.equal(args[args.indexOf('--scale') + 1], String(Math.round(0.8 * 32768)));
});

test('the PowerShell backend quotes paths containing apostrophes', () => {
  const args = backend('powershell').buildArgs({
    file: "C:\\Music\\Rock 'n' Roll.mp3",
    startAt: 0,
    volume: 50,
  });
  const script = args[args.length - 1];
  assert.ok(script.includes("'C:\\Music\\Rock ''n'' Roll.mp3'"), 'single quotes are doubled');
  assert.equal(backend('powershell').supportsSignalPause, false, 'Windows has no SIGSTOP');
});

test('every backend builds arguments that end with the file path', () => {
  for (const entry of BACKENDS) {
    const args = entry.buildArgs({
      file: '/music/song.mp3',
      startAt: 0,
      volume: 75,
      track: { sampleRate: 44100 },
    });
    assert.ok(Array.isArray(args), `${entry.id} must return an array`);
    assert.ok(
      args.some((arg) => String(arg).includes('/music/song.mp3')),
      `${entry.id} must pass the file to the player`,
    );
  }
});
