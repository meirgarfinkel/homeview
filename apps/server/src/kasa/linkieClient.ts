import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson } from './cipher.js';
import type { CameraCredentials, PasswordEncoding } from './credentials.js';
import { cameraRequest, readAll } from './httpClient.js';
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

  constructor(private readonly opts: LinkieClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Send a raw command object and return the decoded reply. */
  send(command: Json): Promise<Json> {
    const run = this.queue.then(() => this.sendWithAuth(command));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Call one method on one module. `module` may be the short name ("ptz") or
   * the full "smartlife.cam.ipcamera.ptz". Throws LinkieError on err_code != 0.
   */
  async call(module: string, method: string, args: Json = {}): Promise<Json> {
    const fullModule = module.includes('.') ? module : CAMERA_MODULE_PREFIX + module;
    const reply = await this.send({ [fullModule]: { [method]: args } });
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

  private async sendWithAuth(command: Json): Promise<Json> {
    const { credentials, logger } = this.opts;
    const candidates = credentials.candidates();
    for (const encoding of candidates) {
      const reply = await this.post(command, encoding);
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

  private async post(command: Json, encoding: PasswordEncoding): Promise<Json | 'unauthorized'> {
    const payload = { ...command, context: { source: randomUUID() } };
    const content = encryptJson(payload).toString('base64');
    const body = Buffer.from(new URLSearchParams({ content }).toString(), 'utf8');

    const res = await cameraRequest({
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
    });
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
