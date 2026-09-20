/**
 * Playback engine.
 *
 * The player owns a single child process running an external audio tool and
 * exposes transport controls over it:
 *
 *   play    -> spawn the backend with the file (and a start offset when seeking)
 *   pause   -> SIGSTOP the child, or stop-and-remember on platforms without it
 *   resume  -> SIGCONT, or respawn at the saved offset
 *   stop    -> SIGTERM and reset the clock
 *
 * Elapsed time is tracked from wall-clock segments rather than by asking the
 * backend, so it works identically for every tool.
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export const STATES = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  STOPPED: 'stopped',
};

const VOLUME_RESTART_DELAY = 350; // ms of quiet before re-spawning for a volume change

export class Player extends EventEmitter {
  /**
   * @param {object}  options
   * @param {object}  [options.backend] descriptor from backends.js; null in silent mode
   * @param {number}  [options.volume] 0-100
   * @param {boolean} [options.silent] simulate playback without touching audio hardware
   */
  constructor({ backend = null, volume = 80, silent = false } = {}) {
    super();
    this.backend = backend;
    this.silent = silent || !backend;
    this.volume = clampVolume(volume);
    this.mutedVolume = null;

    this.state = STATES.IDLE;
    this.track = null;
    this.child = null;

    this.generation = 0; // guards against exit handlers from superseded processes
    this.baseOffset = 0; // seconds into the track when the current segment began
    this.segmentStart = 0; // Date.now() at segment start
    this.frozenElapsed = 0; // elapsed time while paused/stopped

    this.endTimer = null;
    this.volumeTimer = null;
    this.lastError = null;
  }

  /* ---------------------------------------------------------------- *
   * Derived state
   * ---------------------------------------------------------------- */

  get isPlaying() {
    return this.state === STATES.PLAYING;
  }

  get isPaused() {
    return this.state === STATES.PAUSED;
  }

  get isActive() {
    return this.isPlaying || this.isPaused;
  }

  get isMuted() {
    return this.mutedVolume !== null;
  }

  /** Seconds played of the current track. */
  get elapsed() {
    if (this.state !== STATES.PLAYING) return this.frozenElapsed;
    const running = (Date.now() - this.segmentStart) / 1000;
    const value = this.baseOffset + running;
    const duration = this.track?.duration;
    return duration ? Math.min(value, duration) : value;
  }

  /** Progress as 0..1, or null when the track duration is unknown. */
  get progress() {
    const duration = this.track?.duration;
    if (!duration || duration <= 0) return null;
    return Math.min(1, Math.max(0, this.elapsed / duration));
  }

  /** True when the chosen backend can start playback part-way through a file. */
  get canSeek() {
    return this.silent || Boolean(this.backend?.supportsSeek);
  }

  get canSetVolume() {
    return this.silent || Boolean(this.backend?.supportsVolume);
  }

  /** True when pausing keeps the process alive instead of restarting it. */
  get usesSignalPause() {
    if (this.silent) return true;
    return this.backend?.supportsSignalPause ?? process.platform !== 'win32';
  }

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */

  /**
   * Start playing a track, replacing whatever was playing before.
   * @param {object} track   record from library.js
   * @param {object} [options]
   * @param {number} [options.startAt] seconds to start from
   */
  play(track, { startAt = 0 } = {}) {
    if (!track) return false;
    this.#teardown();

    this.track = track;
    this.lastError = null;
    const offset = this.canSeek ? Math.max(0, startAt) : 0;
    this.#beginSegment(offset);
    this.#setState(STATES.PLAYING);
    this.emit('trackChange', track);

    this.#spawnBackend(offset);
    return true;
  }

  /** Freeze playback in place. */
  pause() {
    if (this.state !== STATES.PLAYING) return false;
    this.frozenElapsed = this.elapsed;
    this.#clearEndTimer();

    if (!this.silent && this.child) {
      if (this.usesSignalPause) {
        this.#signalChild('SIGSTOP');
      } else {
        // No job control: remember the position and drop the process.
        this.generation += 1;
        this.#killChild();
      }
    }
    this.#setState(STATES.PAUSED);
    return true;
  }

  /** Continue from where pause() left off. */
  resume() {
    if (this.state !== STATES.PAUSED || !this.track) return false;
    const offset = this.frozenElapsed;
    this.#beginSegment(offset);
    this.#setState(STATES.PLAYING);

    if (this.silent) {
      this.#armSilentEndTimer(offset);
    } else if (this.usesSignalPause && this.child) {
      this.#signalChild('SIGCONT');
    } else {
      this.#spawnBackend(offset);
    }
    return true;
  }

  /** Pause when playing, resume when paused, restart when stopped. */
  togglePause() {
    if (this.state === STATES.PLAYING) return this.pause();
    if (this.state === STATES.PAUSED) return this.resume();
    if (this.track) return this.play(this.track);
    return false;
  }

  /** Halt playback and rewind to the start of the track. */
  stop() {
    if (this.state === STATES.IDLE || this.state === STATES.STOPPED) {
      this.frozenElapsed = 0;
      return false;
    }
    this.#teardown();
    this.frozenElapsed = 0;
    this.baseOffset = 0;
    this.#setState(STATES.STOPPED);
    this.emit('stopped', this.track);
    return true;
  }

  /**
   * Jump to an absolute position in the current track.
   * @returns {boolean} false when the backend cannot seek
   */
  seek(seconds) {
    if (!this.track || !this.isActive) return false;
    if (!this.canSeek) {
      this.emit('notice', {
        level: 'warn',
        message: `${this.backend?.label || 'This backend'} cannot seek — try mpv or ffplay.`,
      });
      return false;
    }

    const duration = this.track.duration;
    const target = Math.max(0, duration ? Math.min(seconds, Math.max(0, duration - 0.35)) : seconds);
    const wasPaused = this.isPaused;

    this.#teardown();
    this.#beginSegment(target);

    if (wasPaused) {
      this.frozenElapsed = target;
      this.#setState(STATES.PAUSED);
      // Stay paused: the process is re-spawned on resume at the new offset.
      if (this.silent) return true;
      if (this.usesSignalPause) {
        this.#spawnBackend(target);
        this.#signalChild('SIGSTOP');
      }
      return true;
    }

    this.#setState(STATES.PLAYING);
    this.#spawnBackend(target);
    this.emit('seek', target);
    return true;
  }

  /** Seek relative to the current position. */
  seekBy(delta) {
    return this.seek(this.elapsed + delta);
  }

  /**
   * Change output volume (0-100).
   * Backends only read the volume at start-up, so a running track is restarted
   * at its current position — debounced so holding a key does not thrash.
   */
  setVolume(percent, { applyNow = true } = {}) {
    const next = clampVolume(percent);
    const changed = next !== this.volume;
    this.volume = next;
    if (this.mutedVolume !== null && next > 0) this.mutedVolume = null;
    this.emit('volume', this.volume);

    if (changed && applyNow && this.isPlaying && !this.silent && this.canSeek) {
      clearTimeout(this.volumeTimer);
      this.volumeTimer = setTimeout(() => {
        if (this.isPlaying) this.seek(this.elapsed);
      }, VOLUME_RESTART_DELAY);
      this.volumeTimer.unref?.();
    }
    return this.volume;
  }

  adjustVolume(delta) {
    return this.setVolume(this.volume + delta);
  }

  /** Mute remembers the previous level so unmuting restores it. */
  toggleMute() {
    if (this.mutedVolume === null) {
      this.mutedVolume = this.volume;
      this.setVolume(0);
    } else {
      const restore = this.mutedVolume;
      this.mutedVolume = null;
      this.setVolume(restore);
    }
    return this.isMuted;
  }

  /** Release every timer and child process. Safe to call repeatedly. */
  dispose() {
    this.#teardown();
    this.#setState(STATES.IDLE);
    this.removeAllListeners();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.emit('stateChange', { state, previous, track: this.track });
  }

  #beginSegment(offset) {
    this.baseOffset = offset;
    this.segmentStart = Date.now();
    this.frozenElapsed = offset;
  }

  #spawnBackend(startAt) {
    if (this.silent) {
      this.#armSilentEndTimer(startAt);
      return;
    }

    const generation = ++this.generation;
    const args = this.backend.buildArgs({
      file: this.track.path,
      startAt,
      volume: this.volume,
      track: this.track,
    });

    let child;
    try {
      child = spawn(this.backend.executable || this.backend.command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.#handleSpawnFailure(error);
      return;
    }

    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.stderr?.on('error', () => {});

    child.on('error', (error) => {
      if (generation !== this.generation) return;
      this.#handleSpawnFailure(error);
    });

    child.on('exit', (code, signal) => {
      if (generation !== this.generation) return; // superseded by a newer spawn
      this.child = null;

      // SIGTERM/SIGKILL means we asked for it; SIGSTOP never reaches here.
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return;

      if (code !== 0 && code !== null) {
        this.lastError = stderr.trim() || `${this.backend.label} exited with code ${code}`;
        this.#setState(STATES.STOPPED);
        this.emit('error', new Error(this.lastError));
        return;
      }

      this.frozenElapsed = this.track?.duration ?? this.elapsed;
      this.#setState(STATES.STOPPED);
      this.emit('end', this.track);
    });
  }

  #handleSpawnFailure(error) {
    const message =
      error.code === 'ENOENT'
        ? `Audio backend "${this.backend?.command}" is not installed or not on PATH.`
        : `Failed to start ${this.backend?.label || 'audio backend'}: ${error.message}`;
    this.lastError = message;
    this.child = null;
    this.#clearEndTimer();
    this.#setState(STATES.STOPPED);
    this.emit('error', new Error(message));
  }

  /** Silent mode has no process, so a timer stands in for the track ending. */
  #armSilentEndTimer(startAt) {
    this.#clearEndTimer();
    const duration = this.track?.duration;
    if (!duration || duration <= 0) return;
    const remaining = Math.max(0, duration - startAt) * 1000;
    // Deliberately not unref'd: in silent mode this timer *is* the playback,
    // so it has to hold the event loop open just like a child process would.
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.frozenElapsed = duration;
      this.#setState(STATES.STOPPED);
      this.emit('end', this.track);
    }, remaining);
  }

  #clearEndTimer() {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  #signalChild(signal) {
    if (!this.child || this.child.exitCode !== null) return false;
    try {
      this.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  #killChild() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      // A stopped process must be continued before it can act on SIGTERM.
      if (process.platform !== 'win32') child.kill('SIGCONT');
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1500);
      hardKill.unref?.();
      child.once('exit', () => clearTimeout(hardKill));
    } catch {
      /* already gone */
    }
  }

  /** Drop the current process and all pending timers without changing state. */
  #teardown() {
    this.generation += 1;
    this.#clearEndTimer();
    clearTimeout(this.volumeTimer);
    this.volumeTimer = null;
    this.#killChild();
  }
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(100, Math.max(0, number)));
}
