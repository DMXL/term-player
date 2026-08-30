import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ESC, type Rgb } from './ansi.js';

const run = promisify(execFile);

/**
 * Cover art: fetching it, taking a colour off it, and drawing it inline where
 * the terminal can show a real image.
 *
 * Nothing here decodes a JPEG. `sips` ships with macOS and will resample to a
 * single pixel, and a one pixel BMP has its colour at a documented offset with
 * no decoding at all, which is how the palette is found for the cost of one
 * short process.
 */

export interface Cover {
  /** The average colour of the whole cover, which seeds the palette. */
  seed: Rgb;
  /** Base64 JPEG, ready to hand to a terminal that draws images. */
  data: string;
}

export type Protocol = 'iterm' | 'kitty' | 'none';

export function protocol(): Protocol {
  const term = process.env['TERM'] ?? '';
  const program = process.env['TERM_PROGRAM'] ?? '';

  if (term === 'xterm-kitty' || process.env['KITTY_WINDOW_ID'] !== undefined) return 'kitty';
  if (program === 'iTerm.app' || program === 'WezTerm') return 'iterm';
  return 'none';
}

const dir = join(tmpdir(), 'term-spotify-art');

/**
 * Covers are immutable at their URL, so one that has been fetched once is read
 * off disk forever after. Skipping back and forth between two tracks therefore
 * costs nothing after the first pass.
 */
export async function cover(url: string): Promise<Cover | null> {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const image = join(dir, `${key}.jpg`);

  try {
    await mkdir(dir, { recursive: true });

    let bytes: Buffer;
    try {
      bytes = await readFile(image);
    } catch {
      const res = await fetch(url);
      if (!res.ok) return null;
      bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(image, bytes);
    }

    return { seed: await seedOf(image, key), data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

async function seedOf(image: string, key: string): Promise<Rgb> {
  const pixel = join(dir, `${key}.bmp`);
  try {
    await readFile(pixel);
  } catch {
    await run('sips', ['-s', 'format', 'bmp', '--resampleHeightWidth', '1', '1', image, '--out', pixel]);
  }

  const bmp = await readFile(pixel);
  // Bytes 10 to 13 hold the offset of the pixel array, and a 24 bit BMP stores
  // it as blue, green, red rather than the other way round.
  const at = bmp.readUInt32LE(10);
  return { r: bmp[at + 2] ?? 0, g: bmp[at + 1] ?? 0, b: bmp[at] ?? 0 };
}

/**
 * Draws the cover at a given cell size. The caller has already worked out both,
 * from the rows it can spare and the measured shape of a cell, so a square cover
 * is asked for in a box that is as near square as the terminal could describe.
 */
export function draw(data: string, cols: number, rows: number, how: Protocol): string {
  // Both dimensions in cells, and no preserving of the aspect ratio.
  //
  // Any mismatch between the shape of the box and the shape of the cover has to
  // go somewhere. Preserve the ratio and it goes into a band of background along
  // whichever edge has the slack, which is what showed up first underneath and
  // then down the side. Filling the box instead puts it into the picture, where
  // being a couple of percent wide is not something anyone will catch.
  //
  // Leaving a dimension out is not the escape it looks like. Unspecified means
  // `auto`, and auto is the cover's own pixel size rather than a width worked
  // out from the height, so the box came out as wide as the JPEG and the slack
  // simply moved to the right.
  if (how === 'iterm') {
    return `${ESC}]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=0:${data}${'\x07'}`;
  }

  if (how === 'kitty') {
    // The payload goes in 4096 byte chunks, with m=1 on every chunk but the last.
    const CHUNK = 4096;
    let out = '';
    for (let i = 0; i < data.length; i += CHUNK) {
      const piece = data.slice(i, i + CHUNK);
      const last = i + CHUNK >= data.length;
      const head = i === 0 ? `a=T,f=100,c=${cols},r=${rows},` : '';
      out += `${ESC}_G${head}m=${last ? 0 : 1};${piece}${ESC}\\`;
    }
    return out;
  }

  return '';
}
