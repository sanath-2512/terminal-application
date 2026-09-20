/**
 * Single source of truth for keyboard bindings.
 *
 * Both the input handler and the on-screen help are generated from this list,
 * so the two can never drift apart.
 */

/**
 * @typedef {object} Binding
 * @property {string}   action  identifier handled by the app
 * @property {string[]} keys    normalised key names this binding listens for
 * @property {string}   display how the keys are shown in help
 * @property {string}   help    one-line description
 * @property {string}   group   section heading in the help view
 * @property {boolean}  [hidden] omit from the help screen
 */

/** @type {Binding[]} */
export const BINDINGS = [
  {
    action: 'toggle-pause',
    short: 'play/pause',
    keys: ['space'],
    display: 'space',
    help: 'Play / pause',
    group: 'Transport',
  },
  {
    action: 'stop',
    short: 'stop',
    keys: ['s'],
    display: 's',
    help: 'Stop and rewind',
    group: 'Transport',
  },
  {
    action: 'next',
    short: 'next',
    keys: ['n'],
    display: 'n',
    help: 'Next song',
    group: 'Transport',
  },
  {
    action: 'previous',
    short: 'prev',
    keys: ['p'],
    display: 'p',
    help: 'Previous song',
    group: 'Transport',
  },
  {
    action: 'restart',
    keys: ['0'],
    display: '0',
    help: 'Restart the current song',
    group: 'Transport',
  },

  {
    action: 'seek-forward',
    keys: ['right'],
    display: '→',
    help: 'Seek forward 5s',
    group: 'Seeking',
  },
  {
    action: 'seek-back',
    keys: ['left'],
    display: '←',
    help: 'Seek back 5s',
    group: 'Seeking',
  },
  {
    action: 'seek-forward-big',
    keys: ['shift+right'],
    display: 'shift →',
    help: 'Seek forward 30s',
    group: 'Seeking',
  },
  {
    action: 'seek-back-big',
    keys: ['shift+left'],
    display: 'shift ←',
    help: 'Seek back 30s',
    group: 'Seeking',
  },

  {
    action: 'volume-up',
    keys: ['+', '='],
    display: '+',
    help: 'Volume up',
    group: 'Sound',
  },
  {
    action: 'volume-down',
    keys: ['-', '_'],
    display: '-',
    help: 'Volume down',
    group: 'Sound',
  },
  { action: 'mute', keys: ['m'], display: 'm', help: 'Mute / unmute', group: 'Sound' },

  {
    action: 'cursor-up',
    keys: ['up', 'k'],
    display: '↑ / k',
    help: 'Move selection up',
    group: 'Playlist',
  },
  {
    action: 'cursor-down',
    keys: ['down', 'j'],
    display: '↓ / j',
    help: 'Move selection down',
    group: 'Playlist',
  },
  {
    action: 'page-up',
    keys: ['pageup'],
    display: 'PgUp',
    help: 'Scroll the list up',
    group: 'Playlist',
    hidden: true,
  },
  {
    action: 'page-down',
    keys: ['pagedown'],
    display: 'PgDn',
    help: 'Scroll the list down',
    group: 'Playlist',
    hidden: true,
  },
  {
    action: 'play-selected',
    keys: ['return'],
    display: 'enter',
    help: 'Play the selected song',
    group: 'Playlist',
  },
  {
    action: 'jump-number',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    display: '1-9',
    help: 'Jump straight to that song',
    group: 'Playlist',
  },
  { action: 'shuffle', keys: ['x'], display: 'x', help: 'Toggle shuffle', group: 'Playlist' },
  {
    action: 'repeat',
    keys: ['r'],
    display: 'r',
    help: 'Repeat: off → all → one',
    group: 'Playlist',
  },

  {
    action: 'help',
    short: 'help',
    keys: ['?', 'f1'],
    display: '?',
    help: 'Toggle this help',
    group: 'General',
  },
  {
    action: 'refresh',
    keys: ['f5'],
    display: 'F5',
    help: 'Rescan the music folder',
    group: 'General',
  },
  {
    action: 'quit',
    short: 'quit',
    keys: ['q', 'escape', 'ctrl+c'],
    display: 'q',
    help: 'Quit',
    group: 'General',
  },
];

/** action -> Binding, used when rendering help and the footer hints. */
export const BINDINGS_BY_ACTION = new Map(BINDINGS.map((binding) => [binding.action, binding]));

/** key name -> action, used for dispatch. */
export const ACTION_BY_KEY = (() => {
  const map = new Map();
  for (const binding of BINDINGS) {
    for (const key of binding.keys) {
      if (!map.has(key)) map.set(key, binding.action);
    }
  }
  return map;
})();

/**
 * Normalise a readline keypress into the names used above.
 * @param {string} str raw character produced by the key
 * @param {object} key readline key descriptor
 * @returns {string|null} null when the key has no meaning here
 */
export function normaliseKey(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl+c';
  if (key.ctrl || key.meta) return null; // other chords are ignored

  const name = key.name;
  if (name === 'left' || name === 'right' || name === 'up' || name === 'down') {
    return key.shift ? `shift+${name}` : name;
  }
  if (name === 'space' || str === ' ') return 'space';
  if (name === 'return' || name === 'enter') return 'return';
  if (name === 'escape') return 'escape';
  if (name === 'pageup' || name === 'pagedown') return name;
  if (name === 'f1' || name === 'f5') return name;

  if (typeof str === 'string' && str.length === 1) return str.toLowerCase();
  if (name) return name.toLowerCase();
  return null;
}

/** Resolve a keypress directly to an action name, or null. */
export function actionForKey(str, key) {
  const normalised = normaliseKey(str, key);
  if (!normalised) return null;
  return ACTION_BY_KEY.get(normalised) ?? null;
}

/** Bindings grouped for the help screen, hidden entries removed. */
export function helpGroups() {
  const groups = new Map();
  for (const binding of BINDINGS) {
    if (binding.hidden) continue;
    if (!groups.has(binding.group)) groups.set(binding.group, []);
    groups.get(binding.group).push(binding);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}
