/**
 * What the view is handed, and the only vocabulary it knows.
 *
 * Both channels write into this shape, so nothing downstream can tell whether a
 * field arrived over AppleScript or over the network, and nothing downstream
 * needs to.
 */

export type PlayerState = 'playing' | 'paused' | 'stopped';

export interface Track {
  /** A `spotify:track:...` URI. */
  uri: string;
  name: string;
  /** Already joined. The local channel hands over one text field, not a list. */
  artist: string;
  album: string;
  /** Absent until the Web API has been asked, since AppleScript has no album URI. */
  albumUri: string | null;
  artworkUrl: string;
  /** Milliseconds, despite the scripting dictionary calling this seconds. */
  duration: number;
}

export interface QueueItem {
  uri: string;
  name: string;
  artist: string;
  /** Milliseconds. */
  duration: number;
}

export interface Snapshot {
  /** Null when Spotify is not running, or is running with nothing loaded. */
  track: Track | null;
  state: PlayerState;
  /** Seconds, fractional, straight off the desktop app. */
  position: number;
  queue: QueueItem[];
  /** Null while unknown, which is the state before the first library call lands. */
  saved: boolean | null;
  /** Set when something went wrong. Replaces the action bar, because it needs reading. */
  notice: string | null;
  /**
   * Why the queue is empty, when there is a reason worth giving.
   *
   * This belongs in the list rather than the action bar. It explains a space on
   * the screen rather than reporting a failure, and it can stand for a whole
   * track, which is far too long for the keys to lose their place.
   */
  queueNote: string | null;
}

export const EMPTY: Snapshot = {
  track: null,
  state: 'stopped',
  position: 0,
  queue: [],
  saved: null,
  notice: null,
  queueNote: null,
};
