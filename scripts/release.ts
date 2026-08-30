/**
 * Cut a release.
 *
 *   pnpm release patch|minor|major [--dry-run] [--prerelease] [--yes]
 *
 * It refuses more often than it runs, which is the point. Nothing is written
 * until every guard has passed, so a refusal leaves the tree exactly as it was.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const MANIFEST = join(ROOT, 'package.json');

/** The git on PATH is Canva's wrapper, which cannot authenticate a DMXL remote. */
const GIT = '/opt/homebrew/bin/git';
const REPO = 'DMXL/term-spotify';
const BRANCH = 'main';
const OP_ITEM = 'PAT: DMXL';

/** Headings that mean a listener would notice something new, changed or gone. */
const NOTICEABLE = ['Added', 'Changed', 'Deprecated', 'Removed'];

/** Roughly two lines of terminal. Past this a bullet has become a commit message. */
const LINE_BUDGET = 180;

type Bump = 'patch' | 'minor' | 'major';

function fail(message: string, remedy?: string): never {
  process.stderr.write(`\nrelease: ${message}\n`);
  if (remedy !== undefined) process.stderr.write(`\n  ${remedy}\n`);
  process.stderr.write('\nNothing was written.\n');
  process.exit(1);
}

function capture(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`\`${file} ${args.join(' ')}\` failed.\n\n${detail}`);
  }
}

function stream(file: string, args: string[], env?: NodeJS.ProcessEnv): void {
  try {
    execFileSync(file, args, { cwd: ROOT, stdio: 'inherit', env: env ?? process.env });
  } catch {
    fail(`\`${file} ${args.join(' ')}\` failed. See the output above.`);
  }
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nextVersion(current: string, bump: Bump): string {
  const parts = current.split('.').map(Number);
  const [major, minor, patch] = parts;
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    fail(`package.json has version "${current}", which is not a plain major.minor.patch.`);
  }
  if (bump === 'major') return `${major! + 1}.0.0`;
  if (bump === 'minor') return `${major!}.${minor! + 1}.0`;
  return `${major!}.${minor!}.${patch! + 1}`;
}

function trimBlanks(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end);
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const bump = positional[0] as Bump | undefined;
  const dryRun = flags.has('--dry-run');
  const forced = flags.has('--yes');
  const prerelease = flags.has('--prerelease');

  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    fail(
      'say which kind of release this is.',
      'pnpm release patch|minor|major [--dry-run] [--prerelease] [--yes]',
    );
  }

  // 1. The tree has to be clean, or the release commit carries somebody's work in progress.
  const dirty = capture(GIT, ['status', '--porcelain']);
  if (dirty !== '') {
    fail(`the working tree is not clean.\n\n${dirty}`, 'Commit or stash first, then run this again.');
  }

  // 2. Releases come off the default branch.
  const branch = capture(GIT, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) {
    fail(`you are on ${branch}, and releases are cut from ${BRANCH}.`);
  }

  // 3. There has to be something to release, written the way a listener would read it.
  const changelog = readFileSync(CHANGELOG, 'utf8');
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (start === -1) fail('CHANGELOG.md has no `## [Unreleased]` heading.');

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i]!) || /^\[Unreleased\]:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = trimBlanks(lines.slice(start + 1, end));
  const headings = body.filter((l) => /^### /.test(l)).map((l) => l.slice(4).trim());

  // A bullet is its marker line plus any lines wrapped underneath it.
  const entries: string[] = [];
  for (const line of body) {
    if (/^\s*[*-] /.test(line)) entries.push(line.trim());
    else if (entries.length > 0 && line.trim() !== '' && !/^### /.test(line)) {
      entries[entries.length - 1] += ` ${line.trim()}`;
    }
  }

  if (entries.length === 0) {
    fail(
      'CHANGELOG.md has nothing under `## [Unreleased]`.',
      'Log what changed first. A release with no entries tells a reader nothing.',
    );
  }

  // 4. Brief. These lines go out as the release notes verbatim, and a changelog
  //    is scanned rather than read.
  const overlong = entries.filter((l) => l.length > LINE_BUDGET);
  if (overlong.length > 0 && !forced) {
    const shown = overlong.map((l) => `  ${l.slice(0, 88)} ... (${l.length} characters)`).join('\n');
    fail(
      `${overlong.length} changelog entr${overlong.length === 1 ? 'y runs' : 'ies run'} past ${LINE_BUDGET} characters.\n\n${shown}`,
      'Cut each to one line and move the reasoning into the commit message, or pass --yes.',
    );
  }

  // 5. The bump has to match what actually landed.
  const noticeable = headings.filter((h) => NOTICEABLE.includes(h));
  if (bump === 'patch' && noticeable.length > 0 && !forced) {
    fail(
      `Unreleased contains ${noticeable.join(' and ')}, which a listener would notice, so this is a minor.`,
      'Run `pnpm release minor`, or pass --yes if you are certain it is a patch.',
    );
  }

  const current = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string }).version;
  if (bump === 'major' && current.startsWith('0.') && !forced) {
    fail(
      'a major bump here means 1.0.0, which says the bug hunt is over and this surface is one we will keep.',
      'Pass --yes if that is what you mean.',
    );
  }

  const next = nextVersion(current, bump);
  const tag = `v${next}`;

  // 6. It has to compile. This runs on a dry run too, because that is the rehearsal.
  process.stdout.write(`\nTypechecking before ${tag}.\n`);
  stream('pnpm', ['typecheck']);

  // 7. Move Unreleased into a dated section and rewrite the link refs.
  const rebuilt = [
    ...lines.slice(0, start + 1),
    '',
    `## [${next}] - ${today()}`,
    '',
    ...body,
    '',
    ...lines.slice(end),
  ];
  const refIndex = rebuilt.findIndex((l) => l.startsWith('[Unreleased]:'));
  if (refIndex === -1) fail('CHANGELOG.md has no `[Unreleased]:` link reference at the foot.');
  rebuilt[refIndex] = `[Unreleased]: https://github.com/${REPO}/compare/${tag}...HEAD`;
  rebuilt.splice(refIndex + 1, 0, `[${next}]: https://github.com/${REPO}/compare/v${current}...${tag}`);

  const notes = body.join('\n');

  if (dryRun) {
    process.stdout.write(`\n${current} to ${next}, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.\n`);
    process.stdout.write(`\nThe release would read:\n\n${notes}\n\nNothing was written.\n`);
    return;
  }

  // 8. Everything from here writes, so the token is fetched first. A lapsed
  //    1Password session fails silently later otherwise, and git falls back to
  //    anonymous and the push is rejected as a bad credential.
  const token = capture('op', ['item', 'get', OP_ITEM, '--fields', 'token', '--reveal']);
  if (token === '') {
    fail(`1Password returned nothing for "${OP_ITEM}".`, `Run: op item get "${OP_ITEM}" --fields token --reveal`);
  }

  writeFileSync(CHANGELOG, rebuilt.join('\n'));
  writeFileSync(
    MANIFEST,
    readFileSync(MANIFEST, 'utf8').replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${next}$2`),
  );

  stream(GIT, ['add', 'CHANGELOG.md', 'package.json']);
  stream(GIT, ['commit', '-m', `Release ${tag}`]);
  stream(GIT, ['tag', '-a', tag, '-m', tag]);
  stream(GIT, ['push', '--follow-tags', 'origin', BRANCH]);

  const notesFile = join(mkdtempSync(join(tmpdir(), 'release-')), 'notes.md');
  writeFileSync(notesFile, notes);
  stream(
    'gh',
    [
      'release',
      'create',
      tag,
      '--repo',
      REPO,
      '--title',
      tag,
      '--notes-file',
      notesFile,
      ...(prerelease ? ['--prerelease'] : []),
    ],
    { ...process.env, GH_TOKEN: token },
  );

  process.stdout.write(`\n${tag} is out: https://github.com/${REPO}/releases/tag/${tag}\n`);
}

main(process.argv.slice(2));
