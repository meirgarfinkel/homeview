# HomeView: rename, download buttons and updates

## Why

Kasa Home becomes HomeView, the third app in a series with HomePix and HomeDocs. It should look
and behave like its siblings: the same family of icon, the same big download buttons in the README,
and updates from inside the app, so a family installs it once and never thinks about versions again.
HomePix is the reference for all three.

It stays a camera app. A smart home hub (lights, plugs, rules) is out of scope.

## Goals

- Every name a person sees says HomeView: window and tray, installers, README, setup pages.
- The README opens like HomePix's: icon, name, one-line pitch, three download buttons.
- The app finds a newer release on its own, downloads it quietly, and offers to restart into it.
  "Check for updates" in the tray menu does the same on request.

## Non-goals and anti-goals

- No hub features.
- No code signing or app store work. Updates must work with the unsigned builds we ship.
- No update offers on phones or from away. Only the computer running HomeView updates itself.
- Never install anything without the person pressing Restart (or answering the Linux password prompt).
- Not renaming internal names nobody sees: the `@kasa/*` package scope, `KASA_*` settings for the
  Kasa camera, and the Kasa driver. Kasa is still a camera brand the app supports.

## Decisions

### Names

- Product name `HomeView`, written like `HomePix`. App ID `io.github.meirgarfinkel.homeview`.
- Download files, matching HomePix: `HomeViewSetup.exe`, `HomeView.dmg`, `HomeView.deb`,
  `HomeView-x86_64.AppImage`. Linux program and package name `homeview`.
- The repo is now `meirgarfinkel/homeview` (renamed 2026-11-26). Every link uses it.
- Nobody has installed it yet (no release exists), so the app ID, data folder, keychain entry and
  start-at-login entry change with no migration.

### Icon

- The dome camera design from the icon canvas: the HomePix roof and chimney on a `#373530` circle,
  over a `#9FDDA0` dome camera with a `#FF7272` record light. `homeview-icon.svg` at the repo root
  is the source. The PNG and ICO are made from it, like HomePix's.
- It replaces the app, tray and installer icons and the web page's favicon.

### README

- The top of the README matches HomePix: icon, title, pitch, then three buttons (Windows, Mac,
  Linux) linking to `releases/latest/download/<file>`. The button images are HomePix's three SVGs,
  copied to `docs/images/`. They say only "Download for …", so they need no change.
- The install steps below them name the new files.

### Updates

The updater ports HomePix's behaviour, rewritten for this app's shape: Electron's main process
does the work, and the page on this computer shows the offer.

- **Where it runs.** A new `apps/desktop/src/updater.ts` in the desktop app. The server only
  passes it through `ServerHooks` (`updateStatus()`, `installUpdate()`, `checkForUpdates()`).
- **Finding a release.** `GET https://api.github.com/repos/meirgarfinkel/homeview/releases/latest`.
  It's newer when its tag (`v1.2.3`) is above `app.getVersion()`. Checked 1 minute after start and
  then every 24 hours, because HomeView runs for days in the tray (HomePix checks only at start).
- **Which file.** It depends on how this copy was installed:
  - Windows: `HomeViewSetup.exe`.
  - Mac: `HomeView.dmg`.
  - AppImage: `HomeView-x86_64.AppImage`, when `APPIMAGE` is set.
  - .deb: `HomeView.deb`, when the program runs from `/opt/HomeView/`.
  - Running from source: never updates.
- **Download.** Into `<data folder>/updates/`, cleared first, through a `.part` file. It's checked
  against the release's size and its `sha256` digest, and a mismatch throws it away. The download
  happens quietly, with no prompt.
- **The offer.**
  - `GET /api/app/update` answers `{ state: 'none' | 'downloading' | 'ready' | 'error', version?, message? }`.
  - The page on this computer shows a bar: "HomeView 1.2.0 is ready." with "Restart to update" and "Later".
  - `/api/app/*` is already refused from away and from phones on the home network.
- **Installing**, when Restart is pressed (`POST /api/app/update/install`):
  - **Windows:** start the installer detached with `/S --force-run`, then quit. The NSIS one-click
    installer replaces the app and opens it again.
  - **Mac:** mount the dmg (`hdiutil attach -nobrowse -readonly`), `ditto` the new `HomeView.app`
    beside this one, swap it in (put the old one back if the swap fails), detach, relaunch with
    `open -n`, then quit. If this copy runs from the dmg or from App Translocation, the bar instead
    says to move HomeView into Applications first.
  - **AppImage:** replace the file at `$APPIMAGE`, `chmod 755` it, relaunch, quit.
  - **.deb:** `pkexec apt-get install -y <file>`. Linux asks for the password. Then relaunch and quit.
    Without `pkexec`, open the file in the software installer instead. If the password prompt is
    closed, the bar says the update was cancelled.
- **Tray.** "Check for updates" is added above "Show logs":
  - With an update ready, it installs it.
  - While checking, the item reads "Checking for updates…".
  - Otherwise it checks, then shows a system notification: "HomeView is up to date", "Downloading
    HomeView 1.2.0…" or "Couldn't check for updates: <reason>".
- **Failures.** The check at start and every 24 hours fails quietly and is logged. A check or
  install the person started shows its reason in the bar or a notification.
- **Releases.** The release job already builds the four files on a `v*` tag. The version comes from
  `apps/desktop/package.json`, so a release is: bump the version, tag, push.

### Also in this branch

- The self-test retries a `fetch` once after a connection reset. This fixes the flaky failure seen
  on the emulated Intel Mac run.

## Testing

- **Unit tests** cover:
  - picking the file for each install kind;
  - comparing versions;
  - a download that's too short or has the wrong digest being thrown away;
  - the status the route answers;
  - the bar's text and buttons;
  - the tray item's states.
- **Install steps:** a fake release server and temporary folders cover the AppImage swap and the
  Mac swap logic. On the Mac, `hdiutil` and `ditto` are behind a small runner so the test can stand in.
- **By hand, with your go-ahead, since releases are public:** tag v0.1.0 and install it. Then tag
  v0.1.1 and check that the app finds it, downloads it and restarts into it on Linux. Mac and Windows
  get the same check when a machine is available.

## Left to the builder

- The bar's exact look, which follows the existing banner styles.
- How the updater is split across files beyond `updater.ts`.
- The wording of notifications and errors, which follows the app's plain style.
