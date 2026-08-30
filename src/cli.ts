import { clientId, forget, login, readTokens, REDIRECT_URI } from './spotify/auth.js';
import { probe } from './probe.js';

const USAGE = `term-spotify

  spot login <client-id>   sign in, storing the grant in the login keychain
  spot status              whether there is a usable session, and for whom
  spot logout              forget the stored grant
  spot probe               check the sources still answer the way we read them

The client id comes from https://developer.spotify.com/dashboard, and that app
must list ${REDIRECT_URI} as a redirect URI.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login': {
      const id = rest[0] ?? (await clientId());
      if (id === undefined || id === null) {
        process.stderr.write('A client id is needed the first time: spot login <client-id>\n');
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

    default: {
      process.stdout.write(USAGE);
      return command === undefined || command === 'help' ? 0 : 1;
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
