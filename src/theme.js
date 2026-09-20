/**
 * Terminal colours and glyphs.
 *
 * Colour is disabled automatically when stdout is not a TTY, when the terminal
 * claims to be "dumb", or when the NO_COLOR convention is in play, so piping
 * the player's output into a file produces clean text.
 */

const forced = process.env.FORCE_COLOR;

export const colorEnabled = (() => {
  if (forced === '0' || forced === 'false') return false;
  if (forced) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
})();

const wrap = (open, close) => (text) =>
  colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

export const style = {
  reset: '\u001b[0m',
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),

  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),

  brightRed: wrap(91, 39),
  brightGreen: wrap(92, 39),
  brightYellow: wrap(93, 39),
  brightBlue: wrap(94, 39),
  brightMagenta: wrap(95, 39),
  brightCyan: wrap(96, 39),

  bgBlue: wrap(44, 49),
  bgGray: wrap(100, 49),
};

/**
 * Glyphs degrade to ASCII when the terminal is unlikely to render box drawing
 * or emoji correctly (Windows consoles without UTF-8, `TERM=dumb`, pipes).
 */
export const unicodeEnabled = (() => {
  if (process.env.MUSIC_PLAYER_ASCII === '1') return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.platform === 'win32') return Boolean(process.env.WT_SESSION);
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  if (locale && !/utf-?8/i.test(locale)) return false;
  return true;
})();

const glyph = (fancy, plain) => (unicodeEnabled ? fancy : plain);

export const glyphs = {
  playing: glyph('▶', '>'),
  paused: glyph('⏸', '||'),
  stopped: glyph('■', '#'),
  note: glyph('♪', '~'),
  barFull: glyph('━', '='),
  barEmpty: glyph('─', '-'),
  barHead: glyph('●', 'O'),
  volFull: glyph('█', '#'),
  volEmpty: glyph('░', '.'),
  cursor: glyph('❯', '>'),
  shuffle: glyph('⇄', 'X'),
  repeat: glyph('↺', 'R'),
  topLeft: glyph('╭', '+'),
  topRight: glyph('╮', '+'),
  bottomLeft: glyph('╰', '+'),
  bottomRight: glyph('╯', '+'),
  horizontal: glyph('─', '-'),
  vertical: glyph('│', '|'),
};

/** ANSI cursor/screen control sequences used by the renderer. */
export const ansi = {
  clearScreen: '\u001b[2J\u001b[H',
  clearLine: '\u001b[2K',
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
  home: '\u001b[H',
  altScreenOn: '\u001b[?1049h',
  altScreenOff: '\u001b[?1049l',
  moveTo: (row, col = 1) => `\u001b[${row};${col}H`,
  clearDown: '\u001b[0J',
};
