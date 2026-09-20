/**
 * Interactive application: wires the playlist, the playback engine, the
 * renderer and the keyboard together, and owns the terminal lifecycle.
 */

import readline from 'node:readline';
import { Player, STATES } from './player.js';
import { Playlist } from './playlist.js';
import { Renderer } from './ui.js';
import { actionForKey, normaliseKey } from './keymap.js';
import { scanLibrary } from './library.js';
import { formatTime, pluralize } from './format.js';
import { glyphs, style } from './theme.js';

const SEEK_STEP = 5;
const SEEK_STEP_BIG = 30;
const VOLUME_STEP = 5;
const RESTART_THRESHOLD = 3; // seconds after which "previous" restarts instead
const FRAME_INTERVAL = 250;
const STATUS_TIMEOUT = 4000;

export class App {
  /**
   * @param {object}   options
   * @param {object[]} options.tracks
   * @param {object}   [options.backend] backend descriptor, or null for silent mode
   * @param {string}   [options.musicDir] folder rescanned by the refresh key
   * @param {boolean}  [options.silent] simulate playback with no audio device
   * @param {boolean}  [options.shuffle]
   * @param {'off'|'all'|'one'} [options.repeat]
   * @param {number}   [options.volume]
   * @param {number}   [options.startIndex]
   * @param {boolean}  [options.autoplay]
   * @param {boolean}  [options.interactive] false renders plain log output
   */
  constructor({
    tracks = [],
    backend = null,
    musicDir = null,
    silent = false,
    shuffle = false,
    repeat = 'off',
    volume = 80,
    startIndex = 0,
    autoplay = true,
    interactive = true,
    stdin = process.stdin,
    stdout = process.stdout,
  } = {}) {
    this.musicDir = musicDir;
    this.backend = backend;
    this.silent = silent;
    this.autoplay = autoplay;
    this.interactive = interactive && Boolean(stdin.isTTY && stdout.isTTY);
    this.stdin = stdin;
    this.stdout = stdout;

    this.playlist = new Playlist(tracks, { shuffle, repeat });
    this.player = new Player({ backend, volume, silent });
    this.renderer = new Renderer({ stream: stdout });

    this.view = 'player';
    this.cursor = 0;
    this.scrollTop = 0;
    this.status = null;
    this.statusTimer = null;
    this.frameTimer = null;
    this.running = false;
    this.exitCode = 0;

    if (startIndex > 0) this.playlist.jumpTo(startIndex);
    this.cursor = Math.max(0, this.playlist.position);

    this.#bindPlayerEvents();
    this.onKeypress = this.onKeypress.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onSignal = this.onSignal.bind(this);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /** Run until the user quits or the queue finishes. Resolves with an exit code. */
  async run() {
    this.running = true;

    if (this.playlist.isEmpty) {
      this.#log(style.brightYellow('No songs to play.'));
      this.running = false;
      return 1;
    }

    this.#attachTerminal();

    if (this.autoplay) {
      this.playCurrent();
    } else {
      this.setStatus('Press space to start playing', 'info');
      this.render();
    }

    await new Promise((resolve) => {
      this.finish = resolve;
    });

    this.#detachTerminal();
    return this.exitCode;
  }

  /** Quit cleanly: stop audio, restore the terminal and resolve run(). */
  quit(code = 0) {
    if (!this.running) return;
    this.running = false;
    this.exitCode = code;
    this.player.dispose();
    this.finish?.();
  }

  #attachTerminal() {
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);

    if (!this.interactive) return;

    this.renderer.start();
    readline.emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.onKeypress);
    this.stdout.on('resize', this.onResize);

    this.frameTimer = setInterval(() => this.render(), FRAME_INTERVAL);
  }

  #detachTerminal() {
    clearInterval(this.frameTimer);
    clearTimeout(this.statusTimer);
    this.frameTimer = null;

    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);

    if (!this.interactive) return;

    this.stdin.off('keypress', this.onKeypress);
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.renderer.stop();
  }

  onSignal() {
    this.quit(0);
  }

  onResize() {
    this.renderer.invalidate();
    this.render();
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  render() {
    if (!this.running || !this.interactive) return;
    const model = {
      player: this.player,
      playlist: this.playlist,
      backend: this.backend,
      silent: this.silent,
      cursor: this.cursor,
      scrollTop: this.scrollTop,
      view: this.view,
      status: this.status,
      musicDir: this.musicDir,
    };
    this.renderer.draw(model);
    this.scrollTop = model.scrollTop; // the renderer clamps it to the viewport
  }

  /** Show a transient message under the playlist. */
  setStatus(text, level = 'info') {
    this.status = { text, level };
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.status = null;
      this.render();
    }, STATUS_TIMEOUT);
    this.statusTimer.unref?.();
    this.render();
  }

  /** Plain output used when there is no TTY to draw on. */
  #log(line) {
    if (this.interactive) return;
    this.stdout.write(`${line}\n`);
  }

  /* ---------------------------------------------------------------- *
   * Playback control
   * ---------------------------------------------------------------- */

  playCurrent({ startAt = 0 } = {}) {
    const track = this.playlist.current();
    if (!track) return false;
    this.cursor = Math.max(0, this.playlist.position);
    this.player.play(track, { startAt });
    this.#log(
      `${style.brightGreen(glyphs.playing)} ${this.playlist.displayPosition}/${this.playlist.length}  ` +
        `${style.bold(track.title)} ${style.gray(`— ${track.artist} (${formatTime(track.duration)})`)}`,
    );
    this.render();
    return true;
  }

  next({ auto = false } = {}) {
    const track = this.playlist.next({ auto });
    if (!track) {
      this.player.stop();
      this.setStatus('End of playlist', 'info');
      this.#log(style.gray('End of playlist.'));
      if (!this.interactive) this.quit(0);
      return false;
    }
    return this.playCurrent();
  }

  previous() {
    // Mirrors every other music player: rewind first, skip back only if the
    // track has barely started.
    if (this.player.isActive && this.player.elapsed > RESTART_THRESHOLD) {
      if (this.player.canSeek) {
        this.player.seek(0);
        this.setStatus('Restarted track', 'info');
        return true;
      }
      return this.playCurrent();
    }
    this.playlist.previous();
    return this.playCurrent();
  }

  #bindPlayerEvents() {
    this.player.on('end', () => {
      if (!this.running) return;
      this.next({ auto: true });
    });

    this.player.on('error', (error) => {
      this.setStatus(error.message, 'error');
      this.#log(style.brightRed(`Playback error: ${error.message}`));
      if (!this.interactive) this.quit(1);
    });

    this.player.on('notice', ({ message, level }) => this.setStatus(message, level));
    this.player.on('stateChange', () => this.render());
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  onKeypress(str, key = {}) {
    if (!this.running) return;

    // Any key closes the help overlay.
    if (this.view === 'help') {
      const action = actionForKey(str, key);
      this.view = 'player';
      this.renderer.invalidate();
      if (action === 'quit') this.quit(0);
      else this.render();
      return;
    }

    const action = actionForKey(str, key);
    if (!action) return;
    this.dispatch(action, { str, key });
  }

  /**
   * Run a named action. Exposed separately from key handling so tests (and any
   * future remote control) can drive the player without synthetic keypresses.
   */
  dispatch(action, { str = '', key = {} } = {}) {
    switch (action) {
      case 'toggle-pause': {
        if (this.player.state === STATES.STOPPED || this.player.state === STATES.IDLE) {
          this.playCurrent();
        } else {
          this.player.togglePause();
          this.setStatus(this.player.isPaused ? 'Paused' : 'Playing', 'info');
        }
        break;
      }
      case 'stop':
        this.player.stop();
        this.setStatus('Stopped', 'info');
        break;
      case 'next':
        this.next();
        break;
      case 'previous':
        this.previous();
        break;
      case 'restart':
        if (this.player.canSeek && this.player.isActive) this.player.seek(0);
        else this.playCurrent();
        this.setStatus('Restarted track', 'info');
        break;

      case 'seek-forward':
        this.#seekBy(SEEK_STEP);
        break;
      case 'seek-back':
        this.#seekBy(-SEEK_STEP);
        break;
      case 'seek-forward-big':
        this.#seekBy(SEEK_STEP_BIG);
        break;
      case 'seek-back-big':
        this.#seekBy(-SEEK_STEP_BIG);
        break;

      case 'volume-up':
        this.player.adjustVolume(VOLUME_STEP);
        this.setStatus(`Volume ${this.player.volume}%`, 'info');
        break;
      case 'volume-down':
        this.player.adjustVolume(-VOLUME_STEP);
        this.setStatus(`Volume ${this.player.volume}%`, 'info');
        break;
      case 'mute':
        this.player.toggleMute();
        this.setStatus(this.player.isMuted ? 'Muted' : `Volume ${this.player.volume}%`, 'info');
        break;

      case 'cursor-up':
        this.#moveCursor(-1);
        break;
      case 'cursor-down':
        this.#moveCursor(1);
        break;
      case 'page-up':
        this.#moveCursor(-10);
        break;
      case 'page-down':
        this.#moveCursor(10);
        break;
      case 'play-selected': {
        const entry = this.playlist.entries()[this.cursor];
        if (entry) {
          this.playlist.jumpTo(entry.trackIndex);
          this.playCurrent();
        }
        break;
      }
      case 'jump-number': {
        const number = Number(normaliseKey(str, key));
        if (Number.isInteger(number) && number >= 1 && number <= this.playlist.length) {
          const entry = this.playlist.entries()[number - 1];
          if (entry) {
            this.playlist.jumpTo(entry.trackIndex);
            this.playCurrent();
          }
        } else {
          this.setStatus(`There is no song ${number}`, 'warn');
        }
        break;
      }

      case 'shuffle': {
        const enabled = this.playlist.toggleShuffle();
        this.cursor = Math.max(0, this.playlist.position);
        this.setStatus(enabled ? 'Shuffle on' : 'Shuffle off', 'info');
        break;
      }
      case 'repeat': {
        const mode = this.playlist.cycleRepeat();
        this.setStatus(`Repeat ${mode}`, 'info');
        break;
      }

      case 'help':
        this.view = this.view === 'help' ? 'player' : 'help';
        this.renderer.invalidate();
        this.render();
        break;
      case 'refresh':
        this.refresh();
        break;
      case 'quit':
        this.quit(0);
        break;
      default:
        break;
    }
  }

  #seekBy(delta) {
    if (!this.player.isActive) return;
    if (!this.player.canSeek) {
      this.setStatus(
        `${this.backend?.label || 'This backend'} cannot seek — install mpv or ffmpeg for seeking.`,
        'warn',
      );
      return;
    }
    this.player.seekBy(delta);
    this.setStatus(`${delta > 0 ? 'Forward' : 'Back'} ${Math.abs(delta)}s`, 'info');
  }

  #moveCursor(delta) {
    const size = this.playlist.length;
    if (size === 0) return;
    this.cursor = Math.min(size - 1, Math.max(0, this.cursor + delta));
    this.render();
  }

  /** Rescan the music folder and merge the result into the queue. */
  async refresh() {
    if (!this.musicDir) {
      this.setStatus('Nothing to rescan (playing an explicit file list)', 'warn');
      return;
    }
    this.setStatus('Rescanning…', 'info');
    try {
      const tracks = await scanLibrary(this.musicDir);
      this.playlist.replace(tracks);
      this.cursor = Math.max(0, this.playlist.position);
      this.setStatus(`Found ${pluralize(tracks.length, 'song')}`, 'info');
    } catch (error) {
      this.setStatus(`Rescan failed: ${error.message}`, 'error');
    }
    this.render();
  }
}
