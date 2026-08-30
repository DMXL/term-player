import { call, SpotifyError } from './spotify/client.js';
import * as local from './spotify/local.js';
import { ASSUMED_CELL_RATIO, measureCells } from './tui/screen.js';

/**
 * Checks that the sources the console depends on still answer the way it reads
 * them. The Web API half moved under everyone in February 2026, so the point of
 * this is to find out from Spotify rather than from the documentation, which
 * has been contradicting itself.
 *
 * One call each, no loops, because development mode's rate limit is the low tier.
 */

type Status = 'ok' | 'gone' | 'error';

const results: { status: Status; label: string; detail: string }[] = [];

function record(status: Status, label: string, detail: string): void {
  results.push({ status, label, detail });
}

async function check(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    record('ok', label, await fn());
  } catch (error) {
    if (error instanceof SpotifyError) {
      const status: Status = error.status === 403 || error.status === 404 ? 'gone' : 'error';
      record(status, label, `${error.status}${error.reason === null ? '' : ` ${error.reason}`}: ${error.message}`);
      return;
    }
    record('error', label, error instanceof Error ? error.message : String(error));
  }
}

interface Track {
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { uri: string; name: string; images: { url: string; width: number }[] };
}

export async function probe(): Promise<void> {
  // The terminal, which decides whether a square cover comes out square.
  await check('terminal: cell ratio', async () => {
    const m = await measureCells(false);
    if (!process.stdout.isTTY) return 'not a terminal, so nothing to ask';
    if (!m.answered) {
      const shown = m.raw.length === 0 ? 'nothing' : JSON.stringify(m.raw);
      return `no usable answer (said ${shown}), falling back to ${ASSUMED_CELL_RATIO}. Covers will have a band under them.`;
    }
    return `${m.ratio.toFixed(3)} tall per wide, measured`;
  });

  // The local half, which owes nothing to the network.
  await check('applescript: running', async () => String(await local.isRunning()));
  await check('applescript: now playing', async () => {
    const t = await local.nowPlaying();
    if (t === null) return 'nothing playing';
    return `${t.name} / ${t.artist} at ${t.position.toFixed(1)}s of ${(t.duration / 1000).toFixed(0)}s, ${t.state}`;
  });

  // The Web API half, one call per question.
  await check('GET /me', async () => {
    const me = await call<{ display_name: string; id: string; product?: string }>('/me');
    return `${me?.display_name} (${me?.id}) product=${me?.product ?? 'field removed'}`;
  });

  await check('GET /me/player', async () => {
    const p = await call<{ is_playing: boolean; item: Track | null; device: { name: string; type: string } }>(
      '/me/player',
    );
    if (p === null) return 'no active device (204)';
    const album = p.item?.album;
    return `device=${p.device.name} (${p.device.type}) album_uri=${album?.uri ?? 'ABSENT'} images=${album?.images.length ?? 0}`;
  });

  await check('GET /me/player/queue', async () => {
    const q = await call<{ currently_playing: Track | null; queue: Track[] }>('/me/player/queue');
    if (q === null) return 'empty (204)';
    const names = q.queue.slice(0, 3).map((t) => t.name);
    return `depth=${q.queue.length} first=[${names.join(', ')}]`;
  });

  // Library, where February 2026 replaced the per type endpoints with one.
  const uri = (await local.nowPlaying())?.uri ?? null;
  const id = uri === null ? null : uri.split(':').pop()!;

  await check('GET /me/library/contains (new)', async () => {
    if (uri === null) return 'skipped, nothing playing';
    const r = await call<boolean[]>('/me/library/contains', { query: { uris: uri } });
    return `saved=${JSON.stringify(r)}`;
  });

  await check('GET /me/tracks/contains (old)', async () => {
    if (id === null) return 'skipped, nothing playing';
    const r = await call<boolean[]>('/me/tracks/contains', { query: { ids: id } });
    return `saved=${JSON.stringify(r)}`;
  });

  await check('GET /me/tracks (saved, limit 1)', async () => {
    const r = await call<{ total: number }>('/me/tracks', { query: { limit: 1 } });
    return `total=${r?.total}`;
  });

  await check('GET /me/playlists (limit 1)', async () => {
    const r = await call<{ total: number; items: { name: string }[] }>('/me/playlists', { query: { limit: 1 } });
    return `total=${r?.total} first=${r?.items[0]?.name ?? 'none'}`;
  });

  await check('GET /search (limit 10)', async () => {
    const r = await call<{ tracks: { items: Track[]; total: number } }>('/search', {
      query: { q: 'kiefer', type: 'track', limit: 10 },
    });
    return `returned=${r?.tracks.items.length} total=${r?.tracks.total}`;
  });

  const width = Math.max(...results.map((r) => r.label.length));
  const mark = { ok: 'ok  ', gone: 'GONE', error: 'FAIL' };
  for (const r of results) {
    process.stdout.write(`${mark[r.status]}  ${r.label.padEnd(width)}  ${r.detail}\n`);
  }

  const bad = results.filter((r) => r.status !== 'ok').length;
  process.stdout.write(`\n${results.length - bad} of ${results.length} answered as expected.\n`);
}

