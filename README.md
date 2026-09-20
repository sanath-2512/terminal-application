# Terminal Music Player

[![CI](https://github.com/sanath-2512/terminal-application/actions/workflows/ci.yml/badge.svg)](https://github.com/sanath-2512/terminal-application/actions/workflows/ci.yml)

A music player that lives entirely in your terminal. Built with Node.js and no
runtime dependencies — play, pause, stop, seek and navigate a whole folder of
music without leaving the command line.

```
  ♪ TERMINAL MUSIC PLAYER                                                mpv

  ▶  Neon Alley                                                          3/6
     Terminal Waves ♪ Public Domain Demos

  0:17  ━━━━━━━━━━━━━━━━━━━━━━━━●───────────────────────────────────  0:40

  PLAYING   ███████░░░  70%   ⇄ shuffle   ↺ repeat all

  PLAYLIST  6 songs · 4:16 total
      1. Night Drive                            Terminal Waves            0:41
      2. Copper Sky                             Terminal Waves            0:42
    ▶ 3. Neon Alley                             Terminal Waves            0:40
  ❯   4. Paper Boats                            Terminal Waves            0:42
      5. Signal Lost                            Terminal Waves            0:44
      6. First Light                            Terminal Waves            0:45

  space play/pause · n next · p prev · s stop · ? help · q quit
```

**Six original demo tracks are included**, so you can clone the repo and hear
something immediately — see [The songs folder](#the-songs-folder).

---

## Features

- **Full transport control** — play, pause, resume, stop, next, previous, restart
- **Seeking** — jump forward and back by 5 or 30 seconds
- **Volume and mute**, with a live meter
- **Shuffle** and **repeat** (off / all / one)
- **Live progress bar** with elapsed and total time
- **Browsable playlist** — move the selection, press enter to play, or hit `1`–`9`
- **Reads real metadata** — ID3v2/ID3v1 tags and durations parsed straight from
  the file bytes, for MP3, WAV, FLAC and Ogg
- **Works with whatever audio tool you have** — mpv, ffplay, mpg123, afplay,
  VLC, SoX, PulseAudio, ALSA, or Windows Media via PowerShell
- **Zero runtime dependencies** — everything above is plain Node.js
- **Rescan on the fly** with `F5` when you add new files
- **Degrades gracefully** — no colour when piped, ASCII when the terminal can't
  do Unicode, and a `--silent` mode for machines with no sound card at all

## Requirements

- **Node.js 18 or newer**
- **One command line audio player.** The app finds whichever you have:

  | Platform | Install one of these |
  |----------|----------------------|
  | Linux    | `sudo apt install mpv` · `ffmpeg` · `mpg123` · `vlc` · `sox` · `alsa-utils` |
  | macOS    | `afplay` is already built in — nothing to do |
  | Windows  | Built-in PowerShell playback works; `winget install mpv` is better |

Run `npm run doctor` to see what was detected.

## Install

```bash
git clone https://github.com/sanath-2512/terminal-application.git
cd terminal-application
npm install          # only needed to regenerate the demo songs
```

There are no runtime dependencies, so `npm install` is optional unless you want
to re-render the demo tracks.

Optionally put it on your `PATH`:

```bash
npm link
music-player --help
```

## Quick start

```bash
npm start                      # play everything in ./songs
npm start -- ~/Music           # play your own folder
npm start -- --shuffle         # shuffle the queue
npm run list                   # print the queue and exit
npm run doctor                 # show detected audio backends
```

Or call the binary directly:

```bash
node bin/music-player.js ~/Music --shuffle --volume 60
```

## Controls

| Key | Action | | Key | Action |
|-----|--------|-|-----|--------|
| <kbd>space</kbd> | Play / pause      | | <kbd>↑</kbd> <kbd>↓</kbd> | Move selection |
| <kbd>n</kbd>     | Next song         | | <kbd>enter</kbd>          | Play selected song |
| <kbd>p</kbd>     | Previous song     | | <kbd>1</kbd>–<kbd>9</kbd> | Jump to that song |
| <kbd>s</kbd>     | Stop and rewind   | | <kbd>x</kbd>              | Toggle shuffle |
| <kbd>0</kbd>     | Restart this song | | <kbd>r</kbd>              | Repeat off / all / one |
| <kbd>←</kbd> <kbd>→</kbd> | Seek ±5s | | <kbd>+</kbd> <kbd>-</kbd> | Volume up / down |
| <kbd>shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> | Seek ±30s | | <kbd>m</kbd> | Mute |
| <kbd>?</kbd>     | Help              | | <kbd>F5</kbd>             | Rescan the folder |
| <kbd>q</kbd>     | Quit              | | <kbd>esc</kbd> <kbd>ctrl</kbd>+<kbd>c</kbd> | Quit |

<kbd>j</kbd> / <kbd>k</kbd> also move the selection, for vim fingers.

Pressing <kbd>p</kbd> more than three seconds into a song restarts it instead of
skipping back — the same behaviour as every other music player.

## Command line options

```
music-player [options] [files or folders...]

  -d, --dir <path>      Folder to play (default: ./songs)
  -l, --list            List the songs that would be played, then exit
  -t, --track <n>       Start at song number n
  -s, --shuffle         Shuffle the queue
  -r, --repeat <mode>   Repeat mode: off | all | one (default: off)
  -v, --volume <0-100>  Starting volume (default: 80)
  -b, --backend <id>    Force an audio backend (mpv, ffplay, mpg123, ...)
      --silent          Simulate playback with no audio device (for testing)
      --no-autoplay     Start paused instead of playing immediately
      --doctor          Show which audio backends are installed, then exit
  -h, --help            Show help
      --version         Print the version
```

The music folder is resolved in this order: positional arguments → `--dir` →
`$MUSIC_PLAYER_DIR` → `./songs`.

Supported formats: `.mp3`, `.wav`, `.flac`, `.ogg`, `.oga`, `.m4a`, `.aac`,
`.opus`, `.wma` (whatever your backend can actually decode).

## The songs folder

`songs/` holds six original instrumental tracks that ship with the project.
They are **synthesised from scratch by this repository** — oscillators, a
Karplus-Strong plucked string, drum voices and a feedback reverb, all rendered
offline in pure JavaScript by `scripts/generate-songs.js`. No sampled or
third-party material is involved, and they are released into the **public domain
(CC0)**, so they are safe to commit, share and screenshot.

Rendering is deterministic — the same seed always produces identical audio:

```bash
npm run generate-songs -- --force          # re-render all six as MP3
node scripts/generate-songs.js --format wav
node scripts/generate-songs.js --only night-drive
```

To use your own music, drop files into `songs/` and press <kbd>F5</kbd>, or just
point the player somewhere else: `npm start -- ~/Music`.

See [`songs/README.md`](songs/README.md) for the track list and details.

## How it works

The problem this project set out to solve was *CLI development, file handling
and process management*. Each one maps to a part of the codebase:

**CLI development** — `src/cli.js` parses arguments with `node:util`'s
`parseArgs`. `src/ui.js` composes every frame into a single string and writes it
in one call to avoid flicker, drawing on the alternate screen buffer so your
scrollback survives. `src/keymap.js` is the single source of truth for key
bindings: both the dispatcher and the on-screen help are generated from it, so
they cannot drift apart.

**File handling** — `src/library.js` walks the music folder and
`src/metadata.js` reads durations and tags directly from the container headers:
MPEG frame headers with Xing/VBRI support for MP3, RIFF chunks for WAV,
STREAMINFO for FLAC, and Ogg page granule positions. Only the few kilobytes that
matter are read, never the whole file, so scanning a large library stays fast.

**Process management** — Node cannot open a sound card, so `src/player.js`
spawns an external audio tool as a child process and controls it:

| Action | How |
|--------|-----|
| Play   | `spawn()` the backend with the file and a start offset |
| Pause  | `SIGSTOP` the child — instant, and the decoder keeps its state |
| Resume | `SIGCONT` |
| Stop   | `SIGCONT` then `SIGTERM`, with a `SIGKILL` fallback after 1.5s |
| Seek   | Kill and re-spawn at the new offset |
| End of track | The child exits with code 0, which triggers auto-advance |

Windows has no `SIGSTOP`, so there the player stops the process and remembers
the position, then re-spawns at that offset on resume. A generation counter
guards every exit handler, so events from a superseded process are ignored
rather than being mistaken for a track ending. Elapsed time is tracked from
wall-clock segments rather than by asking the backend, which means it behaves
identically no matter which tool is driving the audio.

### Project layout

```
bin/music-player.js      Executable entry point
src/
  cli.js                 Argument parsing, --list and --doctor
  app.js                 Wires playlist + player + renderer + keyboard
  player.js              Playback engine and child process control
  playlist.js            Queue model: shuffle, repeat, navigation
  library.js             Folder scanning and track records
  metadata.js            Duration and tag parsing (MP3/WAV/FLAC/Ogg)
  backends.js            Audio backend detection and argument building
  ui.js                  Terminal renderer
  keymap.js              Key bindings (drives dispatch and help)
  format.js              Time, width and progress bar helpers
  theme.js               Colours and glyphs, with graceful degradation
scripts/
  generate-songs.js      Renders the demo album
  lib/synth.js           Oscillators, envelopes, drums, effects
  lib/compose.js         Turns a song spec into audio
  lib/encode.js          WAV, MP3 and ID3 tag writing
songs/                   The demo album (CC0) — and your music
test/                    Unit tests (node:test)
```

## Testing

```bash
npm test
```

147 tests cover the playlist rules, the transport state machine, metadata
parsing (including a full encode → tag → read round trip), backend selection and
argument building, terminal rendering at several sizes and in colour, key
dispatch and the CLI.

The process management is tested against **real child processes**: instead of an
audio tool, the engine is pointed at a short-lived `node -e` process, so
spawning, `SIGSTOP` pausing, `SIGCONT` resuming, `SIGTERM` stopping and
exit-code handling are all exercised for real — no sound card required.

The executable itself is tested too, including that piping into `head` does not
crash it and that output drops colour when it is not going to a terminal.

The playback engine has a `--silent` mode that simulates playback with timers
instead of a child process, so the whole player can be exercised on a machine
with no audio hardware:

```bash
node bin/music-player.js --silent
```

## Troubleshooting

**"No audio backend found"** — install one of the tools listed by
`npm run doctor`. On Ubuntu/Debian, `sudo apt install mpv` is the easiest.

**Seeking does nothing** — `afplay`, `aplay` and `paplay` cannot start part-way
through a file. Install `mpv` or `ffmpeg` for seek support; the player tells you
when the current backend can't do it.

**The interface looks like mojibake** — set `MUSIC_PLAYER_ASCII=1` to force
plain ASCII glyphs.

**No colour** — colour turns itself off when output is piped. Force it back on
with `FORCE_COLOR=1`, or off with `NO_COLOR=1`.

**Nothing plays but there are no errors** — check your system volume and try
`npm run doctor` to confirm which backend is in use, then test it directly, e.g.
`mpv songs/*.mp3`.

## Author

Built by [sanath-2512](https://github.com/sanath-2512).

## License

[MIT](LICENSE) for the code. The demo tracks in `songs/` are public domain (CC0).
