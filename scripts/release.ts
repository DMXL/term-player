/**
 * Cut a release.
 *
 *   pnpm release patch|minor|major --notes-file <path> [--dry-run] [--prerelease] [--yes]
 *
 * The notes come from a file rather than from the changelog, because what goes
 * into a release is decided at release time, from the commits, and confirmed by
 * a human before it is written anywhere. The `/release` skill is what normally
 * produces that file.
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

/** A bullet is its marker line plus any lines wrapped underneath it. */
function bulletsOf(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (/^\s*[*-] /.test(line)) found.push(line.trim());
    else if (found.length > 0 && line.trim() !== '' && !/^#{2,4} /.test(line)) {
      found[found.length - 1] += ` ${line.trim()}`;
    }
  }
  return found;
}

function valueOf(argv: string[], flag: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const notesPath = valueOf(argv, '--notes-file');
  const positional = argv.filter((a) => !a.startsWith('--') && a !== notesPath);
  const bump = positional[0] as Bump | undefined;
  const dryRun = flags.has('--dry-run');
  const forced = flags.has('--yes');
  const prerelease = flags.has('--prerelease');

  const usage = 'pnpm release patch|minor|major --notes-file <path> [--dry-run] [--prerelease] [--yes]';

  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    fail('say which kind of release this is.', usage);
  }

  // 1. The notes say what is going out. They are decided before this runs, from
  //    the commits, and confirmed by a human. Normally the /release skill writes them.
  if (notesPath === undefined || notesPath === '') {
    fail('no --notes-file. This is where what goes out is decided, so it is not optional.', usage);
  }
  let notesRaw: string;
  try {
    notesRaw = readFileSync(notesPath, 'utf8');
  } catch {
    fail(`cannot read the notes at ${notesPath}.`);
  }
  const notesLines = trimBlanks(notesRaw.split('\n'));
  const entries = bulletsOf(notesLines);
  const headings = notesLines.filter((l) => /^### /.test(l)).map((l) => l.slice(4).trim());

  if (entries.length === 0) {
    fail(
      `${notesPath} has no entries in it.`,
      'A release with nothing written down tells a reader nothing. Say what changed first.',
    );
  }

  // 2. The tree has to be clean, or the release commit carries somebody's work in progress.
  const dirty = capture(GIT, ['status', '--porcelain']);
  if (dirty !== '') {
    fail(`the working tree is not clean.\n\n${dirty}`, 'Commit or stash first, then run this again.');
  }

  // 3. Releases come off the default branch.
  const branch = capture(GIT, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) {
    fail(`you are on ${branch}, and releases are cut from ${BRANCH}.`);
  }

  // 4. Brief. These lines go out as the release notes verbatim, and a changelog
  //    is scanned rather than read.
  const overlong = entries.filter((l) => l.length > LINE_BUDGET);
  if (overlong.length > 0 && !forced) {
    const shown = overlong.map((l) => `  ${l.slice(0, 88)} ... (${l.length} characters)`).join('\n');
    fail(
      `${overlong.length} entr${overlong.length === 1 ? 'y runs' : 'ies run'} past ${LINE_BUDGET} characters.\n\n${shown}`,
      'Cut each to one line and move the reasoning into the commit message, or pass --yes.',
    );
  }

  // 5. The bump has to match what actually landed.
  const noticeable = headings.filter((h) => NOTICEABLE.includes(h));
  if (bump === 'patch' && noticeable.length > 0 && !forced) {
    fail(
      `the notes contain ${noticeable.join(' and ')}, which a listener would notice, so this is a minor.`,
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

  // 7. Put the dated section above the newest one already there, and add its link ref.
  const lines = readFileSync(CHANGELOG, 'utf8').split('\n');
  let sectionAt = lines.findIndex((l) => /^## \[/.test(l));
  if (sectionAt === -1) {
    // Nothing released yet, so it goes above the link refs, or at the foot.
    sectionAt = lines.findIndex((l) => /^\[[^\]]+\]:\s*https?:/.test(l));
    if (sectionAt === -1) sectionAt = lines.length;
  }
  const rebuilt = [
    ...trimBlanks(lines.slice(0, sectionAt)),
    '',
    `## [${next}] - ${today()}`,
    '',
    ...notesLines,
    '',
    ...lines.slice(sectionAt),
  ];

  // The previous version only has a tag to compare against if it was ever released.
  const tagged = capture(GIT, ['tag', '--list', `v${current}`]) !== '';
  const ref = tagged
    ? `[${next}]: https://github.com/${REPO}/compare/v${current}...${tag}`
    : `[${next}]: https://github.com/${REPO}/releases/tag/${tag}`;
  const refAt = rebuilt.findIndex((l) => /^\[[^\]]+\]:\s*https?:/.test(l));
  if (refAt === -1) rebuilt.push('', ref);
  else rebuilt.splice(refAt, 0, ref);

  const notes = notesLines.join('\n');

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

  writeFileSync(CHANGELOG, `${trimBlanks(rebuilt).join('\n')}\n`);
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
    ['release', 'create', tag, '--repo', REPO, '--title', tag, '--notes-file', notesFile,
      ...(prerelease ? ['--prerelease'] : [])],
    { ...process.env, GH_TOKEN: token },
  );

  process.stdout.write(`\n${tag} is out: https://github.com/${REPO}/releases/tag/${tag}\n`);
}

main(process.argv.slice(2));
