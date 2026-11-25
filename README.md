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

## Set it up, step by step

This guide assumes no technical background. Follow the steps in order. Every
command goes into a terminal window. On a Mac, open the **Terminal** app; on
Linux, open **Terminal** from your applications menu. You type (or paste)
the command and press **Enter**.

### What you need

- The Kasa camera, plugged in.
- A computer that stays on while you want to watch. It runs Kasa Home, and
  every phone or tablet in the house can then watch through it. It must be
  connected to the same home network as the camera. Linux is tested; macOS
  should work the same way. Windows hasn't been tried.
- About 20 minutes.

### Step 1. Install Node.js

Node.js is the free program that runs Kasa Home.

1. Go to [nodejs.org](https://nodejs.org) and download the version marked
   **LTS**.
2. Run the installer and accept the defaults.
3. Check it worked. In a terminal, type:

   ```bash
   node --version
   ```

   You should see a version number such as `v24.11.0`. Any number of 22.12 or
   higher is fine.

### Step 2. Install pnpm

pnpm downloads the pieces Kasa Home is built from. In the terminal, type:

```bash
npm install -g pnpm@10
```

If you see a "permission denied" error on Mac or Linux, put `sudo` in front
(`sudo npm install -g pnpm@10`) and type your computer's password when asked.

### Step 3. Download Kasa Home

If you have `git` installed, type:

```bash
git clone https://github.com/meirgarfinkel/kasa-home.git
cd kasa-home
```

Without git, go to the [project page](https://github.com/meirgarfinkel/kasa-home),
click the green **Code** button, choose **Download ZIP**, and unzip it. Then
in the terminal, type `cd ` (with a space after it), drag the unzipped
folder onto the terminal window, and press Enter.

From here on, every command is typed inside this folder.

### Step 4. Install and build

```bash
pnpm install
pnpm build
```

This takes a minute or two. Warnings are fine; it has worked if it finishes
without the word `ERR`.

### Step 5. Create your settings file

Kasa Home reads its settings from a file named `.env` in this folder.
Create it from the example:

```bash
cp .env.example .env
chmod 600 .env
```

The second line makes the file private to your user account, because it
will hold passwords.

Open `.env` in a text editor. On a Mac, type `open -e .env`; on Linux, type
`xdg-open .env` or use any text editor. Find this line:

```ini
VIEWER_PASSWORD=
```

and put a password after the `=` sign, with no spaces around it. Anyone who
wants to watch the camera will type this password into the web page. It must
be at least 8 characters. For example:

```ini
VIEWER_PASSWORD=sleepy-owl-42
```

Save the file and leave it open. You'll come back to it in the next step.

### Step 6. Choose how your camera is set up

Pick the one option that describes you.

**Option A. The camera is already working in the Kasa phone app.**
Nothing to set up on the camera. In `.env`, fill in the email and password
you use to sign in to the Kasa app:

```ini
KASA_USERNAME=you@example.com
KASA_PASSWORD=your-kasa-password
```

Save the file and go to **Step 8**.

**Option B. A new or reset camera, linked to a TP-Link account.**
The camera is linked to a free TP-Link account, so the Kasa phone app works
with it too if you ever want it.

1. If you don't have a TP-Link account, create one in your browser at
   [myproducts.tp-link.com](https://myproducts.tp-link.com). Confirm it from
   the email TP-Link sends you.
2. In `.env`, fill in that account's email and password, as shown in
   option A, and save the file.
3. Go to **Step 7**.

**Option C. A new or reset camera, local only (no account at all).**
The camera is never linked to any account and never talks to TP-Link.
There are trade-offs:

- The camera keeps its built-in login, `admin` / `admin`. Anyone who is on
  your Wi-Fi and knows that could watch the camera directly, so only choose
  this if you trust everyone on your Wi-Fi.
- The Kasa phone app can't be used with it. To use the app later, reset the
  camera and set it up again with option B.

Leave `KASA_USERNAME` and `KASA_PASSWORD` empty and go to **Step 7**.

### Step 7. Put the camera on your Wi-Fi (options B and C only)

This step connects a new or reset camera to your Wi-Fi from your computer.
Your computer needs Wi-Fi for this step, even if it normally uses a cable.

> [!NOTE]
> During this step the camera is reset, so it records nothing until setup
> finishes. Your computer also leaves your home Wi-Fi for a minute or two.

1. In the terminal, type:

   ```bash
   pnpm setup-camera
   ```

2. It asks how to set up the camera. Type `1` for an account (option B) or
   `2` for local only (option C), then press Enter.
3. It asks you to reset the camera. Hold down the camera's **reset** button
   until it resets (the camera's manual says how long). After a minute, the
   camera starts its own setup Wi-Fi network, named something like
   `Kasa_Cam_1A2B`. Press Enter.
4. It switches your computer to the camera's setup Wi-Fi. On Linux this
   happens by itself, and you pick the `Kasa_Cam_...` network from a list. On a Mac,
   it asks you to join that network yourself from the Wi-Fi menu; it has no
   password. Press Enter once joined.
5. It lists the Wi-Fi networks the camera can see. Type the number of your
   home Wi-Fi, then its password. The camera only works on 2.4 GHz Wi-Fi. If
   your home network doesn't appear, your router may be broadcasting only
   5 GHz; check its settings.
6. Give the camera a name, such as `nursery`, and confirm with Enter.
7. Your computer returns to your home Wi-Fi (on a Mac, rejoin it yourself and
   press Enter). The command waits up to 2 minutes for the camera to appear
   on your network, then finishes setting it up.
8. For local only, it offers to save the camera's login into `.env`. Type
   `y` and press Enter.

When it prints `Done.`, the camera is ready.

### Step 8. Check Kasa Home can reach the camera

```bash
pnpm probe
```

This only reads from the camera. It never moves it or changes anything, and
it takes about 10 seconds. You're ready if the report includes both of these
lines:

- `Camera`, followed by your camera's name and model.
- `Stream (5 s)`, with more than 0 video frames.

If it stops with an error message instead, see
[If something goes wrong](#if-something-goes-wrong).

### Step 9. Start Kasa Home

```bash
pnpm start
```

Among the lines it prints, look for `Kasa Home is running`. That line
includes the address to open, such as `https://192.168.1.20:8090`. Keep the
terminal window open, because closing it stops Kasa Home. Step 11 shows how to keep
it running in the background.

### Step 10. Open Kasa Home on your phone or computer

1. On any phone, tablet or computer connected to your home Wi-Fi, open a
   browser and type the address from step 9, for example
   `https://192.168.1.20:8090`.
2. The browser warns that the connection isn't private or the certificate
   isn't trusted. This is expected. Kasa Home makes its own security
   certificate, and browsers only trust certificates issued by a company.
   The connection is still encrypted. Click **Advanced** (or **Show
   details**), then **Proceed** (or **visit this website**). Each browser
   asks only once.
3. Type the viewer password you chose in step 5.
4. Press the **Listen** button (a speaker icon) to turn on sound. Browsers
   need one tap before they play sound.

On a phone, you can use the browser's **Add to Home Screen** option to open the
monitor like an app.

### Step 11. Keep it running in the background (optional)

So far Kasa Home stops when you close the terminal or restart the
computer. On Linux, you can make it start by itself:

1. Find where Node.js is installed:

   ```bash
   which node
   ```

2. Create the file `~/.config/systemd/user/kasa-home.service` with the
   text below. Replace `/home/you/kasa-home` with this folder's location
   (type `pwd` in the folder to see it) and `/usr/bin/node` with the path
   from the previous step.

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

   The last line keeps it running even when you aren't logged in. To see
   its messages, type `journalctl --user -u kasa-home -f`.

On a Mac, a tool such as [pm2](https://pm2.keymetrics.io) can do the same
job.

### If something goes wrong

- **"No Kasa camera answered" or the camera isn't found.** Check the camera's
  light shows it's connected, and that the computer is on the same Wi-Fi
  network as the camera (not a guest network). `pnpm discover` lists every
  Kasa device the computer can see.
- **The login is rejected.** Check the email and password in `.env` are the
  ones for the account the camera is linked to, with no spaces around the
  `=` sign. If the password contains spaces or `#`, wrap it in single
  quotes: `KASA_PASSWORD='my pass#word'`.
- **"VIEWER_PASSWORD" error when starting.** Set a viewer password of at
  least 8 characters in `.env` (step 5).
- **The page doesn't open on a phone.** Make sure the phone is on your home
  Wi-Fi, not mobile data, and that you typed `https://` and the `:8090` at
  the end.
- **No sound.** Press the speaker button on the page; browsers block sound
  until you tap something. Check the phone isn't on silent.
- **`pnpm setup-camera` stops part way.** Reset the camera and run it again.
  The Kasa phone app can also set up the camera as usual, and Kasa Home
  works with it afterwards (option A).
- **After changing `.env`**, stop Kasa Home (press Ctrl+C in its terminal)
  and run `pnpm start` again, or with step 11 set up, type
  `systemctl --user restart kasa-home`.

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

All settings live in `.env`. See [.env.example](.env.example) for the full
list with explanations. The ones you might change:

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
