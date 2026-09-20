import test from 'node:test';
import assert from 'node:assert/strict';

import { Renderer, clampScroll } from '../src/ui.js';
import { Player } from '../src/player.js';
import { Playlist } from '../src/playlist.js';
import { stripAnsi } from '../src/format.js';

/** A stdout stand-in with a fixed size that records what was written. */
function fakeStream({ columns = 80, rows = 24 } = {}) {
  return {
    columns,
    rows,
    isTTY: false,
    written: [],
    write(chunk) {
      this.written.push(chunk);
      return true;
    },
    on() {},
    off() {},
  };
}

function scene({ columns = 80, rows = 24, count = 5 } = {}) {
  const tracks = Array.from({ length: count }, (_, i) => ({
    path: `/music/${i}.mp3`,
    title: `Song ${i + 1}`,
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 100 + i,
  }));
  const playlist = new Playlist(tracks);
  const player = new Player({ silent: true, volume: 60 });
  const renderer = new Renderer({ stream: fakeStream({ columns, rows }) });
  return { tracks, playlist, player, renderer };
}

const model = (overrides = {}) => ({
  cursor: 0,
  scrollTop: 0,
  view: 'player',
  backend: null,
  silent: true,
  status: null,
  ...overrides,
});

test('no rendered line is wider than the terminal', () => {
  for (const columns of [40, 60, 80, 100, 132]) {
    const { playlist, player, renderer } = scene({ columns, count: 12 });
    player.play(playlist.current());

    const frame = renderer.compose(model({ player, playlist }));
    for (const line of frame.split('\n')) {
      assert.ok(
        stripAnsi(line).length <= columns,
        `line overflows at ${columns} columns: ${JSON.stringify(stripAnsi(line))}`,
      );
    }
    player.dispose();
  }
});

test('a frame never uses more rows than the terminal has', () => {
  for (const rows of [12, 16, 24, 40]) {
    const { playlist, player, renderer } = scene({ rows, count: 40 });
    player.play(playlist.current());

    const frame = renderer.compose(model({ player, playlist }));
    assert.ok(frame.split('\n').length <= rows, `too many rows at height ${rows}`);
    player.dispose();
  }
});

test('the now-playing panel shows the current track', () => {
  const { playlist, player, renderer } = scene();
  playlist.jumpTo(2);
  player.play(playlist.current());

  const frame = stripAnsi(renderer.compose(model({ player, playlist, cursor: 2 })));
  assert.match(frame, /Song 3/);
  assert.match(frame, /Test Artist/);
  assert.match(frame, /3\/5/, 'shows position in the queue');
  assert.match(frame, /PLAYING/);
  player.dispose();
});

test('the transport state is reflected in the header', () => {
  const { playlist, player, renderer } = scene();
  player.play(playlist.current());

  player.pause();
  assert.match(stripAnsi(renderer.compose(model({ player, playlist }))), /PAUSED/);

  player.stop();
  assert.match(stripAnsi(renderer.compose(model({ player, playlist }))), /STOPPED/);
  player.dispose();
});

test('shuffle and repeat state are visible', () => {
  const { playlist, player, renderer } = scene();
  playlist.setShuffle(true);
  playlist.setRepeat('one');

  const frame = stripAnsi(renderer.compose(model({ player, playlist })));
  assert.match(frame, /shuffle/);
  assert.match(frame, /repeat one/);
  player.dispose();
});

test('an empty playlist explains what to do', () => {
  const player = new Player({ silent: true });
  const renderer = new Renderer({ stream: fakeStream() });
  const frame = stripAnsi(renderer.compose(model({ player, playlist: new Playlist([]) })));

  assert.match(frame, /No songs found/);
  player.dispose();
});

test('a long list scrolls to keep the cursor visible', () => {
  const { playlist, player, renderer } = scene({ rows: 24, count: 60 });
  const state = model({ player, playlist, cursor: 45 });

  const frame = stripAnsi(renderer.compose(state));
  assert.match(frame, /46\. Song 46/, 'the selected row is on screen');
  assert.ok(state.scrollTop > 0, 'the viewport scrolled down');
  assert.match(frame, /more/, 'there is an indicator for the rows off screen');
  player.dispose();
});

test('the selected row stays visible wherever it is in a long list', () => {
  // Regression: the "more above/below" markers used to be drawn over the first
  // and last visible rows, which hid the selection whenever it sat on one.
  const { playlist, player, renderer } = scene({ rows: 24, count: 60 });

  for (const cursor of [0, 1, 9, 10, 30, 57, 58, 59]) {
    const state = model({ player, playlist, cursor, scrollTop: 0 });
    const frame = stripAnsi(renderer.compose(state));
    assert.match(
      frame,
      new RegExp(`\\b${cursor + 1}\\. Song ${cursor + 1}\\b`),
      `song ${cursor + 1} should be visible when it is selected`,
    );
  }
  player.dispose();
});

test('status messages are shown', () => {
  const { playlist, player, renderer } = scene();
  const frame = stripAnsi(
    renderer.compose(model({ player, playlist, status: { text: 'Volume 75%', level: 'info' } })),
  );
  assert.match(frame, /Volume 75%/);
  player.dispose();
});

test('the help view lists the shortcuts', () => {
  const { playlist, player, renderer } = scene({ rows: 40 });
  const frame = stripAnsi(renderer.compose(model({ player, playlist, view: 'help' })));

  assert.match(frame, /KEYBOARD SHORTCUTS/);
  assert.match(frame, /Play \/ pause/);
  assert.match(frame, /Toggle shuffle/);
  assert.match(frame, /Press any key/);
  player.dispose();
});

test('identical frames are only written once', () => {
  const { playlist, player, renderer } = scene();
  const stream = renderer.stream;
  const state = model({ player, playlist });

  renderer.draw(state);
  const afterFirst = stream.written.length;
  renderer.draw(state);
  assert.equal(stream.written.length, afterFirst, 'an unchanged frame is skipped');

  renderer.invalidate();
  renderer.draw(state);
  assert.ok(stream.written.length > afterFirst, 'invalidate forces a redraw');
  player.dispose();
});

test('clampScroll keeps the cursor inside the viewport', () => {
  assert.equal(clampScroll(0, 0, 5, 10), 0, 'no scrolling when everything fits');
  assert.equal(clampScroll(0, 3, 50, 10), 0, 'scrolls up to reveal the cursor');
  assert.equal(clampScroll(25, 0, 50, 10), 16, 'scrolls down to reveal the cursor');
  assert.equal(clampScroll(49, 0, 50, 10), 40, 'stops at the bottom');
  assert.equal(clampScroll(5, 5, 50, 10), 5, 'leaves a valid window alone');
});
