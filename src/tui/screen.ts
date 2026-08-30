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

export class Screen {
  private restored = false;
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
