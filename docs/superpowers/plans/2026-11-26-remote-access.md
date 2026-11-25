# Remote access implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch the camera from anywhere in a phone browser, through an embedded Tailscale Funnel helper, with pairing that keeps strangers out.

**Architecture:** A Go helper (`kasa-tunnel`, built on `tsnet`) publishes `https://<name>.ts.net` and reverse-proxies to a second, loopback-only plain-HTTP listener in the server. Everything arriving on that listener is marked *remote* by the listener itself and goes through its own gate: tunnel secret, Host check, paired-device cookie, then the normal session. The desktop app supplies the helper's path and opens browser links. The server's `RemoteAccess` object owns the helper, the device list and pairing codes, and survives reloads.

**Tech Stack:** TypeScript 6, Node 24, Fastify 5, React 19 + Vite, vitest, Electron 45, electron-builder 26, Go (version from Tailscale's `go.mod`), `tailscale.com/tsnet`.

**Spec:** `docs/superpowers/specs/2026-11-26-remote-access-design.md`

## Global Constraints

- Remote requests are never "this computer": no code may treat a request from the remote listener as loopback. Use `isLocalRequest(req)` (Task 3), never `isLoopback(req.ip)`, in routes.
- The remote flag comes only from which listener accepted the socket. Never from a header.
- On the remote listener, always 403: `/api/setup*`, `/api/settings*`, `/api/app/*`, `/api/remote/*` except `/api/remote/pair`.
- Open on the remote listener: `/api/health`, `/api/remote/pair`, non-`/api/` static files. Everything else under `/api/` needs a paired device; camera, status, live and ptz need a session too.
- Pairing codes: 128 random bits, base64url, single use, valid 10 minutes.
- Device token: 32 random bytes, base64url. Stored as SHA-256 hex. Cookie `kasa_device`, `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000`.
- Pair rate limit: 10 per client address per 15 minutes, and 30 overall per 15 minutes.
- Remote access can be turned on only when setup is complete and a viewer password exists.
- `remote.json` in the data folder holds `{ enabled, devices }`, written with `writePrivateFile`. `lastSeenAt` is flushed at most every 10 minutes and on stop.
- The helper gets its secret through the environment variable `KASA_TUNNEL_SECRET`, never the command line. Helper header: `X-Kasa-Tunnel`.
- Only `https://login.tailscale.com/` links may be opened through `openExternal`.
- Helper machine name: `kasa-home`. The real host name comes from the `ready` event.
- All user-facing copy and comments follow the unslop rules: sentence case, plain words, no em dashes.
- Commits end with the two trailer lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014coFUwGw74CkTYA7BfwGKs`. Author email `36854346+meirgarfinkel@users.noreply.github.com`.
- Never touch the live camera, and never run `tailscale` against a real account. Tests use fakes.

## Review Focus

1. A request on the remote listener whose socket is 127.0.0.1 must get no loopback rights anywhere: `/api/session` says `local:false` with no `lanUrl`, and setup and settings are 403 (Task 3).
2. A client sending its own `X-Kasa-Tunnel` or `X-Forwarded-For` through Funnel: the helper must overwrite both (Task 1). The server must reject a remote request with a wrong or missing secret (Task 3).
3. A removed phone with a live view open: its WebSocket closes and its next request is 401 `device-not-paired` (Task 3).
4. The helper crashing, or never getting past sign-in: the settings page shows the state, the manager restarts it with backoff, and the server keeps serving at home (Task 4).
5. A reload (password change, camera change) while remote access is on: the remote listener keeps working and is swapped to the new app with the main one (Task 4).

---

### Task 1: The `kasa-tunnel` helper

**Files:**
- Create: `apps/tunnel/go.mod`, `apps/tunnel/main.go`, `apps/tunnel/proxy.go`, `apps/tunnel/proxy_test.go`, `apps/tunnel/events.go`, `apps/tunnel/build.mjs`, `apps/tunnel/package.json`, `apps/tunnel/.gitignore` (`bin/`)
- Modify: `mise.toml` (add `go`, the version Tailscale's `go.mod` needs), `.github/workflows/build.yml` (check job: `actions/setup-go@v5` with `go-version-file: apps/tunnel/go.mod`, `cache-dependency-path: apps/tunnel/go.sum`)

**Interfaces:**
- Produces: binary `kasa-tunnel` with flags `--state-dir <dir>`, `--target <host:port>`, `--hostname <name>` (default `kasa-home`), `--version` (prints `kasa-tunnel <version>` and exits 0). Reads `KASA_TUNNEL_SECRET` (exit 2 with a stderr message if empty).
- Produces: stdout JSON lines, exactly these shapes: `{"type":"login","url":"..."}`, `{"type":"enable","url":"..."}`, `{"type":"ready","url":"https://<name>"}` (no trailing dot), `{"type":"error","message":"..."}`. Human logs go to stderr only.
- Produces: `pnpm --filter @kasa/tunnel build` writes `apps/tunnel/bin/linux/kasa-tunnel`, `bin/win/kasa-tunnel.exe` or `bin/mac/kasa-tunnel`, for the host OS only. `pnpm --filter @kasa/tunnel test` runs `go test ./...`.

- [ ] **Step 1: Write the failing proxy tests** in `proxy_test.go`, against `newProxy(target *url.URL, secret string) http.Handler` with `httptest`:
  - `TestProxySetsSecretAndReplacesForwardedFor`: the client sends `X-Kasa-Tunnel: fake` and `X-Forwarded-For: 1.2.3.4`. The backend sees `X-Kasa-Tunnel` == secret and `X-Forwarded-For` == the client's own IP (from `RemoteAddr`) only.
  - `TestProxyKeepsHost`: the backend sees the original `Host` header.
  - `TestProxyPassesWebSocketUpgrade`: a `Connection: Upgrade` / `Upgrade: websocket` request reaches a backend that hijacks and echoes bytes both ways.
- [ ] **Step 2: Run** `cd apps/tunnel && go test ./...`. Expected: FAIL, `newProxy` undefined.
- [ ] **Step 3: Implement `newProxy`** with `httputil.ReverseProxy{Rewrite: ...}`. `Rewrite` already drops incoming `X-Forwarded-*`. Set `Out.Host = In.Host`, `X-Kasa-Tunnel`, and `X-Forwarded-For` from the client address. The client address is a funnel connection's real source: check how `tsnet.ListenFunnel` connections report it (`RemoteAddr()` or `*ipn.FunnelConn`'s `Src`, read in the module cache with `go doc`). If it is not `RemoteAddr`, carry it through `http.Server.ConnContext`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Implement `main.go`.**
  - Build `tsnet.Server{Hostname, Dir: stateDir, Logf: stderr logger, UserLogf: stderr logger}`, then `Start()`.
  - Poll `LocalClient().Status()` every 2 s:
    - `NeedsLogin` with a non-empty `AuthURL`: emit `login`, once per distinct URL. If no URL shows up within 10 s, call `StartLoginInteractive`.
    - `Running`: call `QueryFeature(ctx, "funnel")`. Read the exact response fields from `tailcfg.QueryFeatureResponse` in the module cache. While it isn't complete and has a URL, emit `enable` (once per URL) and keep polling.
  - Once complete: `ListenFunnel("tcp", ":443", tsnet.FunnelOnly())`, emit `ready` with `https://` plus `strings.TrimSuffix(Self.DNSName, ".")`, then serve `newProxy`.
  - Fatal errors emit `error` and exit 1. SIGINT and SIGTERM close the server and exit 0.
- [ ] **Step 6: Write `build.mjs`.**
  - Runs `go build -trimpath -ldflags "-s -w -X main.version=<package.json version>"` with `CGO_ENABLED=0`.
  - Linux and Windows: amd64.
  - macOS: arm64 and amd64, then `lipo -create`, then `codesign --force -s -` on the result.
  - Prints the output path.
- [ ] **Step 7: Verify.** `pnpm --filter @kasa/tunnel build` succeeds, and `apps/tunnel/bin/linux/kasa-tunnel --version` prints `kasa-tunnel 0.1.0`. `KASA_TUNNEL_SECRET= ./kasa-tunnel --state-dir /tmp/x --target 127.0.0.1:1` exits 2. Do not run it with a secret: that would try to reach Tailscale.
- [ ] **Step 8: Commit** ("Add the kasa-tunnel helper that publishes Kasa Home through Tailscale Funnel").

### Task 2: Shared types, device store, pairing codes

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/remote/devices.ts`, `apps/server/src/remote/pairing.ts`, `apps/server/src/remote/deviceName.ts`
- Test: `apps/server/test/remoteDevices.test.ts`, `apps/server/test/pairing.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type RemotePhase = 'off' | 'starting' | 'sign-in' | 'approve' | 'on' | 'problem';
  export interface RemoteDevice { id: string; name: string; createdAt: string; lastSeenAt?: string }
  export interface RemoteStatus {
    available: boolean; // the helper is installed (desktop app)
    enabled: boolean;
    phase: RemotePhase;
    url?: string;      // when phase is 'on'
    message?: string;  // when phase is 'problem'
    devices: RemoteDevice[];
  }
  export interface PairCodeResponse { url: string; expiresAt: string }
  ```
  `SessionResponse` gains `remote: boolean` (this request came through the tunnel) and `remoteOn: boolean` (remote access is on, phase `on`).
- Produces (server):
  ```ts
  export const DEVICE_COOKIE = 'kasa_device';
  export function deviceCookie(token: string): string;
  export class DeviceStore extends EventEmitter<{ removed: [string] }> {
    constructor(dir: string, logger?: Logger);
    readonly enabled: boolean;
    setEnabled(on: boolean): void;            // writes remote.json now
    list(): RemoteDevice[];
    add(name: string, now?: Date): { device: RemoteDevice; token: string }; // writes now
    find(token: string | undefined): RemoteDevice | undefined; // compares SHA-256 hashes
    touch(id: string, now?: Date): void;      // memory; flushes if 10 min since last write
    remove(id: string): boolean;              // writes now, emits 'removed'
    flush(): void;
  }
  export class PairingCodes {
    constructor(ttlMs?: number);              // default 10 * 60_000
    create(now?: number): { code: string; expiresAt: Date };
    consume(code: string, now?: number): boolean; // true once, then false
  }
  export function deviceName(userAgent: string | undefined): string; // 'iPhone', 'iPad', 'Android phone', 'Mac', 'Windows PC', 'Linux PC', else 'Phone'
  ```

- [ ] **Step 1: Write failing tests:**
  - **`DeviceStore`:** `add` returns a 43-char token, and `remote.json` holds `tokenHash`, never the token. `find(token)` returns the device; `find('wrong')` and `find(undefined)` return undefined. `remove` emits `removed` with the id and survives a reload of the store from disk. `setEnabled(true)` persists. A corrupt `remote.json` loads as `{enabled:false, devices:[]}` without throwing. `touch` doesn't write before 10 minutes (check the file's `mtime` or a spy) and writes after.
  - **`PairingCodes`:** the code is 22 base64url chars; `consume` returns true then false; expired after 10 minutes.
  - **`deviceName`:** one assertion per name above, using real user-agent strings.
- [ ] **Step 2: Run** `pnpm --filter @kasa/server test -- remoteDevices pairing`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Use `randomBytes`, base64url, and `writePrivateFile` from `security/dataDir.ts`. Validate `remote.json` with zod, like `settings/store.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then run `pnpm typecheck`.
- [ ] **Step 5: Commit** ("Add the remote device list and pairing codes").

### Task 3: Remote listener and the remote gate

**Files:**
- Create: `apps/server/src/security/remoteRequest.ts`, `apps/server/src/routes/remotePair.ts`
- Modify: `apps/server/src/listen.ts` (`FrontOptions.remote`), `apps/server/src/app.ts`, `apps/server/src/routes/api.ts`, `apps/server/src/routes/settings.ts`, `apps/server/src/routes/setup.ts`, `apps/server/src/routes/live.ts`
- Test: `apps/server/test/remoteGate.test.ts`

**Interfaces:**
- Consumes: Task 2's `DeviceStore`, `PairingCodes`, `deviceName`, `DEVICE_COOKIE`, `deviceCookie`.
- Produces:
  ```ts
  // security/remoteRequest.ts
  export function markRemote(raw: http.IncomingMessage): void;
  export function isRemote(req: FastifyRequest | http.IncomingMessage): boolean;
  export function isLocalRequest(req: FastifyRequest): boolean; // !isRemote(req) && isLoopback(req.ip)
  export function clientIp(req: FastifyRequest): string; // remote: first X-Forwarded-For value; else req.ip
  // listen.ts
  listenHttp(app, { host: '127.0.0.1', port: 0, remote: true }) // marks every request and upgrade
  // app.ts
  export interface RemoteGateDeps {
    secret(): string | undefined;   // undefined: tunnel not running
    host(): string | undefined;     // from the 'ready' event
    devices: DeviceStore;
    pairing: PairingCodes;
  }
  AppDeps.remote?: RemoteGateDeps
  ```
  Each authorised remote request gets `req.remoteDeviceId` (a Fastify request decorator).

- [ ] **Step 1: Write failing tests** in `remoteGate.test.ts`. Use a real `listenHttp(..., { remote: true })` on port 0 and `fetch`/`ws`, with a test `RemoteGateDeps` (secret `s3cret`, host `kasa-home.example.ts.net`) and a viewer password set:
  - No secret header, or a wrong one: 403.
  - Right secret with Host `evil.example`: 403. Host not known yet (`host()` undefined): 503.
  - Right secret and host, no device cookie: `/api/session` gives 401 `{error:'device-not-paired'}`. `/api/health` gives 200. `/` gives the static index (when built) or 404 JSON, but never 401.
  - With a device cookie: `/api/session` gives 200 with `remote:true`, `local:false` and no `lanUrl`. `/api/status` without a session gives 401 `unauthorized`.
  - With device and session: `/api/setup/status`, `/api/settings`, `/api/app/quit` and `/api/remote/devices` all give 403, even though the socket is 127.0.0.1.
  - `POST /api/remote/pair`:
    - a valid code gives 200, a `kasa_device` cookie with `Secure; HttpOnly; SameSite=Strict`, and a session cookie with `Secure`;
    - the same code again gives 401 `{error:'bad-code'}`;
    - the 11th attempt from one `X-Forwarded-For` address in 15 minutes gives 429;
    - on the normal (non-remote) listener, it gives 404.
  - Before setup is complete, or with no viewer password: every remote `/api/` request except health gives 403 `not-set-up`.
  - A paired device with an open live WebSocket: `devices.remove(id)` closes that socket, and its next request gives 401 `device-not-paired`.
  - On the normal listener nothing changes. Run the existing suites.
- [ ] **Step 2: Run** `pnpm --filter @kasa/server test -- remoteGate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `listen.ts`: call `markRemote(req)` in `dispatch` and in `upgrade` when `opts.remote` is set.
  - `app.ts`: the remote gate runs first in `onRequest` when `isRemote(req)`, in this order:
    1. secret (`timingSafeEqual`);
    2. Host;
    3. set up with a password;
    4. same-origin check for WebSockets and changes;
    5. non-API paths pass;
    6. health and pair pass;
    7. the forbidden prefixes give 403 `{error:'local-only', message:"This can't be done from away. Use Kasa Home at home."}`;
    8. the device cookie (missing or unknown: 401 `{error:'device-not-paired', message:"This phone isn't set up to watch from away. At home, scan the code in Kasa Home on your computer."}`), then `touch`;
    9. session, except for `/api/session`, `/api/login` and `/api/logout`.

    Remote requests skip the IP allowlist and every loopback branch.
  - Replace every `isLoopback(req.ip)` in `app.ts` and `routes/*` with `isLocalRequest(req)`.
  - The login limiter and login logs use `clientIp(req)`.
  - `remotePair.ts`: registered only when `deps.remote` is set. It answers 404 unless `isRemote(req)`. It applies the two limiters (`LoginRateLimiter(10, 15m)` per `clientIp`, `LoginRateLimiter(30, 15m)` keyed `'all'`), consumes the code, adds a device named `deviceName(user-agent)`, sets both cookies, and logs `{device, ip}`.
  - `live.ts`: a remote socket closes (code 4401) when its device is removed. Unsubscribe when the socket closes.
- [ ] **Step 4: Run** `pnpm --filter @kasa/server test`. Expected: all pass.
- [ ] **Step 5: Commit** ("Gate requests arriving through the tunnel: paired phones only, never as this computer").

### Task 4: Tunnel manager, remote access service, control routes, server wiring

**Files:**
- Create: `apps/server/src/remote/tunnel.ts`, `apps/server/src/remote/remoteAccess.ts`, `apps/server/src/routes/remote.ts`, `apps/server/test/fixtures/fakeTunnel.mjs`
- Modify: `apps/server/src/server.ts`, `apps/server/src/app.ts` (`ServerHooks.openExternal?(url: string): void`, `AppDeps.remote` becomes a `RemoteAccess`), `apps/server/src/routes/api.ts` (`remoteOn`)
- Test: `apps/server/test/tunnel.test.ts`, `apps/server/test/remoteRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1's event lines, flags and env; Tasks 2 and 3.
- Produces:
  ```ts
  export type TunnelEvent =
    | { type: 'login'; url: string } | { type: 'enable'; url: string }
    | { type: 'ready'; url: string } | { type: 'error'; message: string };
  export interface TunnelOptions {
    command: string; args?: string[];  // args before the flags; the fake uses ['fakeTunnel.mjs']
    stateDir: string; targetPort: number; logger: Logger;
    backoffMs?: number[];              // default [1000, 5000, 30000]
  }
  export class TunnelManager extends EventEmitter<{ change: [] }> {
    readonly secret: string;           // 32 random bytes, hex, new per start()
    phase(): RemotePhase; url(): string | undefined; host(): string | undefined;
    message(): string | undefined; link(): string | undefined; // the current login or enable URL
    start(): void; stop(): Promise<void>; signOut(): Promise<void>; // signOut: stop, then rm -rf stateDir
  }
  export class RemoteAccess implements RemoteGateDeps {
    constructor(opts: { dataDir: string; tunnel?: Omit<TunnelOptions, 'stateDir' | 'targetPort'>;
                        logger: Logger; openExternal?: (url: string) => void });
    readonly devices: DeviceStore; readonly pairing: PairingCodes;
    readonly available: boolean;       // tunnel options given
    attach(targetPort: number): void;  // after the remote listener is bound
    status(): RemoteStatus;
    setEnabled(on: boolean): Promise<void>;
    openLink(): boolean;               // false unless link() starts with https://login.tailscale.com/
    pairUrl(code: string): string | undefined; // `${url}/pair#${code}` when phase is 'on'
    signOut(): Promise<void>; stop(): Promise<void>; // stop also flushes devices
    secret(): string | undefined; host(): string | undefined;
  }
  ```
- Phases: `start` gives `starting`; `login` gives `sign-in`; `enable` gives `approve`; `ready` gives `on`. A child exit while enabled restarts with backoff. After the last backoff fails it gives `problem`, with the last `error` message or "The connection helper stopped." `stop` gives `off`.
- Control routes, local only (`isLocalRequest`) with a session, else 403 `local-only`:
  - `GET /api/remote` gives `RemoteStatus`.
  - `POST /api/remote/enable {on: boolean}`: when turning on before setup or without a viewer password, gives 409 `{error:'needs-password', message:'Set up Kasa Home and choose a password first.'}`.
  - `POST /api/remote/open-link` gives 204, or 409 when there is no link.
  - `POST /api/remote/sign-out` gives 204.
  - `DELETE /api/remote/devices/:id` gives 204, or 404.
  - `POST /api/remote/pair-code` is allowed for local, or for a signed-in non-remote session (the phone at home). It gives `PairCodeResponse`, or 409 `{error:'remote-off'}` unless the phase is `on`.

- [ ] **Step 1: Write `fakeTunnel.mjs`.** It reads `FAKE_TUNNEL_SCRIPT` (a JSON array of `{event}` or `{exit: code}` or `{waitMs}` steps), checks that `KASA_TUNNEL_SECRET` is set, and plays the steps on stdout.
- [ ] **Step 2: Write failing tests:**
  - **`tunnel.test.ts`:**
    - phases follow `login`, `enable`, `ready`; `host()` is `kasa-home.example.ts.net`;
    - bad JSON lines are ignored;
    - an exit while enabled restarts (`backoffMs: [10, 10]`) and then gives `problem`;
    - `stop()` gives `off` and the child is killed;
    - the secret is passed in the environment and not in argv.
  - **`remoteRoutes.test.ts`** (app built with a `RemoteAccess` on the fake):
    - each route's success and refusal above;
    - `pair-code` gives a URL `https://kasa-home.example.ts.net/pair#<22 chars>`;
    - `open-link` calls `openExternal` only for `https://login.tailscale.com/...`;
    - starting the server with `enabled: true` in `remote.json` starts the tunnel;
    - a `reload()` keeps the remote listener serving: a request before and after both reach the app.
- [ ] **Step 3: Run** the two tests. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `StartServerOptions.tunnel?: { command: string; args?: string[] }` and `.openExternal?`.
  - In `startServer`, create one `RemoteAccess` next to `onboarding` (it survives reloads) and pass it into every `buildApp`.
  - After the first listen, when `remote.available`, bind `listenHttp(app, { host: '127.0.0.1', port: 0, remote: true })` and `attach(port)`.
  - In `swapInto`, also swap the remote listener. `stop()` closes it and calls `remote.stop()`.
  - `/api/session` sets `remoteOn` (phase `on`) and `remote: isRemote(req)`.
- [ ] **Step 5: Run** `pnpm --filter @kasa/server test`. Expected: all pass.
- [ ] **Step 6: Commit** ("Run the tunnel helper and add the away-from-home controls").

### Task 5: Desktop app, packaging and CI

**Files:**
- Modify: `apps/desktop/src/main.ts`, `apps/desktop/src/selfTest.ts`, `apps/desktop/electron-builder.yml`, `apps/desktop/package.json`, `.github/workflows/build.yml`
- Test: `apps/desktop/test/` (a unit test for the helper path function)

**Interfaces:**
- Consumes: Task 1's binary layout; Task 4's `StartServerOptions.tunnel` and `openExternal`.
- Produces: `export function tunnelBinary(opts: { packaged: boolean; resourcesPath: string; appRoot: string; platform: NodeJS.Platform }): string | undefined`.
  - Packaged: `<resourcesPath>/tunnel/kasa-tunnel[.exe]`.
  - Dev: `<appRoot>/../tunnel/bin/<linux|win|mac>/kasa-tunnel[.exe]`.
  - Undefined when the file is missing.

- [ ] **Step 1: Write the failing test** for `tunnelBinary`: the packaged paths on win32 and darwin, the dev path, and undefined when missing.
- [ ] **Step 2: Run** `pnpm --filter @kasa/desktop test`. Expected: FAIL.
- [ ] **Step 3: Implement and wire it.**
  - `startServer({ ..., tunnel: bin ? { command: bin } : undefined, openExternal: (u) => void shell.openExternal(u) })`.
  - `electron-builder.yml` `extraResources`: add `{ from: '../tunnel/bin/${os}', to: 'tunnel' }`. If the mac universal merge complains about the file, add `mac.x64ArchFiles: 'Contents/Resources/tunnel/kasa-tunnel'`.
  - Desktop `dist` script: `pnpm --filter @kasa/tunnel build && pnpm build && electron-builder --publish never`.
  - The self-test runs `<tunnel binary> --version` and fails unless the output starts with `kasa-tunnel `.
  - CI `package` job: `actions/setup-go@v5` (same `go-version-file` and cache path) before the dist step.
- [ ] **Step 4: Verify.** Run `pnpm --filter @kasa/desktop test`. Then run `pnpm --filter @kasa/desktop dist` and the AppImage `--self-test`, which prints `SELF-TEST OK`. Check that `dpkg -c release/kasa-home.deb | grep kasa-tunnel` shows the helper.
- [ ] **Step 5: Commit** ("Ship the tunnel helper in the desktop app").

### Task 6: Web pages

**Files:**
- Create: `apps/web/src/components/AwayFromHome.tsx`, `apps/web/src/components/Pair.tsx`, `apps/web/src/components/NotPaired.tsx`, with tests next to each (`*.test.tsx`)
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Settings.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/styles/app.css`

**Interfaces:**
- Consumes: Task 2's types; Task 4's routes; `qrSvg(text)` from `lib/qr.ts`.

Copy, exactly:

| Where | Text |
| --- | --- |
| Section title | `Away from home` |
| Off | `Watch from anywhere with your phone's browser.` |
| Starting | `Connecting...` |
| Sign-in | `Sign in once to the free Tailscale service that carries the encrypted video.`, button `Sign in` |
| Approve | `One more click: allow Kasa Home to share a web address.`, button `Approve` |
| On | the URL, button `Add a phone`, then the device list `<name>, added <date>, used <relative>`, each with `Remove` |
| Add a phone (QR panel) | `Scan this with the phone's camera. The code works once, for 10 minutes.` |
| Problem | the message, button `Try again` (turns off and on again) |
| Footer link | `Sign out of Tailscale` |
| Phone button | `Use this phone away from home` |
| Pair page, working | `Setting up this phone...` |
| Pair page, failed | `This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.` |
| Pair page, done | the camera, plus a one-time hint `Tip: add this page to your home screen.` |
| Not paired | `This phone isn't set up to watch from away. At home, scan the code in Kasa Home on your computer.` |

- [ ] **Step 1: Write failing tests:**
  - **`AwayFromHome`:**
    - renders each phase from a mocked `GET /api/remote`;
    - the toggle posts `enable`;
    - `Sign in` and `Approve` post `open-link`;
    - `Add a phone` shows an SVG QR built from the `pair-code` URL;
    - `Remove` sends DELETE;
    - polls every 2 s while the phase is `starting`, `sign-in` or `approve`.
  - **`Pair`:** reads the code from `location.hash`, posts `{code}` to `/api/remote/pair`, clears the hash with `history.replaceState`, and shows the failed text on 401.
  - **`App`:**
    - `/pair` renders `Pair`;
    - a 401 `device-not-paired` from `/api/session` renders `NotPaired`;
    - on `session.remote` the Settings button is hidden;
    - with `!local && !remote && remoteOn`, Settings shows the phone button, which posts `pair-code` and assigns `location`.
  - Only the computer (`session.local && session.desktop`) shows `AwayFromHome`.
- [ ] **Step 2: Run** `pnpm --filter @kasa/web test`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the existing components' structure and styles.
- [ ] **Step 4: Run** `pnpm check` at the root. Expected: all pass.
- [ ] **Step 5: Commit** ("Add the away-from-home settings and phone pairing pages").

### Task 7: Docs

**Files:** Modify `README.md` (an "Away from home" section: what it does, the three steps, what Tailscale sees, how to turn it off and remove phones), and add the remote listener and its rules to `docs/PROTOCOL.md` only if that file covers the server (it covers the camera, so most likely skip it).

- [ ] **Step 1:** Write the README section in plain words, per the unslop rules.
- [ ] **Step 2: Commit** ("Document away-from-home viewing").
