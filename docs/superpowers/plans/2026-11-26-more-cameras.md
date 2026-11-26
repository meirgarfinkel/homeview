# More cameras implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kasa Home watches ONVIF/RTSP cameras from other brands (H.264 or
H.265 video, G.711 or AAC sound, ONVIF pan/tilt), next to the existing Kasa
support, with one camera per install.

**Architecture:** A `CameraDriver` interface sits between the server and the
camera. Today's `Camera` becomes the Kasa driver; a new ONVIF driver combines
a TypeScript RTSP client (`apps/server/src/rtsp/`) and ONVIF client
(`apps/server/src/onvif/`). The media path (`liveHub`, `fmp4`) learns H.265
and more sound formats; the browser plays H.265 through MSE as it is and
decodes PCMA and AAC itself.

**Tech Stack:** TypeScript, Node 24, Fastify 5, zod, vitest, React (web),
`fast-xml-parser` (new, server only). ffmpeg only on the dev machine, once,
to make test clips.

**Spec:** `docs/superpowers/specs/2026-11-26-more-cameras-design.md`

## Global Constraints

- One camera per install. Kasa keeps working exactly as today; existing
  `settings.json` files with no `kind` load as `kind: 'kasa'`.
- No new helper program and no new network listener.
- No video or sound conversion. H.265 goes to the browser as `hvc1`.
- RTSP 1.0 over TCP with interleaved RTP only. No UDP, no RTSPS.
- The camera password never appears in logs, in a page, in an API answer or
  in an error message. Log RTSP URLs with the credentials removed.
- Only private and loopback camera addresses, unless `allowPublicHost` is
  set (same rule as the Kasa code). No HTTP or RTSP redirects followed.
- A stream address from `GetStreamUri` is never connected to as given: keep
  its port and path, replace the host with the camera's known host. A typed
  `rtsp://` address must itself pass the private-address rule.
- XML parsed with entities and DTDs off (`processEntities: false`), answers
  capped at 256 KiB, every camera call time-limited (10 s).
- New setup routes live under `/api/setup/*` (already local only).
- Copy rules: sentence case, plain words, no em dashes. Exact user-facing
  strings, used verbatim:
  - `"This browser can't play this camera's video (H.265). Try another browser, or set the camera to H.264 in its own app."`
  - `"This camera's sound format isn't supported yet."`
  - `"This camera's video format isn't supported."`
  - `"Make sure the camera is set up in its own app and on your Wi-Fi."`
  - `"Not in the list? Type its address."`
  - Tapo hint: `"Tapo: in the Tapo app, create a \"Camera account\" (Advanced settings). Use that, not your Tapo login."`
  - Reolink hint: `"Reolink: turn on ONVIF and RTSP in the camera's network settings if they are off."`
  - Other hint: `"Others: use the camera's admin username and password."`
- Stream pick rule: the main (first) profile if it is 1080p or smaller (height
  ≤ 1080), else the largest profile with height ≤ 1080, else the smallest
  profile; on equal size prefer H.264. Only H.264/H.265 profiles count.
- Presets come from `GetPresets` in camera order; index = position in that
  list. No `SetPreset`.
- SOAP auth: WS-Security UsernameToken PasswordDigest first, then HTTP
  Digest; remember the working one per client.
- Commits: author email `36854346+meirgarfinkel@users.noreply.github.com`,
  trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_014coFUwGw74CkTYA7BfwGKs`.
- Run tools through mise: `mise exec -- pnpm ...`. Full check:
  `mise exec -- pnpm check` (lint, format, typecheck, all tests).

## Review Focus

1. A camera that sends H.265 parameter sets only in the SDP and never
   in-band: video still starts (Task 2 and Task 5 tests).
2. A camera whose clock is years off: WS-Security still signs in, because
   `Created` is corrected by the offset (Task 6 test).
3. A camera that returns `rtsp://192.168.1.250:554/...` (its old NAT
   address) from `GetStreamUri`: the client connects to the known host with
   port and path kept (Task 6 test).
4. A camera that closes the RTSP connection every few minutes, or answers
   keepalive with 454 Session Not Found: the source reconnects and the
   viewer only sees a short "reconnecting" (Task 5 test).
5. Switching the camera from Kasa to ONVIF in a set-up install keeps the
   viewer password and paired phones, and a wrong ONVIF password leaves the
   old Kasa camera in use (Task 9 test).

---

## File structure

```
apps/server/src/camera/driver.ts         CameraDriver, PtzControl, MediaSource types
apps/server/src/camera/kasaDriver.ts     wraps kasa/Camera, watcher, time-zone sync
apps/server/src/camera/onvifDriver.ts    ONVIF + RTSP driver, following
apps/server/src/camera/onvifPtz.ts       PtzControl over ONVIF
apps/server/src/camera/createDriver.ts   picks a driver from Config
apps/server/src/media/h265.ts            H.265 NAL helpers, SPS parse
apps/server/src/media/fmp4.ts            + hvc1/hvcC, codec strings
apps/server/src/media/liveHub.ts         codec-aware keyframes, codec message
apps/server/src/rtsp/sdp.ts              SDP parse
apps/server/src/rtsp/depacketize.ts      RTP -> access units / audio frames
apps/server/src/rtsp/auth.ts             Basic + Digest
apps/server/src/rtsp/session.ts          one RTSP connection (DESCRIBE..TEARDOWN)
apps/server/src/rtsp/rtspSource.ts       FrameSource with reconnect
apps/server/src/onvif/xml.ts             hardened parse helpers
apps/server/src/onvif/soap.ts            envelope, WS-Security, Digest fallback
apps/server/src/onvif/device.ts          device/media/ptz calls
apps/server/src/onvif/discovery.ts       WS-Discovery probe
apps/server/src/onvif/pickProfile.ts     stream pick rule, host rewrite
apps/server/src/dev/fakeRtsp.ts          fake RTSP server (tests, dev)
apps/server/src/dev/fakeOnvif.ts         fake ONVIF device + discovery (tests, dev)
apps/server/src/scripts/fakeOnvifCamera.ts  `pnpm dev:fake-onvif`
apps/server/test/fixtures/clip-320x180.{h264,h265,aac,alaw}
apps/web/src/lib/g711.ts                 + decodeAlaw
apps/web/src/lib/aacDecoder.ts           WebCodecs AAC decoder
apps/web/src/components/setup/BrandChoice.tsx, OnvifSetup.tsx
apps/web/src/components/CameraSection.tsx  settings: kind, model, stream, change
```

---

### Task 1: Camera driver interface, Kasa behind it

No behaviour change. Everything outside `kasa/` and `camera/` talks to a
`CameraDriver`.

**Files:**

- Create: `apps/server/src/camera/driver.ts`, `apps/server/src/camera/kasaDriver.ts`, `apps/server/src/camera/createDriver.ts`
- Modify: `apps/server/src/kasa/cameraSource.ts` (frame types), `apps/server/src/media/liveHub.ts` (import types from `camera/driver.ts`), `apps/server/src/server.ts`, `apps/server/src/routes/api.ts`, `apps/server/src/routes/live.ts` if it names `Camera`, `packages/shared/src/index.ts`
- Test: `apps/server/test/kasaDriver.test.ts`, existing suites stay green

**Interfaces:**

- Produces (in `camera/driver.ts`):
  ```ts
  export type VideoCodec = 'h264' | 'h265';
  export type AudioCodec = 'pcmu' | 'pcma' | 'aac';
  export interface VideoFrame {
    kind: 'video';
    codec: VideoCodec;
    data: Buffer;
    timestamp: number;
  }
  export interface AudioFrame {
    kind: 'audio';
    codec: AudioCodec;
    sampleRate: number;
    channels: number;
    /** AAC AudioSpecificConfig. */ config?: Buffer;
    data: Buffer;
    timestamp: number;
  }
  export type MediaFrame = VideoFrame | AudioFrame;
  export interface FrameSource {
    /* moved unchanged from liveHub.ts */
  }
  export interface PtzControl {
    readonly capability: PtzCapability;
    step(d: PtzDirection): Promise<void>;
    hold(d: PtzDirection): Promise<void>;
    stop(): Promise<void>;
    presets(): Promise<PtzPreset[]>;
    goToPreset(index: number): Promise<void>;
    dispose(): Promise<void>;
  }
  export interface CameraDriver {
    readonly kind: CameraKind; // from shared
    readonly host: string;
    readonly source: FrameSource;
    readonly ptz: PtzControl | undefined; // undefined = no pan/tilt
    info(maxAgeMs?: number): Promise<CameraInfo>;
    /** Background work: following the camera, clock sync. Called once after the app is built. */
    start(): void;
    dispose(): Promise<void>;
  }
  ```
- Shared: `export type CameraKind = 'kasa' | 'onvif'`; `CameraInfo` gains `kind: CameraKind`, and `firmware` becomes optional.
- `createDriver(config: Config, logger: Logger, located?: LocatedCamera): CameraDriver` in `createDriver.ts`; Task 8 adds the ONVIF branch. `KasaDriver` keeps a public `camera: Camera` for Kasa-only routes and setup.
- `cameraSource.ts` re-exports `MediaFrame` from `camera/driver.ts` and emits `codec: 'h264'` / `codec: 'pcmu', sampleRate: 8000, channels: 1`.

- [ ] **Step 1: Write the failing test** `kasaDriver.test.ts` against the fake Kasa camera (`dev/fakeCamera.ts`, as `integration.test.ts` uses it):
  - `exposes kind kasa, the host, and a ptz control` → `driver.kind === 'kasa'`, `driver.ptz?.capability` defined.
  - `info() reports kind kasa` → `(await driver.info()).kind === 'kasa'`.
  - `frames carry their codec` → first video frame has `codec: 'h264'`, first audio frame `codec: 'pcmu', sampleRate: 8000, channels: 1`.
  - `start() follows the camera and dispose() stops it` → after `dispose()`, no watcher timers remain (use the existing watcher test pattern).
- [ ] **Step 2: Run** `mise exec -- pnpm --filter @kasa/server test kasaDriver` → FAIL (module missing).
- [ ] **Step 3: Implement.** Move `startCameraTasks`'s watcher and time-zone sync from `server.ts` into `KasaDriver.start()` and its timers into `dispose()`. `server.ts`'s `Instance.camera` becomes `driver: CameraDriver | undefined`. `routes/api.ts` treats `driver.ptz === undefined` exactly like a Kasa camera whose capability is `'unsupported'`: same status field, same error answers from the move and preset routes.
- [ ] **Step 4: Run** `mise exec -- pnpm check` → all green, server test count unchanged plus the new file.
- [ ] **Step 5: Commit** `Put the Kasa camera behind a camera driver interface`.

### Task 2: H.265 in the video path

**Files:**

- Create: `apps/server/src/media/h265.ts`, fixtures `apps/server/test/fixtures/clip-320x180.h265` (and `.h264`, `.aac`, `.alaw` for later tasks)
- Modify: `apps/server/src/media/fmp4.ts`, `apps/server/src/media/liveHub.ts`
- Test: `apps/server/test/h265.test.ts`, `apps/server/test/fmp4.test.ts`, `apps/server/test/liveHub.test.ts`

**Interfaces:**

- Produces in `h265.ts`: `H265NalType` (`VPS: 32, SPS: 33, PPS: 34, AUD: 35`, IRAP range 16..21), `h265NalType(nal): number` (`(nal[0] >> 1) & 0x3f`), `isH265Keyframe(nals: Buffer[]): boolean`, `parseH265Sps(nal: Uint8Array): { width: number; height: number; codec: string }` where `codec` is the MSE string, e.g. `hvc1.1.6.L93.B0`.
- `fmp4.ts`: `VideoTrackConfig` becomes `{ codec: 'h264'; width; height; sps: Buffer[]; pps: Buffer[] } | { codec: 'h265'; width; height; vps: Buffer[]; sps: Buffer[]; pps: Buffer[] }`; `initSegment` writes `hvc1` + `hvcC` for H.265.
- `liveHub` uses the frame's `codec` to split NALs, find parameter sets and keyframes, and builds `CodecMessage.video.mimeType` from the matching parser. A change of codec, size or parameter sets sends a new codec message and init segment, as today.

- [ ] **Step 1: Make fixtures once** (commit the outputs, keep each under 60 KB):
  ```bash
  cd apps/server/test/fixtures
  ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -t 2 -c:v libx265 -x265-params keyint=15:repeat-headers=1 -bsf:v hevc_mp4toannexb -f hevc clip-320x180.h265
  ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -t 2 -c:v libx264 -g 15 -bsf:v h264_mp4toannexb -f h264 clip-320x180.h264
  ffmpeg -f lavfi -i sine=frequency=440:sample_rate=16000 -t 2 -c:a aac -b:a 32k -f adts clip-16k.aac
  ffmpeg -f lavfi -i sine=frequency=440:sample_rate=8000 -t 2 -c:a pcm_alaw -f alaw clip-8k.alaw
  ```
- [ ] **Step 2: Write failing tests:**
  - `h265.test.ts`: `parses the SPS of the 320x180 clip` → `{ width: 320, height: 180 }` and `codec` matching `/^hvc1\.1\.\d+\.L\d+\.B0$/`; `finds VPS, SPS, PPS and an IRAP in the first access unit`; `parses a 1920x1080 SPS with conformance cropping to 1080, not 1088` (fixture `frame-1920x1080.h265`, made with the first command at `size=1920x1080` and `-frames:v 1`).
  - `fmp4.test.ts`: `H.265 init segment has hvc1 and hvcC with all three parameter-set arrays` (walk the boxes, assert `hvcC` holds 3 arrays with NAL types 32, 33, 34).
  - `liveHub.test.ts`: `an H.265 source produces a codec message with an hvc1 type and keyframe-aligned fragments`; `parameter sets given only once, before the first IRAP, still start the stream for a viewer who joins later` (Review Focus 1); `a switch from H.264 to H.265 sends a new codec message and init segment`.
- [ ] **Step 3: Run** `mise exec -- pnpm --filter @kasa/server test h265 fmp4 liveHub` → new tests FAIL.
- [ ] **Step 4: Implement** `h265.ts` (profile_tier_level and SPS parse per ITU-T H.265 7.3.2.2, reading only what width, height, cropping and the codec string need), `hvcC` per ISO/IEC 14496-15 8.3.3, and the codec-aware hub.
- [ ] **Step 5: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 6: Commit** `Play H.265 video as it is`.

### Task 3: More sound formats, and clear messages in the browser

**Files:**

- Modify: `packages/shared/src/index.ts` (`CodecMessage.audio`), `apps/server/src/media/liveHub.ts`, `apps/web/src/lib/g711.ts`, `apps/web/src/hooks/useLiveStream.ts`, `apps/web/src/lib/msePlayer.ts`, the sound panel component (`SoundMeter.tsx` or `Monitor.tsx`, where the sound controls render)
- Create: `apps/web/src/lib/aacDecoder.ts`
- Test: `apps/server/test/liveHub.test.ts`, `apps/web/src/lib/g711.test.ts`, `apps/web/src/lib/aacDecoder.test.ts`, `apps/web/src/hooks/useLiveStream.test.ts` (create if missing) or the component test that covers the stage

**Interfaces:**

- Shared: `CodecMessage.audio` becomes `{ codec: 'pcmu' | 'pcma' | 'aac'; sampleRate: number; channels: number; /** base64 AudioSpecificConfig, AAC only */ config?: string } | null`. `null` means "the camera's sound can't be played" (unsupported format or no sound track). `BinaryKind.Audio` payload: one encoded frame in the codec named (raw AAC access unit, no ADTS header).
- `liveHub` sends `audio: null` when the source reports an audio codec outside the three, and never forwards those frames.
- Web: `decodeAlaw(bytes: Uint8Array): Float32Array` in `g711.ts`; `createAacDecoder(config: Uint8Array, sampleRate: number, channels: number, onPcm: (pcm: Float32Array) => void): AacDecoder | undefined` (undefined when `globalThis.AudioDecoder` is missing or `AudioDecoder.isConfigSupported` says no), with `decode(frame: Uint8Array, timestampUs: number): void` and `close(): void`; mono mix-down of stereo before `onPcm`.
- `useLiveStream` exposes `soundUnsupported: boolean` and `videoUnsupported: boolean` (set when `msePlayer.reset` throws because `isTypeSupported` is false).

- [ ] **Step 1: Write failing tests:**
  - `g711.test.ts`: `decodeAlaw matches the G.711 table` (0xd5 → ~0, 0x55 → ~0, 0x2a → near -1, 0xaa → near +1; check the sign convention against the ITU table).
  - `aacDecoder.test.ts`: `returns undefined without WebCodecs`; with a stub `AudioDecoder` that reports two-channel `AudioData`, `mixes stereo to mono before onPcm`.
  - `liveHub.test.ts`: `codec message names pcma, 8000, 1 for an A-law source`; `codec message carries the AAC config as base64`; `an unsupported audio codec gives audio: null and drops those frames`.
  - web stage test: `shows the H.265 message when the browser can't play the type` (stub `MediaSource.isTypeSupported` → false; the exact Global Constraints string is visible); `shows "This camera's sound format isn't supported yet." when audio is null`; `AAC without WebCodecs shows the same sound message and video still plays`.
- [ ] **Step 2: Run** server and web tests for these files → FAIL.
- [ ] **Step 3: Implement.** Keep `PcmPlayer` and the sound meter fed with `Float32Array` whatever the codec; set the player's sample rate from the codec message.
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Play A-law and AAC sound, and say when a format can't play`.

### Task 4: SDP and RTP depacketizing

Pure functions, no network.

**Files:**

- Create: `apps/server/src/rtsp/sdp.ts`, `apps/server/src/rtsp/depacketize.ts`
- Test: `apps/server/test/rtsp/sdp.test.ts`, `apps/server/test/rtsp/depacketize.test.ts`

**Interfaces:**

- `parseSdp(text: string, baseUrl: string): SdpMedia[]` with `SdpMedia = { type: 'video' | 'audio'; payloadType: number; encoding: string /* upper-case, e.g. H264, H265, MPEG4-GENERIC, PCMU, PCMA */; clockRate: number; channels: number; control: string /* absolute URL */; fmtp: Record<string, string> }`.
- `parameterSetsFromFmtp(media: SdpMedia): Buffer[]` (H.264 `sprop-parameter-sets`; H.265 `sprop-vps`, `sprop-sps`, `sprop-pps`, in VPS, SPS, PPS order).
- `aacConfigFromFmtp(media): { config: Buffer; sampleRate: number; channels: number; sizeLength: number; indexLength: number; indexDeltaLength: number }`.
- `class VideoDepacketizer { constructor(codec: VideoCodec, clockRate: number); push(packet: RtpPacket): Buffer | undefined /* one Annex-B access unit when the marker bit or a timestamp change closes it */ }`.
- `class AudioDepacketizer { constructor(media: SdpMedia); push(packet: RtpPacket): Buffer[] /* encoded frames */ }`.
- `parseRtp(buf: Buffer): RtpPacket` (`{ payloadType, sequence, timestamp, marker, payload }`, skips CSRC and header extensions, strips padding).
- Limits: an access unit over 4 MiB is dropped with one warning; a sequence gap drops the access unit in progress and waits for the next one.

- [ ] **Step 1: Write failing tests.** Real SDP samples as string constants (write them from the spec of a Reolink-style H.264 + AAC answer, a Hikvision-style H.265 + PCMU answer, and a Tapo-style H.264 + PCMA answer; no real addresses: use `192.0.2.x`):
  - `sdp.test.ts`: `parses three answers into media with absolute control URLs` (relative `trackID=1`, absolute, and `*` control); `extracts H.265 parameter sets in VPS, SPS, PPS order`; `reads the AAC config, size and index lengths`.
  - `depacketize.test.ts`: packetize the fixture clips in the test with a small helper (`packetizeH264`, `packetizeH265`, `packetizeAac` in `test/rtsp/packetize.ts`, writing single-NAL, STAP-A/AP and FU-A/FU at MTU 1200), then assert `round-trips every H.264 access unit`, `round-trips every H.265 access unit`, `splits AAC-hbr packets with several AUs`, `PCMA payload passes through`, `a lost packet drops only that access unit`, `an access unit over 4 MiB is dropped`, `a header extension and padding are skipped`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per RFC 6184 (H.264), RFC 7798 (H.265), RFC 3640 (AAC-hbr), RFC 3551 (G.711).
- [ ] **Step 4: Run** `mise exec -- pnpm --filter @kasa/server test rtsp` → PASS.
- [ ] **Step 5: Commit** `Read video and sound out of RTP packets`.

### Task 5: RTSP client and stream source

**Files:**

- Create: `apps/server/src/rtsp/auth.ts`, `apps/server/src/rtsp/session.ts`, `apps/server/src/rtsp/rtspSource.ts`, `apps/server/src/dev/fakeRtsp.ts`
- Test: `apps/server/test/rtsp/auth.test.ts`, `apps/server/test/rtsp/rtspSource.test.ts`

**Interfaces:**

- `auth.ts`: `authorizationFor(challenge: string /* WWW-Authenticate */, method: string, uri: string, username: string, password: string, nc?: number): string` (Basic, and Digest MD5 with and without `qop=auth`).
- `RtspSourceOptions = { url: string /* rtsp://host:port/path, no credentials */; username: string; password: string; allowPublicHost: boolean; logger: Logger; stallTimeoutMs?: number; connectTimeoutMs?: number }`.
- `class RtspSource extends EventEmitter implements FrameSource` with `start()`, `stop()`, `state`, `setHost(host: string)` (keeps port and path), events `frame`, `state`, `connected` exactly as `CameraSource`. Video frames carry `codec`; audio frames carry `codec`, `sampleRate`, `channels`, `config` (AAC). An audio track in another encoding is set up only if it is PCMU, PCMA or MPEG4-GENERIC; otherwise frames are emitted with that encoding name lower-cased as `codec` so the hub sends `audio: null` (Task 3).
- Errors: 401 after one auth retry → `StreamAuthError('The camera rejected the username or password.')`; 453 or 503 → `StreamBusyError` (reuse the Kasa classes from `cameraSource.ts`, moved to `camera/driver.ts`); a 3xx answer → an error, not followed.
- Keepalive: `GET_PARAMETER` (fall back to `OPTIONS` if the camera answered `OPTIONS` without `GET_PARAMETER` in `Public`) at half the `Session` timeout, default 60 s → 30 s. TEARDOWN on stop, best effort, 1 s.
- `fakeRtsp.ts`: `startFakeRtsp(opts: { video: 'h264' | 'h265'; audio?: 'aac' | 'pcma' | 'pcmu' | 'g726'; username: string; password: string; auth: 'basic' | 'digest'; sdpParameterSetsOnly?: boolean; dropAfterMs?: number; sessionNotFoundOnKeepalive?: boolean }): Promise<{ port: number; url: string; close(): Promise<void>; connections: number }>`, serving the Task 2 fixtures in a loop over TCP interleaved RTP, using the test packetizers from Task 4 moved to `src/dev/packetize.ts` (the test file re-exports them).

- [ ] **Step 1: Write failing tests:**
  - `auth.test.ts`: `Basic header`; `Digest per RFC 2617 example` (the "Mufasa" vector); `Digest with qop=auth increments nc`.
  - `rtspSource.test.ts` against `startFakeRtsp`: `goes live with H.264 + AAC and emits both`; `goes live with H.265 and parameter sets only in the SDP` (Review Focus 1: the first emitted video frame contains VPS, SPS, PPS NALs); `Digest auth works`; `wrong password → state error with the plain message, retried at the long auth interval`; `the password never appears in any log line` (capture the pino output, search for the password); `reconnects after the camera drops the connection` and `reconnects when keepalive gets 454` (Review Focus 4: `connections` reaches 2, state goes live again); `refuses a public host unless allowPublicHost` (`rtsp://8.8.8.8/...` → error, no socket opened); `stop() sends TEARDOWN and emits idle`; `g726 audio yields frames whose codec the hub rejects` (codec `g726`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `node:net`, a line-based response parser with a 64 KiB header cap and the `$`-framed interleaved reader (4-byte header, length ≤ 65535).
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Add an RTSP client that feeds the live view`.

### Task 6: ONVIF client

**Files:**

- Modify: `apps/server/package.json` (add `fast-xml-parser`, exact current version)
- Create: `apps/server/src/onvif/xml.ts`, `soap.ts`, `device.ts`, `discovery.ts`, `pickProfile.ts`, `apps/server/src/dev/fakeOnvif.ts`
- Test: `apps/server/test/onvif/soap.test.ts`, `device.test.ts`, `discovery.test.ts`, `pickProfile.test.ts`

**Interfaces:**

- `soap.ts`: `class SoapClient { constructor(opts: { deviceUrl: string; username: string; password: string; allowPublicHost: boolean; logger: Logger; now?: () => Date }); call(serviceUrl: string, body: string /* inner XML */): Promise<XmlNode> }`. Reads `GetSystemDateAndTime` once (no auth) to set the clock offset; signs with WS-Security PasswordDigest (`Base64(SHA1(nonce + created + password))`); on a SOAP `NotAuthorized` fault or HTTP 401 retries once with HTTP Digest, then remembers the mode. Errors are typed: `OnvifAuthError`, `OnvifUnreachableError`, `OnvifFaultError(code, reason)`.
- `xml.ts`: `parseXml(text: string): XmlNode` (fast-xml-parser with `processEntities: false`, `removeNSPrefix: true`, `ignoreAttributes: false`; rejects input containing `<!DOCTYPE` or over 256 KiB) and `child(node, ...path): XmlNode | undefined`, `text(node): string | undefined`.
- `device.ts`: `class OnvifDevice` with `static connect(opts): Promise<OnvifDevice>` (gets services or falls back to `GetCapabilities`), and `info(): Promise<{ manufacturer; model; firmware; serial; hardwareId }>`, `macAddress(): Promise<string | undefined>`, `profiles(): Promise<OnvifProfile[]>`, `streamUri(token: string): Promise<string>` (host already rewritten, see below), `hasPtz: boolean`, `continuousMove(token, x: number, y: number): Promise<void>`, `stop(token): Promise<void>`, `relativeMove(token, x, y): Promise<void>` (throws `OnvifFaultError` when unsupported), `presets(token): Promise<{ token: string; name: string }[]>`, `gotoPreset(token, presetToken): Promise<void>`.
  `OnvifProfile = { token: string; name: string; codec: 'h264' | 'h265' | 'other'; width: number; height: number; hasPtz: boolean }`.
- `pickProfile.ts`: `pickProfile(profiles: OnvifProfile[]): OnvifProfile | undefined` (the Global Constraints rule) and `rewriteStreamHost(uri: string, knownHost: string): string` (keeps scheme `rtsp:`, port (default 554) and path+query; drops user info).
- `discovery.ts`: `discoverOnvif(opts: { timeoutMs?: number /* default 3000 */; targets?: string[]; port?: number; logger: Logger }): Promise<DiscoveredOnvif[]>`, `DiscoveredOnvif = { endpointId: string; xaddr: string; host: string; name?: string; hardware?: string }`, from WS-Discovery ProbeMatches (Types `dn:NetworkVideoTransmitter`), deduplicated by `endpointId`, private hosts only. Names come from `onvif://www.onvif.org/name/...` scopes, URL-decoded, max 64 chars.
- `fakeOnvif.ts`: `startFakeOnvif(opts: { username; password; auth: 'ws-security' | 'digest'; clockSkewMs?: number; profiles: OnvifProfile[]; streamUri: string; ptz?: boolean; presets?: string[]; serial: string; mac: string; endpointId: string; discoveryPort?: number }): Promise<{ deviceUrl: string; moves: string[]; close(): Promise<void> }>`.

- [ ] **Step 1: Write failing tests:**
  - `soap.test.ts`: `PasswordDigest matches the ONVIF spec example`; `a camera clock 3 years ahead still accepts the request` (Review Focus 2: fake with `clockSkewMs: 3 * 365 * 86400_000`); `falls back to HTTP Digest and remembers it` (the second call makes no WS-Security attempt); `a wrong password gives OnvifAuthError`; `rejects a DOCTYPE answer`; `rejects an answer over 256 KiB`; `a redirect is an error`; `times out after 10 s` (fake timers).
  - `device.test.ts`: `reads info, MAC, profiles and a stream URI`; `the stream URI points at the known host` (Review Focus 3: fake answers `rtsp://192.168.1.250:8554/h265Preview_01_main`, the device was reached on `127.0.0.1` → `rtsp://127.0.0.1:8554/h265Preview_01_main`); `ptz moves are sent with the profile token`.
  - `pickProfile.test.ts`: `main 1080p H.265 is kept`; `main 4K, sub 640x360 H.264 and 1080p H.265 → 1080p`; `two 1080p, H.264 preferred`; `only 4K and 5MP → the smaller one`; `only MJPEG → undefined`.
  - `discovery.test.ts`: send a probe to the fake on a test port; `returns endpoint id, host and decoded name`; `drops a public xaddr`; `deduplicates repeated matches`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Add an ONVIF client for discovery, streams and pan/tilt`.

### Task 7: ONVIF driver and pan/tilt

**Files:**

- Create: `apps/server/src/camera/onvifDriver.ts`, `apps/server/src/camera/onvifPtz.ts`
- Test: `apps/server/test/onvifDriver.test.ts`, `apps/server/test/onvifPtz.test.ts`

**Interfaces:**

- `OnvifCameraConfig = { host: string; onvifPort: number; username: string; password: string; profileToken?: string; rtspUrl?: string; identity: { endpointId?: string; serial?: string; mac?: string } }` (Task 8 puts this on `Config.camera.onvif`).
- `class OnvifDriver implements CameraDriver` (`kind: 'onvif'`), `static create(cfg: OnvifCameraConfig, opts: { allowPublicHost: boolean; logger: Logger; discovery?: { targets?: string[]; port?: number } }): Promise<OnvifDriver>`. With `rtspUrl` and no ONVIF: `ptz` undefined, no following. `info()` maps to `CameraInfo` (`alias` = discovery name or model, `model`, `firmware`, `host`, `resolution` = `${w}x${h}` of the chosen profile, `kind: 'onvif'`).
- Following: `start()` checks reachability every 30 s; after 2 failures it runs `discoverOnvif`, matches `endpointId`, else `serial` (via `GetDeviceInformation` on each candidate), else `mac`, and on a match calls `source.setHost` and rebuilds the SOAP client.
- `class OnvifPtz implements PtzControl`: `capability` `'supported'` when the profile has PTZ, else the driver gives `ptz: undefined`. `hold(d)` = `continuousMove` with velocity 0.5 in that direction, auto-stopped after the same hold deadline Kasa uses (`ptz.ts`); `step(d)` = `relativeMove` 0.1 if supported, else `continuousMove` 0.5 for 300 ms then `stop`; `presets()` = camera order mapped to `{ index, name }`; `goToPreset(i)` uses the token at position `i`, out of range → the same error type Kasa throws for a bad index.

- [ ] **Step 1: Write failing tests** with `startFakeOnvif` + `startFakeRtsp`:
  - `onvifDriver.test.ts`: `goes live with the picked profile` (fake profiles 4K main + 1080p H.265 → frames come from the 1080p URI); `uses a saved profileToken over the pick rule`; `info() reports kind onvif, model and resolution`; `an rtspUrl-only camera plays and has no ptz`; `follows the camera to a new port/host by endpointId` (restart the fake on a new address with the same endpoint id, discovery targets pointed at it, assert `driver.host` changes and the stream comes back); `follows by serial when there is no endpointId`.
  - `onvifPtz.test.ts`: `hold sends ContinuousMove then Stop on stop()`; `step uses RelativeMove when supported, else a short ContinuousMove and Stop`; `presets keep camera order and goToPreset uses that token`; `goToPreset out of range throws`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Add the ONVIF camera driver with pan/tilt and following`.

### Task 8: Settings, config and picking the driver

**Files:**

- Modify: `apps/server/src/settings/` store schema and save, `apps/server/src/config.ts`, `apps/server/src/camera/createDriver.ts`, `apps/server/src/server.ts`
- Test: `apps/server/test/settingsStore.test.ts`, `apps/server/test/configSettings.test.ts`, `apps/server/test/server.test.ts`

**Interfaces:**

- Settings `camera` gains `kind: z.enum(['kasa', 'onvif']).optional()` (missing = `'kasa'`) and, for ONVIF, `onvif: { host; onvifPort; profileToken?; rtspUrl?; identity: { endpointId?; serial?; mac? } }`. Username and password stay in the existing fields with the same protector (`passwordProtected`).
- `Config.camera` gains `kind: CameraKind` and `onvif?: OnvifCameraConfig`. `setupComplete` is true for ONVIF when a viewer password and `onvif` with username and password exist.
- `createDriver` builds `OnvifDriver` for `kind: 'onvif'`; Kasa discovery (`locateCamera`) runs only for Kasa.

- [ ] **Step 1: Write failing tests:** `a settings file without kind loads as kasa` (use a copy of a real pre-change file shape); `an onvif camera round-trips with the password protected, never plain on disk`; `config marks setup complete for an onvif camera`; `server.test: an onvif settings file starts an OnvifDriver against the fakes and /api/status reports live`; `server.test: /api/camera answers kind onvif`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Save and start ONVIF cameras from settings`.

### Task 9: Setup and change-camera routes

**Files:**

- Modify: `apps/server/src/routes/setup.ts`, `apps/server/src/routes/settings.ts`, `packages/shared/src/index.ts`
- Test: `apps/server/test/setupRoutes.test.ts`, `apps/server/test/settingsRoutes.test.ts`, `apps/server/test/remoteGate.test.ts`

**Interfaces (shared types and routes):**

- `POST /api/setup/onvif/scan` → `{ cameras: { endpointId: string; host: string; name?: string }[] }`.
- `POST /api/setup/onvif/check` body `{ host: string; port?: number; username: string; password: string } | { rtspUrl: string; username: string; password: string }` → `{ model?: string; profiles: { token: string; name: string; codec: 'h264' | 'h265'; width: number; height: number }[]; picked: string }` or errors `400 { error: 'bad-address' }`, `401 { error: 'camera-login' }`, `422 { error: 'video-format' }` (no H.264/H.265 profile), `504 { error: 'no-answer' }`, `502 { error: 'onvif-off' }` (HTTP answers but no ONVIF service). Nothing is saved.
- `POST /api/setup/onvif/save` same body plus `profileToken?: string` → checks again, saves the camera block (`kind: 'onvif'`) keeping every other setting, then reloads. Before setup it is open like `existing-camera`; after setup it needs a signed-in session from this computer (`isLocalRequest` and authenticated), else 403.
- `POST /api/setup/kasa-camera` after setup: the existing `existing-camera` logic in change-camera mode, same auth rule, so ONVIF can switch back to Kasa.
- `POST /api/settings/camera-profile` `{ profileToken }` (ONVIF only, local signed-in) saves and reloads.
- The camera password is never in any answer.

- [ ] **Step 1: Write failing tests:**
  - `scan lists the fake camera`; `check returns profiles and the picked token`; `check maps each failure to its error code` (wrong password, MJPEG only, closed port, HTTP server without ONVIF); `save stores kind onvif and reloads`; `save after setup without a local session → 403`; `change camera keeps the viewer password, paired phones and sound settings` and `a wrong password on save keeps the old Kasa camera in use` (Review Focus 5); `switching back to Kasa works`; `no answer contains the camera password` (serialize every response body in the suite and search); `remoteGate: /api/setup/onvif/* through the tunnel → 403`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Add setup and change-camera routes for other brands`.

### Task 10: Setup screens and the camera settings section

**Files:**

- Create: `apps/web/src/components/setup/BrandChoice.tsx`, `apps/web/src/components/setup/OnvifSetup.tsx`, `apps/web/src/components/CameraSection.tsx`, tests next to each
- Modify: `apps/web/src/components/setup/SetupWizard.tsx`, `apps/web/src/components/Settings.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/app.css`

**Interfaces:**

- Wizard steps become `'password' | 'brand' | 'choice' | 'existing' | 'account' | 'local' | 'onvif'`. `BrandChoice` shows heading "Which camera do you have?" and two buttons: "Kasa" and "Another brand" with the line "Reolink, Tapo, Amcrest and others". Kasa → today's `CameraChoice`.
- `OnvifSetup` steps: (1) the "Make sure..." line and the three hint lines, verbatim; (2) scanning (button "Search again"), list of found cameras (name or "Camera", address), the link "Not in the list? Type its address." opening one field that accepts an address or an `rtsp://` URL; (3) username and password, "Connect", then on success the picked stream shown as "1920×1080, H.265" with a "Change" select listing all profiles; (4) save → `onDone`. Error copy per code:
  - `camera-login`: "The camera didn't accept that username or password."
  - `onvif-off`: "The camera answered, but ONVIF looks turned off. Turn it on in the camera's own app."
  - `no-answer`: "No answer from that address. Check the camera is on and on the same Wi-Fi."
  - `video-format`: the Global Constraints string for video format.
  - `bad-address`: "That doesn't look like a camera address."
- `CameraSection` in Settings (computer only): kind and model ("Reolink E1 Pro, other brand" or "Kasa KC410S"), for ONVIF the stream select (saves via `camera-profile`), and "Change camera" which opens `BrandChoice` → the matching flow in change mode; cancel returns to Settings without changes.

- [ ] **Step 1: Write failing tests:** `BrandChoice routes Kasa to today's choice and Another brand to OnvifSetup`; `OnvifSetup shows the hints verbatim`; `lists scanned cameras and connects to the chosen one`; `typed rtsp URL goes to check`; `each error code shows its message`; `stream select shows size and codec and sends the token`; `CameraSection Change camera then cancel changes nothing` (no POST made); `existing SetupWizard tests still pass with the extra brand step`.
- [ ] **Step 2: Run** `mise exec -- pnpm --filter @kasa/web test` → FAIL.
- [ ] **Step 3: Implement**, following the existing setup screens' structure, `useHeadingFocus` and CSS classes.
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green.
- [ ] **Step 5: Commit** `Add setup screens for other camera brands`.

### Task 11: Fake ONVIF camera for development, end-to-end test, README

**Files:**

- Create: `apps/server/src/scripts/fakeOnvifCamera.ts`, `apps/server/test/onvifIntegration.test.ts`
- Modify: `apps/server/package.json` (`"fake-onvif": "tsx src/scripts/fakeOnvifCamera.ts"`), root `package.json` (`"dev:fake-onvif": "pnpm --filter @kasa/server fake-onvif"`), `README.md`

**Interfaces:**

- The script starts `startFakeOnvif` + `startFakeRtsp` on 127.0.0.1 (ONVIF HTTP 18080, RTSP 18554, discovery 13702), H.265 + AAC, PTZ with presets "Crib" and "Door", user `admin` / password from `FAKE_ONVIF_PASSWORD` or `fake-onvif`, and prints the address.
- README: a "Cameras from other brands" section: which brands are known to work through ONVIF and RTSP, the three hints, that cloud-only cameras (Ring, Nest, Arlo, most Wyze) are not supported, and the H.265 browser note.

- [ ] **Step 1: Write the failing test** `onvifIntegration.test.ts`: a server with no camera; run setup through `/api/setup/password`, `/api/setup/onvif/scan` (discovery pointed at the fake), `/check`, `/save`; then a WebSocket viewer on `/api/live` gets a codec message with an `hvc1` type and an `aac` audio codec, an init segment, and media fragments; `POST /api/ptz/move` hold right then stop shows `ContinuousMove` and `Stop` in `moves`; presets list "Crib", "Door".
- [ ] **Step 2: Run** → FAIL until the script's pieces are wired; then implement the script and fix anything the end-to-end path shows.
- [ ] **Step 3: Write the README section.**
- [ ] **Step 4: Run** `mise exec -- pnpm check` → green. Then by hand: `mise exec -- pnpm dev:fake-onvif` in one shell and the server in another, go through setup in a browser, and confirm video, sound and pan/tilt.
- [ ] **Step 5: Commit** `Add a fake ONVIF camera, an end-to-end test and README notes`.
