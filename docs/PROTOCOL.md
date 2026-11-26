# Kasa camera local protocol

Notes on how a TP-Link Kasa camera talks on the local network, as used by this
project. Verified against a **KC410S (US), firmware 2.3.27**. Other
`IOT.IPCAMERA` models (KC100, KC110, KC120, KC200, KC400, KC401, KC420WS, EC60,
EC70, EC71, KD110) appear to use the same protocol, but only the KC410S was
tested.

Sources: live testing, earlier community work (go2rtc, ha-kasa-camera-local,
kasa-legacy-camera, hkubota's KC120 notes), and the names of classes, fields
and strings in the Kasa Android app 3.4.703. No TP-Link code is included in
this repository.

## Ports

| Port  | Protocol | Purpose                                            |
| ----- | -------- | -------------------------------------------------- |
| 9999  | UDP      | Discovery (`get_sysinfo`), no authentication       |
| 10443 | HTTPS    | LINKIE.json control API                            |
| 19443 | HTTPS    | Live audio/video stream, speaker (talk-back) input |

Both HTTPS ports use a self-signed certificate. TLS 1.2 with RSA key exchange
(`TLS_RSA_WITH_AES_256_GCM_SHA384`), so there is no forward secrecy.

## The XOR "cipher"

Discovery and the control API obfuscate JSON with an autokey XOR:

```text
key = 0xAB
encrypt: for each byte b: key = key ^ b; out = key
decrypt: for each byte c: out = c ^ key; key = c
```

This is obfuscation only. The key is a public constant.

## Discovery (UDP 9999)

Broadcast `xor('{"system":{"get_sysinfo":{}}}')` to port 9999. Cameras answer
with an XOR'd JSON reply, unauthenticated. Fields of interest under
`system.get_sysinfo.system`:

- `alias`, `model`, `sw_ver`, `type` (`IOT.IPCAMERA`), `mac`, `deviceId`
- `c_opt`: password encodings the camera accepts (see below)
- `resolution`, `camera_switch` (`off` = privacy mode), `led_status`
- `latitude` / `longitude`: the location set in the Kasa app. **Anyone on the
  LAN can read this.**

## Authentication

HTTP Basic on both HTTPS ports:

```text
Authorization: Basic base64("<kasa account email>:<encoded password>")
```

The encoding comes from `c_opt` (app class `DeviceCipherHelper`). The app picks
the highest supported value:

| `c_opt` | Encoding                   |
| ------- | -------------------------- |
| 0       | `base64(password)`         |
| 1       | `md5(password)`, lowercase |

The KC410S reports `[0, 1]` and accepts MD5. An unauthenticated control
request returns HTTP 200 with `{"err_code":-10007,"err_msg":"Unauthorized Error"}`.
The stream port returns HTTP 401 with `WWW-Authenticate: Basic realm="smarthome@tp-link.com"`.

## Control API: `POST https://<cam>:10443/data/LINKIE.json`

- Body: `application/x-www-form-urlencoded`, single field
  `content=<base64(xor(json))>`
- Response body: `base64(xor(json))`

Request shape:

```json
{
  "smartlife.cam.ipcamera.<module>": { "<method>": { "...": "args" } },
  "context": { "source": "<any uuid>" }
}
```

The reply mirrors that shape, with `err_code` 0 on success.

Modules present in the app: `OSD`, `audio`, `battery`, `camSchedule`, `cloud`,
`dateTime`, `dayNight`, `debug`, `delivery`, `dndSchedule`, `intelligence`,
`led`, `motionDetect`, `p2p`, `ptz`, `relay`, `rtp`, `sdCard`, `siren`,
`soundDetect`, `switch`, `system`, `upgrade`, `upnpc`, `videoControl`, `vod`,
`wireless`.

### Pan/tilt: `smartlife.cam.ipcamera.ptz`

| Method                  | Args                                                                                                                            | Notes                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `set_move`              | `{direction, speed}`                                                                                                            | One fixed step (see below)               |
| `set_stop`              | `{}`                                                                                                                            | Halts any motion at once                 |
| `get_position`          | `{}`                                                                                                                            | Returns `{x, y}`                         |
| `set_target`            | `{x, y}`                                                                                                                        | Smooth absolute move                     |
| `get_all_preset`        | `{}`                                                                                                                            | `{maximum, preset_attr:[{index, name}]}` |
| `set_run_to_preset`     | `{index}`                                                                                                                       | `index` is an integer                    |
| `get_ptz_rectify_state` | `{}`                                                                                                                            | `{rectify_status}`                       |
| also                    | `add_preset`, `edit_preset`, `delete_preset`, `get/set_patrol_is_enable`, `get/set_ptz_tracking_is_enable`, `set_motor_rectify` |                                          |

- `direction`: `top`, `bottom`, `left`, `right`, `top left`, `top right`,
  `bottom left`, `bottom right`.
- Each `set_move` is **one fixed step**, not continuous motion: about 55
  position units at speed 2 and 100 at speed 6 on a KC410S. Steps sent while
  one is running are queued; `set_stop` clears the queue.
- `set_target` glides smoothly at a fixed ~450 units/s (a `speed` argument
  is accepted and ignored). A target past the edge is clamped to the end of
  travel, which on a KC410S is x ±1934 and y ±387. HomeView holds a
  direction by targeting the far edge, and releases with `set_stop`.
- `set_stop` takes effect immediately, mid-step or mid-glide.
- Timing matters more than it looks. The camera sends `Connection: close`
  on every reply, so each request needs a new TLS handshake (~0.5 s), and
  while a handshake is running the camera answers nothing else for about
  1.2 s. A connection opened ahead of time and left idle (the camera keeps
  them for at least 30 s) answers in 20–60 ms. So HomeView keeps a few
  pre-connected sockets while pan/tilt is in use, holds one back for
  `set_stop`, and replaces used ones only when nothing is moving.
- `speed` is an integer **1–10**. 11 and above return `err_code -41203`
  ("parameter value error"). Omitting `speed` returns `-41202` ("parameter
  format error").

## Setting up a camera (onboarding)

The Kasa app's camera command list (`LinkieCameraCommand`) includes the
commands needed to set up a camera. The full setup flow below was verified on
a factory-reset KC410S (fw 2.3.27); commands not used by it come from the app
and are untested.

| Module (`smartlife.cam.ipcamera.*`) | Method                                                          | Fields                                                                       |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `cloud`                             | `get_info` (**verified**)                                       | → `binded`, `username`, `cld_connection`                                     |
| `cloud`                             | `set_bind`, `set_unbind`                                        | `username`, `password`                                                       |
| `wireless`                          | `set_start_scan`                                                | `band`, `scan_type`                                                          |
| `wireless`                          | `get_ap_list`                                                   | `band`, `scan` → `ap_info[]`                                                 |
| `wireless`                          | `get_uplink` (**verified**)                                     | → `uplink_info[]`: `ssid`, `passphrase`, `band`, `wpa_mode`, `encryption`    |
| `wireless`                          | `set_uplink`                                                    | `ssid`, `passphrase`, `band`, `wpa_mode`, `encryption`, `key_index`, `apply` |
| `wireless`                          | `set_apply_changes`                                             | `delay`                                                                      |
| `system`                            | `get_onboarding_status` (**verified**), `set_onboarding_status` | `value` (`"done"` when set up)                                               |
| `system`                            | `set_alias`                                                     | `value`                                                                      |
| `system`                            | `set_dev_location`                                              | `latitude`, `longitude`                                                      |
| `system`                            | `set_change_local_password`                                     | `c_opt`, `passphrase`                                                        |
| `system`                            | `set_reset_config`                                              | `isfullreset`                                                                |

On the KC410S, `wireless.get_connect_status` returns `-10008` (unsupported),
and `get_uplink` returns the Wi-Fi password in plain text to any client with
the account login. Values seen on a WPA2 network: `band: "2G"`,
`wpa_mode: "WPA2_PSK"`, `encryption: "AES"`.

A camera in setup mode broadcasts its own **open** Wi-Fi, named like
`Kasa_Cam_1A2B`. The KC410S answers there at `192.168.0.10` (the app's code
also mentions `192.168.191.1` and `192.168.0.1`). Verified on a reset KC410S:

- The login is `admin` / `admin`, with the password MD5-encoded as usual.
- `wireless.get_ap_list` works after `set_start_scan`. `wpa_mode` values seen
  include `WPA2_PSK` and `WPA_AUTO`.
- `set_uplink` rejects `key_index: "0"` with `-31006` ("The parameter
  [key_index] error."). `key_index` is a WEP field; leave it out. Accepted:
  `{ssid, passphrase, band: "2G", wpa_mode: "WPA2_PSK", encryption: "AES", apply: true}`.
  The camera then leaves its setup network and joins the home Wi-Fi within
  about a minute.
- On the home network the setup login still works. `system.set_alias` and
  `system.set_onboarding_status {value: "done"}` succeed with it.
- `cloud.set_bind {username, password}` takes the account password **as
  typed** (not MD5). From then on the camera accepts only the account login. The camera
  has no internet there, so the app sends the Wi-Fi details first and links the
  account (`set_bind`) only once the camera is on the home network.

Not yet tested: whether a camera that's never linked (local-only) streams
video, and models other than the KC410S.

`pnpm setup-camera` and the desktop app's setup pages implement this flow. The
desktop app drives it with the state machine in
[apps/server/src/setup/onboarding.ts](../apps/server/src/setup/onboarding.ts). For other models it still tries a
few fallbacks (another `key_index`, MD5 for `set_bind`) and reports which
worked.

## Clock and on-screen time

| Module (`smartlife.cam.ipcamera.*`) | Method                                     | Fields                                   |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `dateTime`                          | `get_status`, `get_time`, `get_time_zone`  | → `epoch_sec`, `timezone`, `area`        |
| `dateTime`                          | `set_time_zone`                            | `timezone` (`"UTC+2:00"`), `area` (IANA) |
| `OSD`                               | `get_time_is_enable`, `set_time_is_enable` | `value`: `"on"` / `"off"`                |
| `OSD`                               | `get_logo_is_enable`, `set_logo_is_enable` | `value`: `"on"` / `"off"`                |

All verified on a KC410S. After a factory reset its time zone is
`UTC+0:00` / `GMT` and the on-screen time is `off`. The clock itself is set
over NTP. `timezone` is a fixed offset, so HomeView re-sends it when
daylight saving changes.

## Live stream: `GET https://<cam>:19443/https/stream/mixed`

Query, as the app builds it (`TPLocalStreamingClient`):
`video=H264&resolution=<res>&audio=G711`, with `deviceId=` only for child
devices. `resolution` is one of `2560x1440`, `2304x1296`, `1080P`, `720P`, `360P`.
The app also sends an `X-PLAYER-ID` header.

The response is `multipart/x-mixed-replace;boundary=data-boundary--`. Some
models send it with chunked transfer encoding, and the response's
Content-Length should be ignored. Each part carries:

- `Content-Type: video/x-h264`: one H.264 Annex-B access unit. The KC410S sends
  2560×1440 Main profile level 5.0 (`avc1.4d0032`) at about 14 fps.
- `Content-Type: audio/g711u`: G.711 mu-law, 8 kHz mono.
- `Content-Length`, and a timestamp in `X-Timestamp` (go2rtc) or
  `X-CurrentFrameTimestamp` (app). The app also reads `X-FrameRate`,
  `X-IsTracking`, `X-IsPatrolOn` and `X-CurrentPresetId`.

HTTP 503 means too many simultaneous viewers.

Related paths in the app: `/https/stream/keepalive`, and
`/https/speaker/audio/%sblock` for talk-back (POST,
`multipart/x-mixed-replace;boundary=audio-boundary--`, parts
`Content-Type: audio/<codec>`, with an empty `audio/heartbeat` part to keep it
open). Talk-back is not implemented here.
