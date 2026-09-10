import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The expensive half: everything that reaches past the live mpv process.
 *
 * ncm-cli owns the NetEase API, so this file is a typed wrapper over its
 * commands rather than a second API client. The only network read the console
 * needs is `recommend daily`, which runs once at cold start. The rest are
 * controls that answer once and are gone.
 */

export interface Song {
  /** Encrypted id, 32 hex characters, which the API and `like`/`dislike` want. */
  id: string;
  /** Numeric id, which `play` and `queue add` also want. */
  originalId: number;
  name: string;
  /** Milliseconds. */
  duration: number;
  artists: { name: string }[];
  fullArtists?: { name: string }[];
  album: { name: string };
  coverImgUrl: string;
  liked: boolean;
  /** False when there is no audio source or no permission to play it. */
  playFlag?: boolean;
}

export class NeteaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeteaseError';
  }
}

/**
 * Runs ncm-cli and returns its parsed reply. A non zero exit or a plain text
 * error line (which ncm-cli prints on some failures while still exiting zero)
 * becomes a `NeteaseError`; an empty reply becomes null.
 */
async function call(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run('ncm-cli', args));
  } catch (error) {
    throw new NeteaseError(error instanceof Error ? error.message : String(error));
  }
  const text = stdout.trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NeteaseError(text);
  }
}

/** The daily recommended songs, which are the cold start source. */
export async function recommendDaily(limit: number): Promise<Song[]> {
  const body = (await call(['recommend', 'daily', '--limit', String(limit)])) as { data?: Song[] } | null;
  return body?.data ?? [];
}

/** The daily mix, cached for the day, since it changes once a day. */
export async function dailyMix(limit: number, force = false): Promise<Song[]> {
  if (!force) {
    const cached = await readCache();
    if (cached !== null && cached.date === today() && cached.songs.length > 0) {
      return cached.songs;
    }
  }
  const songs = await recommendDaily(limit);
  if (songs.length > 0) await writeCache({ date: today(), songs });
  return songs;
}

const CACHE_DIR = path.join(os.homedir(), '.config', 'term-player');
const CACHE_FILE = path.join(CACHE_DIR, 'daily-mix.json');

interface CachedMix {
  date: string;
  songs: Song[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readCache(): Promise<CachedMix | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) as CachedMix;
    return Array.isArray(parsed.songs) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(cached: CachedMix): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cached), 'utf8');
  } catch {
    // A cache that will not write is not worth a broken console.
  }
}

/** Starts mpv on one song, which is required before `queue add` will take. */
export const play = (song: Song): Promise<unknown> =>
  call(['play', '--song', '--encrypted-id', song.id, '--original-id', String(song.originalId)]);

/** Appends a song to the live queue. */
export const queueAdd = (song: Song): Promise<unknown> =>
  call(['queue', 'add', '--encrypted-id', song.id, '--original-id', String(song.originalId)]);

export const pause = (): Promise<unknown> => call(['pause']);

export const resume = (): Promise<unknown> => call(['resume']);

export const next = (): Promise<unknown> => call(['next']);

export const prev = (): Promise<unknown> => call(['prev']);

/** Clears the queue and stops playback, leaving nothing behind. */
export const stop = (): Promise<unknown> => call(['stop']);

/** `song like` and `song dislike` take the encrypted id alone, as `--songId`. */
export const like = (encryptedId: string): Promise<unknown> =>
  call(['song', 'like', '--songId', encryptedId]);

export const dislike = (encryptedId: string): Promise<unknown> =>
  call(['song', 'dislike', '--songId', encryptedId]);
