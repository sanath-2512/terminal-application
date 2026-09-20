import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * Colour is decided once, at module load, from the environment. To test the
 * coloured code path these assertions run in a child process with
 * FORCE_COLOR=1, which is also the closest thing to how a real terminal
 * session looks.
 */
const SCRIPT = `
import { Renderer } from './src/ui.js';
import { Player } from './src/player.js';
import { Playlist } from './src/playlist.js';
import { colorEnabled } from './src/theme.js';
import { visibleLength } from './src/format.js';

if (!colorEnabled) {
  console.log(JSON.stringify({ error: 'colour was not enabled in the child' }));
  process.exit(0);
}

const tracks = Array.from({ length: 8 }, (_, i) => ({
  path: '/music/' + i + '.mp3',
  title: 'A Very Long Song Title That Definitely Overflows A Narrow Terminal ' + (i + 1),
  artist: 'An Extremely Long Artist Name That Also Overflows',
  album: 'An Album With A Rather Long Name Too',
  duration: 200 + i,
}));

const results = [];
for (const columns of [40, 48, 60, 80, 120]) {
  const playlist = new Playlist(tracks, { repeat: 'all' });
  playlist.setShuffle(true);
  const player = new Player({ silent: true, volume: 65 });
  player.play(playlist.current());

  const renderer = new Renderer({ stream: { columns, rows: 24, isTTY: false, write() {} } });
  for (const view of ['player', 'help']) {
    const frame = renderer.compose({
      player, playlist, cursor: 3, scrollTop: 0, view,
      backend: { label: 'mpv' }, silent: false,
      status: { text: 'A status message long enough to need trimming on a narrow screen', level: 'info' },
    });
    results.push({
      columns,
      view,
      // A colour escape that lost its leading ESC byte shows up as a bare
      // "[0m"-style fragment in the visible text.
      leaked: /\\[[0-9;]*m/.test(frame.replace(/\\u001b\\[[0-9;]*m/g, '')),
      widest: Math.max(...frame.split('\\n').map(visibleLength)),
      coloured: frame.includes('\\u001b['),
    });
  }
  player.dispose();
}
console.log(JSON.stringify(results));
`;

test('coloured frames never leak escape fragments or overflow the width', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: '1' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const frames = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.ok(!frames.error, frames.error);
  assert.ok(Array.isArray(frames) && frames.length === 10);

  for (const frame of frames) {
    const where = `${frame.view} view at ${frame.columns} columns`;
    assert.equal(frame.coloured, true, `${where} should actually be coloured`);
    assert.equal(frame.leaked, false, `${where} leaked a broken colour escape`);
    assert.ok(frame.widest <= frame.columns, `${where} overflowed (${frame.widest} wide)`);
  }
});
