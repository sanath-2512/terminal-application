import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  formatBytes,
  formatTime,
  levelBar,
  padVisible,
  parseTimeSpec,
  pluralize,
  progressBar,
  stripAnsi,
  truncate,
  truncateAnsi,
  visibleLength,
} from '../src/format.js';

test('formatTime renders minutes and hours', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(599), '9:59');
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3725), '1:02:05');
});

test('formatTime refuses to print NaN for unknown durations', () => {
  assert.equal(formatTime(null), '--:--');
  assert.equal(formatTime(undefined), '--:--');
  assert.equal(formatTime(Number.NaN), '--:--');
  assert.equal(formatTime(-1), '--:--');
  assert.equal(formatTime(Infinity), '--:--');
});

test('parseTimeSpec accepts seconds, m:ss and h:mm:ss', () => {
  assert.equal(parseTimeSpec('90'), 90);
  assert.equal(parseTimeSpec('1:30'), 90);
  assert.equal(parseTimeSpec('1:02:03'), 3723);
  assert.equal(parseTimeSpec(42), 42);
});

test('parseTimeSpec rejects nonsense', () => {
  assert.equal(parseTimeSpec('abc'), null);
  assert.equal(parseTimeSpec(''), null);
  assert.equal(parseTimeSpec('1:2:3:4'), null);
  assert.equal(parseTimeSpec(null), null);
});

test('truncate keeps short strings and ellipsises long ones', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('abc', 0), '');
});

test('truncateAnsi measures printable width, not escape codes', () => {
  const coloured = '\u001b[1mHello\u001b[22m brave new world';
  assert.equal(visibleLength(coloured), 21);
  const cut = truncateAnsi(coloured, 12);
  assert.equal(visibleLength(cut), 12);
  assert.ok(cut.includes('\u001b[1m'), 'keeps the opening escape');
});

test('stripAnsi and padVisible ignore colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[39m'), 'red');
  assert.equal(visibleLength(padVisible('\u001b[31mred\u001b[39m', 6)), 6);
});

test('progressBar fills proportionally and survives unknown progress', () => {
  assert.equal(visibleLength(progressBar(0, 20)), 20);
  assert.equal(visibleLength(progressBar(1, 20)), 20);
  assert.equal(visibleLength(progressBar(0.5, 20)), 20);
  assert.equal(visibleLength(progressBar(null, 20)), 20);
  assert.equal(visibleLength(progressBar(5, 20)), 20, 'out of range ratios are clamped');
});

test('levelBar has a stable width', () => {
  assert.equal(visibleLength(levelBar(0, 10)), 10);
  assert.equal(visibleLength(levelBar(55, 10)), 10);
  assert.equal(visibleLength(levelBar(100, 10)), 10);
});

test('clamp, formatBytes and pluralize', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(pluralize(1, 'song'), '1 song');
  assert.equal(pluralize(2, 'song'), '2 songs');
});
