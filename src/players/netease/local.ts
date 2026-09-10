import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The local, per tick read, which is `ncm-cli state` over mpv.
 *
 * ncm-cli owns auth and playback, so this channel has no token and no
 * dictionary to relearn. `state` reads the live mpv process, so it costs
 * nothing and has no rate limit, which is what makes it safe to call on every
 * tick, the way AppleScript is for the Spotify player.
 */

export type NcmStatus = 'playing' | 'stopped';

export interface NcmState {
  status: NcmStatus;
  /** `"<name> - <artist>"`, joined by ncm-cli from the live audio. Absent while stopped. */
  title: string | null;
  /** Seconds, fractional. */
  position: number;
  /** Seconds, fractional. Absent while stopped, where there is nothing to time. */
  duration: number | null;
  currentIndex: number;
  queueLength: number;
}

/** Whether ncm-cli and its mpv backend are installed. */
export async function isAvailable(): Promise<boolean> {
  try {
    await Promise.all([run('ncm-cli', ['--version']), run('mpv', ['--version'])]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The live player state, or null when ncm-cli will not answer. `stopped` is an
 * ordinary answer, not an error, so only a failed process or a non JSON reply
 * is null.
 */
export async function state(): Promise<NcmState | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('ncm-cli', ['state']));
  } catch {
    return null;
  }

  let body: { state?: Record<string, unknown> };
  try {
    body = JSON.parse(stdout) as { state?: Record<string, unknown> };
  } catch {
    return null;
  }
  const s = body.state;
  if (s === undefined) return null;

  return {
    status: s['status'] === 'playing' ? 'playing' : 'stopped',
    title: typeof s['title'] === 'string' ? (s['title'] as string) : null,
    position: typeof s['position'] === 'number' ? (s['position'] as number) : 0,
    duration: typeof s['duration'] === 'number' ? (s['duration'] as number) : null,
    currentIndex: typeof s['currentIndex'] === 'number' ? (s['currentIndex'] as number) : 0,
    queueLength: typeof s['queueLength'] === 'number' ? (s['queueLength'] as number) : 0,
  };
}

/** One entry in ncm-cli's persisted queue, in play order. */
export interface QueueEntry {
  encryptedId: string;
  /** `"<name> - <artist>"` once resolved, the raw hex id before that. */
  title: string;
}

const QUEUE_FILE = path.join(os.homedir(), '.config', 'ncm-cli', 'queue.json');

/**
 * The live queue in play order, read from the file ncm-cli persists. `state`
 * gives a `currentIndex` but no id, and unplayable songs are dropped from the
 * queue as it is built, so the index alone cannot be trusted to line up with
 * the daily mix. This file carries the reliable encrypted id for every entry.
 */
export async function queue(): Promise<QueueEntry[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(QUEUE_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { items?: { encryptedId?: string; title?: string }[] };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.map((it) => ({
      encryptedId: typeof it.encryptedId === 'string' ? it.encryptedId : '',
      title: typeof it.title === 'string' ? it.title : '',
    }));
  } catch {
    return null;
  }
}
