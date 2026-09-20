/**
 * Terminal renderer.
 *
 * Draws the whole interface into an off-screen string and writes it in one go,
 * which keeps the display flicker-free. The alternate screen buffer is used so
 * quitting leaves the user's scrollback exactly as it was.
 */

import { ansi, glyphs, style } from './theme.js';
import {
  formatTime,
  levelBar,
  padVisible,
  progressBar,
  pluralize,
  truncate,
  truncateAnsi,
  visibleLength,
} from './format.js';
import { helpGroups, BINDINGS_BY_ACTION } from './keymap.js';
import { STATES } from './player.js';

const MIN_WIDTH = 40;
const MIN_LIST_ROWS = 3;

export class Renderer {
  constructor({ stream = process.stdout } = {}) {
    this.stream = stream;
    this.active = false;
    this.lastFrame = null;
  }

  get width() {
    return Math.max(MIN_WIDTH, this.stream.columns || 80);
  }

  get height() {
    return Math.max(12, this.stream.rows || 24);
  }

  /** Switch to the alternate screen buffer and hide the cursor. */
  start() {
    if (this.active) return;
    this.active = true;
    this.lastFrame = null;
    if (this.stream.isTTY) {
      this.stream.write(ansi.altScreenOn + ansi.hideCursor + ansi.clearScreen);
    }
  }

  /** Restore the terminal to the state it was in before start(). */
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.stream.isTTY) {
      this.stream.write(ansi.showCursor + ansi.altScreenOff);
    }
    this.lastFrame = null;
  }

  /** Force the next render to redraw everything (used on resize). */
  invalidate() {
    this.lastFrame = null;
  }

  /** Compose and write a frame. */
  draw(model) {
    const frame = this.compose(model);
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    if (this.stream.isTTY) {
      this.stream.write(ansi.home + frame + ansi.clearDown);
    } else {
      this.stream.write(`${frame}\n`);
    }
  }

  /** Build the frame text without writing it (handy for tests). */
  compose(model) {
    const lines =
      model.view === 'help' ? this.#renderHelp(model) : this.#renderPlayer(model);
    const height = this.height;
    return lines
      .slice(0, height - 1)
      .map((line) => this.#fit(line))
      .join('\n');
  }

  /* ---------------------------------------------------------------- *
   * Sections
   * ---------------------------------------------------------------- */

  #fit(line) {
    // Cutting raw characters could slice through a colour escape and leak
    // fragments like "[0m" onto the screen, so truncate on printable width.
    return visibleLength(line) > this.width ? truncateAnsi(line, this.width) : line;
  }

  #renderPlayer(model) {
    const { player, playlist } = model;
    const width = this.width;
    const lines = [];

    lines.push(this.#header(model));
    lines.push('');
    lines.push(...this.#nowPlaying(model));
    lines.push('');
    lines.push(this.#progressLine(player, width));
    lines.push('');
    lines.push(this.#statusLine(model));
    lines.push('');

    const heading =
      style.bold('PLAYLIST') +
      style.gray(
        `  ${pluralize(playlist.length, 'song')} · ${formatTime(playlist.totalDuration())} total`,
      );
    lines.push(`  ${heading}`);

    const chromeRows = lines.length + 3; // + message line + footer + spacing
    const listRows = Math.max(MIN_LIST_ROWS, this.height - chromeRows - 1);
    lines.push(...this.#playlistRows(model, listRows));

    lines.push('');
    lines.push(this.#messageLine(model));
    lines.push(this.#footer(model));
    return lines;
  }

  #header(model) {
    const width = this.width;
    const left = `  ${style.brightMagenta(glyphs.note)} ${style.bold('TERMINAL MUSIC PLAYER')}`;
    const backendName = model.silent
      ? 'silent (no audio)'
      : model.backend?.label || 'no backend';
    const right = `${style.gray(backendName)}  `;
    const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
    return left + ' '.repeat(gap) + right;
  }

  #nowPlaying(model) {
    const { player, playlist } = model;
    const track = player.track || playlist.current();
    const width = this.width;

    if (!track) {
      return [`  ${style.gray('Nothing loaded.')}`, ''];
    }

    const icon =
      player.state === STATES.PLAYING
        ? style.brightGreen(glyphs.playing)
        : player.state === STATES.PAUSED
          ? style.brightYellow(glyphs.paused)
          : style.gray(glyphs.stopped);

    const position = playlist.length > 0 ? `${playlist.displayPosition}/${playlist.length}` : '';
    const titleRoom = width - 10 - position.length;
    const title = style.bold(style.brightCyan(truncate(track.title, Math.max(8, titleRoom))));

    const subtitleParts = [track.artist, track.album].filter(Boolean);
    const subtitle = truncate(subtitleParts.join(` ${glyphs.note} `), width - 8);

    const titleLine = `  ${icon}  ${title}`;
    const counter = style.gray(position);
    const gap = Math.max(1, width - visibleLength(titleLine) - visibleLength(counter) - 2);

    return [titleLine + ' '.repeat(gap) + counter + '  ', `     ${style.gray(subtitle)}`];
  }

  #progressLine(player, width) {
    const elapsed = formatTime(player.elapsed);
    const total = formatTime(player.track?.duration ?? null);
    const barWidth = Math.max(10, width - elapsed.length - total.length - 10);
    const bar = progressBar(player.progress, barWidth);
    return `  ${style.gray(elapsed)}  ${bar}  ${style.gray(total)}`;
  }

  #statusLine(model) {
    const { player, playlist } = model;
    const stateLabel =
      player.state === STATES.PLAYING
        ? style.brightGreen('PLAYING')
        : player.state === STATES.PAUSED
          ? style.brightYellow('PAUSED ')
          : style.gray('STOPPED');

    const volume = player.isMuted
      ? `${style.brightRed('muted')}`
      : `${levelBar(player.volume, 10)} ${String(player.volume).padStart(3)}%`;

    const shuffle = playlist.shuffle
      ? style.brightMagenta(`${glyphs.shuffle} shuffle`)
      : style.gray(`${glyphs.shuffle} shuffle`);

    const repeatLabel = { off: 'repeat off', all: 'repeat all', one: 'repeat one' }[playlist.repeat];
    const repeat =
      playlist.repeat === 'off'
        ? style.gray(`${glyphs.repeat} ${repeatLabel}`)
        : style.brightMagenta(`${glyphs.repeat} ${repeatLabel}`);

    return `  ${stateLabel}   ${volume}   ${shuffle}   ${repeat}`;
  }

  #playlistRows(model, maxRows) {
    const { playlist, cursor } = model;
    const entries = playlist.entries();
    if (entries.length === 0) {
      return [`  ${style.gray('No songs found. Drop audio files into the music folder.')}`];
    }

    // When the list is taller than the viewport, reserve the top and bottom
    // rows for "more above/below" markers. Reserving them rather than drawing
    // over the list means the selected row can never be hidden by a marker.
    const needsScrolling = entries.length > maxRows;
    const windowRows = needsScrolling ? Math.max(1, maxRows - 2) : maxRows;
    const scrollTop = clampScroll(cursor, model.scrollTop, entries.length, windowRows);
    model.scrollTop = scrollTop;

    const width = this.width;
    const numberWidth = String(entries.length).length;
    const durationWidth = 6;
    const artistWidth = width > 72 ? 22 : 0;
    const titleWidth = Math.max(10, width - 18 - numberWidth - artistWidth);

    const rows = [];
    if (needsScrolling) {
      rows.push(scrollTop > 0 ? `  ${style.gray(`\u2191 ${scrollTop} more`)}` : '');
    }

    for (let i = scrollTop; i < Math.min(entries.length, scrollTop + windowRows); i += 1) {
      const entry = entries[i];
      const isCursor = i === cursor;
      const isCurrent = entry.isCurrent;

      const marker = isCursor ? style.brightCyan(glyphs.cursor) : ' ';
      const playing = isCurrent
        ? model.player.state === STATES.PLAYING
          ? style.brightGreen(glyphs.playing)
          : style.brightYellow(glyphs.paused)
        : ' ';

      const number = style.gray(String(i + 1).padStart(numberWidth));
      let title = padVisible(truncate(entry.track.title, titleWidth), titleWidth);
      let artist = artistWidth
        ? style.gray(padVisible(truncate(entry.track.artist, artistWidth), artistWidth))
        : '';
      const duration = formatTime(entry.track.duration).padStart(durationWidth);

      if (isCurrent) title = style.brightCyan(title);
      else if (isCursor) title = style.bold(title);

      rows.push(
        `  ${marker} ${playing} ${number}. ${title}${artist ? `  ${artist}` : ''}  ${style.gray(duration)}`,
      );
    }

    if (needsScrolling) {
      const remaining = entries.length - (scrollTop + windowRows);
      rows.push(remaining > 0 ? `  ${style.gray(`\u2193 ${remaining} more`)}` : '');
    }
    return rows;
  }

  #messageLine(model) {
    const message = model.status;
    if (!message || !message.text) return '';
    const colour =
      message.level === 'error'
        ? style.brightRed
        : message.level === 'warn'
          ? style.brightYellow
          : style.brightGreen;
    return `  ${colour(truncate(message.text, this.width - 4))}`;
  }

  #footer() {
    const hint = (action) => {
      const binding = BINDINGS_BY_ACTION.get(action);
      if (!binding) return '';
      return `${style.bold(binding.display)} ${style.gray(binding.short || binding.help)}`;
    };
    const actions = ['toggle-pause', 'next', 'previous', 'stop', 'help', 'quit'];
    const separator = style.gray(' \u00b7 ');

    // Drop hints from the right until the row fits the terminal.
    for (let count = actions.length; count > 1; count -= 1) {
      const row = `  ${actions.slice(0, count).map(hint).filter(Boolean).join(separator)}`;
      if (visibleLength(row) <= this.width) return row;
    }
    return `  ${hint('quit')}`;
  }

  #renderHelp() {
    const groups = helpGroups();
    const blocks = groups.map((group) => [
      style.brightMagenta(group.title),
      ...group.items.map(
        (binding) => `  ${style.bold(padVisible(binding.display, 9))} ${style.gray(binding.help)}`,
      ),
      '',
    ]);

    const lines = [`  ${style.bold('KEYBOARD SHORTCUTS')}`, ''];
    const columnWidth = 40;

    if (this.width >= columnWidth * 2 + 4) {
      // Pick the split point that leaves the two columns closest in height.
      const total = blocks.reduce((sum, block) => sum + block.length, 0);
      let split = 1;
      let best = Infinity;
      let running = 0;
      for (let i = 1; i < blocks.length; i += 1) {
        running += blocks[i - 1].length;
        const imbalance = Math.abs(running - (total - running));
        if (imbalance < best) {
          best = imbalance;
          split = i;
        }
      }

      const left = blocks.slice(0, split).flat();
      const right = blocks.slice(split).flat();
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const leftCell = padVisible(left[i] ?? '', columnWidth);
        lines.push(`  ${leftCell}${right[i] ?? ''}`.trimEnd());
      }
    } else {
      lines.push(...blocks.flat().map((line) => `  ${line}`));
    }

    lines.push(`  ${style.gray('Press any key to go back.')}`);
    return lines;
  }
}

/** Keep the cursor inside the visible window. */
export function clampScroll(cursor, scrollTop, total, rows) {
  if (total <= rows) return 0;
  let top = Math.max(0, Math.min(scrollTop, total - rows));
  if (cursor < top) top = cursor;
  if (cursor >= top + rows) top = cursor - rows + 1;
  return Math.max(0, Math.min(top, total - rows));
}
