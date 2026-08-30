import stringWidth from 'string-width';

/** `3:07`, and `1:02:14` once a track runs past the hour, which podcasts do. */
export function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Cuts to a display width rather than a character count, so a wide glyph or an
 * emoji in a track name cannot push a row past the edge and wrap it.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width === 1) return '…';

  let out = '';
  let used = 0;
  for (const char of text) {
    const w = stringWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/** Pads on the right to a display width. Never truncates, so callers cut first. */
export function pad(text: string, width: number): string {
  const short = width - stringWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

export const widthOf = stringWidth;
