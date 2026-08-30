import type { PlayerState, QueueItem, Snapshot } from '../core/model.js';
import { EMPTY } from '../core/model.js';
import { call, NotSignedIn, SpotifyError } from './client.js';
import * as local from './local.js';

/**
 * Joins the two channels into the one shape the view reads.
 *
 * The division of labour is the point. The desktop app is asked on every tick
 * because it costs nothing, and the Web API is asked only when something has
 * happened that could have changed its answer, because Development Mode sits on
 * the low rate limit tier and a per second poll would spend it on nothing.
 */

/** All Spotify will report, so a full queue means there is more it is not saying. */
const QUEUE_CAP = 20;

/** First wait before retrying a queue that came back empty or unanswered. */
const RETRY_MS = 3_000;
const RETRY_CEILING_MS = 30_000;

interface ApiTrack {
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { uri: string };
}

export class Session {
  private fetchedFor: string | null = null;
  private fetchedState: PlayerState | null = null;
  private queue: QueueItem[] = [];
  private saved: boolean | null = null;
  private albumUri: string | null = null;
  private notice: string | null = null;
  private inFlight = false;

  /**
   * Set whenever the network half has nothing to show, whether because it
   * failed or because Spotify had no answer. Without this a queue that came
   * back empty once would stay empty for the whole track, since the only other
   * trigger is the track changing.
   */
  private stale = true;
  private nextTry = 0;
  private backoff = RETRY_MS;

  /**
   * Reads the player, and brings the network half along if it is still current.
   * Never throws: a channel that fails becomes a notice on the screen, because
   * a console that vanishes on a refused request is worse than one that says so.
   */
  async snapshot(): Promise<Snapshot> {
    const now = await local.nowPlaying();

    if (now === null) {
      const running = await local.isRunning();
      return { ...EMPTY, notice: running ? null : 'Spotify is not running.' };
    }

    const changed = now.uri !== this.fetchedFor;
    // Pausing lets Spotify drop the device, and playing brings it back, so the
    // queue is worth asking for again on either. This is what makes pressing
    // play recover a console that started against a sleeping device.
    const moved = now.state !== this.fetchedState;
    const due = this.stale && Date.now() >= this.nextTry;

    if (changed || moved || due) {
      this.fetchedFor = now.uri;
      this.fetchedState = now.state;
      // Stale for one frame at most, and the alternative is blocking the tick.
      void this.refresh(now.uri, !changed);
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
    if (this.fetchedFor === null) return;
    this.backoff = RETRY_MS;
    await this.refresh(this.fetchedFor, false);
  }

  /**
   * `queueOnly` keeps a retry down to the one call that was missing, rather than
   * spending three on a saved state and an album URI that have not changed.
   */
  private async refresh(uri: string, queueOnly: boolean): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const queue = await this.readQueue();

      if (!queueOnly) {
        const [saved, album] = await Promise.all([this.readSaved(uri), this.readAlbumUri()]);
        this.saved = saved;
        this.albumUri = album;
      }

      if (queue === null) {
        // Spotify answered 204, which it does when no device is currently
        // holding the playback. The local channel still knows the track, so the
        // screen keeps everything but the list.
        this.queue = [];
        this.notice = 'Spotify has no active device for the queue. Press play to wake it.';
        this.hold();
      } else {
        this.queue = queue;
        this.notice = null;
        if (queue.length === 0) this.hold();
        else this.settle();
      }
    } catch (error) {
      this.notice = describe(error);
      this.hold();
    } finally {
      this.inFlight = false;
    }
  }

  /** Nothing usable came back, so try again later, and less often each time. */
  private hold(): void {
    this.stale = true;
    this.nextTry = Date.now() + this.backoff;
    this.backoff = Math.min(RETRY_CEILING_MS, this.backoff * 2);
  }

  private settle(): void {
    this.stale = false;
    this.backoff = RETRY_MS;
  }

  /** Null when Spotify answered 204, which is not the same as an empty queue. */
  private async readQueue(): Promise<QueueItem[] | null> {
    const body = await call<{ queue: ApiTrack[] }>('/me/player/queue');
    if (body === null) return null;
    return (body.queue ?? []).map((t) => ({
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
    return body?.item?.album?.uri ?? this.albumUri;
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
