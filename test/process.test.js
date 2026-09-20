import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { Player, STATES } from '../src/player.js';

/**
 * These tests drive the playback engine against a *real* child process.
 *
 * Instead of an audio tool, the backend spawns `node -e "setTimeout(...)"`,
 * which behaves the same way from the engine's point of view: it runs for a
 * while, it can be signalled, and it exits with a status code. That exercises
 * spawning, SIGSTOP/SIGCONT pausing, SIGTERM stopping and exit handling
 * without needing a sound card.
 */

const POSIX = process.platform !== 'win32';

/** A backend that runs for `ms` milliseconds and then exits with `code`. */
function fakeBackend({ ms = 5000, code = 0 } = {}) {
  return {
    id: 'fake',
    label: 'Fake backend',
    command: process.execPath,
    executable: process.execPath,
    supportsSeek: true,
    supportsVolume: true,
    supportsSignalPause: POSIX,
    buildArgs: ({ file }) => [
      '-e',
      `process.title=${JSON.stringify(`fake-player ${file}`)};` +
        `setTimeout(() => process.exit(${code}), ${ms});`,
    ],
  };
}

const track = (duration = 30) => ({ path: '/music/demo.mp3', title: 'Demo', duration });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only Linux exposes /proc, so the "is it SIGSTOP-ed" assertions are made
// there and skipped elsewhere. Liveness uses signal 0, which is portable.
const CAN_READ_PROC = process.platform === 'linux';

/** Read a process state letter from /proc: R/S running, T stopped. */
async function processState(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // The state letter follows the parenthesised command name.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return null;
  }
}

/** True while the process exists, using a signal-0 probe. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but is not ours to signal
  }
}

test('play spawns a real child process', async () => {
  const player = new Player({ backend: fakeBackend() });
  player.play(track());

  assert.equal(player.state, STATES.PLAYING);
  assert.ok(player.child, 'a child process was created');
  assert.ok(player.child.pid > 0);

  player.dispose();
  await wait(50);
});

test('the child is passed the file it should play', () => {
  const player = new Player({ backend: fakeBackend() });
  player.play(track());

  const args = player.child.spawnargs;
  assert.ok(args.some((arg) => arg.includes('/music/demo.mp3')));
  player.dispose();
});

test('pause stops the child with SIGSTOP and resume continues it', async (t) => {
  if (!POSIX) {
    t.skip('signal-based pausing is POSIX only');
    return;
  }

  const player = new Player({ backend: fakeBackend() });
  player.play(track());
  await wait(150);

  const { pid } = player.child;
  if (CAN_READ_PROC) assert.notEqual(await processState(pid), 'T', 'the child runs before pausing');

  player.pause();
  await wait(150);
  assert.equal(player.state, STATES.PAUSED);
  assert.ok(processAlive(pid), 'the child is stopped, not killed');
  assert.equal(player.child.pid, pid, 'and it is the same process');
  if (CAN_READ_PROC) assert.equal(await processState(pid), 'T', 'it really is SIGSTOP-ed');

  player.resume();
  await wait(150);
  assert.ok(processAlive(pid), 'the child is still there after resuming');
  if (CAN_READ_PROC) assert.notEqual(await processState(pid), 'T', 'and running again');
  assert.equal(player.child.pid, pid, 'resuming did not respawn anything');

  player.dispose();
  await wait(50);
});

test('stop terminates the child without reporting the track as finished', async () => {
  const player = new Player({ backend: fakeBackend() });
  let ended = false;
  player.on('end', () => {
    ended = true;
  });

  player.play(track());
  await wait(150);
  const { pid } = player.child;

  player.stop();
  await wait(250);

  assert.equal(player.state, STATES.STOPPED);
  assert.equal(player.child, null);
  assert.equal(ended, false, 'a deliberate stop is not an end-of-track');
  assert.equal(processAlive(pid), false, 'the process is gone');
  player.dispose();
});

test('a stopped (SIGSTOP-ed) child can still be killed', async (t) => {
  if (!POSIX || !CAN_READ_PROC) {
    t.skip('needs POSIX signals and /proc to confirm the stopped state');
    return;
  }

  const player = new Player({ backend: fakeBackend() });
  player.play(track());
  await wait(120);

  const { pid } = player.child;
  player.pause();
  await wait(120);
  assert.equal(await processState(pid), 'T', 'the child is SIGSTOP-ed');

  // SIGTERM alone cannot be acted on by a stopped process, so the engine has
  // to send SIGCONT first.
  player.stop();
  await wait(300);
  assert.equal(processAlive(pid), false, 'the paused process was cleaned up');
  player.dispose();
});

test('a child that exits on its own reports the track as finished', async () => {
  const player = new Player({ backend: fakeBackend({ ms: 150 }) });
  const ended = new Promise((resolve) => player.once('end', resolve));

  player.play(track());
  const finished = await ended;

  assert.equal(finished.title, 'Demo');
  assert.equal(player.state, STATES.STOPPED);
  player.dispose();
});

test('a child that fails reports an error instead of finishing', async () => {
  const player = new Player({ backend: fakeBackend({ ms: 100, code: 3 }) });
  const failed = new Promise((resolve) => player.once('error', resolve));

  let ended = false;
  player.on('end', () => {
    ended = true;
  });

  player.play(track());
  const error = await failed;

  assert.match(error.message, /exited with code 3/);
  assert.equal(ended, false, 'a crash is not an end-of-track');
  assert.equal(player.state, STATES.STOPPED);
  player.dispose();
});

test('a missing backend binary produces a helpful error', async () => {
  const player = new Player({
    backend: {
      id: 'ghost',
      label: 'Ghost',
      command: 'definitely-not-a-real-binary-xyz',
      executable: 'definitely-not-a-real-binary-xyz',
      supportsSeek: true,
      supportsVolume: true,
      buildArgs: ({ file }) => [file],
    },
  });

  const failed = new Promise((resolve) => player.once('error', resolve));
  player.play(track());
  const error = await failed;

  assert.match(error.message, /not installed or not on PATH/);
  player.dispose();
});

test('seeking replaces the child process rather than confusing the old one', async () => {
  const player = new Player({ backend: fakeBackend() });
  let ended = false;
  player.on('end', () => {
    ended = true;
  });

  player.play(track());
  await wait(150);
  const firstPid = player.child.pid;

  player.seek(12);
  await wait(250);

  assert.notEqual(player.child.pid, firstPid, 'a new process was started');
  assert.equal(processAlive(firstPid), false, 'the old one was cleaned up');
  assert.equal(ended, false, 'killing the old process did not look like a finished track');
  assert.ok(Math.abs(player.elapsed - 12) < 0.5);
  player.dispose();
});

test('switching tracks does not leave the previous process running', async () => {
  const player = new Player({ backend: fakeBackend() });
  player.play({ ...track(), title: 'First' });
  await wait(120);
  const firstPid = player.child.pid;

  player.play({ ...track(), title: 'Second' });
  await wait(250);

  assert.equal(processAlive(firstPid), false, 'the first process was terminated');
  assert.equal(player.track.title, 'Second');
  player.dispose();
  await wait(50);
});

test('dispose leaves no child process behind', async () => {
  const player = new Player({ backend: fakeBackend() });
  player.play(track());
  await wait(120);
  const { pid } = player.child;

  player.dispose();
  await wait(250);
  assert.equal(processAlive(pid), false);
});
