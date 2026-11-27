# Live page on phones, stream stats and the default size

Approved 2026-11-27.

## Why

On a phone the live page scrolls badly, the video wastes width, and stream stats cover the
picture. In Settings, "Camera default" doesn't say what size that is.

## Design

1. **Default size label.** The camera reports only its top size. When a Kasa camera streams at
   its default (no saved or `.env` resolution), the server saves the size it receives as
   `cameraDefaultSize` (`"1280x720"`) in settings.json. `withCamera` drops it for a different
   camera. The Video quality option reads "Camera default (720p)"; without a saved size, "Camera
   default".
2. **Scrolling.** PTZ arrows: `touch-action: pan-y`; a touch press starts moving only after
   150 ms without the browser taking the gesture (`pointercancel` cancels it). Mouse and pen
   start at once. Range inputs get `touch-action: pan-y`.
3. **Stats off the video.** The `stage-meta` overlay goes. Settings → Video shows "Now streaming
   1280×720 · 15 fps · 42 kb/s" (and "· 2 viewers" when more than one) from `/api/status`.
4. **Full-width video on phones** (900px or narrower): the stage spans the whole width, no
   rounded corners, no side border.
5. **No View card.** Snapshot becomes an icon button in the top bar beside the gear; Pop out an
   icon beside it where `pictureInPictureEnabled`. One tap/click on the video toggles
   fullscreen; on iPhone (no element fullscreen) it uses `video.webkitEnterFullscreen()`. F, M
   and arrow keys still work.

## Approaches

The only other place considered for the stats was a dim line under the video; Settings → Video
was picked because it's where they help judge the quality setting.
