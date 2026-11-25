# Kasa Home desktop app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Kasa Home as installable desktop apps (Linux, Windows, macOS) that a parent sets up entirely in the browser, with a tray icon.

**Architecture:** The server gains a settings file, a "not set up yet" mode, a
`startServer()` entry point, setup and settings APIs, and plain HTTP for the
computer itself. The web app gains the setup wizard, camera onboarding
screens and a settings page. A new `apps/desktop` Electron app runs the
server in its main process (bundled into one file with tsup), shows a tray
icon, and opens the normal browser. electron-builder makes the installers;
GitHub Actions builds, self-tests and releases them.

**Tech Stack:** TypeScript 6, Node 22.12+, Fastify 5, React 19 + Vite, vitest,
tsup, Electron (current stable), electron-builder, GitHub Actions. New
libraries: `qrcode-generator` (web), `jsdom` and `@testing-library/react`
(web tests).

**Spec:** `docs/superpowers/specs/2026-11-25-desktop-app-design.md`

## Global Constraints

- Product name **Kasa Home** in every user-visible string; `kasa-home` in
  file and package names; app id `io.github.meirgarfinkel.kasahome`.
- Installer files: `Kasa-Home-x86_64.AppImage`, `kasa-home.deb`,
  `Kasa-Home-Setup.exe` (per-user, no administrator password),
  `Kasa-Home.dmg` (universal: Apple Silicon and Intel).
- No terminal or file editing needed at any point in the desktop app.
- Setup pages and setup APIs answer only loopback clients until setup is
  complete. Others get the "isn't set up yet" response.
- The viewer password is stored as a salted scrypt hash, never plain.
- The camera password is encrypted with Electron `safeStorage` when
  available, otherwise stored in the owner-only file.
- The data folder is mode 0700, files in it 0600.
- `pnpm start`, `.env` and the existing systemd setup keep working;
  environment variables override `settings.json`. The desktop app never
  reads `.env`.
- The computer itself uses `http://localhost:<port>` (no certificate
  warning); everyone else uses `https://<LAN IP>:<port>`.
- Default port 8090; if taken, the next free port up to 8099.
- TP-Link account sign-up link: `https://myproducts.tp-link.com`.
- Out of scope: phone apps, auto-update, code signing, automatic Wi-Fi
  switching on macOS and Windows.
- All writing in the UI and docs follows the repo's plain style: sentence
  case, no em dashes, straight quotes.

## Review Focus

1. **Port 8090 already in use** (for example `pnpm start` or the systemd
   service still running): the app starts on 8091 and the tray, the All set
   page and the QR code all show 8091. Pinned in Task 4.
2. **A corrupt or half-written `settings.json`** (power cut during a save):
   the app still starts, keeps the bad file as `settings.json.broken`, and
   shows setup again instead of crashing. Pinned in Task 2.
3. **Loopback detection:** `127.0.0.1`, `::1` and `::ffff:127.0.0.1` count as
   the computer itself; the computer's own LAN address (`192.168.x.y`) does
   not. Pinned in Task 5.
4. **The computer has no LAN address** (not on any network): the All set
   page says to connect the computer to Wi-Fi instead of showing a QR code
   for `127.0.0.1`. Pinned in Tasks 4 and 12.
5. **A wrong Kasa password on the "already works" path:** a clear message,
   nothing saved, the parent can retry. Pinned in Task 6.

---

## File structure

```text
apps/server/src/
  security/passwordHash.ts      new   scrypt hash and verify
  security/session.ts           edit  SessionManager takes a verifier
  settings/store.ts             new   settings.json read/write, protector
  config.ts                     edit  camera login optional, merge settings
  server.ts                     new   startServer(): what index.ts does today
  index.ts                      edit  thin wrapper over startServer()
  listen.ts                     edit  plain HTTP for loopback clients
  security/network.ts           edit  isLoopback()
  app.ts                        edit  optional camera, setup gate
  routes/setup.ts               new   setup + onboarding API
  routes/settings.ts            new   settings + app API
  setup/onboarding.ts           new   Onboarding state machine
  setup/wifiSwitcher.ts         new   nmcli and manual switchers
  scripts/setupCamera.ts        edit  terminal front end of Onboarding
apps/web/src/
  App.tsx                       edit  route to setup / not set up / monitor
  components/setup/*.tsx        new   wizard screens
  components/Settings.tsx       new   settings page
  components/Login.tsx          edit  "Set a new password" on the computer
  lib/api.ts                    edit  new endpoints
packages/shared/src/index.ts    edit  session, setup, onboarding, settings types
apps/desktop/                   new   Electron app, packaging, icons
.github/workflows/build.yml     new   check, package, self-test, release
README.md                       edit  downloads-first guide
```

---

### Task 1: Hashed viewer password

**Files:**

- Create: `apps/server/src/security/passwordHash.ts`
- Modify: `apps/server/src/security/session.ts:18-55`, `apps/server/src/routes/api.ts:59-90`, `apps/server/src/app.ts:57-59`
- Test: `apps/server/test/passwordHash.test.ts`, `apps/server/test/session.test.ts`

**Interfaces:**

- Produces:
  - `hashPassword(password: string): Promise<string>` returning `scrypt$<N>$<saltB64>$<hashB64>` (N = 2^15, 16-byte salt, 32-byte key).
  - `verifyPassword(password: string, stored: string): Promise<boolean>` (false for a malformed `stored`).
  - `interface PasswordCheck { verify(candidate: string): Promise<boolean>; binding: string }`
  - `passwordCheckFromPlain(password: string): PasswordCheck` (binding = the password, as today)
  - `passwordCheckFromHash(hash: string): PasswordCheck` (binding = the hash string)
  - `new SessionManager(check: PasswordCheck, secret?: string)`, with `checkPassword(candidate): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
// passwordHash.test.ts
it('hashes with a fresh salt and verifies only the right password', async () => {
  const a = await hashPassword('sleepy-owl-42');
  const b = await hashPassword('sleepy-owl-42');
  expect(a).toMatch(/^scrypt\$32768\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  expect(a).not.toBe(b);
  expect(await verifyPassword('sleepy-owl-42', a)).toBe(true);
  expect(await verifyPassword('sleepy-owl-43', a)).toBe(false);
  expect(await verifyPassword('x', 'garbage')).toBe(false);
});
// session.test.ts: existing tests switch to passwordCheckFromPlain('hunter2'), awaiting checkPassword; add:
it('works from a stored hash, and a new hash logs everyone out', async () => {
  const s = new SessionManager(
    passwordCheckFromHash(await hashPassword('hunter22')),
    'a'.repeat(32),
  );
  expect(await s.checkPassword('hunter22')).toBe(true);
  const { token } = s.issue();
  const other = new SessionManager(
    passwordCheckFromHash(await hashPassword('hunter22')),
    'a'.repeat(32),
  );
  expect(other.verify(token)).toBe(false);
});
```

- [ ] **Step 2: Run** `cd apps/server && npx vitest run test/passwordHash.test.ts test/session.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `passwordHash.ts` with `crypto.scrypt` and `timingSafeEqual`, then change `SessionManager` to take a `PasswordCheck` (HMAC key from `secret` + `check.binding`), and the login route to `await sessions.checkPassword(...)`. `app.ts` builds it with `passwordCheckFromPlain(config.viewerPassword)` for now (Task 3 adds the hash).
- [ ] **Step 4: Run** the two files, then `npx vitest run`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "Hash-capable viewer password check"`

---

### Task 2: Settings store

**Files:**

- Create: `apps/server/src/settings/store.ts`
- Test: `apps/server/test/settingsStore.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface SecretProtector {
    encrypt(plain: string): string;
    decrypt(stored: string): string;
    readonly kind: 'safeStorage' | 'plain';
  }
  export const plainProtector: SecretProtector;
  export interface Settings {
    viewerPasswordHash?: string;
    camera?: { username: string; password: string; alias?: string; localOnly: boolean };
  }
  export class SettingsStore {
    constructor(dir: string, protector?: SecretProtector, logger?: Logger);
    load(): Settings; // never throws; see Step 1
    save(next: Settings): void; // atomic, 0600
    readonly file: string; // <dir>/settings.json
  }
  ```

  On disk the camera password is `{ "passwordProtected": "<protector output>", "protector": "<kind>" }`; `load()` returns it decrypted.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns empty settings when there is no file', () => {
  expect(new SettingsStore(tmp()).load()).toEqual({});
});
it('round-trips, writes owner-only, and never stores the camera password in plain text with a real protector', () => {
  const dir = tmp();
  const rot13: SecretProtector = {
    kind: 'safeStorage',
    encrypt: (s) => `x:${[...s].reverse().join('')}`,
    decrypt: (s) => [...s.slice(2)].reverse().join(''),
  };
  const store = new SettingsStore(dir, rot13);
  const value = {
    viewerPasswordHash: 'scrypt$1$a$b',
    camera: { username: 'a@b.c', password: 'pw-123', localOnly: false },
  };
  store.save(value);
  expect(new SettingsStore(dir, rot13).load()).toEqual(value);
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readFileSync(store.file, 'utf8')).not.toContain('pw-123');
});
it('keeps a corrupt file as settings.json.broken and starts empty', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'settings.json'), '{"camera": {"user');
  expect(new SettingsStore(dir).load()).toEqual({});
  expect(readFileSync(path.join(dir, 'settings.json.broken'), 'utf8')).toContain('"user');
});
it('drops a camera password it can no longer decrypt, keeping the rest', () => {
  /* save with rot13, load with a protector whose decrypt throws: camera is undefined, viewerPasswordHash kept */
});
```

- [ ] **Step 2: Run** `npx vitest run test/settingsStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with zod validation of the parsed JSON (invalid shape counts as corrupt), write to `settings.json.tmp` then `renameSync`, `mkdirSync(dir, { recursive: true, mode: 0o700 })` plus `chmodSync`.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the settings store"`

---

### Task 3: Config from environment plus settings

**Files:**

- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/https.test.ts` (config block), new `apps/server/test/configSettings.test.ts`

**Interfaces:**

- Consumes: `Settings` (Task 2), `PasswordCheck` helpers (Task 1).
- Produces:
  - `loadConfig(env?: NodeJS.ProcessEnv, settings?: Settings): Config`
  - `Config.camera.username: string | undefined`, `Config.camera.password: string | undefined`
  - `Config.viewer: { kind: 'plain'; password: string } | { kind: 'hash'; hash: string } | undefined` (replaces `viewerPassword`)
  - `Config.setupComplete: boolean`: true when a viewer password (or `ALLOW_NO_PASSWORD`) and a camera login both exist.
  - `Config.desktop: boolean` (false here; Task 4 sets it).
  - `viewerCheck(config: Config): PasswordCheck | undefined`

Rules: env `KASA_USERNAME`/`KASA_PASSWORD`/`KASA_ALIAS`/`VIEWER_PASSWORD` win over settings. Without `settings`, a missing `VIEWER_PASSWORD` still throws `ConfigError` as today (unchanged `pnpm start` behaviour); a missing camera login no longer throws, it makes `setupComplete` false.

- [ ] **Step 1: Write the failing tests**

```ts
it('is not set up with empty settings and no env', () => {
  const c = loadConfig({}, {});
  expect(c.setupComplete).toBe(false);
  expect(c.viewer).toBeUndefined();
  expect(c.camera.username).toBeUndefined();
});
it('takes the hash and camera login from settings', () => {
  const c = loadConfig(
    {},
    {
      viewerPasswordHash: 'scrypt$1$a$b',
      camera: { username: 'u@x', password: 'p', alias: 'Nursery', localOnly: false },
    },
  );
  expect(c.setupComplete).toBe(true);
  expect(c.viewer).toEqual({ kind: 'hash', hash: 'scrypt$1$a$b' });
  expect(c.camera).toMatchObject({ username: 'u@x', password: 'p', alias: 'Nursery' });
});
it('lets environment variables override settings', () => {
  const c = loadConfig(
    { KASA_USERNAME: 'env@x', KASA_PASSWORD: 'envpw', VIEWER_PASSWORD: 'long enough' },
    {
      viewerPasswordHash: 'scrypt$1$a$b',
      camera: { username: 'u@x', password: 'p', localOnly: false },
    },
  );
  expect(c.camera.username).toBe('env@x');
  expect(c.viewer).toEqual({ kind: 'plain', password: 'long enough' });
});
it('still refuses to start from .env alone without a viewer password', () => {
  expect(() => loadConfig({ KASA_USERNAME: 'u', KASA_PASSWORD: 'p' })).toThrow(/VIEWER_PASSWORD/);
});
```

- [ ] **Step 2: Run** `npx vitest run test/configSettings.test.ts test/https.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, updating every reader of `config.viewerPassword` and `config.camera.username/password` (`app.ts`, `index.ts`, `kasa/camera.ts`, scripts) to the new shapes. Scripts that need a camera login (`probe`, `discover` doesn't) exit with a plain message when it's missing.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc -p tsconfig.json --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "Merge settings.json into config; camera login optional"`

---

### Task 4: `startServer()` and setup mode

**Files:**

- Create: `apps/server/src/server.ts`
- Modify: `apps/server/src/index.ts` (becomes ~20 lines), `apps/server/src/app.ts` (camera and hub optional), `apps/server/src/routes/api.ts`, `apps/server/src/routes/live.ts`, `apps/server/tsup.config.ts` (add `server` entry)
- Test: `apps/server/test/server.test.ts`

**Interfaces:**

- Consumes: `SettingsStore` (Task 2), `loadConfig(env, settings)` (Task 3).
- Produces:

  ```ts
  export interface ServerHooks {
    getAutostart?(): boolean;
    setAutostart?(on: boolean): void;
    quit?(): void;
  }
  export interface StartServerOptions {
    env?: NodeJS.ProcessEnv; // default process.env; desktop passes {} plus its own values
    settings?: SettingsStore; // desktop always; pnpm start: one in config.dataDir
    dataDir?: string;
    staticDir?: string;
    logger?: Logger;
    hooks?: ServerHooks;
    desktop?: boolean;
  }
  export interface RunningServer {
    port: number;
    localUrl: string; // http://localhost:<port> (Task 5 makes it reachable)
    lanUrl: string | undefined; // https://<lan ip>:<port>, undefined when there is no LAN address
    setupComplete(): boolean;
    reload(): Promise<void>; // re-read settings, rebuild camera/hub/app on the same port,
    // recomputing the allowed networks (the computer may have
    // changed Wi-Fi during camera setup)
    stop(): Promise<void>;
  }
  export function startServer(opts?: StartServerOptions): Promise<RunningServer>;
  export function lanAddress(
    interfaces?: ReturnType<typeof os.networkInterfaces>,
  ): string | undefined;
  ```
  - `AppDeps.camera` and `AppDeps.hub` become optional. Without a camera, camera, PTZ and live routes answer `503 { error: 'not-set-up' }`.
  - `/api/session` gains `setupComplete: boolean`, `local: boolean` and `desktop: boolean` (shared `SessionResponse` updated).
  - If locating the camera fails at startup, the server still starts (setup complete but camera offline): camera routes answer `503 { error: 'camera-offline', message }`, and a retry runs every 30 s.
  - Port: try `config.port` (desktop default 8090), then +1 up to +9.

- [ ] **Step 1: Write the failing tests** (fake camera, temp data dir, `HTTPS=false` to keep them short):

```ts
it('starts with no settings and serves the setup state', async () => {
  const s = await startServer({
    env: { PORT: '0', HTTPS: 'false', LOG_LEVEL: 'silent' },
    settings: new SettingsStore(tmp()),
    desktop: true,
  });
  const res = await fetch(`${s.localUrl}/api/session`).then((r) => r.json());
  expect(res).toMatchObject({ setupComplete: false, local: true, desktop: true });
  expect((await fetch(`${s.localUrl}/api/camera`)).status).toBe(503);
  await s.stop();
});
it('moves to the next port when the first is taken', async () => {
  const blocker = net.createServer().listen(0);
  const taken = (blocker.address() as AddressInfo).port;
  const s = await startServer({
    env: { PORT: String(taken), HTTPS: 'false', LOG_LEVEL: 'silent' },
    settings: new SettingsStore(tmp()),
  });
  expect(s.port).toBe(taken + 1);
  expect(s.localUrl).toBe(`http://localhost:${taken + 1}`);
  await s.stop();
  blocker.close();
});
it('reload() picks up a saved camera login without changing port', async () => {
  /* save settings pointing at the fake camera (KASA_HOST env to 127.0.0.1 and fake ports), reload, /api/camera answers 200 with alias 'fake nursery', port unchanged */
});
it('reports no LAN address when only loopback exists', () => {
  expect(
    lanAddress({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    }),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run** `npx vitest run test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server.ts` by moving `main()`'s body out of `index.ts` and making the camera part optional. `index.ts` calls `loadEnvFile()` then `startServer({ settings: new SettingsStore(config dataDir) })` and wires SIGINT/SIGTERM to `stop()`.
- [ ] **Step 4: Run** the full server suite and `pnpm --filter @kasa/server build && node apps/server/dist/index.js` against your real `.env` (it should start exactly as before). Expected: tests pass; log shows `Kasa Home is running`.
- [ ] **Step 5: Commit** `git commit -m "Add startServer() with a not-set-up mode and port fallback"`

---

### Task 5: Plain HTTP for the computer itself

**Files:**

- Modify: `apps/server/src/listen.ts`, `apps/server/src/security/network.ts`, `apps/server/src/routes/api.ts:48` (cookie `secure` flag)
- Test: `apps/server/test/https.test.ts`, `apps/server/test/network.test.ts`

**Interfaces:**

- Produces: `isLoopback(ip: string | undefined): boolean` in `security/network.ts`. Plain-HTTP connections from loopback go to an `http.createServer(app.routing)` server, and its `upgrade` events are re-emitted on `app.server` so the live WebSocket works over `ws://localhost`. Non-loopback plain HTTP still gets the 308 redirect. Session cookies get `Secure` only when the request itself was HTTPS (`req.protocol === 'https'`).

- [ ] **Step 1: Write the failing tests**

```ts
// network.test.ts
it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10'])(
  'treats %s as this computer',
  (ip) => expect(isLoopback(ip)).toBe(true),
);
it.each(['192.168.1.20', '10.0.0.7', '::ffff:192.168.1.20', undefined])(
  'does not treat %s as this computer',
  (ip) => expect(isLoopback(ip)).toBe(false),
);
// https.test.ts (HTTPS listener block)
it('serves plain HTTP to this computer instead of redirecting', async () => {
  const res = await raw('GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n');
  expect(res).toMatch(/^HTTP\/1\.1 200/);
  expect(res).toContain('{"hi":true}');
});
```

The existing redirect test changes to connect from a non-loopback address. Add a second test app bound to `127.0.0.2` is not enough (still loopback), so the listener gets an injectable `isLocalClient` option, default `isLoopback`, and the redirect test passes `() => false`.

- [ ] **Step 2: Run** `npx vitest run test/https.test.ts test/network.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run** the full suite, plus an integration check in `server.test.ts`: with HTTPS on, `ws://localhost:<port>/api/live` opens and `https://` from a non-local test client is still required. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve plain HTTP to this computer"`

---

### Task 6: Setup gate, password step and "already works" camera

**Files:**

- Create: `apps/server/src/routes/setup.ts`
- Modify: `apps/server/src/app.ts` (gate in the `onRequest` hook)
- Test: `apps/server/test/setupRoutes.test.ts`

**Interfaces:**

- Consumes: `SettingsStore`, `hashPassword`, `RunningServer.reload` (passed into `buildApp` as `deps.reload: () => Promise<void>`), `isLoopback`, `discover`, `findWorkingLogin`.
- Produces (all JSON; shared types `SetupCamera`, `SetupExistingResult`):
  - Gate: while `!config.setupComplete`, any request from a non-loopback client gets `403 { error: 'not-set-up' }` for `/api/*` and the normal page for `/` (the page shows the not-set-up screen from `/api/session`).
  - `POST /api/setup/password { password }` (loopback, not set up): min 8 chars, saves `viewerPasswordHash`. `204`.
  - `POST /api/setup/existing-camera { username, password, alias? }` (loopback, not set up): discovers cameras, tries the login on each until one works (or only the one named `alias`).
    - Several cameras accept it and no `alias` given: `200 { choose: SetupCamera[] }` (`{ alias, model, host }`).
    - One works: saves `camera` (`localOnly: false`), responds `200 { saved: SetupCamera }`, then calls `reload()` after the response is sent.
    - None found: `404 { error: 'no-camera', message: 'No Kasa camera answered on this network. Check it is plugged in and on the same Wi-Fi as this computer.' }`.
    - Login rejected by all: `401 { error: 'wrong-login', message: 'The camera did not accept that email and password. Check they are the ones you use in the Kasa app.' }`. Nothing saved.
  - `POST /api/setup/reset-password { password }` (loopback only, any time): replaces the hash, `204`. Used by "Set a new password".

- [ ] **Step 1: Write the failing tests** (fake camera via `KASA_HOST`-free discovery against `discoveryTargets`: give `startServer` an `env` with `KASA_DISCOVERY_TARGETS=127.0.0.1` and the fake discovery port; add that env var to config as a test-only knob documented in `.env.example`):

```ts
it('refuses setup to anyone but this computer', async () => {
  /* inject with remoteAddress '192.168.1.50': POST /api/setup/password -> 403 not-set-up */
});
it('saves a hashed viewer password', async () => {
  /* POST from 127.0.0.1 -> 204; store.load().viewerPasswordHash matches /^scrypt\$/ and is not the password */
});
it('rejects a short viewer password', async () => {
  /* 'short' -> 400 */
});
it('connects an existing camera and finishes setup', async () => {
  /* POST existing-camera with the fake's account -> 200 saved.alias 'fake nursery'; after reload, /api/session setupComplete true; /api/camera 200 */
});
it('reports a wrong Kasa password and saves nothing', async () => {
  /* -> 401 wrong-login; store.load().camera undefined */
});
it('reports when no camera answers', async () => {
  /* fake stopped -> 404 no-camera */
});
it('lets this computer reset a forgotten viewer password, nobody else', async () => {
  /* non-loopback -> 403; loopback -> 204 and old session cookie no longer works */
});
it('closes the setup endpoints once setup is complete', async () => {
  /* POST /api/setup/password after completion -> 409 */
});
```

- [ ] **Step 2: Run** `npx vitest run test/setupRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `routes/setup.ts` and the gate.
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add browser setup: password and existing camera"`

---

### Task 7: Onboarding state machine

**Files:**

- Create: `apps/server/src/setup/onboarding.ts`, `apps/server/src/setup/wifiSwitcher.ts`
- Modify: `apps/server/src/scripts/setupCamera.ts` (drives `Onboarding` from the terminal; same prompts as today)
- Test: `apps/server/test/onboarding.test.ts`

**Interfaces:**

- Consumes: everything in `kasa/setup.ts` as it is today, `setup/nmcli.ts`, `discover`.
- Produces:

  ```ts
  export type OnboardingPhase =
    | 'reset-camera' // waiting for the parent to say the camera is reset
    | 'join-camera-wifi' // auto: switching; manual: waiting to see the camera at 192.168.0.10
    | 'scanning' // asking the camera for networks
    | 'choose-wifi' // waiting for { ssid, passphrase, alias }
    | 'sending' // set_uplink
    | 'return-home' // auto: switching back; manual: waiting to be on home Wi-Fi
    | 'waiting-for-camera' // up to 120 s for the camera to appear by device ID
    | 'finishing' // alias, clock, on-video time, account link
    | 'done'
    | 'failed';
  export interface OnboardingStatus {
    phase: OnboardingPhase;
    autoWifi: boolean;
    networks?: { ssid: string; signal?: number; open: boolean }[]; // in choose-wifi
    cameraNetwork?: string; // e.g. Kasa_Cam_1A2B, when known
    error?: { message: string; retryFrom: OnboardingPhase }; // in failed
    result?: { alias: string; host: string; linked: boolean; warnings: string[] }; // in done
  }
  export type OnboardingAnswer =
    | { type: 'camera-reset' }
    | { type: 'wifi'; ssid: string; passphrase: string; alias: string }
    | { type: 'retry' };
  export interface WifiSwitcher {
    readonly auto: boolean;
    joinCameraNetwork(): Promise<string | undefined>;
    returnHome(): Promise<void>;
  }
  export function createWifiSwitcher(): Promise<WifiSwitcher>; // nmcli with an active Wi-Fi connection, else manual
  export class Onboarding {
    constructor(opts: {
      mode: 'account' | 'local';
      account?: { username: string; password: string };
      switcher: WifiSwitcher;
      setupAddresses?: string[];
      apiPort?: number;
      discovery?: DiscoverOptions;
      timeouts?: Partial<{ cameraWifiMs: number; homeMs: number }>;
      onSaved(camera: Settings['camera']): void;
      logger: Logger;
    });
    status(): OnboardingStatus;
    answer(a: OnboardingAnswer): void; // throws OnboardingStateError on an answer that doesn't fit the phase
    cancel(): Promise<void>; // returns the computer to home Wi-Fi when it's on the camera's
  }
  ```

  Manual switcher: `joinCameraNetwork()` resolves at once; the machine then polls the setup address every 2 s for up to `cameraWifiMs` (default 10 min). `returnHome()` resolves at once; `waiting-for-camera` polls discovery as today.
  Error messages reuse the existing ones in `setupCamera.ts` (for example "The camera didn't show up. Check the Wi-Fi password and that the network is 2.4 GHz, then reset and try again.").
  `onSaved` gets `{ username, password, alias, localOnly }`: the account for `account`, the working setup login for `local`.

- [ ] **Step 1: Write the failing tests** against `FakeCamera` with `setupMode` (as `setup.test.ts` does) and a test switcher `{ auto: true, joinCameraNetwork: async () => 'Kasa_Cam_TEST', returnHome: async () => {} }`, `setupAddresses: ['127.0.0.1']`, discovery pointed at the fake:

```ts
it('walks a reset camera onto the home Wi-Fi and links the account', async () => {
  const saved = vi.fn();
  const job = new Onboarding({
    mode: 'account',
    account: ACCOUNT,
    switcher,
    onSaved: saved,
    ...fakeTargets,
  });
  expect(job.status().phase).toBe('reset-camera');
  job.answer({ type: 'camera-reset' });
  await waitFor(() => job.status().phase === 'choose-wifi');
  expect(job.status().networks?.map((n) => n.ssid)).toEqual(['HomeNet', 'Cafe', 'Neighbours']);
  job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'wifi-secret', alias: 'nursery' });
  await waitFor(() => job.status().phase === 'done', 10_000);
  expect(fake.uplink?.ssid).toBe('HomeNet');
  expect(fake.bound).toBe(true);
  expect(saved).toHaveBeenCalledWith({ ...ACCOUNT, alias: 'nursery', localOnly: false });
});
it('local only: never links, saves the setup login', async () => {
  /* mode 'local' -> fake.bound false; saved with username 'admin', localOnly true */
});
it('fails with a retry point when the camera never appears on the home network', async () => {
  /* fake ignores uplink (setupMode option) and homeMs: 500 -> phase failed, error.retryFrom 'reset-camera', message matches /2.4 GHz/ */
});
it('rejects an answer that does not fit the phase', () => {
  /* answer wifi during reset-camera -> throws OnboardingStateError */
});
it('cancel() sends the computer back to home Wi-Fi', async () => {
  /* switcher.returnHome spy called once after cancel during choose-wifi */
});
```

- [ ] **Step 2: Run** `npx vitest run test/onboarding.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the sequence in `setupCamera.ts`'s `main()` into the class. `setupCamera.ts` keeps its questions and drives `answer()` from them, writing `.env` from `onSaved` exactly as today.
- [ ] **Step 4: Run** the full suite, then rehearse the terminal command against the fake: `FAKE_CAMERA_SETUP=1 pnpm dev:fake-camera` plus `ENV_FILE=/tmp/x.env pnpm setup-camera`. Expected: tests pass; rehearsal finishes with `Done.`
- [ ] **Step 5: Commit** `git commit -m "Move camera onboarding into a reusable state machine"`

---

### Task 8: Onboarding API

**Files:**

- Modify: `apps/server/src/routes/setup.ts`
- Test: `apps/server/test/setupRoutes.test.ts`

**Interfaces:**

- Consumes: `Onboarding`, `createWifiSwitcher` (Task 7), `SettingsStore`, `deps.reload`.
- Produces (loopback only; allowed when not set up, or when set up and the request has a valid session):
  - `POST /api/setup/onboarding { mode: 'account' | 'local', account? }`: starts a job (replacing a finished one; `409` if one is running). For `account`, `account` is required when not set up, and defaults to the saved camera login otherwise. `202` with the status.
  - `GET /api/setup/onboarding`: `200 OnboardingStatus`, or `404` when no job.
  - `POST /api/setup/onboarding/answer` with an `OnboardingAnswer`: `200` status, `409 { error: 'wrong-step' }` on `OnboardingStateError`.
  - `DELETE /api/setup/onboarding`: cancels, `204`.
  - On `onSaved`: write `camera` into settings; when the job reaches `done`, call `reload()`.
    The page polls `GET` once a second (polling chosen over a WebSocket: simpler, and the page survives a server reload).

- [ ] **Step 1: Write the failing tests**: one full run through the routes with a test switcher injected via `buildApp` deps (`deps.createSwitcher`), asserting the final `/api/session` has `setupComplete: true` once a viewer password was also set; plus `403` from a non-loopback client and `409` for an answer in the wrong phase.
- [ ] **Step 2: Run** `npx vitest run test/setupRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Expose camera onboarding over the API"`

---

### Task 9: Settings and app API

**Files:**

- Create: `apps/server/src/routes/settings.ts`
- Test: `apps/server/test/settingsRoutes.test.ts`

**Interfaces:**

- Consumes: `SettingsStore`, `hashPassword`, `verifyPassword`, `ServerHooks` (Task 4), `deps.reload`.
- Produces (session required for all; shared type `SettingsResponse`):
  - `GET /api/settings`: `{ camera: { username, alias?, localOnly } | null, local: boolean, desktop: boolean, autostart: boolean | null, managedByEnv: string[] }` (`autostart` is `null` without the hook; `managedByEnv` lists settings set by environment variables, which the page shows as read-only).
  - `PUT /api/settings/viewer-password { current, password }`: `current` must verify; saves the new hash; responds `204` with a fresh session cookie, so the person changing it stays signed in while everyone else is logged out.
  - `PUT /api/settings/camera { username, password, alias? }`: same checks and messages as `/api/setup/existing-camera`; saves, then `reload()`.
  - `PUT /api/app/autostart { enabled }`: loopback only; calls `hooks.setAutostart`; `404` without the hook.
  - `POST /api/app/quit`: loopback only; responds `204`, then calls `hooks.quit`; `404` without the hook.

- [ ] **Step 1: Write the failing tests:** wrong `current` gives `403` and keeps the hash; a successful change keeps the caller signed in and invalidates an older cookie; `autostart` and `quit` are `404` without hooks and `403` from a non-loopback client; with hooks, `quit` calls the hook once after replying.
- [ ] **Step 2: Run** `npx vitest run test/settingsRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add settings and app API"`

---

### Task 10: Web: routing, welcome, camera choice, existing camera

**Files:**

- Create: `apps/web/src/components/setup/SetupWizard.tsx`, `PasswordStep.tsx`, `CameraChoice.tsx`, `ExistingCamera.tsx`, `NotSetUp.tsx`; `apps/web/vitest.config.ts` (jsdom environment for `*.test.tsx`)
- Modify: `apps/web/src/App.tsx`, `apps/web/src/lib/api.ts`, `packages/shared/src/index.ts`, `apps/web/package.json` (devDeps `jsdom`, `@testing-library/react`, `@testing-library/user-event`)
- Test: `apps/web/src/components/setup/SetupWizard.test.tsx`

**Interfaces:**

- Consumes: the APIs from Tasks 4, 6 and 8; shared types.
- Produces: `api.setup.{password, existingCamera, resetPassword, startOnboarding, onboarding, answer, cancelOnboarding}`; `<SetupWizard onDone={() => void} />`.

`App.tsx`: `!session.setupComplete && session.local` shows `SetupWizard`; `!session.setupComplete` shows `NotSetUp` ("Kasa Home isn't set up yet. Finish setup on the computer it's installed on."); otherwise the current login/monitor logic.

Screens and copy (exact):

- Welcome: heading "Welcome to Kasa Home", text "Choose a password. Everyone who watches the camera will type it, on any phone or computer.", a password field with a show/hide toggle, "At least 8 characters", button "Next".
- Camera choice: heading "Your camera", three options:
  - "It already works in the Kasa app"
  - "It's new or reset, and I have a TP-Link account" with "No account yet? Create one free at myproducts.tp-link.com, then come back." (link opens in a new tab)
  - "It's new or reset, and I don't want an account" with "The camera keeps its built-in admin / admin login, so anyone on your Wi-Fi who knows it could watch. The Kasa app won't work with it."
- Existing camera: "Kasa email", "Kasa password", button "Connect"; shows the server's `message` on error; with `choose`, a list of camera names to pick from.

- [ ] **Step 1: Write the failing tests** (mock `fetch`):

```ts
it('walks from password to the existing-camera form and connects', async () => {
  /* type 'sleepy-owl-42', Next -> POST /api/setup/password; pick 'It already works in the Kasa app'; fill and Connect -> POST /api/setup/existing-camera; onDone called after {saved} */
});
it('blocks a short password with the 8-character hint', async () => {
  /* 'short' -> Next disabled or message 'At least 8 characters' and no request sent */
});
it('shows the camera list when several accept the login', async () => {
  /* {choose:[a,b]} -> two buttons; clicking b resends with alias */
});
it('shows the server message for a wrong login and keeps the form', async () => {
  /* 401 wrong-login -> message visible, fields kept */
});
```

- [ ] **Step 2: Run** `cd apps/web && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the existing panel/button styles in `app.css`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Web setup: welcome, camera choice, existing camera"`

---

### Task 11: Web: new camera onboarding screens

**Files:**

- Create: `apps/web/src/components/setup/Onboarding.tsx`
- Test: `apps/web/src/components/setup/Onboarding.test.tsx`

**Interfaces:**

- Consumes: `OnboardingStatus`, `OnboardingAnswer` (shared), `api.setup.*` (Task 10).
- Produces: `<Onboarding mode="account" | "local" account?={...} onDone={() => void} onCancel={() => void} />`, polling `GET /api/setup/onboarding` every 1000 ms.

One screen per phase (exact headings):

- `reset-camera`: "Reset the camera". Text: "Hold the camera's reset button until it resets (its manual says how long). After about a minute it starts its own Wi-Fi network, named like Kasa_Cam_1A2B." Button "The camera is reset".
- `join-camera-wifi`: auto: "Connecting to the camera…". Manual: "Join the camera's Wi-Fi", "On this computer, open the Wi-Fi menu and join the network named like Kasa_Cam_1A2B. It has no password. This page carries on by itself once you have."
- `scanning`: "Asking the camera which networks it can see…"
- `choose-wifi`: "Choose your home Wi-Fi", the network list, "Wi-Fi password", "Camera name" (default "nursery"), note "The camera only works on 2.4 GHz Wi-Fi.", button "Connect the camera".
- `return-home` manual: "Rejoin your home Wi-Fi", "Switch this computer back to your home Wi-Fi. This page carries on by itself."
- `waiting-for-camera` / `finishing`: "Waiting for the camera to join your Wi-Fi (up to 2 minutes)…"
- `failed`: the error message and "Try again" (sends `retry`) and "Cancel".
- `done`: calls `onDone`.

- [ ] **Step 1: Write the failing tests**: given a sequence of mocked statuses, the right heading shows for each phase; "Connect the camera" sends `{ type: 'wifi', ssid, passphrase, alias }`; manual vs auto `join-camera-wifi` copy differs; `failed` shows the message and "Try again" sends `retry`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement**; the wizard (Task 10) routes the second and third camera choices here.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Web setup: new camera onboarding"`

---

### Task 12: Web: All set page, settings page, password reset link

**Files:**

- Create: `apps/web/src/components/setup/AllSet.tsx`, `apps/web/src/components/Settings.tsx`, `apps/web/src/lib/qr.ts`
- Modify: `apps/web/src/components/Login.tsx`, `apps/web/src/components/Monitor.tsx` (settings button in the header), `apps/web/package.json` (dependency `qrcode-generator`)
- Test: `apps/web/src/components/setup/AllSet.test.tsx`, `apps/web/src/components/Settings.test.tsx`, `apps/web/src/lib/qr.test.ts`

**Interfaces:**

- Consumes: `/api/session` (`lanUrl` added to `SessionResponse` for local clients only), `/api/settings` and friends (Task 9).
- Produces: `qrSvg(text: string): string` (an `<svg>` string), `<AllSet lanUrl={string | undefined} autostart={boolean | null} />`, `<Settings onClose={() => void} />`.

AllSet copy: heading "All set", the live view (reuse `Monitor`'s video element), "Watch on your phone: scan this, or type the address.", the QR code and the address. Then "Phones show a security warning the first time. Tap Advanced, then Proceed. It's safe: Kasa Home makes its own certificate." On Windows hosts (from `navigator.userAgent`), add: "If Windows asks whether to allow Kasa Home on networks, allow it on private networks." With `lanUrl` undefined: "Connect this computer to your Wi-Fi to watch on other devices." and no QR. Checkbox "Start Kasa Home when this computer starts" when `autostart !== null`.

Settings sections: "Viewer password" (current, new, "Save"), "Camera" (email, password, "Connect"; read-only with "Set in .env" for `managedByEnv` items), "Set up a new or reset camera" (local only, opens `Onboarding`), "Start when this computer starts" (local + desktop), "Stop Kasa Home" (local + desktop, with a confirm).

Login: when `session.local`, a link "Forgot it? Set a new password" opens a form posting to `/api/setup/reset-password`.

- [ ] **Step 1: Write the failing tests:** `qrSvg('https://192.168.1.20:8090')` returns a string starting `<svg` with `viewBox`; AllSet shows the QR and address with a `lanUrl` and the "Connect this computer to your Wi-Fi" message without one; the autostart checkbox calls `PUT /api/app/autostart`; Settings hides the desktop-only sections when `local` or `desktop` is false; Login shows the reset link only when `local`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check`, then `pnpm build` and open `http://localhost:8090` against a temp data dir (`DATA_DIR=$(mktemp -d) pnpm start` with no `.env` camera values) to click through the wizard against `pnpm dev:fake-camera`. Expected: tests pass; the wizard reaches All set.
- [ ] **Step 5: Commit** `git commit -m "Web: All set page, settings page, password reset"`

---

### Task 13: The Electron app

**Files:**

- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/tsup.config.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/tray.ts`, `apps/desktop/src/autostart.ts`, `apps/desktop/src/protector.ts`, `apps/desktop/src/logs.ts`, `apps/desktop/src/selfTest.ts`
- Modify: `pnpm-workspace.yaml` (if needed), root `package.json` (`"desktop": "pnpm --filter @kasa/desktop start"`)
- Test: `apps/desktop/test/autostart.test.ts`, `apps/desktop/test/logs.test.ts`

**Interfaces:**

- Consumes: `startServer`, `ServerHooks`, `SettingsStore`, `SecretProtector` (server Tasks 2 and 4).
- Produces:
  - `main.ts`: `app.requestSingleInstanceLock()`; `second-instance` and launches without `--hidden` open `localUrl` with `shell.openExternal`; `app.dock?.hide()`; `startServer({ env: { LOG_LEVEL: 'info' }, settings: new SettingsStore(userData, safeStorageProtector()), dataDir: userData, staticDir: path.join(process.resourcesPath, 'web'), hooks, desktop: true, logger })`.
  - `autostart.ts`: `getAutostart(): boolean`, `setAutostart(on: boolean): void`. macOS/Windows: `app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })`. Linux (where Electron has no login items): write or remove `~/.config/autostart/kasa-home.desktop` with `Exec="<process.env.APPIMAGE ?? process.execPath>" --hidden`; `linuxAutostartFile(execPath: string): string` is exported for the test.
  - `protector.ts`: `safeStorageProtector(): SecretProtector` (`kind: 'safeStorage'` when `safeStorage.isEncryptionAvailable()` and, on Linux, `safeStorage.getSelectedStorageBackend() !== 'basic_text'`; otherwise `plainProtector`).
  - `tray.ts`: menu "Open Kasa Home", "Start with this computer" (checkbox), "Show logs", "Quit". Tooltip "Kasa Home: <localUrl>".
  - `logs.ts`: `openLogFile(dir: string, maxBytes = 5_000_000): string` (rotates `kasa-home.log` to `kasa-home.old.log` when over `maxBytes`); pino writes there.
  - `selfTest.ts`: `--self-test` sets `userData` to a temp dir, starts the server, checks `GET /api/health` is 200 and `/api/session` has `setupComplete: false`, prints `SELF-TEST OK`, exits 0 (1 with the error otherwise).
  - Bundling: `tsup` bundles `src/main.ts` with `noExternal: [/.*/]` and `external: ['electron']` into `dist/main.mjs`, so the packaged app needs no `node_modules`. All desktop dependencies are devDependencies.

- [ ] **Step 1: Write the failing tests** (plain vitest, `electron` mocked):

```ts
it('writes a Linux autostart entry that starts hidden', () => {
  expect(linuxAutostartFile('/opt/Kasa Home/kasa-home')).toContain(
    'Exec="/opt/Kasa Home/kasa-home" --hidden',
  );
  expect(linuxAutostartFile('/x')).toContain('Name=Kasa Home');
});
it('rotates the log past the size limit', () => {
  /* write 6 MB, openLogFile(dir, 5_000_000) -> old file exists, new file empty */
});
```

- [ ] **Step 2: Run** `cd apps/desktop && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @kasa/web build && pnpm --filter @kasa/desktop build && pnpm --filter @kasa/desktop exec electron dist/main.mjs --self-test`. Expected: `SELF-TEST OK`. Then `pnpm desktop` with no settings: the browser opens the welcome page, and the tray menu works.
- [ ] **Step 5: Commit** `git commit -m "Add the Kasa Home desktop app"`

---

### Task 14: Installers and icon

**Files:**

- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.svg`, `apps/desktop/build/icon.png` (1024×1024), `apps/desktop/build/trayTemplate.png` and `trayTemplate@2x.png` (macOS), `apps/desktop/build/tray.png` (Linux/Windows, 32×32)
- Modify: `apps/desktop/package.json` (`"dist": "electron-builder"`)

**Interfaces:**

- Produces, in `apps/desktop/release/`: the four files named in Global Constraints.

`electron-builder.yml` decisions: `appId: io.github.meirgarfinkel.kasahome`, `productName: Kasa Home`, `files: [dist/**, package.json]`, `extraResources: [{ from: ../web/dist, to: web }]`; `linux.target: [AppImage, deb]`, `deb.depends` adds `libayatana-appindicator3-1 | libappindicator3-1`, `linux.category: Video`; `win.target: nsis` with `oneClick: false, perMachine: false, allowToChangeInstallationDirectory: false`; `mac.target: { target: dmg, arch: universal }`, `mac.identity: "-"` (ad-hoc), `mac.extendInfo.LSUIElement: true` (menu bar only). `artifactName` per target to produce the exact file names.

Icon: a simple line drawing in the style of `apps/web/src/components/Icons.tsx` (a camera on a house outline), exported to PNG with `rsvg-convert` once and committed.

- [ ] **Step 1: Build** on Linux: `pnpm --filter @kasa/desktop dist`. Expected: `Kasa-Home-x86_64.AppImage` and `kasa-home.deb` in `release/`.
- [ ] **Step 2: Self-test the AppImage:** `./apps/desktop/release/Kasa-Home-x86_64.AppImage --self-test`. Expected: `SELF-TEST OK`.
- [ ] **Step 3: Install the .deb in a clean container** and self-test there: `podman run --rm -v $PWD/apps/desktop/release:/r ubuntu:24.04 bash -c "apt-get update && apt-get install -y /r/kasa-home.deb xvfb && xvfb-run /opt/Kasa\ Home/kasa-home --self-test --no-sandbox"`. Expected: `SELF-TEST OK`.
- [ ] **Step 4: Commit** `git commit -m "Package Kasa Home with electron-builder"`

---

### Task 15: GitHub build and release

**Files:**

- Create: `.github/workflows/build.yml`
- Modify: root `package.json` (remove the stale `test:e2e` script)

**Interfaces:**

- Consumes: `pnpm check`, `pnpm --filter @kasa/desktop dist`, the `--self-test` flag.
- Produces: on every pull request and push to `main`: a `check` job (ubuntu) and a `package` matrix (`ubuntu-latest`, `windows-latest`, `macos-latest`) that builds and self-tests (Linux under `xvfb-run`; macOS runs the universal app natively and again with `arch -x86_64`), uploading `Kasa-Home-Linux`, `Kasa-Home-Windows`, `Kasa-Home-Mac` artifacts. On a `v*` tag: the same, then a `release` job that fails unless the tag equals `v` + `apps/desktop/package.json` version, and publishes a GitHub Release with the four files.

- [ ] **Step 1: Write the workflow**, using `pnpm/action-setup` and `actions/setup-node` with Node 24 and pnpm 10, pinned by major version.
- [ ] **Step 2: Push a branch and open a pull request.** Expected: all jobs green; three artifacts downloadable.
- [ ] **Step 3: Download the Windows and Mac artifacts** and record each self-test's `SELF-TEST OK` line from the job logs in the PR description.
- [ ] **Step 4: Commit** `git commit -m "Build, self-test and release installers on GitHub"`

---

### Task 16: README for downloads

**Files:**

- Modify: `README.md`, `.env.example` (document `KASA_DISCOVERY_TARGETS` from Task 6 as a testing knob), `docs/PROTOCOL.md` (link to the onboarding state machine)

Rewrite the step-by-step guide around the installers:

1. Download the file for your computer from the latest Release (links to the four files by name).
2. Install: per system, including the AppImage "Allow executing file as program" step, the Windows "More info, then Run anyway" warning, and the macOS "Open Anyway" in System Settings > Privacy & Security.
3. Open Kasa Home; the browser opens the welcome page.
4. Follow the pages (password, camera choice, with the TP-Link sign-up link and the local-only trade-offs).
5. Watch on phones with the QR code; the one-time certificate warning.
6. Changing settings later; where the tray icon is; what to do on desktops without a tray icon (open the app again to get the page; "Stop Kasa Home" in Settings).

Keep the current terminal guide as "Run from source", shortened, and the troubleshooting list updated for the app.

- [ ] **Step 1: Write it.**
- [ ] **Step 2: Check every link and file name** against the Release from Task 15. Expected: all resolve.
- [ ] **Step 3: Commit** `git commit -m "README: install from the downloads"`
