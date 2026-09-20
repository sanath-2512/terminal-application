import test from 'node:test';
import assert from 'node:assert/strict';

import { Player, STATES } from '../src/player.js';

const track = (duration = 2) => ({
  path: '/music/demo.mp3',
  title: 'Demo',
  artist: 'Tester',
  duration,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every test runs the player in silent mode: playback is simulated with timers
 * instead of a child process, so the transport logic can be exercised with no
 * audio hardware and no external tools installed.
 */
function makePlayer(options = {}) {
  return new Player({ silent: true, volume: 70, ...options });
}

test('a new player is idle and holds no track', () => {
  const player = makePlayer();
  assert.equal(player.state, STATES.IDLE);
  assert.equal(player.track, null);
  assert.equal(player.elapsed, 0);
  assert.equal(player.progress, null);
  player.dispose();
});

test('play starts the clock and reports progress', async () => {
  const player = makePlayer();
  player.play(track(10));

  assert.equal(player.state, STATES.PLAYING);
  assert.equal(player.isPlaying, true);
  await wait(250);

  assert.ok(player.elapsed >= 0.2, `elapsed should advance, got ${player.elapsed}`);
  assert.ok(player.progress > 0 && player.progress < 1);
  player.dispose();
});

test('pause freezes elapsed time and resume continues from there', async () => {
  const player = makePlayer();
  player.play(track(10));
  await wait(200);

  player.pause();
  assert.equal(player.state, STATES.PAUSED);
  const frozen = player.elapsed;

  await wait(200);
  assert.equal(player.elapsed, frozen, 'a paused player must not advance');

  player.resume();
  assert.equal(player.state, STATES.PLAYING);
  await wait(150);
  assert.ok(player.elapsed > frozen, 'resuming continues from the pause point');
  player.dispose();
});

test('togglePause flips between playing and paused', async () => {
  const player = makePlayer();
  player.play(track(10));

  player.togglePause();
  assert.equal(player.state, STATES.PAUSED);
  player.togglePause();
  assert.equal(player.state, STATES.PLAYING);
  player.dispose();
});

test('stop rewinds to the beginning', async () => {
  const player = makePlayer();
  player.play(track(10));
  await wait(150);

  player.stop();
  assert.equal(player.state, STATES.STOPPED);
  assert.equal(player.elapsed, 0);
  player.dispose();
});

test('togglePause restarts a stopped track', () => {
  const player = makePlayer();
  player.play(track(10));
  player.stop();

  player.togglePause();
  assert.equal(player.state, STATES.PLAYING);
  player.dispose();
});

test('seek moves to an absolute position', async () => {
  const player = makePlayer();
  player.play(track(30));

  player.seek(12);
  assert.ok(Math.abs(player.elapsed - 12) < 0.1, `expected ~12s, got ${player.elapsed}`);

  player.seekBy(5);
  assert.ok(Math.abs(player.elapsed - 17) < 0.2, `expected ~17s, got ${player.elapsed}`);
  player.dispose();
});

test('seek clamps to the track and never goes negative', () => {
  const player = makePlayer();
  player.play(track(30));

  player.seek(-50);
  assert.equal(player.elapsed, 0);

  player.seek(9999);
  assert.ok(player.elapsed <= 30, 'cannot seek past the end');
  player.dispose();
});

test('seeking while paused keeps the player paused', () => {
  const player = makePlayer();
  player.play(track(30));
  player.pause();

  player.seek(10);
  assert.equal(player.state, STATES.PAUSED);
  assert.ok(Math.abs(player.elapsed - 10) < 0.1);
  player.dispose();
});

test('an end event fires when the track runs out', async () => {
  const player = makePlayer();
  const ended = new Promise((resolve) => player.once('end', resolve));

  player.play(track(0.3));
  const finished = await ended;

  assert.equal(finished.title, 'Demo');
  assert.equal(player.state, STATES.STOPPED);
  player.dispose();
});

test('volume is clamped to 0-100', () => {
  const player = makePlayer();
  assert.equal(player.setVolume(150), 100);
  assert.equal(player.setVolume(-20), 0);
  assert.equal(player.setVolume(55), 55);

  player.adjustVolume(10);
  assert.equal(player.volume, 65);
  player.dispose();
});

test('mute remembers the previous level', () => {
  const player = makePlayer({ volume: 80 });

  assert.equal(player.toggleMute(), true);
  assert.equal(player.volume, 0);
  assert.equal(player.isMuted, true);

  assert.equal(player.toggleMute(), false);
  assert.equal(player.volume, 80, 'unmuting restores the old level');
  player.dispose();
});

test('state changes are announced to listeners', async () => {
  const player = makePlayer();
  const states = [];
  player.on('stateChange', ({ state }) => states.push(state));

  player.play(track(10));
  player.pause();
  player.resume();
  player.stop();

  assert.deepEqual(states, [
    STATES.PLAYING,
    STATES.PAUSED,
    STATES.PLAYING,
    STATES.STOPPED,
  ]);
  player.dispose();
});

test('playing a second track replaces the first', async () => {
  const player = makePlayer();
  const changes = [];
  player.on('trackChange', (next) => changes.push(next.title));

  player.play({ ...track(10), title: 'First' });
  await wait(120);
  player.play({ ...track(10), title: 'Second' });

  assert.deepEqual(changes, ['First', 'Second']);
  assert.equal(player.track.title, 'Second');
  assert.ok(player.elapsed < 0.1, 'the clock restarts for the new track');
  player.dispose();
});

test('a track with unknown duration still plays, with no progress bar', async () => {
  const player = makePlayer();
  player.play({ path: '/x.mp3', title: 'Mystery', duration: null });

  await wait(120);
  assert.equal(player.state, STATES.PLAYING);
  assert.equal(player.progress, null);
  assert.ok(player.elapsed > 0);
  player.dispose();
});

test('capability flags follow the backend descriptor', () => {
  const seekable = new Player({
    backend: { id: 'mpv', command: 'mpv', supportsSeek: true, supportsVolume: true, buildArgs: () => [] },
  });
  assert.equal(seekable.canSeek, true);
  assert.equal(seekable.canSetVolume, true);

  const basic = new Player({
    backend: { id: 'aplay', command: 'aplay', supportsSeek: false, supportsVolume: false, buildArgs: () => [] },
  });
  assert.equal(basic.canSeek, false);
  assert.equal(basic.canSetVolume, false);

  seekable.dispose();
  basic.dispose();
});

test('seeking on a backend that cannot seek emits a notice instead of moving', () => {
  const player = new Player({
    backend: {
      id: 'aplay',
      label: 'ALSA (aplay)',
      command: 'aplay',
      supportsSeek: false,
      supportsVolume: false,
      buildArgs: () => [],
    },
  });

  const notices = [];
  player.on('notice', (notice) => notices.push(notice));
  player.state = STATES.PLAYING;
  player.track = track(30);

  assert.equal(player.seek(10), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /cannot seek/i);
  player.dispose();
});
