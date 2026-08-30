import type { QueueItem, Snapshot } from '../core/model.js';
import { EMPTY } from '../core/model.js';
import { call, NotSignedIn, SpotifyError } from './client.js';
import * as local from './local.js';

/**
 * Joins the two channels into the one shape the view reads.
 *
 * The division of labour is the point. The desktop app is asked on every tick
 * because it costs nothing, and the Web API is asked only when the track
 * changes or the user acts, because Development Mode sits on the low rate limit
 * tier and a per second poll would spend it on nothing.
 */

/** All Spotify will report, so a full queue means there is more it is not saying. */
const QUEUE_CAP = 20;

interface ApiTrack {
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { uri: string };
}

export class Session {
  /** The track the network half was last fetched for, so it refetches only on change. */
  private fetchedFor: string | null = null;
  private queue: QueueItem[] = [];
  private saved: boolean | null = null;
  private albumUri: string | null = null;
  private notice: string | null = null;
  private inFlight = false;

  /**
   * Reads the player, and brings the network half along if it is still current.
   * Never throws: a channel that fails becomes a notice on the screen, because
   * a console that vanishes on a refused request is worse than one that says so.
   */
  async snapshot(): Promise<Snapshot> {
    const now = await local.nowPlaying();

    if (now === null) {
      const running = await local.isRunning();
      return {
        ...EMPTY,
        notice: running ? null : 'Spotify is not running.',
      };
    }

    if (now.uri !== this.fetchedFor) {
      this.fetchedFor = now.uri;
      // Stale for one frame at most, and the alternative is blocking the tick.
      void this.refresh(now.uri);
    }

    return {
      track: {
        uri: now.uri,
        name: now.name,
        artist: now.artist,
        album: now.album,
        albumUri: this.albumUri,
        artworkUrl: now.artworkUrl,
        duration: now.duration,
      },
      state: now.state,
      position: now.position,
      queue: this.queue,
      saved: this.saved,
      queueTruncated: this.queue.length >= QUEUE_CAP,
      notice: this.notice,
    };
  }

  /** Forces the network half to be asked again, which is what `r` is wired to. */
  async refreshNow(): Promise<void> {
    if (this.fetchedFor !== null) await this.refresh(this.fetchedFor);
  }

  private async refresh(uri: string): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const [queue, saved, album] = await Promise.all([
        this.readQueue(),
        this.readSaved(uri),
        this.readAlbumUri(),
      ]);
      this.queue = queue;
      this.saved = saved;
      this.albumUri = album;
      this.notice = null;
    } catch (error) {
      this.notice = describe(error);
    } finally {
      this.inFlight = false;
    }
  }

  private async readQueue(): Promise<QueueItem[]> {
    const body = await call<{ queue: ApiTrack[] }>('/me/player/queue');
    return (body?.queue ?? []).map((t) => ({
      uri: t.uri,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      duration: t.duration_ms,
    }));
  }

  private async readSaved(uri: string): Promise<boolean> {
    const body = await call<boolean[]>('/me/library/contains', { query: { uris: uri } });
    return body?.[0] ?? false;
  }

  /**
   * The album URI is the one thing here that has to come over the network, since
   * the scripting dictionary offers an album name and no identifier at all.
   */
  private async readAlbumUri(): Promise<string | null> {
    const body = await call<{ item: ApiTrack | null }>('/me/player');
    return body?.item?.album?.uri ?? null;
  }

  /**
   * Flips the saved state, and answers what it became.
   *
   * The URIs go in the query string. A JSON body is refused with "Missing
   * required field: uris", which reads like the body was the intended shape and
   * is not, so this is worth leaving written down.
   */
  async toggleSaved(uri: string): Promise<boolean> {
    const next = !(this.saved ?? false);
    await call('/me/library', {
      method: next ? 'PUT' : 'DELETE',
      query: { uris: uri },
    });
    this.saved = next;
    return next;
  }

  get album(): string | null {
    return this.albumUri;
  }
}

function describe(error: unknown): string {
  if (error instanceof NotSignedIn) return 'Not signed in. Run `spot login <client-id>`.';
  if (error instanceof SpotifyError) {
    if (error.reason === 'PREMIUM_REQUIRED') return 'That needs Spotify Premium.';
    if (error.status === 429) return 'Spotify is rate limiting. Backing off.';
    if (error.status === 401) return 'The session expired. Run `spot login` again.';
    return `Spotify said ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
