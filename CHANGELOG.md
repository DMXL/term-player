# Changelog

One line per change a listener could notice, in the words they would use rather than the words the diff uses. The reasoning belongs in the commit that made the change, not here.

Nothing is written here until a release is cut. What goes in is drawn from the commits since the last tag and confirmed before it lands, so a line here is a change somebody checked rather than one somebody merely committed. That is also why there is no `Unreleased` section: nothing is logged before it ships.

The format otherwise follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the numbering follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version stays below 1.0.0, anything may change between releases. The rules are in `CLAUDE.md`.

## [0.2.0] - 2026-08-31

### Changed

* The saved mark is a green dot instead of a heart.

### Removed

* The `t` key, which opened the current track in the Spotify app.

### Fixed

* The current track shows every artist, not just the primary one.
* The queue no longer mislabels the new song as next right after a track change.
* Pressing `r` repaints the fresh queue immediately instead of on the next tick.

## [0.1.1] - 2026-08-30

### Fixed

* Cover art fills its box instead of leaving a band of background down one edge.

## [0.1.0] - 2026-08-30

First public release.

### Added

* The console: cover art, title, artists, a rule carrying elapsed and total time, and the queue.
* Cover art inline on iTerm2 and Kitty, a colour block elsewhere, with the palette taken from the cover.
* Keys `f` save, `a` album, `t` track, `j`/`k` scroll, `g`/`G` jump, `r` refresh, `?` help, `q` quit. Transport stays on the media keys.
* `spot login` over PKCE, storing the grant in the login keychain, plus `status`, `logout` and `probe`.
* Sizing that follows the window, dropping the cover when the queue needs the room.
* Queue and saved state fetched only when the track changes or you press a key, never on a timer.

[0.2.0]: https://github.com/DMXL/term-spotify/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/DMXL/term-spotify/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DMXL/term-spotify/releases/tag/v0.1.0
