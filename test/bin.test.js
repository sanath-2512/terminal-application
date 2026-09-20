import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PROJECT_ROOT, 'bin', 'music-player.js');

/** Run the executable and return its result. */
function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    ...options,
  });
}

test('the executable prints its version and exits 0', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(result.stderr, '');
});

test('the executable prints help without touching stderr', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /USAGE/);
  assert.equal(result.stderr, '');
});

test('an unknown flag fails cleanly, with no stack trace', () => {
  const result = run(['--nope']);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /at .*\.js:\d+/, 'no stack trace');
});

test('piping into a reader that exits early does not crash', (t) => {
  if (process.platform === 'win32') {
    t.skip('shell pipelines differ on Windows');
    return;
  }

  // `head -2` closes the pipe while the player is still writing, which used to
  // surface as an unhandled EPIPE.
  const result = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${BIN}" --list | head -2`], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, 'the pipeline should succeed');
  assert.doesNotMatch(result.stderr, /EPIPE/, 'EPIPE must be handled, not reported');
  assert.doesNotMatch(result.stderr, /at .*\.js:\d+/, 'no stack trace');
});

test('output is plain text when it is not going to a terminal', () => {
  const result = run(['--list']);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\u001b\[/, 'colour is disabled when piped');
  assert.match(result.stdout, /Night Drive/);
});

test('the player refuses a folder that does not exist, without a stack trace', () => {
  const result = run(['--dir', path.join(PROJECT_ROOT, 'no-such-folder')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Music folder not found/);
  assert.doesNotMatch(result.stdout + result.stderr, /at .*\.js:\d+/);
});

test('--silent plays a queue through to the end and exits 0', () => {
  // Silent mode runs in real time, so this points at the short fixture tones
  // rather than the ~40s demo album. With no TTY the player logs each track and
  // exits once the queue is done.
  const result = run(['--dir', path.join(PROJECT_ROOT, 'test', 'fixtures'), '--silent'], {
    timeout: 20000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /End of playlist/);
});
