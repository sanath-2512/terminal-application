import test from 'node:test';
import assert from 'node:assert/strict';

import { Playlist, REPEAT_MODES, shuffleArray } from '../src/playlist.js';

const makeTracks = (names) =>
  names.map((name) => ({ path: `/music/${name}.mp3`, title: name, duration: 60 }));

/** Deterministic RNG so shuffle assertions are reproducible. */
function seededRandom(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('an empty playlist is safe to navigate', () => {
  const playlist = new Playlist([]);
  assert.equal(playlist.length, 0);
  assert.equal(playlist.isEmpty, true);
  assert.equal(playlist.current(), null);
  assert.equal(playlist.next(), null);
  assert.equal(playlist.previous(), null);
  assert.equal(playlist.jumpTo(0), null);
});

test('next walks forward and stops at the end when repeat is off', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']));
  assert.equal(playlist.current().title, 'a');
  assert.equal(playlist.next().title, 'b');
  assert.equal(playlist.next().title, 'c');
  assert.equal(playlist.next({ auto: true }), null, 'auto-advance stops at the end');
});

test('a manual next at the end wraps even with repeat off', () => {
  const playlist = new Playlist(makeTracks(['a', 'b']));
  playlist.next();
  assert.equal(playlist.next().title, 'a', 'pressing next explicitly wraps around');
});

test('repeat all wraps on auto-advance', () => {
  const playlist = new Playlist(makeTracks(['a', 'b']), { repeat: 'all' });
  playlist.next({ auto: true });
  assert.equal(playlist.next({ auto: true }).title, 'a');
});

test('repeat one replays on auto-advance but not on a keypress', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']), { repeat: 'one' });
  assert.equal(playlist.next({ auto: true }).title, 'a', 'track ended: play it again');
  assert.equal(playlist.next().title, 'b', 'user pressed next: actually move on');
});

test('previous steps back and wraps to the end', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']));
  playlist.next();
  assert.equal(playlist.previous().title, 'a');
  assert.equal(playlist.previous().title, 'c', 'wraps around to the last track');
});

test('jumpTo selects by track index and rejects out of range values', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']));
  assert.equal(playlist.jumpTo(2).title, 'c');
  assert.equal(playlist.displayPosition, 3);
  assert.equal(playlist.jumpTo(9), null);
  assert.equal(playlist.jumpTo(-1), null);
  assert.equal(playlist.current().title, 'c', 'a rejected jump changes nothing');
});

test('cycleRepeat walks every mode and returns to the start', () => {
  const playlist = new Playlist(makeTracks(['a']));
  assert.equal(playlist.repeat, 'off');
  const seen = REPEAT_MODES.map(() => playlist.cycleRepeat());
  assert.deepEqual(seen, ['all', 'one', 'off']);
});

test('shuffle keeps the current track playing and covers every track exactly once', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c', 'd', 'e']), {
    random: seededRandom(42),
  });
  playlist.jumpTo(2);
  playlist.setShuffle(true);

  assert.equal(playlist.current().title, 'c', 'the playing track is not interrupted');
  assert.deepEqual([...playlist.order].sort((x, y) => x - y), [0, 1, 2, 3, 4]);
});

test('turning shuffle off restores playback order at the current track', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c', 'd']), { random: seededRandom(3) });
  playlist.setShuffle(true);
  playlist.next();
  const playing = playlist.current().title;

  playlist.setShuffle(false);
  assert.deepEqual(playlist.order, [0, 1, 2, 3]);
  assert.equal(playlist.current().title, playing, 'still on the same song');
});

test('shuffleArray is a permutation and leaves the input alone', () => {
  const input = [1, 2, 3, 4, 5, 6];
  const output = shuffleArray(input, seededRandom(9));
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...output].sort((a, b) => a - b), input);
});

test('upcoming lists the next tracks and only wraps with repeat all', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']));
  assert.deepEqual(
    playlist.upcoming(2).map((track) => track.title),
    ['b', 'c'],
  );

  playlist.jumpTo(2);
  assert.deepEqual(playlist.upcoming(2), [], 'nothing after the last track');

  playlist.setRepeat('all');
  assert.deepEqual(
    playlist.upcoming(2).map((track) => track.title),
    ['a', 'b'],
  );
});

test('totalDuration tolerates tracks with unknown length', () => {
  const playlist = new Playlist([
    { path: '/a', title: 'a', duration: 30 },
    { path: '/b', title: 'b', duration: null },
    { path: '/c', title: 'c', duration: 15 },
  ]);
  assert.equal(playlist.totalDuration(), 45);
});

test('replace swaps the queue but stays on the same song when it survives', () => {
  const playlist = new Playlist(makeTracks(['a', 'b', 'c']));
  playlist.jumpTo(1);
  playlist.replace(makeTracks(['x', 'b', 'y']));

  assert.equal(playlist.length, 3);
  assert.equal(playlist.current().title, 'b');
});

test('entries reports the playback order with the current track flagged', () => {
  const playlist = new Playlist(makeTracks(['a', 'b']));
  playlist.next();
  const entries = playlist.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.isCurrent),
    [false, true],
  );
});
