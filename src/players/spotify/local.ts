import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The desktop app over AppleScript, which is where the player bar comes from.
 *
 * This channel costs nothing, has no rate limit and no token, so the parts of
 * the screen that tick every second read from here rather than the Web API.
 * What it cannot do is anything plural: the dictionary declares no collections
 * at all, so there is no queue, no playlist and no device list in it.
 */

export type PlayerState = 'playing' | 'paused' | 'stopped';

export interface NowPlaying {
  /** A `spotify:track:...` URI. The dictionary offers no album URI. */
  uri: string;
  name: string;
  /** One text field. Several artists arrive already joined, not as a list. */
  artist: string;
  album: string;
  albumArtist: string;
  artworkUrl: string;
  trackNumber: number;
  discNumber: number;
  /** Milliseconds, matching the Web API rather than the dictionary's seconds. */
  duration: number;
  /** Seconds, fractional. Writable, which is what makes scrubbing possible. */
  position: number;
  state: PlayerState;
  volume: number;
  shuffling: boolean;
  repeating: boolean;
}

/** Unit separator, chosen because no track or album name will contain it. */
const SEP = '\u001f';

const READ = `tell application "Spotify"
  set t to current track
  set out to {name of t, artist of t, album of t, album artist of t, id of t, artwork url of t, (track number of t) as text, (disc number of t) as text, (duration of t) as text, (player position) as text, (player state as text), (sound volume) as text, (shuffling as text), (repeating as text)}
  set AppleScript's text item delimiters to "${SEP}"
  set s to out as text
  set AppleScript's text item delimiters to ""
  return s
end tell`;

export async function isRunning(): Promise<boolean> {
  try {
    const { stdout } = await run('osascript', [
      '-e',
      'tell application "System Events" to return (name of processes) contains "Spotify"',
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Null when the app is not running or has nothing loaded. Asking a stopped
 * Spotify for `current track` raises rather than answering, so that is caught
 * here and read as "nothing playing".
 */
export async function nowPlaying(): Promise<NowPlaying | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('osascript', ['-e', READ]));
  } catch {
    return null;
  }

  const f = stdout.trim().split(SEP);
  if (f.length < 14) return null;

  return {
    name: f[0]!,
    artist: f[1]!,
    album: f[2]!,
    albumArtist: f[3]!,
    uri: f[4]!,
    artworkUrl: f[5]!,
    trackNumber: Number(f[6]),
    discNumber: Number(f[7]),
    duration: Number(f[8]),
    position: Number(f[9]),
    state: f[10] as PlayerState,
    volume: Number(f[11]),
    shuffling: f[12] === 'true',
    repeating: f[13] === 'true',
  };
}

async function tell(script: string): Promise<void> {
  await run('osascript', ['-e', `tell application "Spotify" to ${script}`]);
}

export const playpause = (): Promise<void> => tell('playpause');
export const next = (): Promise<void> => tell('next track');
export const previous = (): Promise<void> => tell('previous track');
export const seek = (seconds: number): Promise<void> => tell(`set player position to ${seconds}`);
export const setVolume = (level: number): Promise<void> => tell(`set sound volume to ${level}`);

/** Brings the desktop app forward on whatever it is showing. */
export const reveal = (): Promise<void> => tell('activate');

/** Opens a `spotify:` URI in the desktop app, which navigates to it. */
export async function open(uri: string): Promise<void> {
  await run('open', [uri]);
}
