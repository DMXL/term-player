# Changelog

Every change a listener could notice gets one line here, in the words they would use rather than the words the diff uses. One line, not a paragraph. The reasoning belongs in the commit that made the change. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the numbering follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version stays below 1.0.0, anything may change between releases. See the versioning rules in `CLAUDE.md` for what earns a bump and when a release is cut.

## [Unreleased]

### Fixed

* Cover art no longer has a band of background down one edge.

## [0.1.0] - 2026-08-30

First public release.

### Added

* The console: cover art, title, artists, a rule carrying elapsed and total time, and the queue.
* Cover art inline on iTerm2 and Kitty, a colour block elsewhere, with the palette taken from the cover.
* Keys `f` save, `a` album, `t` track, `j`/`k` scroll, `g`/`G` jump, `r` refresh, `?` help, `q` quit. Transport stays on the media keys.
* `spot login` over PKCE, storing the grant in the login keychain, plus `status`, `logout` and `probe`.
* Sizing that follows the window, dropping the cover when the queue needs the room.
* Queue and saved state fetched only when the track changes or you press a key, never on a timer.

[Unreleased]: https://github.com/DMXL/term-spotify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DMXL/term-spotify/releases/tag/v0.1.0
