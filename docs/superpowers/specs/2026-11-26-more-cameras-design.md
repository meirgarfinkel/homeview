# More cameras design

Let Kasa Home watch local cameras from other brands, not only the Kasa
KC410S.

## Why

Kasa Home is more useful to parents if it is not tied to one camera model.
Most local cameras from other brands (Reolink, Tapo, Amcrest, Hikvision,
Dahua, Annke and many more) speak two open standards: RTSP for video and
sound, and ONVIF for finding the camera, getting its stream address and
moving pan/tilt. Supporting those standards covers most of the market of
cameras that work without a cloud.

## Decided by the owner

- Families stick to one brand. One install watches one camera, as today.
- H.265 video goes to the browser as it is. No conversion. We assume the
  browser can play it, and worry about conversion later.
- Build approach 1 below: the app speaks RTSP and ONVIF itself.
- Leave room for a later cloud camera stage (Ring, Nest) that reuses the
  same screens.

## Goals

- A parent with an ONVIF camera that is already on their Wi-Fi (set up with
  its own app) can finish Kasa Home's setup with: pick "another brand",
  pick the camera from a list, type the camera's username and password.
- Live video (H.264 or H.265), sound with the sound meter and alerts, and
  pan/tilt with presets where the camera supports them. All of this also
  works through "away from home".
- Kasa cameras keep working exactly as today, including the existing setup
  wizard and settings files.
- The camera is followed when its address changes, like Kasa today.

## Non-goals

- More than one camera at a time.
- Converting video (H.265 to H.264) or sound.
- Cloud-only cameras (Ring, Nest, Arlo, most Wyze). A later stage.
- Setting up a brand-new camera's Wi-Fi for non-Kasa brands. The parent
  uses the camera's own app for that first.
- Recording, motion events from the camera, talk-back (talk-back does not
  exist yet for any camera).
- RTSPS or RTSP over UDP.

## Anti-goals (a failure even if it works)

- A new helper program, or a new network listener, for this feature.
- Any change that weakens the security gate built for remote access, or
  that lets a camera's answers make the server contact the internet.
- The camera password showing up in logs, in the page, or in an error.
- Existing Kasa users having to redo setup after updating.

## Approaches

1. **Speak RTSP and ONVIF in the server (chosen).** A TypeScript RTSP
   client and a small ONVIF client feed the existing video path, which
   learns H.265 and more sound formats. No new program, one security gate,
   full control of the setup screens. Cost: we write and test the stream
   reader and the camera commands ourselves.
2. **Ship go2rtc as a helper.** Reads many brands at once, but brings its
   own web server and control panel to lock down, and has no pan/tilt.
3. **Ship ffmpeg.** Reads anything and could convert later, but it is
   large, carries licence and patent questions, and does nothing for
   pan/tilt or discovery.

The owner picked 1.

## How it works

### Camera drivers

Everything outside the driver talks to one interface. Today's `Camera`
class becomes the Kasa driver behind it.

```ts
interface CameraDriver {
  readonly kind: 'kasa' | 'onvif'; // later: cloud kinds
  readonly host: string;
  readonly info: { model?: string; name?: string };
  readonly source: MediaSource; // start/stop, events: frame, state, connected
  readonly ptz?: PtzControl; // absent = no pan/tilt
  relocate?(host: string): void;
  dispose(): Promise<void>;
}

interface PtzControl {
  readonly capability: PtzCapability;
  step(d: PtzDirection): Promise<void>;
  hold(d: PtzDirection): Promise<void>;
  stop(): Promise<void>;
  presets(): Promise<PtzPreset[]>;
  goToPreset(index: number): Promise<void>;
  dispose(): Promise<void>;
}
```

Kasa-only extras (the clock sync, the Linkie client, the Wi-Fi setup) stay
inside the Kasa driver and the Kasa setup code. `server.ts`, `routes/api.ts`
and `liveHub.ts` use only the interface.

Media frames carry their format:

- video: `{ kind: 'video', codec: 'h264' | 'h265', data, timestamp }`, one
  Annex-B access unit;
- audio: `{ kind: 'audio', codec: 'pcmu' | 'pcma' | 'aac', sampleRate,
config?, data, timestamp }`.

A later cloud driver may deliver video another way (Nest's newer cameras
only offer WebRTC). The interface does not need to cover that now, but
nothing in it should assume the server always sees raw frames forever:
keep the frame source behind `source` so a different delivery can be added
beside it.

### RTSP client (`apps/server/src/rtsp/`)

- RTSP 1.0 over TCP, with RTP interleaved on the same connection. No UDP.
- Basic and Digest auth. Credentials never in logs; log the URL without
  them.
- DESCRIBE, SETUP (video and the first audio track), PLAY, keepalive with
  GET_PARAMETER or OPTIONS at half the session timeout, TEARDOWN on stop.
- RTP depacketizing: H.264 (single NAL, STAP-A, FU-A), H.265 (single NAL,
  AP, FU), AAC (`mpeg4-generic`, AAC-hbr), PCMU and PCMA.
- Parameter sets from the SDP (`sprop-parameter-sets`, `sprop-vps/sps/pps`)
  and from the stream.
- Same reconnect behaviour as `CameraSource`: backoff, stall timeout, a
  clear message for 401 and for "too many viewers".
- Only private and loopback addresses unless `allowPublicHost` is set,
  same rule as today. No redirects followed.

### ONVIF client (`apps/server/src/onvif/`)

- Discovery: WS-Discovery Probe to 239.255.255.250:3702, collect
  ProbeMatches for a few seconds. Each result gives the device service
  address and a stable endpoint id (`urn:uuid:...`).
- SOAP 1.2 over HTTP with WS-Security UsernameToken (PasswordDigest). Read
  the camera clock first (`GetSystemDateAndTime`, no auth) and correct the
  `Created` time by the offset, since many cameras' clocks are wrong.
- Calls used: `GetDeviceInformation`, `GetCapabilities` or `GetServices`,
  `GetProfiles`, `GetStreamUri` (RTP-Unicast, RTSP), and for PTZ
  `ContinuousMove`, `Stop`, `RelativeMove` when supported, `GetPresets`,
  `GotoPreset`.
- XML parsed with entities and DTDs turned off. Answers are size-capped
  and time-limited.
- Hold = `ContinuousMove` in that direction until stop. Step = a short
  `ContinuousMove` then `Stop`, unless `RelativeMove` is supported.

### Picking the stream

A camera has several profiles, usually a main stream and a smaller
substream. My call: pick the main stream when it is 1080p or smaller,
otherwise the largest profile that is 1080p or smaller, and when two are
the same size prefer H.264. This keeps phones and the away-from-home link
from choking on 4K, while still playing H.265 when that is all there is.
Settings let the parent switch to another profile.

### Video and sound to the browser

- `liveHub` builds the fMP4 init segment for H.264 (as now) or H.265
  (`hvc1` with an `hvcC` box from VPS, SPS and PPS). The codec string in
  `CodecMessage.video.mimeType` follows (`hvc1.x.x.Lx.Bx`).
- If the browser says it can't play the type (`MediaSource.isTypeSupported`
  is false), the page shows: "This browser can't play this camera's video
  (H.265). Try another browser, or set the camera to H.264 in its own
  app." No conversion.
- `CodecMessage.audio.codec` becomes `'pcmu' | 'pcma' | 'aac'`, with the
  AAC config when needed. The browser decodes PCMA like PCMU (a table).
  AAC is decoded in the browser, so the sound meter and "Tap to listen"
  keep working. If the browser can't decode AAC, video plays without sound
  and the sound panel says so.

### Setup

The first setup screen gains a choice before today's Kasa choices:

```
Which camera do you have?
  [ Kasa ]                      -> today's screens, unchanged
  [ Another brand ]             Reolink, Tapo, Amcrest and others
```

Another brand:

1. "Make sure the camera is set up in its own app and on your Wi-Fi."
   A short brand-hint list underneath:
   - Tapo: in the Tapo app, create a "Camera account" (Advanced settings).
     Use that, not your Tapo login.
   - Reolink: turn on ONVIF and RTSP in the camera's network settings if
     they are off.
   - Others: use the camera's admin username and password.
2. Kasa Home searches (a few seconds) and lists cameras found:
   name or model, and address. "Not in the list? Type its address."
3. Username and password. Kasa Home checks them by reading the profiles.
   Wrong password, ONVIF off and no answer each get their own plain
   message.
4. Then the viewer password step and "All set", as for Kasa.

A camera with RTSP but no ONVIF: the "type its address" path also accepts
a full `rtsp://` address. That camera has no pan/tilt and is not followed
when its address changes.

### Settings

`settings.json`'s `camera` block gains `kind`, default `'kasa'`, so
existing files load unchanged. For `'onvif'` it holds `host`, `onvifPort`,
`deviceId` (the WS-Discovery endpoint id), `username`, `password`,
`profileToken`, and `rtspUrl` when typed by hand. The file is written
owner-only, as today. The Settings page shows the camera kind and model,
the stream choice, and "Change camera" (back to setup).

### Following the camera

When the ONVIF camera stops answering at its address, re-run discovery and
match `deviceId`, then relocate, like the Kasa driver does with its device
id.

## Security notes

- Camera passwords are stored like the Kasa password is today and never
  sent to the page.
- Only stream addresses on the camera's own host are accepted from
  `GetStreamUri`. A camera can't send the server elsewhere.
- XML parsing is hardened (no entities, size caps). RTSP and RTP lengths
  are checked against limits before buffering.
- Discovery answers are untrusted data: names are shown as text, never as
  HTML.
- The remote-access rules don't change: the new setup routes sit under
  `/api/setup/*`, which is already local only.

## Testing

- Unit tests for RTP depacketizing (H.264, H.265, AAC, PCMA), SDP parsing,
  Digest auth, the hvcC box, WS-Security digest, SOAP answers recorded from
  real cameras (anonymised).
- A fake ONVIF and RTSP camera in `apps/server/src/dev/`, like
  `fakeCamera.ts`, serving H.264 and H.265 test clips with AAC sound, PTZ
  that logs moves, and WS-Discovery replies. Test clips are made once with
  the dev machine's ffmpeg and committed small; ffmpeg is not needed to
  run tests.
- Server tests for the driver interface with both drivers, and that
  existing Kasa settings load as `kind: 'kasa'`.
- Web tests for the brand choice, the camera list, the error messages and
  the "can't play H.265" message.
- Hand check: the owner has only the Kasa camera. A real ONVIF camera
  (borrowed, or a cheap Tapo or Reolink) is needed before calling this
  done. Until then the fake camera is the proof.

## Left to the builder

- File layout inside `rtsp/` and `onvif/`, the backoff numbers, discovery
  wait time.
- How AAC is decoded in the browser, as long as the sound meter works.
- Whether to use an existing small XML parser or write a minimal one, as
  long as it is hardened as above.

## Decisions from the builder check

These were my calls, made from the brief (security first, then ease).

1. **Change camera keeps everything else.** The viewer password, paired
   phones, away-from-home and sound settings stay. The old camera block
   stays in use until the new camera's login is checked; only then is it
   replaced and the app reloaded. Kasa to another brand and back is
   allowed. The setup routes get a "change camera" mode that needs a
   signed-in local session, like onboarding after setup does today.
2. **Every ONVIF camera gets an identity, however it was added.** Store the
   WS-Discovery endpoint id when there is one, plus the serial number from
   `GetDeviceInformation` and the MAC from `GetNetworkInterfaces`. Following
   matches any of them. A typed-in ONVIF camera is followed too, when
   discovery can see it. Only a bare `rtsp://` camera is not followed.
3. **A stream address on another host is rewritten, not followed.** Keep
   the port and path from `GetStreamUri`, replace the host with the
   camera's known address. The server never connects to an address the
   camera named. A typed `rtsp://` address must itself be private.
4. **A format change mid-stream works like today's.** When the codec,
   size or sound format changes, viewers get a new codec message and init
   segment and the page rebuilds its player. Switching the profile in
   Settings saves settings and reloads, so viewers reconnect.
5. **Unsupported formats.** Sound in any other format: video plays, and
   the sound panel says "This camera's sound format isn't supported yet."
   Setup lists only profiles with H.264 or H.265 video; a camera with none
   gets "This camera's video format isn't supported."
6. **No profile at 1080p or smaller: use the smallest one.**
7. **Presets are read from the camera, not saved by Kasa Home.** The
   existing preset buttons list `GetPresets` in camera order, and the index
   maps to that list's token. No `SetPreset`. No presets means no buttons.
8. **SOAP auth tries WS-Security first, then HTTP Digest.** The working
   method is remembered for the session.
