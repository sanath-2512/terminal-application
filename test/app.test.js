import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import { STATES } from '../src/player.js';

/** stdout stand-in that is deliberately not a TTY, so no drawing happens. */
function quietStdout() {
  return { columns: 80, rows: 24, isTTY: false, written: [], write(chunk) { this.written.push(chunk); }, on() {}, off() {} };
}

function makeApp(overrides = {}) {
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    path: `/music/${i}.mp3`,
    title: `Song ${i + 1}`,
    artist: 'Tester',
    duration: 60,
  }));
  const app = new App({
    tracks,
    silent: true,
    volume: 50,
    stdout: quietStdout(),
    ...overrides,
  });
  // run() is never called in these tests, so mark the app live by hand and give
  // quit() something to resolve.
  app.running = true;
  app.finish = () => {};
  return app;
}

test('the app starts on the first track', () => {
  const app = makeApp();
  assert.equal(app.playlist.current().title, 'Song 1');
  assert.equal(app.cursor, 0);
  app.player.dispose();
});

test('startIndex selects a different opening track', () => {
  const app = makeApp({ startIndex: 3 });
  assert.equal(app.playlist.current().title, 'Song 4');
  assert.equal(app.cursor, 3);
  app.player.dispose();
});

test('next and previous move through the queue', () => {
  const app = makeApp();
  app.playCurrent();

  app.dispatch('next');
  assert.equal(app.player.track.title, 'Song 2');
  assert.equal(app.cursor, 1, 'the selection follows playback');

  app.dispatch('next');
  assert.equal(app.player.track.title, 'Song 3');

  app.dispatch('previous');
  assert.equal(app.player.track.title, 'Song 2');
  app.player.dispose();
});

test('previous restarts the track once it is past the rewind threshold', () => {
  const app = makeApp();
  app.playCurrent();
  app.dispatch('next');

  // Pretend the track has been playing for a while.
  app.player.seek(20);
  app.dispatch('previous');

  assert.equal(app.player.track.title, 'Song 2', 'stays on the same song');
  assert.ok(app.player.elapsed < 1, 'and rewinds it');
  app.player.dispose();
});

test('space toggles pause and restarts after a stop', () => {
  const app = makeApp();
  app.playCurrent();

  app.dispatch('toggle-pause');
  assert.equal(app.player.state, STATES.PAUSED);

  app.dispatch('toggle-pause');
  assert.equal(app.player.state, STATES.PLAYING);

  app.dispatch('stop');
  assert.equal(app.player.state, STATES.STOPPED);

  app.dispatch('toggle-pause');
  assert.equal(app.player.state, STATES.PLAYING, 'space restarts a stopped track');
  app.player.dispose();
});

test('number keys jump straight to a song', () => {
  const app = makeApp();
  app.dispatch('jump-number', { str: '4', key: { name: '4' } });

  assert.equal(app.player.track.title, 'Song 4');
  assert.equal(app.playlist.displayPosition, 4);
  app.player.dispose();
});

test('a number beyond the queue warns instead of jumping', () => {
  const app = makeApp();
  app.playCurrent();
  app.dispatch('jump-number', { str: '9', key: { name: '9' } });

  assert.equal(app.player.track.title, 'Song 1', 'still on the original track');
  assert.equal(app.status.level, 'warn');
  assert.match(app.status.text, /no song 9/i);
  app.player.dispose();
});

test('the cursor moves independently of playback until enter is pressed', () => {
  const app = makeApp();
  app.playCurrent();

  app.dispatch('cursor-down');
  app.dispatch('cursor-down');
  assert.equal(app.cursor, 2);
  assert.equal(app.player.track.title, 'Song 1', 'moving the selection does not change the song');

  app.dispatch('play-selected');
  assert.equal(app.player.track.title, 'Song 3');
  app.player.dispose();
});

test('the cursor cannot leave the list', () => {
  const app = makeApp();
  app.dispatch('cursor-up');
  assert.equal(app.cursor, 0);

  app.dispatch('page-down');
  assert.equal(app.cursor, 5, 'stops at the last song');
  app.player.dispose();
});

test('volume keys adjust and clamp the level', () => {
  const app = makeApp({ volume: 95 });

  app.dispatch('volume-up');
  assert.equal(app.player.volume, 100);
  app.dispatch('volume-up');
  assert.equal(app.player.volume, 100, 'clamped at the top');

  app.dispatch('volume-down');
  assert.equal(app.player.volume, 95);
  assert.match(app.status.text, /Volume 95%/);
  app.player.dispose();
});

test('mute is reversible', () => {
  const app = makeApp({ volume: 40 });

  app.dispatch('mute');
  assert.equal(app.player.volume, 0);
  assert.match(app.status.text, /Muted/);

  app.dispatch('mute');
  assert.equal(app.player.volume, 40);
  app.player.dispose();
});

test('shuffle and repeat are toggled from the keyboard', () => {
  const app = makeApp();

  app.dispatch('shuffle');
  assert.equal(app.playlist.shuffle, true);
  app.dispatch('shuffle');
  assert.equal(app.playlist.shuffle, false);

  app.dispatch('repeat');
  assert.equal(app.playlist.repeat, 'all');
  app.dispatch('repeat');
  assert.equal(app.playlist.repeat, 'one');
  app.dispatch('repeat');
  assert.equal(app.playlist.repeat, 'off');
  app.player.dispose();
});

test('help toggles the view', () => {
  const app = makeApp();
  app.dispatch('help');
  assert.equal(app.view, 'help');
  app.dispatch('help');
  assert.equal(app.view, 'player');
  app.player.dispose();
});

test('a finished track advances to the next one automatically', async () => {
  const app = makeApp();
  app.playCurrent();

  // Emitting the engine's own end event is exactly what a finished file does.
  app.player.emit('end', app.player.track);
  assert.equal(app.player.track.title, 'Song 2');
  app.player.dispose();
});

test('reaching the end of the queue stops instead of looping', () => {
  const app = makeApp();
  app.interactive = true; // stay open the way a real terminal session would
  app.playlist.jumpTo(5);
  app.playCurrent();

  app.player.emit('end', app.player.track);
  assert.equal(app.player.state, STATES.STOPPED);
  assert.equal(app.playlist.current().title, 'Song 6', 'stays on the last track');
  assert.match(app.status.text, /End of playlist/);
  app.player.dispose();
});

test('without a terminal, finishing the queue exits the process cleanly', () => {
  const app = makeApp();
  assert.equal(app.interactive, false, 'no TTY means log-and-exit mode');
  app.playlist.jumpTo(5);
  app.playCurrent();

  app.player.emit('end', app.player.track);
  assert.equal(app.running, false, 'the run promise is resolved');
  assert.equal(app.exitCode, 0);
});

test('with repeat all, the queue wraps around', () => {
  const app = makeApp({ repeat: 'all' });
  app.playlist.jumpTo(5);
  app.playCurrent();

  app.player.emit('end', app.player.track);
  assert.equal(app.player.track.title, 'Song 1');
  app.player.dispose();
});

test('quit stops playback and reports an exit code', () => {
  const app = makeApp();
  app.playCurrent();

  app.quit(0);
  assert.equal(app.running, false);
  assert.equal(app.exitCode, 0);
});

test('an empty queue exits with a failure code rather than hanging', async () => {
  const app = new App({ tracks: [], silent: true, stdout: quietStdout() });
  assert.equal(await app.run(), 1);
});

test('refresh explains itself when there is no folder to rescan', async () => {
  const app = makeApp({ musicDir: null });
  await app.refresh();
  assert.equal(app.status.level, 'warn');
  app.player.dispose();
});
