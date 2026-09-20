/** Small pure helpers for turning numbers and strings into terminal output. */

import { colorEnabled, glyphs, style } from './theme.js';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Remove SGR colour codes so widths can be measured accurately. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '');
}

/** Printable width of a string, ignoring colour escapes. */
export function visibleLength(text) {
  return stripAnsi(text).length;
}

/**
 * Seconds -> `m:ss`, or `h:mm:ss` once the value passes an hour.
 * Unknown/invalid values render as `--:--` so the UI never prints `NaN`.
 */
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse a user supplied position: `90`, `1:30` and `1:02:03` are all accepted.
 * Returns null when the input is not a time.
 */
export function parseTimeSpec(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

/** Truncate to `max` printable characters, appending an ellipsis when cut. */
export function truncate(text, max) {
  const str = String(text);
  if (max <= 0) return '';
  if (str.length <= max) return str;
  if (max === 1) return '.';
  return `${str.slice(0, max - 1)}…`;
}

/**
 * Truncate a string that may contain colour escapes to `max` printable
 * characters, keeping the escapes intact and closing them off at the end so a
 * cut never leaks a half-written sequence into the terminal.
 */
export function truncateAnsi(text, max) {
  const str = String(text);
  if (max <= 0) return '';
  if (visibleLength(str) <= max) return str;

  let out = '';
  let visible = 0;
  let index = 0;
  while (index < str.length && visible < max - 1) {
    if (str[index] === '\u001b') {
      const match = /^\u001b\[[0-9;]*m/.exec(str.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    out += str[index];
    visible += 1;
    index += 1;
  }
  return out + '\u2026' + (colorEnabled ? style.reset : '');
}

/** Pad a possibly-coloured string to `width` printable characters. */
export function padVisible(text, width) {
  const missing = width - visibleLength(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Render a progress bar. `ratio` is 0..1; an unknown ratio (null) draws an
 * empty track so tracks with no readable duration still look sane.
 */
export function progressBar(ratio, width, { color = style.brightCyan } = {}) {
  const size = Math.max(4, width);
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return style.gray(glyphs.barEmpty.repeat(size));
  }
  const filled = Math.round(clamp(ratio, 0, 1) * size);
  const head = filled > 0 && filled < size ? 1 : 0;
  const body = Math.max(0, filled - head);
  return (
    color(glyphs.barFull.repeat(body) + (head ? glyphs.barHead : '')) +
    style.gray(glyphs.barEmpty.repeat(Math.max(0, size - body - head)))
  );
}

/** Render a small block meter, used for the volume indicator. */
export function levelBar(percent, width = 10) {
  const filled = Math.round((clamp(percent, 0, 100) / 100) * width);
  return (
    style.brightGreen(glyphs.volFull.repeat(filled)) +
    style.gray(glyphs.volEmpty.repeat(Math.max(0, width - filled)))
  );
}

/** Human readable file size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `1 song` / `2 songs`. */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
