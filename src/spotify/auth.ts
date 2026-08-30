import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readSecret, writeSecret, deleteSecret } from '../core/keychain.js';

/**
 * Authorization Code with PKCE, which is the only flow open to a client that
 * ships to a user's machine and therefore cannot keep a secret. No client
 * secret is involved anywhere.
 *
 * The redirect must be a loopback IP literal. Spotify stopped accepting the
 * `localhost` hostname in February 2025 because it resolves inconsistently.
 */

const PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

/**
 * Read the player and the queue, control playback, and read and change what is
 * saved. Nothing wider, so the consent screen states only what the console does.
 */
const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify',
].join(' ');

export interface Tokens {
  access: string;
  refresh: string;
  /** Epoch milliseconds. Refreshed a little early rather than on expiry. */
  expiresAt: number;
}

export async function clientId(): Promise<string | null> {
  return process.env['SPOTIFY_CLIENT_ID'] ?? (await readSecret('client-id'));
}

export async function setClientId(id: string): Promise<void> {
  await writeSecret('client-id', id);
}

export async function readTokens(): Promise<Tokens | null> {
  const raw = await readSecret('tokens');
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: Tokens): Promise<void> {
  await writeSecret('tokens', JSON.stringify(tokens));
}

export async function forget(): Promise<boolean> {
  return await deleteSecret('tokens');
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Runs the browser half of the flow: opens the consent page, then waits on a
 * one shot loopback server for Spotify to redirect back with the code.
 */
export async function login(id: string): Promise<Tokens> {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authorize = new URL('https://accounts.spotify.com/authorize');
  authorize.searchParams.set('client_id', id);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', REDIRECT_URI);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('state', state);

  const code = await awaitRedirect(state, authorize.toString());
  const tokens = await exchange(id, code, verifier);
  await writeTokens(tokens);
  await setClientId(id);
  return tokens;
}

function awaitRedirect(state: string, openUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returned = url.searchParams.get('state');

      const done = (message: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>term-spotify</title>
<body style="font:16px system-ui;padding:3rem;color:#111">${message}</body>`);
        server.close();
      };

      if (error !== null) {
        done('Sign in was refused. You can close this tab.');
        reject(new Error(`Spotify refused the sign in: ${error}`));
        return;
      }
      // A mismatched state means this redirect was not the one we started.
      if (returned !== state) {
        done('That did not match the request. You can close this tab.');
        reject(new Error('The state did not match the one sent, so the redirect was ignored.'));
        return;
      }
      if (code === null) {
        done('No code came back. You can close this tab.');
        reject(new Error('Spotify redirected without a code.'));
        return;
      }

      done('Signed in. You can close this tab and go back to the terminal.');
      resolve(code);
    });

    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      execFile('open', [openUrl], () => {
        // Opening is best effort. The URL is printed too, so a failure here is
        // recoverable by pasting it.
      });
    });
  });
}

async function exchange(id: string, code: string, verifier: string): Promise<Tokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: id,
      code_verifier: verifier,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return {
    access: body['access_token'] as string,
    refresh: body['refresh_token'] as string,
    expiresAt: Date.now() + (body['expires_in'] as number) * 1000,
  };
}

/**
 * Spotify rotates the refresh token on most refreshes, so the new one is stored
 * whenever it is present. Dropping it would strand the session at the next hour.
 */
export async function refresh(id: string, tokens: Tokens): Promise<Tokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh,
      client_id: id,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const next: Tokens = {
    access: body['access_token'] as string,
    refresh: (body['refresh_token'] as string | undefined) ?? tokens.refresh,
    expiresAt: Date.now() + (body['expires_in'] as number) * 1000,
  };
  await writeTokens(next);
  return next;
}
