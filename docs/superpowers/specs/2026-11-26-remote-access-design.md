# Remote access design

Watch the camera away from home, with nothing to install on the phone.

## Why

Kasa Home works only on the home network today. Viewing from away is the
main reason people stay on cloud camera apps. The owner wants it to be
secure first and then as easy as possible: the fewest steps for a parent who
is not technical.

## Goals

- A phone opens one `https://` address in its normal browser and sees the
  camera from anywhere: live video, sound, talk-back and pan/tilt.
- Setup on the computer is: turn it on, sign in once in the browser, approve
  once. Adding a phone is one QR scan.
- Video stays encrypted all the way from the computer to the phone.
- No router changes, no domain, no port forwarding. Works behind CGNAT.
- A phone that was never paired cannot even try a password.

## Non-goals

- Viewing away from home in the server-only (non-desktop) mode.
- Push notifications, recording, multiple cameras.
- Passkeys (a later step; device pairing covers most of the risk now).
- Guaranteeing Tailscale's service, bandwidth or pricing.

## Anti-goals (a failure even if it works)

- Anything that lets someone on the internet change settings, run camera
  setup, change passwords or quit the app.
- Requiring the user to install a second program, edit files, or touch the
  router.
- Kasa Home running its own relay servers or seeing anyone's video.
- A request arriving through the tunnel being treated as "this computer"
  (loopback), which today unlocks setup.

## Approaches

1. **Embedded Tailscale with Funnel (chosen).** Kasa Home ships a small
   helper program built on Tailscale's `tsnet` library. It joins the user's
   free Tailscale account and publishes a public `https://<name>.ts.net`
   address with Funnel. TLS ends on the user's computer, so Tailscale relays
   encrypted bytes it cannot read. The user never installs Tailscale: they
   sign in once (Google, Apple, Microsoft or GitHub) and click one approve
   button. Costs: a Go helper (about 25 MB) built for each platform, and a
   Tailscale account.
2. **Tailscale app installed by the user.** Same security, but the user must
   install and sign in to a separate app first. More steps for parents.
3. **Cloudflare Tunnel.** Cloudflare decrypts traffic in the middle and the
   user needs their own domain. Weaker privacy, more setup.
4. **Port forwarding with a certificate and dynamic DNS.** Exposes the home
   IP, breaks behind CGNAT, needs router changes. Fails the "no router"
   goal.
5. **Our own relay service.** We would run servers and hold trust. Fails the
   anti-goals.

The owner asked for security first and the least user effort second; that
picks 1. This was my call from that brief, not an option they picked from a
list.

## How it works

### Pieces

- **`kasa-tunnel` helper** (Go, `apps/tunnel/`). Started and stopped by the
  desktop app. It is the only new process. Arguments: a state folder inside
  the app data folder, the local target address, and the machine name
  `kasa-home`. A per-launch random secret comes in through the environment,
  never the command line. It writes one JSON event per line on stdout:
  - `{"type":"login","url":...}` when the user must sign in;
  - `{"type":"enable","url":...}` when Funnel or HTTPS must be approved on
    the account (from `QueryFeature("funnel")`);
  - `{"type":"ready","url":"https://kasa-home.<tailnet>.ts.net"}` once it
    listens;
  - `{"type":"error","message":...}`.

  Once signed in and approved, it calls `ListenFunnel("tcp", ":443",
  FunnelOnly())` and runs a Go reverse proxy to the target. Each proxied
  request gets the header `X-Kasa-Tunnel: <secret>` and the real client
  address in `X-Forwarded-For` (its own value replaces whatever the client
  sent). WebSockets pass through. FunnelOnly means other devices on the
  user's tailnet cannot use it either; only the public address works.
- **Remote listener in the server.** A second plain-HTTP listener on
  `127.0.0.1` with a random port, feeding the same app. Every request on it
  is a *remote* request. It is never treated as loopback, whatever its
  socket address says. A request without the right `X-Kasa-Tunnel` secret
  gets 403. The Host header must be the `ts.net` name. The client address
  for rate limits comes from `X-Forwarded-For`, trusted only on this
  listener and only with the secret.
- **Tunnel manager in the server** (`apps/server/src/remote/`). It owns the
  helper's lifecycle through a small spawn interface the desktop app
  provides (path to the binary). It holds the latest state for the
  settings page, restarts the helper with backoff if it dies, and starts it
  at launch when remote access was left on.

### Remote request rules

On the remote listener:

| Path | Rule |
| --- | --- |
| `/api/health` | open |
| `/api/remote/pair` | open, rate-limited |
| `/api/session`, `/api/login`, `/api/logout` | paired phone needed |
| camera, status, live, ptz routes | paired phone and signed-in session |
| `/api/setup/*`, `/api/settings*`, `/api/app/*`, `/api/remote/*` (except pair) | always 403 |
| static page files | open (no secrets in them) |

"Paired phone" means a valid `kasa_device` cookie whose token hash is in the
device list. The usual session rules then apply on top. The same-origin
check for WebSockets and changes stays on.

### Pairing a phone

Two ways in, both proven at home:

1. **From the computer:** Settings → Away from home → **Add a phone** shows a
   QR code for `https://<name>.ts.net/pair#<code>`. The code is 128 random
   bits, single use, valid 10 minutes, and only the computer itself
   (loopback) can create one.
2. **From a phone already signed in at home:** its Settings page shows
   **Use this phone away from home**. The server makes a code for that
   signed-in session and sends the phone to the same pairing address.

The pairing page reads the code from the `#` part (so it is never sent in a
URL or logged), posts it to `/api/remote/pair`, and gets two cookies: a
`kasa_device` token (32 random bytes, HttpOnly, Secure, SameSite=Strict,
400 days) and a normal signed-in session. The phone lands on the camera.
The address then works at home and away, so a parent keeps one bookmark.
The page suggests "Add to Home Screen".

Devices are stored in `remote.json` as `{id, name, tokenHash, createdAt,
lastSeenAt}`, with the token hashed (SHA-256). The name comes from the
browser ("iPhone", "Android phone", "Mac", ...). `lastSeenAt` updates at most
once a minute. Removing a device takes effect on its next request and
closes its open live view.

When the session runs out (30 days, or the password changed), a paired
phone signs in again with the viewer password. An unpaired phone on the
remote address sees: "This phone isn't set up to watch from away. At home,
scan the code in Kasa Home on your computer."

### The computer's settings page

A new **Away from home** section, shown on the computer only:

```
Away from home                                  [ Off | On ]
  Off:      Watch from anywhere with your phone's browser.
  Starting: Connecting...
  Sign in:  Sign in once to the free Tailscale service that carries the
            encrypted video.          [ Sign in ]  (opens the browser)
  Approve:  One more click: allow Kasa Home to share a web address.
                                      [ Approve ]  (opens the browser)
  On:       https://kasa-home.tail1234.ts.net        [ Add a phone ]
            Phones: iPhone, added 26 Nov, used today        [ Remove ]
  Problem:  <message>                                [ Try again ]
            Sign out of Tailscale (small link)
```

Turning it off stops the helper; paired phones are kept for next time.
"Sign out of Tailscale" deletes the helper's state folder. The phone's
settings page shows only the "Use this phone away from home" button, and
only while remote access is on.

### Security notes

- `ts.net` names appear in public certificate logs, so expect scanners. Their
  requests stop at the device check.
- The pairing endpoint is rate-limited per address (10 in 15 minutes) and
  overall (30 in 15 minutes). The code's 128 bits make guessing hopeless
  anyway.
- The login rate limit uses the real client address on the remote listener.
- Every pair, remote sign-in and device removal is logged.
- The helper's state folder holds the Tailscale node key: owner-only
  permissions, like the rest of the data folder.
- The helper is pinned to a Tailscale release and updated with the app.
- Real HTTPS on the remote address also lets talk-back use the microphone,
  which browsers allow only on secure pages.

## Build and release

- Go module in `apps/tunnel/`, Go version from Tailscale's `go.mod`.
- CI builds the helper per installer: Linux x64, Windows x64, and macOS
  arm64 plus x64 joined into one universal file with `lipo`. electron-builder
  ships it as an extra resource.
- The desktop self-test also runs `kasa-tunnel --version`.

## Testing

- Go tests: the proxy adds the secret, replaces `X-Forwarded-For`, and passes
  WebSockets (with `httptest`, no Tailscale).
- Server tests with a fake helper (a small script that prints the events):
  state changes, restart after a crash, and every rule in the table above,
  including "a loopback socket on the remote listener is not loopback".
- Web tests for the settings section and the pairing page.
- The real Tailscale sign-in and Funnel can only be checked by the owner
  with their own account. That is a hand check after install.

## Decisions from the builder check

These were my calls, made from the brief (security first, then ease).

1. **One app, remote flag set by the listener.** The remote listener is a
   second long-lived front, like the existing ones in `listen.ts`: it
   dispatches into whatever app is current, so it survives `reload()` and
   `swap()`. Before dispatch it marks the raw request with a private symbol.
   The flag comes only from which listener accepted the socket, never from a
   header. `buildApp`'s onRequest hook reads it first, and remote requests
   take their own path: no IP allowlist, no loopback rights.
2. **A code made on the computer signs the phone in without the password.**
   Only the computer itself can make one, and whoever sits at it already has
   full rights there. The code is single use and lasts 10 minutes. That
   keeps adding a phone to one scan. The viewer password is still needed
   when a paired phone's 30-day session runs out.
3. **Remote access needs a viewer password.** Turning it on is refused
   before setup is complete or with `ALLOW_NO_PASSWORD` open access. The
   remote listener answers 403 in either case.
4. **The pairing page and the "not set up" page don't call the API**,
   except `/api/remote/pair`. The web app learns it is on the remote address
   from the server's 401 answer `{error:"device-not-paired"}` and shows the
   message.
5. **Remote access has its own file**, `remote.json` in the data folder,
   holding `enabled` and the device list, written owner-only like the
   other data files. Saving it never triggers a reload, and `settings.json`
   is untouched. `lastSeenAt` is kept in memory and written at most every
   10 minutes and on shutdown.
6. **The host name comes from the `ready` event**, because Tailscale may
   rename `kasa-home` to `kasa-home-1`. The remote Host check uses that
   name. Requests before `ready` get 503.
7. **The desktop app only supplies the helper's path.** The server's tunnel
   manager spawns the helper and makes the per-launch secret. Opening the
   sign-in and approve links goes through a new `openExternal` hook, limited
   to `https://login.tailscale.com/` addresses.
8. **Host passes through unchanged**, since our own Go proxy forwards the
   original Host. The existing CSP and origin checks then work as they are.
9. **macOS:** after `lipo` joins the two builds, the universal file is
   ad-hoc signed again (`codesign -s -`), the same identity the app uses
   today. Windows has no signing today, so nothing changes there.

## Left to the builder

- Exact file layout inside the new folders, the backoff numbers, and the
  helper's log format on stderr.
- How the browser-name guess is written.
