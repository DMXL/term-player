import type { PlayerState, QueueItem, Snapshot, Track } from '../../core/model.js';
import { EMPTY } from '../../core/model.js';
import type { Player } from '../../core/player.js';
import { dailyMix, dislike, like, NeteaseError, next as nextTrack, pause, play, prev as prevTrack, queueAdd, resume, stop, type Song } from './client.js';
import * as local from './local.js';

/**
 * Joins the two ncm-cli channels into the one shape the view reads.
 *
 * The live mpv process is read on every tick because it costs nothing, and the
 * NetEase API is asked exactly once, at cold start, to fetch the daily mix.
 * term-player keeps that list in memory, because there is no per song command
 * that would let it re read the artist, album or artwork later, so a track
 * played outside the daily mix can only be described by the `state` title.
 */

/** How many songs to pull from the daily mix, which ncm-cli caps at 40. */
const COLD_START_LIMIT = 30;

/** How many upcoming songs to hand to the view at once. */
const MAX_QUEUE = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The uri is `encryptedId:originalId`, opaque to the view and split back here. */
function uriOf(song: Song): string {
  return `${song.id}:${song.originalId}`;
}

function artistsOf(song: Song): string {
  const list = song.fullArtists !== undefined && song.fullArtists.length > 0 ? song.fullArtists : song.artists;
  return list.map((a) => a.name).join(', ');
}

function toTrack(song: Song): Track {
  return {
    uri: uriOf(song),
    name: song.name,
    artist: artistsOf(song),
    album: song.album?.name ?? '',
    // The album is not targetable from the CLI, so there is no URI to hand over.
    albumUri: null,
    artworkUrl: song.coverImgUrl.replace(/^http:/, 'https:'),
    duration: song.duration,
  };
}

function toQueueItem(song: Song): QueueItem {
  return {
    uri: uriOf(song),
    name: song.name,
    artist: artistsOf(song),
    duration: song.duration,
    disabled: song.playFlag === false,
  };
}

/** `state` has no `paused` value, so paused is read from a retained queue. */
function stateOf(st: local.NcmState): PlayerState {
  if (st.status === 'playing') return 'playing';
  return st.queueLength > 0 ? 'paused' : 'stopped';
}

/** Splits `state.title`'s `"<name> - <artist>"` into its halves. */
function splitTitle(title: string): { name: string; artist: string } {
  const i = title.indexOf(' - ');
  if (i === -1) return { name: title, artist: '' };
  return { name: title.slice(0, i), artist: title.slice(i + 3) };
}

export class Session implements Player {
  /** The daily mix in play order, including the songs that cannot be played. */
  private playlist: Song[] = [];
  /** The daily mix keyed by encrypted id, for looking up the live queue. */
  private byId = new Map<string, Song>();
  /** The one time mix fetch, memoized so concurrent ticks share it. */
  private mixPromise: Promise<Song[]> | null = null;
  /** Whether the one time start has run, or been decided against. */
  private started = false;
  private coldStartInFlight = false;
  private notice: string | null = null;
  /** The last seen play state, so play/pause knows which way to toggle. */
  private lastState: PlayerState = 'stopped';

  /** Fetches the daily mix once and fills both lookups, without ever throwing. */
  private loadMix(force = false): Promise<Song[]> {
    if (this.mixPromise === null) {
      this.mixPromise = dailyMix(COLD_START_LIMIT, force)
        .then((songs) => {
          this.playlist = songs;
          this.byId = new Map(songs.map((song) => [song.id, song]));
          // Only playable songs go into the live queue. The unplayable ones stay
          // on screen, greyed, but ncm-cli would skip them, so they are not queued.
          const playable = songs.filter((song) => song.playFlag !== false);
          if (playable.length === 0) this.notice = 'NetEase gave no playable daily mix.';
          return playable;
        })
        .catch((error: unknown) => {
          this.notice = describe(error);
          return [] as Song[];
        });
    }
    return this.mixPromise;
  }

  /**
   * Reads the player and, on the first sight of nothing playing, loads the
   * daily mix. Never throws: a failed channel becomes a notice, because a
   * console that vanishes on a refused request is worse than one that says so.
   */
  async snapshot(): Promise<Snapshot> {
    const st = await local.state();

    if (st === null) {
      return { ...EMPTY, notice: 'NetEase is not reachable. Is ncm-cli installed?' };
    }

    this.lastState = stateOf(st);

    // The one time start is building the queue, so hold the loading state until
    // it finishes rather than let the list appear one song at a time.
    if (this.coldStartInFlight) {
      return { ...EMPTY, notice: 'Loading your daily mix…' };
    }

    if (st.queueLength === 0) {
      if (!this.started) {
        this.coldStartInFlight = true;
        void this.coldStart();
      }
      return this.started
        ? { ...EMPTY, notice: this.notice ?? 'Nothing playing.' }
        : { ...EMPTY, notice: 'Loading your daily mix…' };
    }

    // A queue that outlived the last session still needs its metadata, which a
    // fresh session has not fetched yet. Load it before resolving, so a stale
    // queue can be told apart from a current one.
    if (this.byId.size === 0) await this.loadMix();

    // Unplayable songs are dropped from the queue as ncm-cli builds it, so the
    // `currentIndex` from `state` cannot be trusted to line up with the daily
    // mix. The persisted queue carries the reliable id, so resolve the current
    // song through it rather than by position.
    const entries = await local.queue();
    if (entries === null) return this.degraded(st);

    const currentEntry = entries[st.currentIndex];
    const currentId = currentEntry?.encryptedId ?? '';
    const current = currentId !== '' ? this.byId.get(currentId) : undefined;

    if (current === undefined) {
      // The queue's current song is not in today's mix, so it is a leftover
      // from an earlier session. Clear it and start the mix fresh.
      this.coldStartInFlight = true;
      this.started = false;
      void this.coldStart(true);
      return { ...EMPTY, notice: 'Loading your daily mix…' };
    }

    this.started = true;

    // The display queue is the daily mix in order, with unplayable songs greyed
    // in place. The live queue only holds the playable ones, so the window is
    // positioned from the current song's place in the full list instead.
    const pos = this.playlist.findIndex((song) => song.id === current.id);
    const queue = pos >= 0 ? this.playlist.slice(pos + 1, pos + 1 + MAX_QUEUE).map(toQueueItem) : [];
    const track = toTrack(current);

    return {
      track: {
        ...track,
        // The live length wins when it is present, since it is the honest one.
        duration: st.duration !== null ? st.duration * 1000 : track.duration,
      },
      state: stateOf(st),
      position: st.position,
      queue,
      saved: current.liked,
      notice: this.notice,
      queueNote: null,
    };
  }

  /** The fallback when the queue cannot be read: describe the title alone. */
  private degraded(st: local.NcmState): Snapshot {
    const { name, artist } = st.title === null ? { name: '', artist: '' } : splitTitle(st.title);
    return {
      track: {
        uri: st.title ?? 'netease:unknown',
        name,
        artist,
        album: '',
        albumUri: null,
        artworkUrl: '',
        duration: (st.duration ?? 0) * 1000,
      },
      state: stateOf(st),
      position: st.position,
      queue: [],
      saved: null,
      notice: this.notice,
      queueNote: 'Played outside the daily mix, so its details are not known.',
    };
  }

  /** Clears the cached mix and rebuilds the queue from a fresh fetch. */
  async refreshNow(): Promise<void> {
    this.mixPromise = null; // forget the cached fetch, so it is asked again
    this.started = false;
    this.coldStartInFlight = true;
    void this.coldStart(true, true);
  }

  /** Flips the heart, and answers what it became. Only the daily mix is known. */
  async toggleSaved(uri: string): Promise<boolean> {
    const encryptedId = uri.split(':')[0]!;
    const song = this.byId.get(encryptedId);
    if (song === undefined) {
      throw new NeteaseError('That track is not from the daily mix, so it cannot be saved.');
    }
    const next = !song.liked;
    if (next) await like(encryptedId);
    else await dislike(encryptedId);
    song.liked = next;
    return next;
  }

  /** The album is not targetable from the CLI, and albumUri is always null. */
  async openAlbum(_uri: string): Promise<void> {}

  /** Toggles play and pause from the last state the tick saw. */
  async playPause(): Promise<void> {
    if (this.lastState === 'playing') await pause();
    else await resume();
  }

  async next(): Promise<void> {
    await nextTrack();
  }

  async previous(): Promise<void> {
    await prevTrack();
  }

  /**
   * Loads the daily mix and leaves it queued but not playing.
   *
   * `queue add` refuses to run until there is a playback process, so the first
   * song is played and paused again before the rest are queued. Pausing up front
   * keeps the queue building silent: the whole list is committed to memory first,
   * so a tick landing mid start already renders the right tracks, while the
   * slower queue append runs in the background on a paused player. When
   * `stopFirst` is set a leftover queue is cleared before rebuilding.
   */
  private async coldStart(stopFirst = false, force = false): Promise<void> {
    try {
      if (stopFirst) await stop();
      const songs = await this.loadMix(force);
      if (songs.length === 0) {
        this.started = true;
        return;
      }
      await this.startFirst(songs[0]!);
      await pause();
      for (const song of songs.slice(1)) {
        await queueAdd(song);
      }
      this.started = true;
    } catch (error) {
      this.notice = describe(error);
      this.started = true;
    } finally {
      this.coldStartInFlight = false;
    }
  }

  /**
   * Starts the first song, polling for a title rather than trusting the play
   * result. ncm-cli's play gives up after three seconds, but its daemon can take
   * that long just to resolve the song's URL, so a silent failure would leave
   * the transport keys pointing at an empty player. A title appearing is the one
   * signal the song actually loaded.
   */
  private async startFirst(song: Song): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await play(song);
      for (let i = 0; i < 6; i += 1) {
        await sleep(1000);
        const st = await local.state();
        if (st !== null && st.title !== null) return;
      }
    }
    throw new NeteaseError('NetEase would not start playing.');
  }
}

function describe(error: unknown): string {
  if (error instanceof NeteaseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
