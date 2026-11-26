# Settings redesign and video quality

Approved 2026-11-27.

## Why

On a computer, Settings is a 480px column that looks like a phone page. The camera streams at its
default size (720p on the KC410S), and the only way to change that is `KASA_STREAM_RESOLUTION` in
`.env`.

## Goals

- On a computer, Settings looks like a desktop app: a sidebar of categories and a pane on the right.
- Video quality can be chosen in Settings.

## Non-goals

- 4K. No Kasa camera streams it; the stream request accepts at most `2560x1440`.
- Changing the phone layout beyond adding category headings.

## Approaches considered

- **Sidebar + pane** (picked): categories down the left, one category's settings at a time.
- Wide card grid: today's cards in two or three columns. Busy, no grouping.
- One page with a sticky side index: every setting as a row. Long page, more restyling.

## Design

### Layout

- Computer (wider than 900px): the Settings block is centered, about 960px wide. Top row: an
  icon-only back-arrow button on the left (accessible name "Back"), then the "Settings" title.
  Below: sidebar of categories on the left, the chosen category's settings on the right. Camera
  opens first.
- Phone (900px or narrower): no sidebar. One scrolling column with a heading over each category.
  The back arrow stays at the top left.
- A category with nothing to show is hidden.

| Category | Contents |
|---|---|
| Camera | Camera in use and Change camera, camera login, set up a new camera |
| Video | Video quality (Kasa); the stream chooser for a standard (ONVIF) camera |
| Access | Viewer password, away from home, "use the away address" on a phone |
| App | Start when this computer starts, updates, stop HomeView (desktop app on this computer only) |

### Video quality

- Choices: Camera default, 720p (`720P`), 1080p (`1080P`), 2K. 2K is offered only when the camera's
  reported `resolution` is `2560x1440` or `2304x1296`, and uses that value.
- Saved as `streamResolution` in settings.json. Saving it reloads the server config, which restarts
  the stream; HomeView itself doesn't restart.
- `KASA_STREAM_RESOLUTION` in `.env` wins. The choice is then shown locked with "Set in .env".
- Anyone signed in can change it (my call): it only affects sharpness and data use.

## Left to the builder

Styling details, the sidebar's selected state, the exact icon drawing.
