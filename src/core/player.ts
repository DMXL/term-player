import type { Snapshot } from './model.js';

/**
 * What the console drives, and what every music player supplies.
 *
 * The view and the run loop speak only this. Each player wires its own source
 * into the same `Snapshot`, so the screen never knows which player is behind
 * it, and a new player means a new implementation of this interface rather than
 * a change anywhere in `tui/`.
 */
export interface Player {
  /** Reads the player now. Never throws: a failed channel becomes a notice. */
  snapshot(): Promise<Snapshot>;

  /** Forces the expensive half to be asked again, which is what `r` is wired to. */
  refreshNow(): Promise<void>;

  /** Flips the current track in or out of the library, and answers what it became. */
  toggleSaved(uri: string): Promise<boolean>;

  /** Opens the album for a URI in the player's own app, where it has one. */
  openAlbum(uri: string): Promise<void>;

  /** Toggles play and pause. */
  playPause(): Promise<void>;

  /** Skips to the next track. */
  next(): Promise<void>;

  /** Skips back to the previous track. */
  previous(): Promise<void>;
}
