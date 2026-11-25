# Kasa Monitor

Watch and listen to a TP-Link Kasa camera from any browser on your home
network, without the Kasa app and without the cloud. Built for using a Kasa
Spot Pan Tilt (KC410S) as a baby monitor.

- Live video in the browser (H.264, no plugins, no transcoding)
- Live audio with a level meter and a "sound detected" alert
- Pan/tilt: tap to nudge, hold to keep moving (buttons or arrow keys), presets
- Finds the camera by itself and follows it if its IP address changes
- Keeps the camera's clock in this computer's time zone
- Fullscreen, picture-in-picture and snapshots
- One camera connection shared by every open screen
- Local network only, HTTPS, password protected

Tested with a KC410S on firmware 2.3.27. Other Kasa `IOT.IPCAMERA` models
probably work for video. Pan/tilt needs a pan/tilt model.

## How it works

```text
Kasa camera ──HTTPS :19443──▶ server ──WebSocket (fMP4 + G.711)──▶ browser (MSE + Web Audio)
            ◀─HTTPS :10443──         ◀──────── REST (pan/tilt) ──────────
```

The server pulls the camera's multipart H.264/G.711 stream, wraps each video
frame in a fragmented-MP4 segment and fans it out over a WebSocket. The browser
plays it with Media Source Extensions and plays the audio through Web Audio.
The camera's protocol is described in [docs/PROTOCOL.md](docs/PROTOCOL.md).

```text
apps/server     Fastify server: camera client, fMP4 muxer, live hub, API
apps/web        React + Vite single-page app
packages/shared Types shared by both (WebSocket and API messages)
docs/           Camera protocol notes
```

## Requirements

- Node.js 22.12 or newer (`mise.toml` and `.nvmrc` pin 24) and pnpm 10
- The computer and the camera on the same network
- The email and password of the Kasa account the camera belongs to

## Setup

```bash
pnpm install
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```ini
KASA_USERNAME=you@example.com
KASA_PASSWORD=your-kasa-password
VIEWER_PASSWORD=a-password-for-the-web-page
```

Check that the camera is reachable and the credentials work:

```bash
pnpm discover   # lists Kasa devices on the network
pnpm probe      # checks login, stream and pan/tilt (never moves the camera)
pnpm setup-camera  # sets up a new or reset camera without the app
```

Build and run:

```bash
pnpm build
pnpm start
```

Then open `https://<this-computer's-ip>:8090` on any device on your network.
Plain `http://` links redirect to HTTPS. The first visit shows a certificate
warning because the server makes its own certificate; accept it once per
browser. The server log prints the certificate fingerprint so you can check
it.

To keep it running in the background, use your system's service manager
(systemd, launchd, pm2, Docker and so on) to run `pnpm start` in this folder.

## Setting up a new camera without the app

`pnpm setup-camera` puts a new or factory-reset camera on your Wi-Fi from this
computer, no phone needed. It:

1. joins this computer to the camera's setup Wi-Fi (automatically with
   NetworkManager's `nmcli` on Linux, otherwise it asks you to);
2. shows the Wi-Fi networks the camera can see and sends it your network's
   name and password;
3. rejoins your home Wi-Fi, finds the camera there, names it, and links it to
   your TP-Link account. You can choose local-only instead, which never links
   it to an account;
4. sets the camera's clock to this computer's time zone and turns on the
   time shown on the video, as the Kasa app does;
5. for local-only, offers to save the camera's login to `.env`. No address is
   saved: the monitor finds the camera by itself.

You need a TP-Link ID to link an account; one can be created in a browser at
[myproducts.tp-link.com](https://myproducts.tp-link.com). Local-only needs no
account, but leaves the camera on its default `admin`/`admin` login, which
anyone on your Wi-Fi could use.

Tested start to finish on a factory-reset KC410S, linked to an account.
Local-only setup and other models haven't been tried on real hardware yet. If
it fails part-way, the Kasa app can still set the camera up as usual. Details
in [docs/PROTOCOL.md](docs/PROTOCOL.md#setting-up-a-camera-onboarding).

To rehearse without a camera, run `FAKE_CAMERA_SETUP=1 pnpm dev:fake-camera`
and follow what it prints.

## Configuration

All settings live in `.env`. See [.env.example](.env.example) for the full
list. The important ones:

| Variable                 | Default            | Meaning                                                          |
| ------------------------ | ------------------ | ---------------------------------------------------------------- |
| `KASA_USERNAME`          | (required)         | Kasa account email                                               |
| `KASA_PASSWORD`          | (required)         | Kasa account password                                            |
| `VIEWER_PASSWORD`        | (required)         | Password for the web page, 8+ characters                         |
| `KASA_HOST`              | discovered         | Pin the camera IP (normally found and followed automatically)    |
| `KASA_ALIAS`             |                    | Which camera to use when there are several                       |
| `KASA_STREAM_RESOLUTION` | camera default     | `2560x1440`, `2304x1296`, `1080P`, `720P` or `360P`              |
| `PORT`                   | `8090`             | Web server port                                                  |
| `HTTPS`                  | `true`             | Serve HTTPS with a self-signed or supplied certificate           |
| `TLS_CERT_FILE`          |                    | Use your own certificate (e.g. from mkcert), with `TLS_KEY_FILE` |
| `ALLOWED_CIDRS`          | this machine's LAN | Client networks allowed to connect                               |
| `PTZ_STEP_SPEED`         | `2`                | Pan/tilt speed for a tap, 1–10                                   |
| `KASA_TIMEZONE`          | this computer's    | Time zone for the camera's clock and on-video timestamp          |

## Security

The page shows a live camera, so it is locked down by default:

- **Local network only.** Requests from outside this machine's LAN subnet are
  refused, including from Docker and VPN interfaces.
- **HTTPS** for video, audio, the password and the session cookie.
- **Password required.** The server will not start without `VIEWER_PASSWORD`
  unless you set `ALLOW_NO_PASSWORD=true`. Sessions are signed, HttpOnly,
  `SameSite=Strict` cookies; login attempts are rate-limited.
- **No DNS rebinding or cross-site use.** Unknown `Host` headers, cross-origin
  WebSockets and cross-origin POSTs are rejected, and a strict
  Content-Security-Policy is sent.
- **Credentials stay on the server.** They are never sent to the browser, never
  logged, and never sent to a non-LAN camera address. Generated secrets are
  stored in `data/` with owner-only permissions.
- **Nothing goes to the cloud.** The server only talks to the camera and to
  your browsers.

Do not port-forward this server to the internet.

The camera's own local protocol is weak, and this project can't change that:

- The password is checked as an unsalted MD5 hash.
- Control commands are only obfuscated.
- Its TLS has no forward secrecy.
- It tells anyone on the LAN the location set in the Kasa app.
- It returns your Wi-Fi password in plain text to anyone with the Kasa login.

Recommendations:

- Use a unique Kasa password with two-step verification turned on.
- Turn off UPnP on your router.
- If you can, put cameras on their own network.

## Development

```bash
pnpm dev              # API server (tsx watch) + Vite on http://127.0.0.1:5173
pnpm dev:fake-camera  # optional: a simulated camera on 127.0.0.1
pnpm test             # unit + integration tests (uses a fake camera; ffmpeg optional)
pnpm lint
pnpm typecheck
pnpm format
pnpm check            # all of the above, as CI would run them
```

The integration tests run against an in-process fake camera that speaks the
same protocol, so no real camera or credentials are needed.

## Disclaimer

This is an independent project, not affiliated with or endorsed by TP-Link.
Kasa is a trademark of TP-Link. The protocol was worked out for
interoperability with hardware you own; no TP-Link code is included.

## License

[MIT](LICENSE)
