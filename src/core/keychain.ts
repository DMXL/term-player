import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Tokens live in the macOS keychain rather than a dotfile, because a refresh
 * token is a durable grant on the account for as long as it stays valid.
 *
 * Entries are named per secret, so revoking one leaves the others alone and
 * `security` shows plainly what belongs to what.
 */

function service(secret: string): string {
  return `term-spotify: ${secret}`;
}

export async function readSecret(secret: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', service(secret), '-w']);
    const value = stdout.trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export async function writeSecret(secret: string, value: string): Promise<void> {
  await run('security', [
    'add-generic-password',
    '-U', // update in place when it already exists
    '-s',
    service(secret),
    '-a',
    process.env['USER'] ?? 'term-spotify',
    '-w',
    value,
  ]);
}

export async function deleteSecret(secret: string): Promise<boolean> {
  try {
    await run('security', ['delete-generic-password', '-s', service(secret)]);
    return true;
  } catch {
    return false; // Not there, which is the outcome asked for.
  }
}
