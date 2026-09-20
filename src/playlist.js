/**
 * Playlist / queue model.
 *
 * Pure data structure with no I/O, which keeps the navigation rules (shuffle,
 * repeat, wrap-around) easy to reason about and to unit test.
 */

export const REPEAT_MODES = ['off', 'all', 'one'];

/** Fisher-Yates shuffle using an injectable RNG so tests stay deterministic. */
export function shuffleArray(items, random = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class Playlist {
  /**
   * @param {object[]} tracks
   * @param {object}   [options]
   * @param {boolean}  [options.shuffle]
   * @param {'off'|'all'|'one'} [options.repeat]
   * @param {() => number} [options.random] RNG used for shuffling
   */
  constructor(tracks = [], { shuffle = false, repeat = 'off', random = Math.random } = {}) {
    this.tracks = [...tracks];
    this.random = random;
    this.repeat = REPEAT_MODES.includes(repeat) ? repeat : 'off';
    this.shuffle = false;
    this.order = this.tracks.map((_, i) => i);
    this.position = this.tracks.length > 0 ? 0 : -1;
    if (shuffle) this.setShuffle(true);
  }

  get length() {
    return this.tracks.length;
  }

  get isEmpty() {
    return this.tracks.length === 0;
  }

  /** Index into `tracks` of the current entry, or -1. */
  get currentIndex() {
    if (this.position < 0 || this.position >= this.order.length) return -1;
    return this.order[this.position];
  }

  /** The current track, or null for an empty playlist. */
  current() {
    const index = this.currentIndex;
    return index >= 0 ? this.tracks[index] : null;
  }

  /** 1-based position in playback order, for display. */
  get displayPosition() {
    return this.position + 1;
  }

  /**
   * Advance to the next track.
   * @param {object}  [options]
   * @param {boolean} [options.auto] true when a track ended by itself, which is
   *   the only case where "repeat one" replays the same entry.
   * @returns {object|null} the new current track, or null at the end of the queue
   */
  next({ auto = false } = {}) {
    if (this.isEmpty) return null;
    if (auto && this.repeat === 'one') return this.current();

    if (this.position + 1 < this.order.length) {
      this.position += 1;
      return this.current();
    }

    if (this.repeat === 'all' || !auto) {
      if (this.shuffle && this.repeat === 'all') this.reshuffle({ keepCurrentFirst: false });
      this.position = 0;
      return this.current();
    }
    return null; // reached the end with repeat off
  }

  /** Step backwards, wrapping to the end of the queue. */
  previous() {
    if (this.isEmpty) return null;
    if (this.position > 0) {
      this.position -= 1;
    } else {
      this.position = this.order.length - 1;
    }
    return this.current();
  }

  /**
   * Jump to a track by its index in `tracks` (not in shuffled order).
   * @returns {object|null} the track, or null when the index is out of range
   */
  jumpTo(trackIndex) {
    if (trackIndex < 0 || trackIndex >= this.tracks.length) return null;
    const position = this.order.indexOf(trackIndex);
    if (position < 0) return null;
    this.position = position;
    return this.current();
  }

  /** Turn shuffle on or off, keeping the currently playing track in place. */
  setShuffle(enabled) {
    if (enabled === this.shuffle) return this.shuffle;
    const currentTrackIndex = this.currentIndex;
    this.shuffle = Boolean(enabled);

    if (this.shuffle) {
      this.reshuffle({ keepCurrentFirst: true, currentTrackIndex });
    } else {
      this.order = this.tracks.map((_, i) => i);
      this.position = currentTrackIndex >= 0 ? currentTrackIndex : Math.max(0, this.position);
    }
    return this.shuffle;
  }

  toggleShuffle() {
    return this.setShuffle(!this.shuffle);
  }

  /** Rebuild the shuffled order. */
  reshuffle({ keepCurrentFirst = true, currentTrackIndex = this.currentIndex } = {}) {
    const indices = this.tracks.map((_, i) => i);
    if (keepCurrentFirst && currentTrackIndex >= 0) {
      const rest = shuffleArray(
        indices.filter((i) => i !== currentTrackIndex),
        this.random,
      );
      this.order = [currentTrackIndex, ...rest];
      this.position = 0;
    } else {
      this.order = shuffleArray(indices, this.random);
      this.position = this.order.length > 0 ? 0 : -1;
    }
  }

  /** Cycle off -> all -> one -> off and return the new mode. */
  cycleRepeat() {
    const next = (REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length;
    this.repeat = REPEAT_MODES[next];
    return this.repeat;
  }

  setRepeat(mode) {
    if (REPEAT_MODES.includes(mode)) this.repeat = mode;
    return this.repeat;
  }

  /** The next `count` tracks in playback order (excludes the current one). */
  upcoming(count = 3) {
    const result = [];
    for (let step = 1; step <= this.order.length && result.length < count; step += 1) {
      const position = this.position + step;
      if (position >= this.order.length) {
        if (this.repeat !== 'all') break;
        result.push(this.tracks[this.order[position % this.order.length]]);
      } else {
        result.push(this.tracks[this.order[position]]);
      }
    }
    return result;
  }

  /** Tracks paired with their playback order position, for the list view. */
  entries() {
    return this.order.map((trackIndex, position) => ({
      position,
      trackIndex,
      track: this.tracks[trackIndex],
      isCurrent: position === this.position,
    }));
  }

  /** Total duration in seconds; tracks with unknown duration count as zero. */
  totalDuration() {
    return this.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  }

  /** Replace the queue contents, keeping the current track selected if it survives. */
  replace(tracks) {
    const currentPath = this.current()?.path;
    this.tracks = [...tracks];
    this.order = this.tracks.map((_, i) => i);
    this.position = this.tracks.length > 0 ? 0 : -1;
    if (this.shuffle) {
      this.shuffle = false;
      this.setShuffle(true);
    }
    if (currentPath) {
      const index = this.tracks.findIndex((track) => track.path === currentPath);
      if (index >= 0) this.jumpTo(index);
    }
    return this.current();
  }
}
