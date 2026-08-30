# Changelog

Every change a listener could notice is written down here, in the words they would use rather than the words the diff uses. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the numbering follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version stays below 1.0.0, anything may change between releases. See the versioning rules in `CLAUDE.md` for what earns a bump and when a release is cut.

## [Unreleased]

## [0.1.0] - 2026-08-30

The first public release. The console runs and its shape is settled. The details are not, which is what the leading zero is saying.

### Added

* The console. One full screen frame: cover art, the title, the artists, a rule carrying elapsed and total time, and the queue below it.
* Two channels behind that one picture. The desktop app answers over AppleScript on every tick, for free and with no token, and the Web API is asked only for the three things AppleScript has no words for, which are the queue, whether a track is saved, and the album's URI.
* Cover art drawn inline where the terminal can show a picture, on iTerm2 and Kitty, and as a colour block everywhere else, with the layout unmoved either way.
* A palette taken from the cover itself, by resampling it to a single pixel with `sips` and reading the average straight out of the BMP, so the console shifts colour as the music does.
* Keys. `f` saves the current track or unsaves it, `a` and `t` open the album or the track in the Spotify app, `j` and `k` and the arrows scroll the queue, `g` and `G` jump to either end, `r` refreshes the queue and the saved state, `?` shows the key reference, and `q` quits. Play, pause, next and previous are deliberately unbound, because the media keys already reach the desktop app.
* Sizing that measures the window on every frame and again whenever it changes. The cover takes a share of the height rather than a fixed number of rows, and below the height where the queue needs the room it is dropped entirely.
* `spot login <client-id>`, which signs in over PKCE with no client secret and stores the grant in the login keychain rather than a dotfile. The access token is renewed a minute before it lapses without asking again.
* `spot status`, `spot logout`, and `spot probe`, which checks the live sources rather than the documentation, and reports what the terminal said about cell shape and whether it answered at all.
* A queue fetched when the track changes or when you act, never on a timer, so the second by second redraw never reaches for the network. Development Mode sits on the low rate limit tier and the console is built to stay well inside it.
* Two readings of a queue endpoint that answers dishonestly. An idle device returns an empty list while still knowing the track, so the console says so and keeps asking on a widening interval. A context that cannot yield a next track is padded with ten copies of the track already playing, so the console names the context that is refusing and stops asking until the track changes.

[Unreleased]: https://github.com/DMXL/term-spotify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DMXL/term-spotify/releases/tag/v0.1.0
