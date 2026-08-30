# Working on term-spotify

## Pushing

The remote is a `DMXL` one, so the usual rule applies: network commands go through `/opt/homebrew/bin/git`, and `op` has to be authorized first. Both failures are already written up in the global instructions.

Credentials here come from 1Password through a repo local helper, so no token is on disk and nothing needs setting up again.

## Do not spend the rate limit

Development Mode sits on Spotify's low tier, a rolling thirty second window whose size they do not publish. The console is built so ordinary use costs almost nothing: the player bar comes from AppleScript on every tick, and the Web API is asked only when the track changes or the user presses a key.

Keep it that way. Anything that redraws must not reach for the network, and `probe` makes one call per question with no loop. If you need live data while working, make one call and look at what came back rather than retrying.

## What the two channels can and cannot do

`src/spotify/local.ts` is the desktop app over AppleScript. Its dictionary lives at `/Applications/Spotify.app/Contents/Resources/Spotify.sdef` and is worth rereading before assuming anything: it declares **zero** collections, so there is no queue and no playlist in it, `starred` is read only with a handler that raises AppleEvent error `-10000`, and there is an album name but no album URI.

Two traps in it. `duration` is milliseconds even though the dictionary says seconds, while `player position` really is seconds. And `artist` is one text field with several artists already joined, not a list.

`src/spotify/client.ts` covers exactly the three gaps: the queue, the saved state, and the album URI. Do not widen it.

## The library endpoints take query parameters

`PUT /me/library` and `DELETE /me/library` want `?uris=`. A JSON body is refused with `Missing required field: uris`, which reads as though the body were the intended shape. It is not. `GET /me/library/contains` is the same.

The per type endpoints these replaced (`PUT /me/tracks` and friends) answer 403 now, so there is no falling back to them.

## Verifying the console

It needs a TTY, so drive it through a pty rather than giving up:

```zsh
( sleep 4; printf 'q' ) | \
  script -q /tmp/frames.raw /bin/zsh -c 'stty cols 100 rows 34; exec ./node_modules/.bin/tsx src/cli.ts'
```

The frame is written by absolute cursor position, so stripping escapes and reading the result gives nonsense. Replay it onto a grid instead, honouring `ESC[row;colH`, `ESC[2K` and `ESC[2J`, and read that. Decode as UTF-8, or every box drawing character and accent turns into several cells and invents alignment bugs that are not there.

Better still, skip the terminal. `renderText` is pure: hand it a `Snapshot`, a palette and a size and measure what comes back. Every row must come out at exactly `cols` wide, and checking that across several widths is what caught the ragged queue column and the unpainted background.

## Layering, which is enforced by direction only

`core/` imports nothing outside itself. `tui/` and `spotify/` each import `core/` and never each other. `cli.ts` and `console.ts` sit above. Check it before committing:

```zsh
grep -rn "from '\.\./" src/core        # must be empty
grep -rn "from '.*spotify/" src/tui    # must be empty
grep -rn "from '.*tui/" src/spotify    # must be empty
```

No source vocabulary in the view. Nothing in `tui/` may branch on where a field came from, which is what keeps the cheap local read and the expensive network read free to change without the picture caring.

## Versioning, which every session takes part in

This is public and numbered now, so a change that ships without a line in the changelog is a change nobody outside this repo will ever learn about. Adding that line is part of the work, not a step after it.

### Every change a listener could notice gets a line

Before you commit, add a bullet to `## [Unreleased]` in `CHANGELOG.md`, under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated` or `### Security`. Create the heading if the release does not have one yet.

Write it for someone who runs the console, not for someone reading the diff. "The queue no longer empties when the device goes idle" is a line. "Refactor `session.ts` polling" is not, because it names the file rather than the effect.

What does not get a line: refactors nothing outside the repo can see, prose and comment edits, README or `CLAUDE.md` changes, and anything to do with the build that leaves the console behaving identically. The test is whether a user could tell. If they could not, leave the changelog alone.

### What each number means

The leading zero is a claim, and it is currently true: the shape is settled, the details are not, and anything may change between releases. While the version stays below 1.0.0:

| What landed under `## [Unreleased]` | Bump |
|---|---|
| Only `Fixed`, or internal changes | patch, `0.1.0` to `0.1.1` |
| Any `Added`, `Changed`, `Removed` or `Deprecated` | minor, `0.1.0` to `0.2.0` |
| The bug hunt is over and the key map and CLI surface are ones we will keep | `1.0.0`, and it is a decision, not an increment |

After 1.0.0 the rules become the ordinary ones. Major for a break in the key bindings, the `spot` subcommands, the shape of what is stored in the keychain, or the platform floor. Minor for a new capability that costs an existing user nothing. Patch for a fix alone.

`pnpm release patch` refuses when `Unreleased` holds anything a listener would notice, so the table above is enforced rather than remembered. `--yes` overrides it and should be rare.

### When a release is actually cut

Not per fix. Most fixes sit in `Unreleased` until they are worth someone's attention as a group.

Cut one when any of these is true:

* `Unreleased` holds three or more entries and the tree is green.
* Something in `Unreleased` is a capability, which is worth announcing on its own.
* A fix repairs something that makes the console unusable, meaning it will not start, sign in is broken, or it shows wrong data as though it were right. That one ships alone and immediately.

Do not cut a release to tidy up, and do not cut one with an empty `Unreleased`. The script refuses the second and you should refuse the first.

### How

```zsh
pnpm release minor --dry-run   # rehearse: guards run, notes print, nothing is written
pnpm release minor             # do it
```

It checks the tree is clean, that you are on `main`, that `Unreleased` has entries, that the bump matches them, and that `pnpm typecheck` passes. Only then does it move `Unreleased` into a dated section, bump `package.json`, commit, tag `vX.Y.Z`, push, and create the GitHub release with that section as its notes. A refusal writes nothing, so it is always safe to run.

It reads the token from 1Password itself, because the `gh` on this machine is signed in as a different account that cannot write to `DMXL`.

## Prose

No dashes as punctuation anywhere, including code comments and commit messages. Commas, periods, parentheses or separate sentences instead. Arithmetic in code is obviously fine.
