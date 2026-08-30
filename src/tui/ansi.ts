/**
 * Escape sequences, written out rather than pulled from a library, because the
 * console needs precise cursor control and truecolor and nothing else.
 */

export const ESC = '\x1b';

export const altScreen = (on: boolean): string => `${ESC}[?1049${on ? 'h' : 'l'}`;
export const cursorVisible = (on: boolean): string => `${ESC}[?25${on ? 'h' : 'l'}`;
export const clearScreen = `${ESC}[2J`;
export const clearBelow = `${ESC}[0J`;
export const clearLine = `${ESC}[2K`;
export const home = `${ESC}[H`;

/** One based, matching the terminal rather than the array it came from. */
export const moveTo = (row: number, col = 1): string => `${ESC}[${row};${col}H`;

export const reset = `${ESC}[0m`;
export const bold = `${ESC}[1m`;
export const dim = `${ESC}[2m`;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const fg = ({ r, g, b }: Rgb): string => `${ESC}[38;2;${r};${g};${b}m`;
export const bg = ({ r, g, b }: Rgb): string => `${ESC}[48;2;${r};${g};${b}m`;

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** Toward black. `amount` of 0 leaves the colour alone, 1 makes it black. */
export function darken(c: Rgb, amount: number): Rgb {
  const k = 1 - amount;
  return { r: clamp(c.r * k), g: clamp(c.g * k), b: clamp(c.b * k) };
}

/** Toward white, on the same scale. */
export function lighten(c: Rgb, amount: number): Rgb {
  return {
    r: clamp(c.r + (255 - c.r) * amount),
    g: clamp(c.g + (255 - c.g) * amount),
    b: clamp(c.b + (255 - c.b) * amount),
  };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: clamp(a.r + (b.r - a.r) * t),
    g: clamp(a.g + (b.g - a.g) * t),
    b: clamp(a.b + (b.b - a.b) * t),
  };
}

/** Rec. 709 luminance, 0 to 1, used to decide which way a colour has to move. */
export function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Pushes a colour away from a background until it is legible against it. Album
 * art averages toward the muddy middle, so an accent taken straight off the
 * cover is often unreadable on a background taken from the same cover.
 */
export function contrastAgainst(colour: Rgb, ground: Rgb, target = 0.45): Rgb {
  const groundLum = luminance(ground);
  let out = colour;
  for (let i = 0; i < 24; i += 1) {
    if (Math.abs(luminance(out) - groundLum) >= target) break;
    out = groundLum < 0.5 ? lighten(out, 0.08) : darken(out, 0.08);
  }
  return out;
}
