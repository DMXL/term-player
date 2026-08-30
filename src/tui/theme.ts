import { contrastAgainst, darken, lighten, luminance, mix, type Rgb } from './ansi.js';

/**
 * The palette is taken from the cover, so the console changes colour with the
 * music. Everything here is derived from one seed, which keeps the screen
 * coherent no matter what the cover happens to be.
 */

export interface Palette {
  ground: Rgb;
  text: Rgb;
  muted: Rgb;
  accent: Rgb;
  /** The played portion of the progress bar, and the save mark when set. */
  bright: Rgb;
  /** The unplayed portion, and rules. */
  track: Rgb;
}

/** Used before a cover has been read, and whenever one cannot be. */
export const SEED: Rgb = { r: 88, g: 74, b: 102 };

/**
 * Spotify's brand green, for the saved dot. Fixed rather than derived from
 * the cover, because the mark is a Spotify UI element and should read as one
 * no matter what the record looks like.
 */
export const SPOTIFY_GREEN: Rgb = { r: 29, g: 185, b: 84 };

export function paletteFrom(seed: Rgb): Palette {
  // A near black ground keeps the terminal feeling like a terminal, but holding
  // the cover's hue in it is what makes the screen belong to the record.
  const ground = darken(seed, 0.86);

  // A washed out cover would give a grey accent, so the seed is pushed back
  // toward its own hue before anything is derived from it.
  const saturated = saturate(seed, 0.35);

  return {
    ground,
    text: contrastAgainst(lighten(saturated, 0.82), ground, 0.62),
    muted: contrastAgainst(mix(saturated, ground, 0.45), ground, 0.22),
    accent: contrastAgainst(lighten(saturated, 0.42), ground, 0.34),
    bright: contrastAgainst(lighten(saturated, 0.7), ground, 0.55),
    track: mix(ground, lighten(saturated, 0.3), 0.28),
  };
}

/** Pulls a colour away from its own grey, leaving the hue where it was. */
function saturate(c: Rgb, amount: number): Rgb {
  const grey = luminance(c) * 255;
  return {
    r: clamp(grey + (c.r - grey) * (1 + amount * 3)),
    g: clamp(grey + (c.g - grey) * (1 + amount * 3)),
    b: clamp(grey + (c.b - grey) * (1 + amount * 3)),
  };
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

export const DEFAULT_PALETTE = paletteFrom(SEED);
