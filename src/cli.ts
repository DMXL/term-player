import { clientId, forget, login, readTokens, REDIRECT_URI } from './players/spotify/auth.js';
import { Session as SpotifySession } from './players/spotify/session.js';
import * as spotifyLocal from './players/spotify/local.js';
import { Session as NeteaseSession } from './players/netease/session.js';
import * as neteaseLocal from './players/netease/local.js';
import { BIN } from './core/command.js';
import type { Player } from './core/player.js';
import { probe } from './probe.js';
import { run } from './console.js';

const USAGE = `term-player

  ${BIN}                     open the console
  ${BIN} login <client-id>   sign in, storing the grant in the login keychain
  ${BIN} status              whether there is a usable session, and for whom
  ${BIN} logout              forget the stored grant
  ${BIN} probe               check the sources still answer the way we read them

The client id comes from https://developer.spotify.com/dashboard, and that app
must list ${REDIRECT_URI} as a redirect URI.
`;

/**
 * Picks which player fronts the console on the no argument path.
 *
 * `TERM_PLAYER_PROVIDER` forces one, for when the guess is wrong. Otherwise
 * Spotify wins only when it is open and has something playing right now, because
 * a paused Spotify and a NetEase that is ready are better served by NetEase.
 * Spotify is checked for running first, since asking its `current track` would
 * launch the app, and a closed Spotify must fall through to NetEase. NetEase is
 * chosen when ncm-cli and mpv are there to drive it, and Spotify is the fallback
 * when they are not.
 */
async function detectProvider(): Promise<Player> {
  const forced = process.env['TERM_PLAYER_PROVIDER'];
  if (forced === 'netease') return new NeteaseSession();
  if (forced === 'spotify') return new SpotifySession();

  if (await spotifyLocal.isRunning()) {
    const spotify = await spotifyLocal.nowPlaying();
    if (spotify !== null && spotify.state === 'playing') return new SpotifySession();
  }
  if (await neteaseLocal.isAvailable()) return new NeteaseSession();
  return new SpotifySession();
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login': {
      const id = rest[0] ?? (await clientId());
      if (id === undefined || id === null) {
        process.stderr.write(`A client id is needed the first time: ${BIN} login <client-id>\n`);
        return 1;
      }
      process.stdout.write('Opening Spotify to ask for access. Approve it in the browser.\n');
      await login(id);
      process.stdout.write('Signed in.\n');
      return 0;
    }

    case 'status': {
      const id = await clientId();
      const tokens = await readTokens();
      if (id === null || tokens === null) {
        process.stdout.write('Not signed in.\n');
        return 1;
      }
      const left = Math.round((tokens.expiresAt - Date.now()) / 60_000);
      process.stdout.write(`Signed in with client ${id}. Access token ${left} minutes from expiry.\n`);
      return 0;
    }

    case 'logout': {
      process.stdout.write((await forget()) ? 'Forgotten.\n' : 'There was nothing stored.\n');
      return 0;
    }

    case 'probe': {
      await probe();
      return 0;
    }

    case undefined: {
      return await run(await detectProvider());
    }

    default: {
      process.stdout.write(USAGE);
      return command === 'help' ? 0 : 1;
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
