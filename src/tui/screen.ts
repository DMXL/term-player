import { altScreen, clearScreen, cursorVisible, home, reset } from './ansi.js';

/**
 * Owns the terminal for as long as the console runs, and hands it back intact
 * however the process ends. A half restored terminal after a crash is worse
 * than the crash, so the teardown is registered before anything is changed.
 */

export interface Size {
  cols: number;
  rows: number;
}

export type Key =
  | { name: 'char'; value: string }
  | { name: 'up' | 'down' | 'left' | 'right' | 'escape' | 'enter' | 'quit' };

/** What a cell's height is as a multiple of its width, when nothing better is known. */
export const ASSUMED_CELL_RATIO = 2;

export class Screen {
  private restored = false;
  private measuring = false;
  private readonly onKeyHandlers: ((key: Key) => void)[] = [];
  private readonly onResizeHandlers: (() => void)[] = [];

  constructor(private readonly out = process.stdout) {}

  get size(): Size {
    return { cols: this.out.columns || 80, rows: this.out.rows || 24 };
  }

  start(): void {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        this.stop();
        process.exit(0);
      });
    }
    process.on('exit', () => this.stop());
    process.on('uncaughtException', (error) => {
      this.stop();
      process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
      process.exit(1);
    });

    this.out.write(altScreen(true) + cursorVisible(false) + clearScreen + home);

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => this.decode(chunk));
    this.out.on('resize', () => {
      for (const handler of this.onResizeHandlers) handler();
    });
  }

  stop(): void {
    if (this.restored) return;
    this.restored = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.out.write(reset + cursorVisible(true) + altScreen(false));
  }

  /**
   * Asks the terminal how big a cell actually is, so a square cover can be
   * given a square box.
   *
   * Assuming a cell is exactly twice as tall as it is wide is close but wrong,
   * and the error shows: a terminal that draws images keeps the aspect ratio and
   * anchors at the top, so the slack collects as a band along the bottom of the
   * cover. Fonts differ, so this has to be measured rather than guessed.
   *
   * `CSI 14 t` answers with the window in pixels and `CSI 18 t` with it in
   * cells. A terminal that supports neither simply says nothing, which is why
   * this gives up quickly and falls back.
   */
  async cellRatio(): Promise<number> {
    this.measuring = true;
    try {
      return (await measureCells(true, this.out)).ratio;
    } finally {
      this.measuring = false;
    }
  }

  onKey(handler: (key: Key) => void): void {
    this.onKeyHandlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.onResizeHandlers.push(handler);
  }

  write(frame: string): void {
    this.out.write(frame);
  }

  private emit(key: Key): void {
    for (const handler of this.onKeyHandlers) handler(key);
  }

  /**
   * A paste or a fast repeat arrives as several keys in one chunk, so the
   * buffer is walked rather than matched once.
   */
  private decode(chunk: Buffer): void {
    // A size reply is not a keystroke, and would otherwise arrive as a burst of
    // stray characters the moment the console starts.
    if (this.measuring) return;
    const text = chunk.toString('utf8');

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;

      if (ch === '\x03' || ch === '\x04') {
        this.emit({ name: 'quit' });
        continue;
      }

      if (ch === '\x1b') {
        const next = text.slice(i + 1, i + 3);
        const arrow = { '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left' } as const;
        const found = arrow[next as keyof typeof arrow];
        if (found !== undefined) {
          this.emit({ name: found });
          i += 2;
          continue;
        }
        this.emit({ name: 'escape' });
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        this.emit({ name: 'enter' });
        continue;
      }

      this.emit({ name: 'char', value: ch });
    }
  }
}

export interface CellMeasurement {
  /** Cell height as a multiple of cell width. */
  ratio: number;
  /** True when the terminal actually replied, rather than the fallback being used. */
  answered: boolean;
  /** Exactly what came back, so a reply in an unexpected shape can be read. */
  raw: string;
}

/**
 * Asks the terminal how big a cell actually is, so a square cover can be given
 * a square box.
 *
 * Assuming a cell is exactly twice as tall as it is wide is close but wrong,
 * and the error shows: a terminal that draws images keeps the aspect ratio and
 * anchors at the top, so the slack collects as a band along the bottom of the
 * cover. Fonts differ, so this has to be measured rather than guessed.
 *
 * `CSI 14 t` answers with the window in pixels and `CSI 18 t` with it in cells.
 * A terminal that supports neither says nothing at all, which is why this gives
 * up quickly and falls back.
 */
export async function measureCells(
  rawAlreadyOn: boolean,
  out: NodeJS.WriteStream = process.stdout,
): Promise<CellMeasurement> {
  const fallback: CellMeasurement = { ratio: ASSUMED_CELL_RATIO, answered: false, raw: '' };
  if (!process.stdin.isTTY || !out.isTTY) return fallback;

  const own = !rawAlreadyOn;
  if (own) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  try {
    return await new Promise<CellMeasurement>((resolve) => {
      let seen = '';
      let done = false;

      const finish = (result: CellMeasurement): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        process.stdin.off('data', listen);
        resolve(result);
      };

      const listen = (chunk: Buffer): void => {
        seen += chunk.toString('latin1');
        const px = /\x1b\[4;(\d+);(\d+)t/.exec(seen);
        const cells = /\x1b\[8;(\d+);(\d+)t/.exec(seen);
        if (px === null || cells === null) return;

        const [height, width] = [Number(px[1]), Number(px[2])];
        const [rows, cols] = [Number(cells[1]), Number(cells[2])];
        if (rows < 1 || cols < 1 || height < 1 || width < 1) {
          finish({ ...fallback, raw: seen });
          return;
        }

        const ratio = height / rows / (width / cols);
        // A plausible cell is somewhere near twice as tall as wide. Anything
        // outside that means the reply was not what it looked like.
        const sane = ratio > 1.2 && ratio < 3.5;
        finish({ ratio: sane ? ratio : ASSUMED_CELL_RATIO, answered: sane, raw: seen });
      };

      const timer = setTimeout(() => finish({ ...fallback, raw: seen }), 300);
      process.stdin.on('data', listen);
      out.write('\x1b[14t\x1b[18t');
    });
  } finally {
    if (own) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}
