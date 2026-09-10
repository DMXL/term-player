# Working on term-player

## Pushing

The remote is a `DMXL` one, so the usual rule applies: network commands go through `/opt/homebrew/bin/git`, and `op` has to be authorized first. Both failures are already written up in the global instructions.

Credentials here come from 1Password through a repo local helper, so no token is on disk and nothing needs setting up again.

## Do not spend the rate limit

Development Mode sits on Spotify's low tier, a rolling thirty second window whose size they do not publish. The console is built so ordinary use costs almost nothing: the player bar comes from AppleScript on every tick, and the Web API is asked only when the track changes or the user presses a key.

Keep it that way. Anything that redraws must not reach for the network, and `probe` makes one call per question with no loop. If you need live data while working, make one call and look at what came back rather than retrying.

## What the two channels can and cannot do

`src/players/spotify/local.ts` is the desktop app over AppleScript. Its dictionary lives at `/Applications/Spotify.app/Contents/Resources/Spotify.sdef` and is worth rereading before assuming anything: it declares **zero** collections, so there is no queue and no playlist in it, `starred` is read only with a handler that raises AppleEvent error `-10000`, and there is an album name but no album URI.

Two traps in it. `duration` is milliseconds even though the dictionary says seconds, while `player position` really is seconds. And `artist` is one text field that holds only the primary artist, not every artist on the track, so the full list comes from the Web API.

`src/players/spotify/client.ts` covers exactly the three gaps: the queue, the saved state, and the album URI. Do not widen it.

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

`core/` imports nothing outside itself. `tui/` and `players/` each import `core/` and never each other. `cli.ts` and `console.ts` sit above, and `console.ts` drives a `Player` rather than a concrete player. Check it before committing:

```zsh
grep -rn "from '\.\./" src/core        # must be empty
grep -rn "from '.*players/" src/tui    # must be empty
grep -rn "from '.*tui/" src/players    # must be empty
```

No source vocabulary in the view. Nothing in `tui/` may branch on where a field came from, which is what keeps the cheap local read and the expensive network read free to change without the picture caring.

## The player seam and the command name

`src/core/player.ts` is the `Player` interface, and it is the only thing the console drives. `players/spotify/` and `players/netease/` are the two implementations; a new player is a new `players/<name>/` directory that implements the same interface, and nothing in `tui/` or `console.ts` changes.

Which one fronts the console is decided in `src/cli.ts` `detectProvider()`, on the no argument path only: `TERM_PLAYER_PROVIDER` forces one, otherwise Spotify when it is open and has something playing right now, otherwise NetEase when `ncm-cli` and `mpv` are installed, otherwise Spotify. Spotify is checked for running before asking its `current track`, because that AppleScript call would launch a closed app, and a closed Spotify must fall through to NetEase.

The binary name is `term-player`, but Daniel launches the console through a zsh function called `play`, which runs it from source and exports its own name as `TERM_PLAYER_BIN`. `src/core/command.ts` reads that, so every hint the console prints names the command that was actually typed.

## The NetEase player wraps ncm-cli

`players/netease/` does not reimplement the NetEase API. [ncm-cli](https://github.com/NetEase/ncm-cli) owns the account, the playback and the API, so term-player only shells it. It needs ncm-cli and [mpv](https://mpv.io) installed (`brew install mpv`), and sign in is `ncm-cli login` with a QR code, after which term-player stores nothing.

Two reads feed the screen, and a third file keeps them honest. `ncm-cli state` is the per tick source, a local read of the live mpv process with no rate limit, giving the title, position, duration and play state. `~/.config/ncm-cli/queue.json` is read alongside it to get the queue in play order with reliable encrypted ids. `ncm-cli recommend daily` runs once, at cold start, to fetch the daily mix with full metadata, which is the one thing `state` cannot give. The list is held in memory keyed by song id, because there is no per song command to re read the artist, album or artwork later.

The daily mix is cached in `~/.config/term-player/daily-mix.json` keyed by day, so a reopening within the same day does not re fetch it. `r` clears the cache and re fetches, then rebuilds the queue. A cold start, with nothing playing, plays the first daily song just long enough to give mpv a process, pauses it, then queues the rest, so the queue building stays silent. `queue add` refuses to run until there is a playback process, which is why the first song is played (then paused) before the rest are queued.

The quirks worth knowing before touching this code:

* `state` has no `paused` value. `pause` reports `status: "stopped"` while retaining `position` and `queueLength`; `stop` clears the queue (`queueLength: 0`). So `paused` vs `stopped` is read from `queueLength > 0`, not from `status`.
* A stopped `state` omits `title` and `duration` entirely, so both fields are nullable and must be defaulted.
* `position` and `duration` are seconds (fractional); the model wants milliseconds, so multiply by 1000.
* `song like` and `song dislike` take `--songId <encryptedId>`, not `--encrypted-id`.
* `recommend daily --limit N` returns `{ code: 200, data: Song[] }`; a song's `duration` is already milliseconds there, and `coverImgUrl` is `http://` and needs upgrading to `https`.
* A song's `id` is the 32 hex encrypted id, and `originalId` is the numeric one; `play` and `queue add` want both, `like`/`dislike` want only the encrypted one.
* Songs with `playFlag: false` (no audio source or no permission) are shown in the queue greyed but not queued, since ncm-cli would skip them and playing one first would leave the transport keys pointing at nothing. A `playFlag: true` song can still be skipped at play time when its URL fetch fails, so the current song is resolved through `queue.json` by encrypted id, while the queue itself is drawn from the full daily mix order and unplayable entries carry a `disabled` flag for the view.
* There is no album to open, so `openAlbum` is a no-op, and `toggleSaved` only works for songs from the daily mix in memory.
* mpv outlives the console, so a fresh launch can find a queue already populated. The mix is then fetched on demand, without re queueing, so the persisted queue can still be described.
* The view is capped at the next twenty songs, and a cold start is held behind a loading state until it has queued them all, so the list appears whole rather than one song at a time.
* mpv does not answer the macOS media keys, so play, pause and skip are bound to keys (`space`, `n`, `p`) on the `Player` interface. ncm-cli has no single toggle, so `playPause` reads the last seen state and calls `pause` or `resume` accordingly.
* ncm-cli's player daemon can answer its first `play` with `daemon 无响应` while it spins up, which leaves an empty player and every transport key pointing at nothing. `startFirst` polls for a title after each play, since the daemon can take several seconds to resolve the song's URL and a title is the one signal the song actually loaded.

## Versioning, and where the changelog comes from

Public and numbered now, so what ships has to be legible from outside. But the changelog is written at release time rather than as you work, and the reason is worth knowing: a commit is not proof. CI typechecks, builds and checks the layering. It cannot tell whether the console looks right with music playing, and only Daniel can, which happens after the commit and sometimes days after it. Logging as you go would fill the file with claims nobody had earned yet, and nothing would ever go back to retract the ones that did not pan out.

So **do not touch `CHANGELOG.md` while working.** There is no `Unreleased` section to add to, deliberately. `/release` writes the file, drawn from the commits, with every line confirmed by Daniel before it lands.

### Which makes the commit message the source

The changelog is reconstructed from `git log <last tag>..HEAD`, so the commit message is the only record of what a change was for and the only thing the release reads. Keep writing them the way this repo already does: a subject saying what changed, a body saying what was wrong before. A lazy message costs a changelog line later, and by then the context is gone.

### What each number means

The leading zero is a claim, and it is currently true: the shape is settled, the details are not, and anything may change between releases. While the version stays below 1.0.0:

| What is being logged | Bump |
|---|---|
| Fixes only | patch, `0.1.0` to `0.1.1` |
| Anything a listener would notice as new, different or gone | minor, `0.1.0` to `0.2.0` |
| The bug hunt is over and the key map and CLI surface are ones we will keep | `1.0.0`, and it is a decision, not an increment |

Small does not make a feature a patch. Whether a user could notice is the axis, not size.

After 1.0.0 the rules become the ordinary ones. Major for a break in the key bindings, the `term-player` subcommands, the shape of what is stored in the keychain, or the platform floor. Minor for a new capability that costs an existing user nothing. Patch for a fix alone.

### Cutting one

`/release`, and only when Daniel asks for it. Him typing it is the judgment that it is time, so do not suggest one unprompted and do not cut one because commits have piled up. The procedure is in `.claude/skills/release/SKILL.md`.

`major` is honoured only when he types it. Never infer it, and on a `0.x` version confirm he means 1.0.0 before anything runs.

### Never override a guard

`pnpm release` refuses a dirty tree, a branch that is not `main`, notes that are empty or that run past 180 characters, a patch standing over entries a listener would notice, a silent `0.x` to `1.0.0`, and a failing typecheck. It writes nothing until all of them pass, so a refusal is always safe.

`--yes` overrides any of them and is Daniel's to pass, never a session's. A guard that fires is telling you something true. Take it back to him rather than reasoning past it.

## Prose

No dashes as punctuation anywhere, including code comments and commit messages. Commas, periods, parentheses or separate sentences instead. Arithmetic in code is obviously fine.
