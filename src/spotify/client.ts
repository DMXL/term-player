import { appendFile } from 'node:fs/promises';
import { clientId, readTokens, refresh, type Tokens } from './auth.js';

/**
 * The Web API half of the console. It is deliberately thin: the player bar is
 * read locally over AppleScript, so what goes over the network is only what
 * AppleScript has no words for, which is the queue and the saved state.
 */

const BASE = 'https://api.spotify.com/v1';

/** Refresh this far before expiry, so a call never races the clock. */
const EARLY_MS = 60_000;

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
}

export class NotSignedIn extends Error {
  constructor() {
    super('Not signed in. Run `spot login <client-id>` first.');
    this.name = 'NotSignedIn';
  }
}

let cached: Tokens | null = null;

async function accessToken(): Promise<string> {
  const id = await clientId();
  if (id === null) throw new NotSignedIn();

  cached ??= await readTokens();
  if (cached === null) throw new NotSignedIn();

  if (Date.now() >= cached.expiresAt - EARLY_MS) {
    cached = await refresh(id, cached);
  }
  return cached.access;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export async function call<T>(path: string, options: CallOptions = {}): Promise<T | null> {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = res.status === 204 ? '' : await res.text();

  // `SPOT_DEBUG=<file>` appends every exchange, which is the only way to catch
  // an answer that is wrong rather than absent, since it is gone by the time
  // anyone can look at the screen.
  const log = process.env['SPOT_DEBUG'];
  if (log !== undefined && log.length > 0) {
    const line = `${new Date().toISOString()} ${options.method ?? 'GET'} ${url.pathname}${url.search} -> ${res.status} ${text}\n`;
    await appendFile(log, line).catch(() => {
      // Diagnostics must never take the console down with them.
    });
  }

  // The player endpoints answer 204 when there is simply nothing playing, which
  // is an ordinary state and not a failure.
  if (res.status === 204) return null;
  if (!res.ok) {
    let reason: string | null = null;
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; reason?: string } };
      reason = parsed.error?.reason ?? null;
      message = parsed.error?.message ?? text;
    } catch {
      // Not JSON, so the raw body is the best message available.
    }
    throw new SpotifyError(res.status, reason, message);
  }

  return text.length === 0 ? null : (JSON.parse(text) as T);
}
