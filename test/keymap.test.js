import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_BY_KEY, BINDINGS, actionForKey, helpGroups, normaliseKey } from '../src/keymap.js';

test('no key is bound to two different actions', () => {
  const owners = new Map();
  for (const binding of BINDINGS) {
    for (const key of binding.keys) {
      assert.ok(
        !owners.has(key),
        `"${key}" is claimed by both ${owners.get(key)} and ${binding.action}`,
      );
      owners.set(key, binding.action);
    }
  }
});

test('every binding is documented', () => {
  for (const binding of BINDINGS) {
    assert.ok(binding.action, 'needs an action');
    assert.ok(binding.keys.length > 0, `${binding.action} needs at least one key`);
    assert.ok(binding.display, `${binding.action} needs a display label`);
    assert.ok(binding.help, `${binding.action} needs help text`);
    assert.ok(binding.group, `${binding.action} needs a group`);
  }
});

test('normaliseKey maps the keys the player cares about', () => {
  assert.equal(normaliseKey(' ', { name: 'space' }), 'space');
  assert.equal(normaliseKey('', { name: 'return' }), 'return');
  assert.equal(normaliseKey('', { name: 'escape' }), 'escape');
  assert.equal(normaliseKey('N', { name: 'n' }), 'n', 'letters are lower-cased');
  assert.equal(normaliseKey('', { name: 'right' }), 'right');
  assert.equal(normaliseKey('', { name: 'right', shift: true }), 'shift+right');
  assert.equal(normaliseKey('\u0003', { name: 'c', ctrl: true }), 'ctrl+c');
  assert.equal(normaliseKey('', { name: 'f5' }), 'f5');
});

test('unhandled control chords are ignored', () => {
  assert.equal(normaliseKey('\u0001', { name: 'a', ctrl: true }), null);
  assert.equal(normaliseKey('', { name: 'z', meta: true }), null);
  assert.equal(normaliseKey(undefined, {}), null);
});

test('actionForKey resolves the main transport keys', () => {
  assert.equal(actionForKey(' ', { name: 'space' }), 'toggle-pause');
  assert.equal(actionForKey('n', { name: 'n' }), 'next');
  assert.equal(actionForKey('p', { name: 'p' }), 'previous');
  assert.equal(actionForKey('s', { name: 's' }), 'stop');
  assert.equal(actionForKey('q', { name: 'q' }), 'quit');
  assert.equal(actionForKey('', { name: 'escape' }), 'quit');
  assert.equal(actionForKey('\u0003', { name: 'c', ctrl: true }), 'quit');
});

test('digits 1-9 jump to a song and 0 restarts the current one', () => {
  for (const digit of '123456789') {
    assert.equal(actionForKey(digit, { name: digit }), 'jump-number', `${digit} should jump`);
  }
  assert.equal(actionForKey('0', { name: '0' }), 'restart');
});

test('arrow keys seek, and vim keys move the selection', () => {
  assert.equal(actionForKey('', { name: 'left' }), 'seek-back');
  assert.equal(actionForKey('', { name: 'right' }), 'seek-forward');
  assert.equal(actionForKey('', { name: 'left', shift: true }), 'seek-back-big');
  assert.equal(actionForKey('', { name: 'up' }), 'cursor-up');
  assert.equal(actionForKey('j', { name: 'j' }), 'cursor-down');
  assert.equal(actionForKey('k', { name: 'k' }), 'cursor-up');
});

test('unbound keys resolve to nothing', () => {
  assert.equal(actionForKey('@', { name: '@' }), null);
  assert.equal(actionForKey(undefined, { name: 'f12' }), null);
});

test('help groups cover every visible binding', () => {
  const grouped = helpGroups().flatMap((group) => group.items);
  const visible = BINDINGS.filter((binding) => !binding.hidden);
  assert.equal(grouped.length, visible.length);
  assert.ok(helpGroups().every((group) => group.title && group.items.length > 0));
});

test('the dispatch table is built from the bindings', () => {
  for (const binding of BINDINGS) {
    for (const key of binding.keys) {
      assert.equal(ACTION_BY_KEY.get(key), binding.action);
    }
  }
});
