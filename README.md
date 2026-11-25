# Kasa Home

Watch and listen to a TP-Link Kasa camera in any web browser on your home
Wi-Fi. You don't need the Kasa phone app, and nothing goes through the
internet. It was built to use a Kasa Spot Pan Tilt (KC410S) as a baby
monitor.

- Live video and sound in the browser, with a sound meter and an alert when
  it gets loud
- Pan and tilt the camera with on-screen buttons or the arrow keys
- Fullscreen, picture-in-picture and snapshots
- Works on phones, tablets and computers on your home network
- Protected by a password of your choice

## Install from the downloads

You don't need a terminal for any of this. You need the camera, plugged in,
and a computer that stays on while you want to watch. That computer runs
Kasa Home, and every phone or tablet in the house watches through it. It
must be on the same home Wi-Fi or network as the camera. Plan on about 20
minutes.

### 1. Download the file for your computer

Pick one file from the [latest release](https://github.com/meirgarfinkel/kasa-home/releases/latest). All releases are on the
[Releases page](https://github.com/meirgarfinkel/kasa-home/releases).

| Your computer                    | File                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Windows                          | [Kasa-Home-Setup.exe](https://github.com/meirgarfinkel/kasa-home/releases/latest/download/Kasa-Home-Setup.exe)             |
| Mac (Apple Silicon or Intel)     | [Kasa-Home.dmg](https://github.com/meirgarfinkel/kasa-home/releases/latest/download/Kasa-Home.dmg)                         |
| Linux, any distribution          | [Kasa-Home-x86_64.AppImage](https://github.com/meirgarfinkel/kasa-home/releases/latest/download/Kasa-Home-x86_64.AppImage) |
| Linux, Ubuntu, Debian or similar | [kasa-home.deb](https://github.com/meirgarfinkel/kasa-home/releases/latest/download/kasa-home.deb)                         |

The files are not signed with a paid developer certificate, so Windows and
macOS warn you once. The steps below say what to click.

### 2. Install it

**Windows.** Double-click `Kasa-Home-Setup.exe`. Windows may show "Windows
protected your PC". Click "More info", then "Run anyway". The installer
needs no administrator password. It installs for your user only and adds
Start menu and desktop shortcuts.

**Mac.** Double-click `Kasa-Home.dmg` and drag Kasa Home to Applications.
Open it from Applications. macOS says it can't verify the app. Click
"Done", open System Settings, go to "Privacy & Security", scroll down, and
click "Open Anyway" next to Kasa Home. Enter your Mac password if asked.
You need macOS 12 or newer. Kasa Home shows only in the menu bar, with no
Dock icon.

**Linux, AppImage.** Right-click the file, choose "Properties", then
"Permissions", and turn on "Allow executing file as program" (in some file
managers the item is "Run as a program"). Then double-click the file.

**Linux, .deb.** Double-click the file and choose "Install" in the software
installer. Then open Kasa Home from your applications menu.

### 3. Open Kasa Home and follow the pages

Kasa Home opens your browser on a welcome page, on this computer only.

1. "Welcome to Kasa Home". Choose a password of at least 8 characters and
   click "Next". Everyone who watches will type it, on any phone or computer.
2. "Your camera". Choose the line that fits.
   - "It already works in the Kasa app". Type your Kasa email and password,
     click "Connect", and pick the camera if more than one shows.
   - "It's new or reset, and I have a TP-Link account". The camera links to
     a free TP-Link account, so the Kasa phone app works with it too. No
     account yet? Create one at
     [myproducts.tp-link.com](https://myproducts.tp-link.com) first, and
     confirm it from the email TP-Link sends you. The next page, "Your
     TP-Link account", asks for that account's email and password.
   - "It's new or reset, and I don't want an account". The camera never
     links to any account and never talks to TP-Link. The cost is that it
     keeps its built-in `admin` / `admin` login, so anyone on your Wi-Fi who
     knows it could watch the camera directly. Choose this only if you trust
     everyone on your Wi-Fi. The Kasa phone app can't be used with it. To use
     the app later, reset the camera and set it up again with an account.
3. For a new or reset camera, the page then walks you through the camera
   setup. The camera records nothing until it finishes.
   - "Reset the camera". Hold the camera's reset button until it resets
     (its manual says how long). After about a minute it starts its own
     Wi-Fi network, named like `Kasa_Cam_1A2B`. Click "The camera is reset".
   - Linux joins the camera's network by itself. On a Mac or Windows the page
     says "Join the camera's Wi-Fi". Open this computer's Wi-Fi menu and join
     the network named like `Kasa_Cam_1A2B`. It has no password. The page
     carries on by itself once you have.
   - "Choose your home Wi-Fi". Pick your network, type its password, and
     name the camera, for example `nursery`. The camera only works on
     2.4 GHz Wi-Fi. If your network is missing, your router may broadcast
     only 5 GHz, so check its settings.
   - On a Mac or Windows, "Rejoin your home Wi-Fi" asks you to switch this
     computer back. The page then waits up to 2 minutes for the camera to
     join your Wi-Fi.
4. "All set" shows the live picture and a QR code.

On Windows, a prompt may ask whether to allow Kasa Home on networks. Allow
it on private networks, or phones can't connect.

### 4. Watch on phones and other computers

1. On the "All set" page, scan the QR code with the phone's camera, or type
   the address under it, for example `https://192.168.1.20:8090`. The phone
   must be on your home Wi-Fi, not mobile data.
2. The phone warns that the connection isn't private. This is expected. Kasa
   Home makes its own security certificate, and browsers only trust
   certificates issued by a company. The connection is still encrypted. Tap
   "Advanced", then "Proceed" (or "visit this website"). Each browser asks
   only once.
3. Type the password you chose.
4. Press the speaker button to turn on sound. Browsers need one tap before
   they play sound.

On the computer that runs Kasa Home, use `http://localhost:8090` instead.
That address gives no certificate warning. If port 8090 is taken, Kasa Home
uses the next free port, up to 8099, and the "All set" page shows the real
address. On a phone, "Add to Home Screen" in the browser menu opens the
monitor like an app.

### 5. Change things later and keep it running

The tray icon (the menu bar on a Mac) has four items:

- "Open Kasa Home" opens the page in your browser.
- "Start with this computer" starts Kasa Home when you log in. It is also a
  checkbox on the "All set" page and in Settings.
- "Show logs" opens the log file, which helps when asking for help.
- "Quit" stops Kasa Home. Nobody can watch until you open it again.

Open the Settings page with the gear button on the monitor. On the computer
itself it lets you change the viewer password, the camera login, set up a
new or reset camera ("Set up a camera"), turn on starting with the computer
and stop Kasa Home ("Stop Kasa Home").

Some Linux desktops show no tray icon. Stock GNOME, for example on Fedora,
needs an AppIndicator extension. Without one, open Kasa Home again from your
applications menu to get the page, and use "Stop Kasa Home" in Settings to
quit.

If you forget the viewer password, open the login page on the computer
itself and click "Forgot it? Set a new password". Phones can't do this.

Kasa Home keeps its settings and logs in this folder:

| System  | Folder                                    |
| ------- | ----------------------------------------- |
| Linux   | `~/.config/Kasa Home`                     |
| Windows | `%APPDATA%\Kasa Home`                     |
| macOS   | `~/Library/Application Support/Kasa Home` |

### If something goes wrong

- **A phone shows "Kasa Home isn't set up yet".** Finish setup on the
  computer that runs Kasa Home. Setup pages answer only that computer.
- **The page doesn't open on a phone.** Make sure the phone is on your home
  Wi-Fi, not mobile data, and that the address starts with `https://` and
  ends with the port, for example `:8090`.
- **No picture, or the camera isn't found.** Check the camera's light shows
  it's connected, and that the computer is on the same Wi-Fi network as the
  camera, not a guest network.
- **Windows or the Mac won't open the installer.** See step 2. Both warnings
  appear once and are expected for unsigned apps.
- **No tray icon on Linux.** See step 5.
- **No sound.** Press the speaker button on the page, because browsers block
  sound until you tap something. Check the phone isn't on silent.
- **The camera setup stops part way.** Click "Try again" if the page offers
  it, or reset the camera and start over. The Kasa phone app can also set up
  the camera as usual, and Kasa Home then works with it ("It already works
  in the Kasa app").
- **Anything else.** Open the tray menu, choose "Show logs", and read the end of
  the file.

## Run from source

This is for people comfortable with a terminal, and for the Linux systemd
setup. The installed app and `pnpm start` are separate. The app never reads
`.env`. `pnpm start` reads `.env`, and any variable set there or in the
environment overrides the matching value in `settings.json`.

You need [Node.js](https://nodejs.org) 22.12 or newer (the LTS version) and
pnpm 10. Linux is tested. macOS should work the same way, and Windows hasn't
been tried.

```bash
npm install -g pnpm@10   # add sudo on Mac or Linux if you get "permission denied"
git clone https://github.com/meirgarfinkel/kasa-home.git
cd kasa-home
pnpm install
pnpm build
cp .env.example .env
chmod 600 .env           # the file holds passwords
```

Open `.env` and set at least these, with no spaces around the `=` sign.
Put values containing spaces or `#` in single quotes.

```ini
VIEWER_PASSWORD=sleepy-owl-42        # 8 or more characters
KASA_USERNAME=you@example.com        # Kasa account email, or the camera's own login
KASA_PASSWORD=your-kasa-password
```

For a new or reset camera, run `pnpm setup-camera` and answer the prompts.
Choose `1` for an account or `2` for local only. It resets the camera,
switches your computer to the camera's Wi-Fi (Linux does this by itself, on a
Mac you join `Kasa_Cam_1A2B` yourself), asks for your home Wi-Fi name and
password, and waits up to 2 minutes for the camera to appear. The camera
needs 2.4 GHz Wi-Fi, and this computer needs Wi-Fi for this step. For local
only, answer `y` when it offers to save the camera's login into `.env`. It
prints `Done.` when finished.

Then check and start:

```bash
pnpm probe   # reads from the camera only; expect a "Camera" line and "Stream (5 s)" with frames
pnpm start   # look for "Kasa Home is running", which includes the address to open
```

`pnpm discover` lists every Kasa device the computer can see. Keep the
terminal open, because closing it stops Kasa Home. After changing `.env`,
stop it with Ctrl+C and run `pnpm start` again.

### Keep it running in the background (Linux)

1. Find Node.js with `which node`, and this folder with `pwd`.
2. Create `~/.config/systemd/user/kasa-home.service` with the text below,
   replacing `/home/you/kasa-home` and `/usr/bin/node` with your paths.

   ```ini
   [Unit]
   Description=Kasa Home
   Wants=network-online.target
   After=network-online.target

   [Service]
   WorkingDirectory=/home/you/kasa-home
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node apps/server/dist/index.js
   Restart=on-failure
   RestartSec=10
   UMask=0077

   [Install]
   WantedBy=default.target
   ```

3. Turn it on:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now kasa-home
   loginctl enable-linger "$USER"
   ```

   The last line keeps it running when you aren't logged in. View its
   messages with `journalctl --user -u kasa-home -f`, and restart it after a
   `.env` change with `systemctl --user restart kasa-home`. On a Mac, a tool
   such as [pm2](https://pm2.keymetrics.io) can do the same job.

### Troubleshooting for source installs

- **"No Kasa camera answered".** Run `pnpm discover`, and check the computer
  is on the camera's Wi-Fi network, not a guest network.
- **The login is rejected.** Check the email and password in `.env` match the
  account the camera is linked to, with no spaces around `=`.
- **"VIEWER_PASSWORD" error when starting.** Set a viewer password of at
  least 8 characters in `.env`.
- **`pnpm setup-camera` stops part way.** Reset the camera and run it again.

## Which cameras work

Tested with a KC410S on firmware 2.3.27. Other plug-in Kasa cameras that use
the same local protocol (Kasa `IOT.IPCAMERA` models such as the KC100,
KC105, KC110, KC115, KC120, KC125, KC200, KC400, KC401, KC411S, KC420WS,
EC60, EC70, EC71 and KD110) will probably show video and sound. Pan and tilt
appear only on cameras that can move. Battery cameras that connect through a
Kasa hub (the KC300/KC310 family) and Tapo-brand cameras use a different
system and don't work. `pnpm probe` tells you within seconds whether a
camera works.

## Settings

The desktop app stores its settings in `settings.json` in its data folder and
changes them from the Settings page. `pnpm start` reads `.env`, which wins
over `settings.json`. See [.env.example](.env.example) for the full list with
explanations. The ones you might change:

| Setting                  | Default            | What it does                                                        |
| ------------------------ | ------------------ | ------------------------------------------------------------------- |
| `KASA_USERNAME`          | (required)         | Kasa account email, or the camera's login for local-only setup      |
| `KASA_PASSWORD`          | (required)         | The matching password                                               |
| `VIEWER_PASSWORD`        | (required)         | Password for the web page, 8+ characters                            |
| `KASA_HOST`              | found by itself    | Pin the camera's IP address (normally found and followed by itself) |
| `KASA_ALIAS`             |                    | Which camera to use when there are several, by name                 |
| `KASA_STREAM_RESOLUTION` | camera default     | `2560x1440`, `2304x1296`, `1080P`, `720P` or `360P`                 |
| `PORT`                   | `8090`             | Web page port                                                       |
| `HTTPS`                  | `true`             | Serve the page over HTTPS with its own or a supplied certificate    |
| `TLS_CERT_FILE`          |                    | Use your own certificate (e.g. from mkcert), with `TLS_KEY_FILE`    |
| `ALLOWED_CIDRS`          | this machine's LAN | Networks allowed to open the page                                   |
| `PTZ_STEP_SPEED`         | `2`                | How far one tap moves the camera, 1 to 10                           |
| `KASA_TIMEZONE`          | this computer's    | Time zone for the camera's clock and the time shown on the video    |

Kasa Home finds the camera on its own and follows it if its IP address
changes. Before switching to a new address, it checks the camera's security
certificate matches, so another device can't pretend to be the camera. It
also keeps the camera's clock in this computer's time zone and rechecks every
hour, so daylight saving changes are picked up.

## Security

The page shows a live camera, so it is locked down by default:

- **Local network only.** Kasa Home refuses requests from outside this
  computer's home network, including Docker and VPN interfaces.
- **HTTPS** for video, sound, the password and the login cookie.
- **Password required.** The server won't start without `VIEWER_PASSWORD`
  unless you set `ALLOW_NO_PASSWORD=true`. Logins use signed, HttpOnly,
  `SameSite=Strict` cookies, and the server slows down repeated wrong
  passwords.
- **No DNS rebinding or cross-site use.** The server rejects unknown `Host`
  headers, cross-origin WebSockets and cross-origin POSTs, and sends a strict
  Content-Security-Policy.
- **Credentials stay on the server.** The server never sends them to the
  browser, never logs them, and never sends them to a camera address outside
  your network. It stores its generated secrets in `data/`, readable only by
  your user.
- **Nothing goes to the cloud.** The server only talks to the camera and to
  your browsers.

Don't port-forward this server to the internet.

The camera's own local protocol is weak, and this project can't change that:

- The camera checks the password as an unsalted MD5 hash.
- Control commands are only scrambled, not encrypted.
- Its encryption has no forward secrecy.
- It tells anyone on your network the location set in the Kasa app.
- It gives out your Wi-Fi password in plain text to anyone with the camera's
  login.

So:

- Use a unique Kasa password with two-step verification turned on.
- Turn off UPnP on your router.
- If you can, put cameras on their own network.

## How it works

```text
Kasa camera ──HTTPS :19443──▶ server ──WebSocket (fMP4 + G.711)──▶ browser (MSE + Web Audio)
            ◀─HTTPS :10443──         ◀──────── REST (pan/tilt) ──────────
```

The server pulls the camera's multipart H.264/G.711 stream, wraps each video
frame in a fragmented-MP4 segment and sends it to every viewer over a
WebSocket. The browser plays it with Media Source Extensions and plays the
sound through Web Audio. Only one connection to the camera is open, however
many people watch. [docs/PROTOCOL.md](docs/PROTOCOL.md) describes the
camera's protocol, including how `pnpm setup-camera` works.

```text
apps/server     Fastify server: camera client, fMP4 muxer, live hub, API
apps/web        React + Vite single-page app
packages/shared Types shared by both (WebSocket and API messages)
docs/           Camera protocol notes
```

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
same protocol, so they need no real camera or credentials. To rehearse
`pnpm setup-camera` without a camera, run
`FAKE_CAMERA_SETUP=1 pnpm dev:fake-camera` and follow what it prints.

## Disclaimer

This is an independent project, not affiliated with or endorsed by TP-Link.
Kasa is a trademark of TP-Link. The protocol was worked out for
interoperability with hardware you own; no TP-Link code is included.

## License

[MIT](LICENSE)
