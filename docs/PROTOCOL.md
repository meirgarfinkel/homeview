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

| Method                  | Args                                                                                                                            | Notes                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `set_move`              | `{direction, speed}`                                                                                                            | Starts continuous motion until `set_stop` |
| `set_stop`              | `{}`                                                                                                                            |                                           |
| `get_position`          | `{}`                                                                                                                            | Returns `{x, y}`                          |
| `set_target`            | `{x, y}`                                                                                                                        | Absolute move (not used here)             |
| `get_all_preset`        | `{}`                                                                                                                            | `{maximum, preset_attr:[{index, name}]}`  |
| `set_run_to_preset`     | `{index}`                                                                                                                       | `index` is an integer                     |
| `get_ptz_rectify_state` | `{}`                                                                                                                            | `{rectify_status}`                        |
| also                    | `add_preset`, `edit_preset`, `delete_preset`, `get/set_patrol_is_enable`, `get/set_ptz_tracking_is_enable`, `set_motor_rectify` |                                           |

- `direction`: `top`, `bottom`, `left`, `right`, `top left`, `top right`,
  `bottom left`, `bottom right`.
- `speed` is an integer **1–10**. 11 and above return `err_code -41203`
  ("parameter value error"). Omitting `speed` returns `-41202` ("parameter
  format error").

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
