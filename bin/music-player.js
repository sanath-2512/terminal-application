#!/usr/bin/env node
/**
 * Executable entry point for the terminal music player.
 *
 * Keeping this file tiny means the interesting code stays importable and
 * testable from src/, and the shebang wrapper does nothing but wire up
 * process-level concerns.
 */

import process from 'node:process';
import { main } from '../src/cli.js';
import { ansi } from '../src/theme.js';

/** Make sure the terminal is usable again no matter how we exit. */
function restoreTerminal() {
  if (process.stdout.isTTY) {
    process.stdout.write(ansi.showCursor + ansi.altScreenOff);
  }
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* stdin already closed */
    }
  }
}

/**
 * Piping into `head`, `less` or any reader that exits early closes stdout
 * under us. That is a normal way for a CLI to be used, not a crash, so the
 * resulting EPIPE is swallowed instead of becoming an unhandled error.
 */
function ignoreEpipe(stream) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') {
      restoreTerminal();
      process.exit(0);
    }
    throw error;
  });
}

ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

process.on('exit', restoreTerminal);

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    restoreTerminal();
    process.stderr.write(`\nmusic-player: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
