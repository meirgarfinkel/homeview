import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson } from './cipher.js';
import type { CameraCredentials, PasswordEncoding } from './credentials.js';
import type { TLSSocket } from 'node:tls';
import { CameraHttpError, cameraRequest, connectCamera, readAll } from './httpClient.js';
import type { CameraTlsConfig } from './tls.js';
import type { Logger } from '../logger.js';

/**
 * Client for the camera's local control API: POST https://<cam>:10443/data/LINKIE.json
 *
 * Request body:  content=<urlencoded base64(xor(json))>
 * Response body: base64(xor(json))
 * Auth:          HTTP Basic, see credentials.ts
 *
 * Commands look like {"smartlife.cam.ipcamera.<module>": {"<method>": {...args}}}
 * and replies mirror that shape with an `err_code` (0 = success).
 */

export const CAMERA_MODULE_PREFIX = 'smartlife.cam.ipcamera.';
/**
 * Pre-connected sockets kept while warm: three for ordinary commands (enough
 * for a tap followed by a hold) and one held back for urgent ones (stop).
 */
type PoolKind = 'normal' | 'urgent';
const POOL_SIZE: Record<PoolKind, number> = { normal: 3, urgent: 1 };
/** Replace used spares this long after the last request. */
const REFILL_AFTER_MS = 1500;
const UNAUTHORIZED = -10007;

export class LinkieError extends Error {
  constructor(
    message: string,
    readonly errCode: number,
  ) {
    super(message);
    this.name = 'LinkieError';
  }
}

export class CameraAuthError extends Error {
  constructor(message = 'The camera rejected the Kasa username/password') {
    super(message);
    this.name = 'CameraAuthError';
  }
}

export interface LinkieClientOptions {
  host: string;
  port: number;
  credentials: CameraCredentials;
  tls?: CameraTlsConfig;
  timeoutMs?: number;
  logger?: Logger;
}

type Json = Record<string, unknown>;

export interface CameraSysinfo {
  alias?: string;
  model?: string;
  sw_ver?: string;
  hw_ver?: string;
  type?: string;
  mac?: string;
  deviceId?: string;
  resolution?: string;
  rssi?: number;
  led_status?: string;
  camera_switch?: string;
  c_opt?: number[];
  [key: string]: unknown;
}

export class LinkieClient {
  private readonly timeoutMs: number;
  /** Serializes requests: the camera's tiny HTTP server handles one at a time best. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pools: Record<PoolKind, Promise<TLSSocket | undefined>[]> = {
    normal: [],
    urgent: [],
  };
  private warmUntil = 0;
  private coolTimer: NodeJS.Timeout | undefined;
  private refillTimer: NodeJS.Timeout | undefined;
  private refillsPaused = false;

  constructor(private readonly opts: LinkieClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  get host(): string {
    return this.opts.host;
  }

  /** Point later requests at a new address (the camera's IP changed). */
  setHost(host: string): void {
    this.opts.host = host;
    this.dropSpares();
  }

  /**
   * Keep pre-connected spare sockets ready for the next `ms`, so requests
   * skip the camera's slow TLS handshake (~0.5 s down to ~30 ms). Used while
   * pan/tilt is active; extended by each call. One socket is reserved for
   * urgent commands, so a stop never waits for a handshake.
   */
  keepWarm(ms: number): void {
    this.warmUntil = Math.max(this.warmUntil, Date.now() + ms);
    this.refillSpares();
  }

  /**
   * While paused, used spares aren't replaced (a handshake stalls the camera
   * for ~1.2 s, so none may be running when a stop goes out). Resuming
   * refills right away.
   */
  pauseRefills(paused: boolean): void {
    this.refillsPaused = paused;
    if (!paused) this.refillSpares();
  }

  /** Drop the spare connections. */
  close(): void {
    this.warmUntil = 0;
    this.dropSpares();
  }

  private dropSpares(): void {
    for (const pool of Object.values(this.pools)) {
      for (const spare of pool.splice(0)) void spare.then((s) => s?.destroy());
    }
  }

  private refillSpares(): void {
    if (this.refillsPaused) return;
    for (const [kind, size] of Object.entries(POOL_SIZE) as [PoolKind, number][]) {
      const pool = this.pools[kind];
      while (pool.length < size && Date.now() < this.warmUntil) {
        const remove = () => {
          const i = pool.indexOf(spare);
          if (i !== -1) pool.splice(i, 1);
          return i !== -1;
        };
        const spare: Promise<TLSSocket | undefined> = connectCamera(
          this.opts.host,
          this.opts.port,
          this.opts.tls,
        ).then(
          (socket) => {
            // The camera closed an idle spare: replace it.
            socket.once('close', () => remove() && this.scheduleRefill());
            return socket;
          },
          () => {
            remove();
            return undefined;
          },
        );
        pool.push(spare);
      }
    }
    clearTimeout(this.coolTimer);
    const left = this.warmUntil - Date.now();
    if (left > 0) {
      this.coolTimer = setTimeout(() => {
        if (Date.now() >= this.warmUntil) this.close();
      }, left + 50);
      this.coolTimer.unref();
    }
  }

  /**
   * The oldest spare socket of a pool, waiting for its handshake if it's
   * still going (it started earlier than a new connection would). An urgent
   * command falls back to the normal pool. Undefined when not warm.
   */
  private async takeSpare(urgent: boolean): Promise<TLSSocket | undefined> {
    for (const kind of urgent ? (['urgent', 'normal'] as const) : (['normal'] as const)) {
      const pool = this.pools[kind];
      while (pool.length > 0) {
        const spare = pool.shift()!;
        this.scheduleRefill();
        const socket = await spare;
        if (socket && !socket.destroyed) return socket;
      }
    }
    return undefined;
  }

  /** Replace used spares once requests quiet down, not between them. */
  private scheduleRefill(): void {
    clearTimeout(this.refillTimer);
    this.refillTimer = setTimeout(() => this.refillSpares(), REFILL_AFTER_MS);
    this.refillTimer.unref();
  }

  send(command: Json, opts: { urgent?: boolean } = {}): Promise<Json> {
    // Urgent commands (stopping the motor) skip the queue: the camera answers
    // requests on parallel connections, so a stop needn't wait for a move.
    if (opts.urgent) return this.sendWithAuth(command, true);
    const run = this.queue.then(() => this.sendWithAuth(command, false));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Call one method on one module. `module` may be the short name ("ptz") or
   * the full "smartlife.cam.ipcamera.ptz". Throws LinkieError on err_code != 0.
   */
  async call(
    module: string,
    method: string,
    args: Json = {},
    opts: { urgent?: boolean } = {},
  ): Promise<Json> {
    const fullModule = module.includes('.') ? module : CAMERA_MODULE_PREFIX + module;
    const reply = await this.send({ [fullModule]: { [method]: args } }, opts);
    const moduleReply = reply[fullModule] as Json | undefined;
    checkErr(moduleReply, `${fullModule}`);
    const methodReply = moduleReply?.[method] as Json | undefined;
    checkErr(methodReply, `${fullModule}.${method}`);
    return methodReply ?? {};
  }

  async getSysinfo(): Promise<CameraSysinfo> {
    const reply = await this.send({ system: { get_sysinfo: {} } });
    const outer = reply['system'] as Json | undefined;
    const inner = outer?.['get_sysinfo'] as Json | undefined;
    checkErr(inner, 'system.get_sysinfo');
    return (inner?.['system'] as CameraSysinfo | undefined) ?? {};
  }

  private async sendWithAuth(command: Json, urgent: boolean): Promise<Json> {
    const { credentials, logger } = this.opts;
    const candidates = credentials.candidates();
    for (const encoding of candidates) {
      const reply = await this.post(command, encoding, urgent);
      if (reply !== 'unauthorized') {
        if (credentials.resolvedEncoding !== encoding) {
          logger?.info({ encoding }, 'Camera accepted credentials');
          credentials.markWorking(encoding);
        }
        return reply;
      }
      logger?.debug({ encoding }, 'Camera rejected password encoding');
    }
    throw new CameraAuthError();
  }

  private async post(
    command: Json,
    encoding: PasswordEncoding,
    urgent: boolean,
  ): Promise<Json | 'unauthorized'> {
    const payload = { ...command, context: { source: randomUUID() } };
    const content = encryptJson(payload).toString('base64');
    const body = Buffer.from(new URLSearchParams({ content }).toString(), 'utf8');

    const started = performance.now();
    const socket = await this.takeSpare(urgent);
    const waitedMs = Math.round(performance.now() - started);
    const request = (spare?: TLSSocket) =>
      cameraRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'POST',
        path: '/data/LINKIE.json',
        headers: {
          Authorization: this.opts.credentials.header(encoding),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        tls: this.opts.tls,
        timeoutMs: this.timeoutMs,
        ...(spare ? { socket: spare } : {}),
      });
    let res: Awaited<ReturnType<typeof cameraRequest>>;
    try {
      res = await request(socket);
    } catch (err) {
      // The camera may have closed the spare just before it was used.
      if (!socket || !(err instanceof CameraHttpError) || err.code !== 'network') throw err;
      res = await request();
    }
    this.opts.logger?.debug(
      { spare: socket !== undefined, waitedMs, ms: Math.round(performance.now() - started) },
      'Camera API request',
    );
    try {
      if (res.statusCode === 401 || res.statusCode === 403) return 'unauthorized';
      if (res.statusCode !== 200) {
        throw new LinkieError(`Camera API returned HTTP ${res.statusCode}`, -res.statusCode);
      }
      const raw = (await readAll(res.body, 1024 * 1024)).toString('latin1').trim();
      const reply = decryptJson<Json>(Buffer.from(raw, 'base64'));
      if (reply['err_code'] === UNAUTHORIZED) return 'unauthorized';
      return reply;
    } finally {
      res.close();
    }
  }
}

function checkErr(node: Json | undefined, where: string): void {
  if (!node) return;
  const code = node['err_code'];
  if (typeof code === 'number' && code !== 0) {
    const msg = typeof node['err_msg'] === 'string' ? node['err_msg'] : 'unknown error';
    if (code === UNAUTHORIZED) throw new CameraAuthError();
    throw new LinkieError(`${where} failed: ${msg} (err_code ${code})`, code);
  }
}
