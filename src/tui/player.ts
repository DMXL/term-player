import { clock, pad, truncate, widthOf } from '../core/format.js';
import type { Snapshot } from '../core/model.js';
import { bg, bold, clearLine, dim, fg, moveTo, reset } from './ansi.js';
import type { Palette } from './theme.js';
import { SPOTIFY_GREEN } from './theme.js';
import { ASSUMED_CELL_RATIO, type Size } from './screen.js';

/**
 * The screen, as one place that decides what goes where.
 *
 * Nothing in here knows which channel filled the snapshot. It is handed a track
 * and a queue and lays them out, which is what lets the cheap local read and the
 * expensive network read change independently of the picture.
 */

const MARGIN = 2;

/** The rows that are always there, whatever the window does. */
const CHROME = 9;

/** Below this the cover is dropped, because a list you can read beats a picture you cannot. */
const MIN_COVER = 4;
const MAX_COVER = 14;
const MIN_QUEUE = 3;

export interface Layout {
  /** Rows given to the cover, or 0 when there is no room for one. */
  cover: number;
  /** One based row where the cover starts. */
  coverRow: number;
  coverCols: number;
  titleRow: number;
  queueRow: number;
  queueRows: number;
  actionRow: number;
  inner: number;
  left: number;
}

export function layout({ cols, rows }: Size, ratio = ASSUMED_CELL_RATIO): Layout {
  const inner = Math.max(10, cols - MARGIN * 2);

  let cover = Math.min(MAX_COVER, rows - CHROME - MIN_QUEUE - 1);
  if (cover < MIN_COVER) cover = 0;
  // A square cover needs as many columns as the cell ratio says, not a guessed
  // two, and it still has to fit across.
  if (cover > 0 && cover * ratio > inner) cover = Math.floor(inner / ratio);
  if (cover < MIN_COVER) cover = 0;

  const after = cover > 0 ? cover + 1 : 0;
  const titleRow = 2 + after;

  return {
    cover,
    coverRow: 2,
    coverCols: Math.round(cover * ratio),
    titleRow,
    queueRow: titleRow + 6,
    queueRows: Math.max(0, rows - CHROME - after),
    actionRow: rows,
    inner,
    left: MARGIN + 1,
  };
}

interface Ctx {
  snap: Snapshot;
  palette: Palette;
  size: Size;
  scroll: number;
  showHelp: boolean;
  /** Cell height as a multiple of cell width, measured from the terminal. */
  ratio: number;
}

/** Colour codes only, since nothing handed to `put` carries cursor movement. */
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Writes one row, padded across the full width in the ground colour.
 *
 * Both halves of that matter. The background is set before the line is cleared,
 * because a clear paints with whatever colour is current and would otherwise
 * leave the terminal's own background behind. And the row is padded to the
 * window rather than to its own text, because a short row would otherwise end
 * in a stripe of that same background.
 */
function painter(ctx: Ctx, l: Layout): (row: number, text: string) => string {
  const { palette: p } = ctx;
  const right = Math.max(0, ctx.size.cols - (l.left - 1) - l.inner);

  return (row, text) => {
    const fill = Math.max(0, l.inner - widthOf(text.replace(SGR, '')));
    return (
      moveTo(row, 1) +
      bg(p.ground) +
      clearLine +
      ' '.repeat(l.left - 1) +
      text +
      bg(p.ground) +
      ' '.repeat(fill + right) +
      reset
    );
  };
}

/**
 * The part of the screen that changes as the track plays, drawn by absolute
 * position so the cover above it is never touched and never has to be resent.
 */
export function renderText(ctx: Ctx): string {
  const l = layout(ctx.size, ctx.ratio);
  const { palette: p } = ctx;
  const rows: string[] = [];
  const paint = painter(ctx, l);
  const put = (row: number, text: string): void => {
    rows.push(paint(row, text));
  };

  if (ctx.showHelp) return help(ctx, l);

  if (ctx.snap.track === null) {
    const message = ctx.snap.notice ?? 'Nothing playing. Start something in Spotify.';
    const row = Math.floor(ctx.size.rows / 2);
    put(row, `${fg(p.muted)}${truncate(message, l.inner)}`);
    put(l.actionRow, actions(ctx));
    return rows.join('');
  }

  const t = ctx.snap.track;

  // Title, with the saved dot held against the right edge. Green when saved,
  // a muted hollow circle when not.
  const mark = ctx.snap.saved === true ? '●' : '○';
  const markColour = ctx.snap.saved === true ? SPOTIFY_GREEN : p.muted;
  const title = truncate(t.name, l.inner - 2);
  put(
    l.titleRow,
    `${bold}${fg(p.text)}${pad(title, l.inner - 2)}${reset}${bg(p.ground)}${fg(markColour)} ${mark}`,
  );

  put(l.titleRow + 1, `${fg(p.accent)}${truncate(t.artist, l.inner)}`);
  put(l.titleRow + 2, '');

  // The rule that would say "Queue" carries the clock instead.
  const elapsed = clock(ctx.snap.position * 1000);
  const total = clock(t.duration);
  const gap = Math.max(1, l.inner - widthOf(elapsed) - widthOf(total));
  put(l.titleRow + 3, `${fg(p.muted)}${elapsed}${' '.repeat(gap)}${total}`);
  put(l.titleRow + 4, bar(ctx, l));
  put(l.titleRow + 5, '');

  // Queue.
  const list = queueLines(ctx, l);
  for (let i = 0; i < l.queueRows; i += 1) {
    put(l.queueRow + i, list[i] ?? '');
  }

  put(l.actionRow - 1, '');
  put(l.actionRow, actions(ctx));
  return rows.join('');
}

function bar(ctx: Ctx, l: Layout): string {
  const { palette: p, snap } = ctx;
  const duration = snap.track?.duration ?? 0;
  const fraction = duration > 0 ? Math.min(1, (snap.position * 1000) / duration) : 0;
  const filled = Math.round(l.inner * fraction);
  return `${fg(p.bright)}${'━'.repeat(filled)}${fg(p.track)}${'━'.repeat(Math.max(0, l.inner - filled))}`;
}

function queueLines(ctx: Ctx, l: Layout): string[] {
  const { palette: p, snap } = ctx;

  if (snap.queue.length === 0) {
    // The reason goes where the list would have been, so the keys keep the bar.
    return [`${fg(p.muted)}${dim}${truncate(snap.queueNote ?? 'Nothing queued.', l.inner)}`];
  }

  const times = snap.queue.map((item) => clock(item.duration));
  const timeCol = Math.max(...times.map((time) => widthOf(time)));
  const textCol = Math.max(4, l.inner - timeCol - 2);

  const lines = snap.queue.map((item, i) => {
    // Right aligned inside the widest time in the list, or an hour long track
    // further down would pull every shorter row out of true.
    const time = times[i]!.padStart(timeCol, ' ');
    const name = item.name;
    const joiner = ` ${'•'} `;
    // The name gets whatever the artists do not need, but never less than half.
    const nameRoom = Math.max(Math.floor(textCol / 2), textCol - widthOf(item.artist) - widthOf(joiner));
    const shownName = truncate(name, nameRoom);
    const artistRoom = textCol - widthOf(shownName) - widthOf(joiner);
    const shownArtist = artistRoom > 0 ? truncate(item.artist, artistRoom) : '';

    const text =
      shownArtist.length > 0
        ? `${fg(p.text)}${shownName}${fg(p.muted)}${joiner}${fg(p.accent)}${shownArtist}`
        : `${fg(p.text)}${shownName}`;
    const used = widthOf(shownName) + (shownArtist.length > 0 ? widthOf(joiner) + widthOf(shownArtist) : 0);

    return `${text}${bg(ctx.palette.ground)}${' '.repeat(Math.max(1, l.inner - used - timeCol))}${fg(p.muted)}${time}`;
  });

  return lines.slice(ctx.scroll, ctx.scroll + l.queueRows);
}

function actions(ctx: Ctx): string {
  const { palette: p, snap } = ctx;
  if (snap.notice !== null && snap.track !== null) {
    return `${fg(p.accent)}${truncate(snap.notice, layout(ctx.size, ctx.ratio).inner)}`;
  }

  const keys: [string, string][] = [
    ['f', snap.saved === true ? 'unsave' : 'save'],
    ['a', 'album'],
    ['t', 'track'],
    ['r', 'refresh'],
    ['?', 'keys'],
    ['q', 'quit'],
  ];

  const l = layout(ctx.size, ctx.ratio);
  let out = '';
  let used = 0;
  for (const [key, label] of keys) {
    const piece = `${key} ${label}`;
    if (used + widthOf(piece) + 3 > l.inner) break;
    out += `${fg(p.accent)}${key}${fg(p.muted)} ${label}   `;
    used += widthOf(piece) + 3;
  }
  return out;
}

function help(ctx: Ctx, l: Layout): string {
  const { palette: p } = ctx;
  const entries: [string, string][] = [
    ['f', 'Save the current track, or unsave it'],
    ['a', 'Open the current album in the Spotify app'],
    ['t', 'Open the current track in the Spotify app'],
    ['j k ↑ ↓', 'Scroll the queue'],
    ['g G', 'Jump to the top or bottom of the queue'],
    ['r', 'Refresh the queue and the saved state'],
    ['?', 'Close this'],
    ['q', 'Quit'],
  ];

  const keyCol = Math.max(...entries.map(([k]) => widthOf(k)));
  const top = Math.max(2, Math.floor((ctx.size.rows - entries.length - 4) / 2));
  const rows: string[] = [];
  const paint = painter(ctx, l);
  const put = (row: number, text: string): void => {
    rows.push(paint(row, text));
  };

  for (let row = 1; row <= ctx.size.rows; row += 1) put(row, '');
  put(top, `${bold}${fg(p.text)}Keys`);
  put(top + 1, '');
  entries.forEach(([key, label], i) => {
    put(top + 2 + i, `${fg(p.accent)}${pad(key, keyCol)}${fg(p.muted)}   ${truncate(label, l.inner - keyCol - 3)}`);
  });
  put(
    top + entries.length + 3,
    `${fg(p.track)}${dim}${truncate('Play, pause, next and previous stay on the media keys.', l.inner)}`,
  );
  return rows.join('');
}
