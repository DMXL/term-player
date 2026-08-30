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
  private queueNote: string | null = null;
  private inFlight = false;
  private repeating = false;

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
      this.repeating = now.repeating;
      void this.refresh(now.uri, !changed, now.repeating);
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
      queueNote: this.queueNote,
    };
  }

  /** Forces the network half to be asked again, which is what `r` is wired to. */
  async refreshNow(): Promise<void> {
    if (this.fetchedFor === null) return;
    this.backoff = RETRY_MS;
    await this.refresh(this.fetchedFor, false, this.repeating);
  }

  /**
   * `queueOnly` keeps a retry down to the one call that was missing, rather than
   * spending three on a saved state and an album URI that have not changed.
   */
  private async refresh(uri: string, queueOnly: boolean, repeating: boolean): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // The player is read alongside the queue because it is the only honest
      // signal about the device. The queue endpoint answers 200 with an empty
      // list when there is nothing to ask, so on its own it cannot tell a
      // sleeping device from a playlist that has run out.
      const [raw, player] = await Promise.all([this.readQueue(), this.readPlayer()]);
      if (player.albumUri !== null) this.albumUri = player.albumUri;
      if (!queueOnly) this.saved = await this.readSaved(uri);

      const degenerate = raw !== null && !believable(raw, uri, repeating);

      this.notice = null;

      if (raw !== null && raw.length > 0 && !degenerate) {
        this.queue = raw;
        this.queueNote = null;
        this.settle();
      } else if (degenerate) {
        // Not a hiccup, and asking again will not help. Spotify pads the queue
        // with the current track whenever the context cannot yield a next one,
        // and it answers that way for as long as the context stands. Settling
        // stops the pointless retries; a change of track re-asks on its own.
        this.queue = [];
        this.queueNote = `Spotify reports no queue for this ${player.context ?? 'context'}.`;
        this.settle();
      } else {
        this.queue = [];
        this.queueNote = player.idle ? 'Spotify has no active device. Press play to wake it.' : null;
        this.hold();
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
   * Whether Spotify currently has a device to speak for, and the album URI while
   * we are here, since that is the one thing the scripting dictionary cannot
   * give us and this is the call that carries it.
   *
   * A 204 means no device holds the playback. The local channel still knows the
   * track perfectly well, which is exactly the situation that reads as a bug.
   */
  private async readPlayer(): Promise<{ idle: boolean; albumUri: string | null; context: string | null }> {
    const body = await call<{ item: ApiTrack | null; context: { type: string } | null }>('/me/player');
    if (body === null) return { idle: true, albumUri: null, context: null };
    return {
      idle: false,
      albumUri: body.item?.album?.uri ?? null,
      context: body.context?.type ?? null,
    };
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

/**
 * Whether a queue is worth believing.
 *
 * When the context cannot yield a next track, Spotify pads the queue with the
 * one already playing: ten identical entries where the desktop app is showing a
 * perfectly good list of its own. A single track album does it reliably, and it
 * answers that way for as long as that context stands, so this is a shape to
 * recognise rather than a hiccup to wait out.
 *
 * Nothing in the response admits to it. It is a plain 200, every item carries
 * `type: track`, and the shape is exactly what a real answer looks like, so the
 * only tell is that every entry is the track already playing.
 *
 * Repeat one would produce that same shape honestly, which is why the local
 * channel's repeat flag is what separates a genuine answer from a confused one.
 */
export function believable(queue: QueueItem[], playing: string, repeating: boolean): boolean {
  if (queue.length < 2 || repeating) return true;
  const distinct = new Set(queue.map((item) => item.uri));
  return !(distinct.size === 1 && distinct.has(playing));
}
