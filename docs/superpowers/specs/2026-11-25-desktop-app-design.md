# Kasa Home desktop app: design

Status: draft for review, 2026-11-25.

## Intent

Parents who have never opened a terminal should be able to run Kasa Home.
Today it needs Node.js, pnpm, git, a hand-edited `.env` file, terminal
commands to set up the camera, and a hand-written service file to keep it
running. The goal is the homepix model: one download per system, installed
like any other app, with everything else done on a page in the browser.

The computer that runs it is both the server and an occasional screen.
Usually people watch on their phones; sometimes on the computer itself. Its
own screen is the same web page in the normal browser, not a separate
window.

## Goals

- Installers for Linux (AppImage and .deb), Windows (installer) and macOS
  (disk image), built and published by GitHub on a version tag.
- No terminal at any point: install, open, and a browser page walks the
  parent through setup.
- First-run setup in the browser: choose the viewer password, then connect
  the camera, one of three ways:
  - it already works in the Kasa app (enter the Kasa email and password);
  - new or reset camera, linked to a TP-Link account (with the sign-up link
    `https://myproducts.tp-link.com`);
  - new or reset camera, local only.
- New or reset cameras are put on the Wi-Fi from the browser, replacing
  `pnpm setup-camera`'s terminal prompts.
- A finished page that shows the live video, the address for phones, and a
  QR code for it.
- A settings page to change the viewer password and camera login later.
- A tray icon (menu bar on macOS) with **Open monitor**, **Start with this
  computer** and **Quit**.

## Non-goals

- Phone apps. Phones keep using the web page.
- Automatic updates. People download the new installer; settings are kept.
- Code signing. As with homepix, Windows shows "Windows protected your PC"
  and macOS asks to allow the app once. The README explains both.
- Automatic Wi-Fi switching on macOS and Windows during camera setup. The
  page tells the parent which network to join and detects when they have.
  (Linux switches by itself, as `pnpm setup-camera` does now.)

## Anti-goals

These would make it a failure even if it technically worked:

- Any step that needs a terminal or editing a file.
- Anyone else on the Wi-Fi being able to reach the setup page before the
  parent has chosen a password, and claim Kasa Home.
- Breaking the current way of running it (`pnpm start`, `.env`, systemd).
- A browser security warning on the very first page the parent sees.

## Constraints

- The camera's setup Wi-Fi has no internet and a different network, so the
  computer itself must do camera setup. A phone can't.
- Kasa Home's page uses a self-signed HTTPS certificate. Each browser warns
  about it once. Phones can't avoid this. The computer itself can, because
  traffic to `localhost` never leaves the machine.
- On Linux, tray icons need AppIndicator support. Ubuntu and most desktops
  have it; stock GNOME (e.g. Fedora) shows no tray icon without an
  extension. Everything the tray does must also be possible without it.
- Unsigned apps: see non-goals.
- Electron runs the server inside its main process, using Electron's bundled
  Node. All server dependencies are plain JavaScript, so nothing needs
  rebuilding for Electron.

## Approaches considered

- **A. Electron, tray icon only (chosen).** The server runs inside the app.
  The app has no window of its own; it opens the normal browser. One tool,
  electron-builder, makes all four installers and handles start-at-login
  and single instance. About 90–120 MB.
- **B. Bundled plain Node, no tray.** About 40–60 MB, but start-at-login,
  packaging and "is it running?" all need hand-written per-system code, and
  nothing on screen shows that it's running.
- **C. Tauri.** Small Rust shell, but the server still needs Node shipped
  alongside, and it adds Rust to build and maintain.

Chosen: A, because the tray icon is how parents know it's running and find
it again, and electron-builder covers the per-system parts in one
well-tested tool. Size matters little for a one-time download.

## Design

### Pieces

```text
apps/desktop    New. Electron main process: tray, single instance, start at
                login, settings storage location, starts the server.
apps/server     Gains a "not set up yet" mode, a settings store, setup and
                settings APIs, and a start function the desktop app calls.
apps/web        Gains the setup wizard and settings pages.
```

### Running the server inside the app

`apps/server` exports a function, roughly
`startServer({ dataDir, settings, logger, hooks })`, that does what
`src/index.ts` does today and returns the addresses it listens on and a
`stop()`. `src/index.ts` becomes a thin wrapper around it, so `pnpm start`
keeps working unchanged.

The server must start without a camera. With no camera login saved, it
serves the setup wizard instead of looking for the camera. When settings
change (setup finishes, the camera login changes), the server rebuilds its
camera connection in place, without the app restarting.

### Where settings live

The desktop app stores everything in the per-user app folder that Electron
provides (`~/.config/Kasa Home` on Linux, `%APPDATA%\Kasa Home` on
Windows, `~/Library/Application Support/Kasa Home` on macOS):

- `settings.json`: the camera login, camera choice and other settings.
- The session secret and the HTTPS certificate, as `data/` holds today.

Rules:

- The folder and its files are readable only by the user.
- The viewer password is stored as a salted hash (scrypt), never as plain
  text. The session code changes to check against the hash.
- The camera password has to be sent to the camera, so it can't be hashed.
  When Electron's `safeStorage` is available, it is encrypted with it;
  otherwise it is stored in the owner-only file.
- For `pnpm start`, environment variables and `.env` keep working, and
  override anything in `settings.json`. The desktop app doesn't read `.env`
  at all (my call), so a stray file can't change an installed app.

### Addresses and HTTPS

- The computer itself uses `http://localhost:<port>`. Plain HTTP is safe
  there because the traffic never leaves the computer, and it avoids the
  certificate warning on the parent's first page.
- Phones and other computers use `https://<computer's IP>:<port>`, as now.
- Today the plain-HTTP port redirects everything to HTTPS. It changes to
  serve loopback clients directly and redirect everyone else.
- Default port 8090. If it's taken, the next free port is used, and the
  tray, the finished page and the settings page show the real address.

### First-run setup (browser)

Who can reach it:

- Until setup finishes, the setup pages and setup API answer only requests
  from the computer itself (loopback). Everyone else gets a short "This
  monitor isn't set up yet. Finish setup on the computer it's installed on."
  page.
- After setup, the setup wizard is gone; changes go through the settings
  page, behind the viewer password.
- Forgotten viewer password (my call): on the computer itself, the login
  page offers "Set a new password". Whoever can use that computer already
  controls Kasa Home, and the alternative is reinstalling.

Screens:

```text
 Welcome            Choose a password for watching. [Next]
 Your camera        ( ) It already works in the Kasa app
                    ( ) It's new or reset, with a TP-Link account
                        (no account yet? myproducts.tp-link.com)
                    ( ) It's new or reset, local only
                        (explains: keeps the admin/admin login; no Kasa app)
 Camera login       For "already works": Kasa email + password, [Check].
                    The server finds the camera and tries the login.
                    With several cameras, the parent picks one by name.
 Camera setup       For new/reset cameras, guided steps (below).
 All set            Live video, the phone address with a QR code, a note
                    that phones show a one-time warning and what to tap,
                    and [x] Start when this computer starts.
```

Camera setup replaces `pnpm setup-camera`'s prompts with pages driven by the
same functions in `apps/server/src/kasa/setup.ts`:

1. Reset the camera: what to do, and how to know it's ready (a Wi-Fi network
   named like `Kasa_Cam_1A2B` appears).
2. Join the camera's Wi-Fi: automatic on Linux (NetworkManager), as now. On
   macOS and Windows the page says which network to join, and the server
   watches for the camera at its setup address and moves on by itself.
3. Pick the home Wi-Fi from the list the camera sees, and type its password.
   The page says only 2.4 GHz networks work.
4. Name the camera.
5. Confirm, then the camera switches networks. The computer rejoins the
   home Wi-Fi (automatically on Linux; the page asks on macOS and Windows).
6. Wait up to 2 minutes for the camera to appear, finish setup (name, clock,
   on-video time, account link), and save the login.

The page stays reachable throughout because it is served from `localhost`,
which doesn't depend on which Wi-Fi the computer is on.

Long steps report progress to the page, by polling a status endpoint or
over a WebSocket (the builder's call). The page explains failures in plain
words with a "try again" path, using the messages `pnpm setup-camera`
already has.

### Settings page

Behind the viewer password, from any device. Contents:

- Change the viewer password.
- Change the camera login, or pick another camera.
- Set up a new or reset camera (the same guided steps). Only on the
  computer itself, because it changes the computer's Wi-Fi.
- Start when this computer starts (desktop app only).
- Stop Kasa Home (desktop app only, and only on the computer itself), for
  desktops without a tray icon.

Less common settings (resolution, time zone, tap speed, allowed networks)
stay in `.env` for now.

### The desktop app

- Single instance. Opening the app again, or clicking **Open monitor**,
  opens `http://localhost:<port>` in the default browser.
- On first launch and every launch from the app menu, it opens the browser.
  When started automatically at login, it doesn't.
- Tray menu: **Open monitor**, **Start with this computer** (a checkbox),
  **Quit**. On macOS, no Dock icon, only the menu bar icon.
- Start at login is off until the parent ticks it on the finished page or
  in the tray.
- Logs go to a file in the app folder, kept to a few MB, with a **Show
  logs** item in the tray for troubleshooting.
- The allowed-networks list is worked out from the computer's network
  interfaces at startup. It is worked out again whenever the server
  rebuilds after setup, since the computer may have changed networks
  during camera setup (my call).
- On Windows, the first time the server listens, Windows asks whether to
  allow it on the network. The finished page and the README say to allow it
  on private networks.

### Installers and releases

- electron-builder makes: `Kasa-Home-x86_64.AppImage`, `kasa-home.deb`,
  `Kasa-Home-Setup.exe` (per-user, no administrator password), and
  `Kasa-Home.dmg`.
- The Mac disk image runs on both Apple Silicon and Intel Macs. My call: one
  "universal" disk image rather than two, so parents don't have to know
  which kind of Mac they have. It's roughly twice the size of a single-kind
  build. It runs on whatever macOS versions the chosen Electron supports
  (macOS 12 and newer at the time of writing). The self-test runs both
  halves on an Apple Silicon runner, the Intel half through Rosetta.
- A GitHub Actions workflow, like homepix's:
  - every pull request: run `pnpm check` on Linux, build all installers on
    Linux, Windows and macOS runners, and run each app's self-test;
  - a version tag such as `v0.2.0`: the same, then publish a GitHub Release
    with all four files.
- Self-test: the packaged app started with `--self-test` starts the server
  on a free port with no camera, checks that the setup page and
  `/api/health` answer, and exits with 0 or an error.
- The README's step-by-step guide is rewritten around the downloads, with a
  short "run from source" section for the current method.

## Decided with the user

- Audience: parents who never opened a terminal.
- Setup, including the Kasa username and password, happens on pages in the
  app's browser UI.
- The computer is sometimes watched on too, through the normal browser.
- Desktop only for now; phones keep using the web page.
- Approach A, Electron with a tray icon.
- The product is named **Kasa Home** everywhere: the app, installers, page
  titles, docs, and the GitHub repository (`meirgarfinkel/kasa-home`).
- Macs: both Apple Silicon and older Intel Macs.

## Left to the builder

- Electron and electron-builder versions (current stable).
- How the wizard's progress reaches the page (polling or WebSocket).
- The QR code library, or generating it without one.
- Exact wording, layout and icons of the new pages, following the existing
  look.
- How the server rebuilds the camera connection when settings change.
- Test design. At minimum: the settings store, the loopback-only setup
  rule, the setup API against the fake camera (which already has a setup
  mode), and the plain-HTTP-on-loopback rule.
- Removing the stale root `test:e2e` script, which points at a script that
  doesn't exist.
