import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Rgb } from './tui/ansi.js';
import type { Palette } from './tui/theme.js';

/**
 * Publishes the console's palette so other terminal apps can wear the same
 * colours as the record that is playing.
 *
 * The channel is one small JSON file, written only when the palette changes
 * (a track change, never a tick) and removed when the console exits. A reader
 * treats the broadcast as live while the file exists and the `pid` in it is
 * still running, which covers a console that died without cleaning up.
 *
 * The shape is documented in the README under "Colour broadcast". Bump
 * `version` for any change a reader would have to know about.
 */

export const BROADCAST_PATH = join(homedir(), '.config', 'term-player', 'palette.json');

export interface Broadcast {
  version: 1;
  pid: number;
  updatedAt: string;
  /** The console's background, the one colour most readers want. */
  ground: string;
  palette: Record<keyof Palette, string>;
}

const hex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** Off when `TERM_PLAYER_BROADCAST` is `0`, `off` or `false`. On otherwise. */
export function enabled(): boolean {
  const flag = (process.env['TERM_PLAYER_BROADCAST'] ?? '').toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(flag);
}

export class Broadcaster {
  private last: string | null = null;
  private registered = false;

  constructor(private readonly path = BROADCAST_PATH) {}

  publish(palette: Palette): void {
    const ground = hex(palette.ground);
    if (ground === this.last) return;

    const body: Broadcast = {
      version: 1,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ground,
      palette: {
        ground,
        text: hex(palette.text),
        muted: hex(palette.muted),
        accent: hex(palette.accent),
        bright: hex(palette.bright),
        track: hex(palette.track),
      },
    };

    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Written aside and renamed into place, so a reader never sees half a file.
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
      renameSync(tmp, this.path);
      this.last = ground;
    } catch {
      // A colour is never worth interrupting the music over.
      return;
    }

    if (!this.registered) {
      this.registered = true;
      // `exit` runs for `q`, the signals and a crash alike, since each of them
      // leaves through `process.exit`.
      process.on('exit', () => this.withdraw());
    }
  }

  /** Removes the file, but only when it is still ours and not a newer console's. */
  withdraw(): void {
    try {
      const current = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Broadcast>;
      if (current.pid === process.pid) unlinkSync(this.path);
    } catch {
      // Already gone, or never written.
    }
    this.last = null;
  }
}
