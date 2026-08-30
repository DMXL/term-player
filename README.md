# term-spotify

A terminal Spotify console. One full screen: what is playing, its cover, how far through it is, and what is coming next. The transport stays on your media keys, so the console keeps only the two actions those keys cannot reach, which are saving a track and jumping to its album.

It reads from two places at once, and the split is the whole design. The desktop app answers over AppleScript for free, with no token and no rate limit, so everything that ticks every second comes from there. The Web API is asked only for the three things AppleScript has no words for: the queue, whether a track is saved, and the album's URI.

## Requirements

macOS, Node 20 or newer, the Spotify desktop app, and a Spotify Premium account, which Development Mode has required of the app owner since February 2026.

You also need a Spotify app of your own, from [the developer dashboard](https://developer.spotify.com/dashboard). Create one, tick **Web API** and nothing else, and give it this redirect URI exactly:

```
http://127.0.0.1:8888/callback
```

The `localhost` hostname stopped being accepted in February 2025, so the loopback literal is not interchangeable with it. Copy the Client ID from the dashboard. There is no client secret to copy, because the sign in uses PKCE and never needs one.

## Setup

```zsh
pnpm install
pnpm build
spot login <client-id>
```

Sign in opens your browser once. The grant lands in the login keychain rather than a dotfile, since a refresh token is a durable hold on the account, and the access token is renewed a minute before it lapses without asking you again.

## Usage

```zsh
spot                # open the console
spot status         # whether there is a usable session, and for whom
spot probe          # check the sources still answer the way the console reads them
spot logout         # forget the stored grant
```

### Keys

| Key | Action |
|---|---|
| `f` | Save the current track, or unsave it |
| `a` | Open the current album in the Spotify app |
| `t` | Open the current track in the Spotify app |
| `j` / `k`, `↑` `↓` | Scroll the queue when it is taller than the window |
| `g` / `G` | Jump to the top or bottom of the queue |
| `r` | Refresh the queue and the saved state now |
| `?` | Key reference |
| `q` | Quit |

Play, pause, next and previous are deliberately unbound. The media keys already reach the desktop app, and a second way to do the same thing is worth less than the keys it costs.

## What it looks like

The cover sits at the top, drawn as a real image where the terminal can show one, and the palette is taken from the cover itself, so the console shifts colour as the music does. Below it the title, the artists, then a rule carrying the elapsed and total time, then the queue.

Colour comes from resampling the cover to a single pixel with `sips` and reading the average straight out of the BMP, which needs no image library and costs about a millisecond. The background is that colour taken most of the way down to black, and the accent is the same hue lifted until it reads against it.

Art renders inline on iTerm2 and Kitty. Everywhere else the space becomes a colour block, and the layout does not move.

### Sizing

The window is measured on every frame and again whenever it changes. The cover takes a share of the height rather than a fixed number of rows, so a tall window gets a large cover and a short one gets a small cover instead of a clipped screen. Below a certain height the cover is dropped entirely and the queue takes the room, because a list you can read beats a picture you cannot.

How wide the cover has to be for a square to come out square depends on the shape of a cell, which depends on the font. The terminal is asked at startup rather than assumed, since guessing at twice as tall as wide is close enough to look deliberate and wrong enough to leave a band of background along the bottom of every cover. A terminal that will not answer gets the guess, after a fifth of a second.

## Two channels, and why

`src/spotify/local.ts` talks to the desktop app. It reads the track, the artists, the album, the cover URL, the duration, the position, the play state, the volume, shuffle and repeat, in one call. Position and volume are writable, which is what makes scrubbing possible without the network.

What that channel cannot do is anything plural. The app's scripting dictionary declares no collections at all and never mentions a queue or a playlist, so `current track` is the only track it will hand over. Its `starred` property is read only and its handler is dead outright, so saving cannot happen there either. It offers the album's name as text but no album URI.

`src/spotify/client.ts` covers exactly those gaps and nothing else. The queue only changes when the track does or when you act, so it is fetched on those events rather than on a timer, and the second by second redraw never touches the network. That matters because Development Mode sits on the low rate limit tier.

## What Spotify no longer offers

Much of what a music client would want has been withdrawn, in November 2024 and again in February 2026. `spot probe` checks the live API rather than the documentation, which still lists endpoints that answer 403.

Gone, and not worth designing around: recommendations, related artists, audio features and analysis, thirty second previews, featured and category playlists, new releases, artist top tracks, batch fetches, and other users' profiles and playlists. Discover Weekly, Release Radar and the rest of Made for You answer 404, because Spotify owns those playlists rather than you.

Three limits shape this console directly:

* The queue endpoint returns twenty upcoming items and no more, which is fewer than the desktop app shows. The panel says so rather than implying the list is complete.
* Spotify lets a paused device go idle, and then answers the queue with nothing at all while still knowing the track. The console says so instead of showing an empty list, and keeps asking on a widening interval, so playing again fills it back in.
* Search is capped at ten results per type, down from fifty.
* The `product` field was removed from the profile, so Premium cannot be checked up front. A 403 on the first control is the only signal there is.

Extended quota, which would lift these, requires 250,000 monthly active users and a registered business, so Development Mode is permanent here. That is a cap of five users, which is ample for a console you run yourself.

## Layering

`core/` imports nothing outside itself. `tui/` and `spotify/` each import `core/` and never each other. `cli.ts` sits above all three. Check it before committing:

```zsh
grep -rn "from '\.\./" src/core        # must be empty
grep -rn "from '.*spotify/" src/tui    # must be empty
grep -rn "from '.*tui/" src/spotify    # must be empty
```

The rule that matters most is the one about channels: nothing in `tui/` decides where a field came from. The view is handed a snapshot with a track and a queue in it, and whether each half arrived over a Unix socket or the network is settled before it ever gets there.
