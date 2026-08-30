import type { Snapshot } from './core/model.js';
import { EMPTY } from './core/model.js';
import { bg, clearScreen, fg, home, moveTo, reset } from './tui/ansi.js';
import { cover, draw, protocol, type Cover } from './tui/art.js';
import { layout, renderText } from './tui/player.js';
import { ASSUMED_CELL_RATIO, Screen } from './tui/screen.js';
import { DEFAULT_PALETTE, paletteFrom, type Palette } from './tui/theme.js';
import { Session } from './spotify/session.js';
import * as local from './spotify/local.js';

/**
 * The run loop, and the only place that knows about both halves at once.
 *
 * The cover is expensive to send and never changes within a track, so it is
 * drawn once and then left alone. Everything that moves is repainted by
 * absolute position underneath it, which is why the picture does not flicker
 * once a second.
 */

const TICK_MS = 500;

export async function run(): Promise<number> {
  if (!process.stdout.isTTY) {
    process.stderr.write('The console needs a terminal. Try `spot probe` instead.\n');
    return 1;
  }

  const screen = new Screen();
  const session = new Session();
  const how = protocol();

  let snap: Snapshot = EMPTY;
  let palette: Palette = DEFAULT_PALETTE;
  let art: Cover | null = null;
  let drawnArtFor: string | null = null;
  let ratio = ASSUMED_CELL_RATIO;
  let scroll = 0;
  let showHelp = false;
  let repaint = true;
  let stopped = false;

  const paint = (): void => {
    const size = screen.size;
    const l = layout(size, ratio);

    if (repaint) {
      screen.write(bg(palette.ground) + clearScreen + home);
      drawnArtFor = null;
      repaint = false;
    }

    // The cover is resent only when the record changes, or the window did.
    const want = showHelp || l.cover === 0 ? null : (snap.track?.artworkUrl ?? null);
    if (want !== null && want !== drawnArtFor) {
      const col = l.left + Math.max(0, Math.floor((l.inner - l.coverCols) / 2));
      if (art !== null && how !== 'none') {
        screen.write(moveTo(l.coverRow, col) + draw(art.data, l.coverCols, l.cover, how));
      } else {
        screen.write(block(l.coverRow, col, l.coverCols, l.cover, palette));
      }
      drawnArtFor = want;
    }

    screen.write(renderText({ snap, palette, size, scroll, showHelp, ratio }));
  };

  const tick = async (): Promise<void> => {
    const next = await session.snapshot();
    const changed = next.track?.uri !== snap.track?.uri;
    snap = next;

    if (changed) {
      scroll = 0;
      art = next.track === null ? null : await cover(next.track.artworkUrl);
      palette = art === null ? DEFAULT_PALETTE : paletteFrom(art.seed);
      repaint = true;
    }
    paint();
  };

  screen.onResize(() => {
    repaint = true;
    paint();
  });

  screen.onKey((key) => {
    if (stopped) return;
    void handle(key);
  });

  const handle = async (key: { name: string; value?: string }): Promise<void> => {
    const l = layout(screen.size, ratio);
    const maxScroll = Math.max(0, snap.queue.length + (snap.queueTruncated ? 1 : 0) - l.queueRows);
    const ch = key.name === 'char' ? key.value : undefined;

    if (key.name === 'quit' || ch === 'q') {
      stopped = true;
      screen.stop();
      process.exit(0);
    }

    if (ch === '?' || (showHelp && key.name === 'escape')) {
      showHelp = !showHelp;
      repaint = true;
      paint();
      return;
    }
    if (showHelp) return;

    if (ch === 'j' || key.name === 'down') scroll = Math.min(maxScroll, scroll + 1);
    else if (ch === 'k' || key.name === 'up') scroll = Math.max(0, scroll - 1);
    else if (ch === 'g') scroll = 0;
    else if (ch === 'G') scroll = maxScroll;
    else if (ch === 'r') await session.refreshNow();
    else if (ch === 'a') {
      const album = session.album;
      if (album !== null) await local.open(album);
    } else if (ch === 't') {
      if (snap.track !== null) await local.open(snap.track.uri);
    } else if (ch === 'f') {
      if (snap.track !== null) {
        try {
          snap = { ...snap, saved: await session.toggleSaved(snap.track.uri) };
        } catch {
          snap = { ...snap, notice: 'That save did not take.' };
        }
      }
    } else return;

    paint();
  };

  screen.start();
  // Measured before the first frame, since it decides the cover's shape.
  ratio = await screen.cellRatio();
  await tick();

  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref();

  // The loop is the interval. This never settles, and the process leaves through
  // `q` or a signal, both of which restore the terminal on the way out.
  await new Promise(() => {});
  return 0;
}

/** Stands in for the cover where the terminal cannot draw one. */
function block(row: number, col: number, cols: number, rows: number, palette: Palette): string {
  let out = '';
  for (let i = 0; i < rows; i += 1) {
    out += `${moveTo(row + i, col)}${bg(palette.track)}${fg(palette.track)}${' '.repeat(cols)}${reset}`;
  }
  return out;
}
