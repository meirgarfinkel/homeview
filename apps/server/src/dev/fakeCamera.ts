import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { decryptJson, encryptJson } from '../kasa/cipher.js';
import { encodePassword, type PasswordEncoding } from '../kasa/credentials.js';
import { NalType, nalType, splitAnnexB } from '../media/h264.js';

/**
 * An in-process stand-in for a Kasa camera, used by the tests and by
 * `pnpm dev:fake-camera`. It speaks the same wire protocol as the real one:
 *
 *   :stream  GET  /https/stream/mixed  -> chunked multipart H.264 + G.711
 *   :api     POST /data/LINKIE.json    -> base64(xor(json)) commands
 *
 * Not for production use.
 */

const START_CODE = Buffer.from([0, 0, 0, 1]);
export const FAKE_BOUNDARY = 'data-boundary--';

/** Group Annex-B NAL units into access units, splitting at each AUD. */
export function accessUnits(annexB: Buffer): Buffer[] {
  const units: Buffer[][] = [];
  for (const nal of splitAnnexB(annexB)) {
    if (nalType(nal) === NalType.AccessUnitDelimiter || units.length === 0) units.push([]);
    units[units.length - 1]!.push(nal);
  }
  return units.map((nals) => Buffer.concat(nals.flatMap((n) => [START_CODE, n])));
}

export interface FrameProducer extends EventEmitter<{ frame: [Buffer] }> {
  start(): void;
  stop(): void;
}

/** Replays a list of access units in a loop at a fixed frame rate. */
export class LoopingFrameProducer
  extends EventEmitter<{ frame: [Buffer] }>
  implements FrameProducer
{
  private timer: NodeJS.Timeout | undefined;
  private index = 0;

  constructor(
    private readonly units: Buffer[],
    private readonly fps = 15,
  ) {
    super();
    if (units.length === 0) throw new Error('No access units to play');
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.emit('frame', this.units[this.index]!);
      this.index = (this.index + 1) % this.units.length;
    }, 1000 / this.fps);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** G.711 mu-law encoder (ITU-T G.711), for the fake camera's audio track. */
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export interface FakeCameraOptions {
  username: string;
  password: string;
  /** How the camera expects the password in Basic auth. */
  encoding: PasswordEncoding;
  video: FrameProducer;
  alias?: string;
  maxStreams?: number;
  /** Omit Content-Length on parts (forces boundary scanning in the client). */
  omitPartLength?: boolean;
  /** Send PTZ commands as unsupported. */
  noPtz?: boolean;
  /**
   * Start like a factory-reset camera: not linked to an account, accepting
   * only this login until `cloud.set_bind` links `username`/`password`.
   */
  setupMode?: {
    login: { username: string; password: string; encoding: PasswordEncoding };
    networks?: FakeWifiNetwork[];
    /** Reject set_uplink when this field is present, to test the fallbacks. */
    rejectUplinkField?: string;
  };
}

export interface FakeWifiNetwork {
  ssid: string;
  rssi: number;
  wpa_mode: string;
  encryption: string;
  band?: string;
}

export interface FakeUplink {
  ssid: string;
  passphrase: string;
  band: string;
  wpa_mode: string;
  encryption: string;
}

export interface RecordedCommand {
  module: string;
  method: string;
  args: unknown;
}

export class FakeCamera {
  readonly commands: RecordedCommand[] = [];
  bound: boolean;
  alias: string;
  onboardingStatus: string;
  uplink: FakeUplink | undefined;
  private streamServer: https.Server | undefined;
  private discoverySocket: dgram.Socket | undefined;
  private apiServer: https.Server | undefined;
  private readonly active = new Set<{ end(): void }>();
  private readonly startedAt = performance.now();
  private audioTimer: NodeJS.Timeout | undefined;
  private audioPhase = 0;
  private readonly audioListeners = new Set<(chunk: Buffer) => void>();

  constructor(private readonly opts: FakeCameraOptions) {
    this.bound = !opts.setupMode;
    this.alias = opts.alias ?? 'fake nursery';
    this.onboardingStatus = opts.setupMode ? 'none' : 'done';
  }

  get activeStreams(): number {
    return this.active.size;
  }

  async start(host = '127.0.0.1', streamPort = 0, apiPort = 0, discoveryPort?: number) {
    const pems = await generate([{ name: 'commonName', value: 'fake-kasa-camera' }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const tlsOpts = { key: pems.private, cert: pems.cert };
    this.streamServer = https.createServer(tlsOpts, (req, res) => this.handleStream(req, res));
    this.apiServer = https.createServer(tlsOpts, (req, res) => this.handleApi(req, res));
    await Promise.all([
      new Promise<void>((r) => this.streamServer!.listen(streamPort, host, r)),
      new Promise<void>((r) => this.apiServer!.listen(apiPort, host, r)),
    ]);
    this.opts.video.start();
    this.startAudio();
    return {
      ...(discoveryPort !== undefined
        ? { discoveryPort: await this.startDiscovery(host, discoveryPort) }
        : {}),
      streamPort: (this.streamServer.address() as AddressInfo).port,
      apiPort: (this.apiServer.address() as AddressInfo).port,
    };
  }

  /** Answer UDP get_sysinfo like a real camera, so discovery can find it. */
  private startDiscovery(host: string, port: number): Promise<number> {
    const socket = dgram.createSocket('udp4');
    this.discoverySocket = socket;
    socket.on('message', (msg, rinfo) => {
      try {
        const req = decryptJson<Record<string, Record<string, unknown>>>(msg);
        if (!req['system']?.['get_sysinfo']) return;
      } catch {
        return;
      }
      const reply = { system: { get_sysinfo: this.respond('system', 'get_sysinfo', {}) } };
      socket.send(encryptJson(reply), rinfo.port, rinfo.address);
    });
    return new Promise((resolve) =>
      socket.bind(port, host, () => resolve((socket.address() as AddressInfo).port)),
    );
  }

  async stop(): Promise<void> {
    this.discoverySocket?.close();
    this.opts.video.stop();
    clearInterval(this.audioTimer);
    for (const s of this.active) s.end();
    this.active.clear();
    await Promise.all(
      [this.streamServer, this.apiServer].map(
        (srv) =>
          new Promise<void>((r) => {
            if (!srv) return r();
            srv.closeAllConnections();
            srv.close(() => r());
          }),
      ),
    );
  }

  /** Drop every open stream connection, as a flaky camera would. */
  dropStreams(): void {
    for (const s of this.active) s.end();
  }

  private authorized(header: string | undefined): boolean {
    const login = this.bound ? this.opts : this.opts.setupMode!.login;
    const expected = Buffer.from(
      `${login.username}:${encodePassword(login.password, login.encoding)}`,
    ).toString('base64');
    return header === `Basic ${expected}`;
  }

  private now(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  private startAudio(): void {
    // 50 ms of audio every 50 ms: a soft hum with a short beep every 2 s.
    const samples = 400;
    this.audioTimer = setInterval(() => {
      const chunk = Buffer.alloc(samples);
      for (let i = 0; i < samples; i++) {
        const t = this.audioPhase++ / 8000;
        const beep = t % 2 < 0.15 ? Math.sin(2 * Math.PI * 880 * t) * 8000 : 0;
        const hum = Math.sin(2 * Math.PI * 120 * t) * 300;
        chunk[i] = linearToMulaw(beep + hum);
      }
      for (const fn of this.audioListeners) fn(chunk);
    }, 50);
  }

  private handleStream(req: IncomingMessage, res: ServerResponse) {
    if (!req.url?.startsWith('/https/stream/mixed')) {
      res.writeHead(404).end();
      return;
    }
    if (!this.authorized(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="smarthome@tp-link.com"' }).end('401 ');
      return;
    }
    if (this.active.size >= (this.opts.maxStreams ?? 2)) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace;boundary=${FAKE_BOUNDARY}`,
      'Cache-Control': 'no-cache',
    });

    const writePart = (type: string, body: Buffer) => {
      const head =
        `--${FAKE_BOUNDARY}\r\nContent-Type: ${type}\r\n` +
        (this.opts.omitPartLength ? '' : `Content-Length: ${body.length}\r\n`) +
        `X-Timestamp: ${this.now().toFixed(3)}\r\n\r\n`;
      res.write(Buffer.concat([Buffer.from(head, 'latin1'), body, Buffer.from('\r\n')]));
    };
    const onFrame = (unit: Buffer) => writePart('video/x-h264', unit);
    const onAudio = (chunk: Buffer) => writePart('audio/g711u', chunk);
    this.opts.video.on('frame', onFrame);
    this.audioListeners.add(onAudio);

    const handle = {
      end: () => {
        cleanup();
        res.destroy();
      },
    };
    const cleanup = () => {
      this.opts.video.off('frame', onFrame);
      this.audioListeners.delete(onAudio);
      this.active.delete(handle);
    };
    this.active.add(handle);
    res.on('close', cleanup);
  }

  private handleApi(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST' || req.url !== '/data/LINKIE.json') {
      res.writeHead(302, { Location: 'https://127.0.0.1:4444/' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const reply = (obj: unknown) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(encryptJson(obj).toString('base64'));

      if (!this.authorized(req.headers.authorization)) {
        reply({ err_code: -10007, err_msg: 'Unauthorized Error' });
        return;
      }
      let command: Record<string, Record<string, unknown>>;
      try {
        const content = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('content');
        if (!content) throw new Error('no content');
        command = decryptJson(Buffer.from(content, 'base64'));
      } catch {
        res
          .writeHead(200)
          .end(encryptJson({ err_code: -1, msg: 'Bad Request' }).toString('base64'));
        return;
      }
      const out: Record<string, unknown> = {};
      for (const [module, methods] of Object.entries(command)) {
        if (module === 'context') continue;
        const moduleOut: Record<string, unknown> = {};
        for (const [method, args] of Object.entries(methods ?? {})) {
          this.commands.push({ module, method, args });
          moduleOut[method] = this.respond(module, method, (args ?? {}) as Record<string, unknown>);
        }
        out[module] = moduleOut;
      }
      reply(out);
    });
  }

  private respond(
    module: string,
    method: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const ok = { err_code: 0 };
    const cam = (name: string) => module === `smartlife.cam.ipcamera.${name}`;
    if (cam('cloud')) {
      if (method === 'get_info') {
        return {
          ...ok,
          binded: this.bound,
          cld_connection: this.bound,
          username: this.bound ? this.opts.username : '',
        };
      }
      if (method === 'set_bind') {
        // A real KC410S takes the account password as typed.
        if (args['username'] !== this.opts.username || args['password'] !== this.opts.password) {
          return { err_code: -20601, err_msg: 'Incorrect email or password' };
        }
        this.bound = true;
        return ok;
      }
    }
    if (cam('wireless')) {
      if (method === 'set_start_scan' || method === 'set_apply_changes') return ok;
      if (method === 'get_ap_list') {
        const networks = this.opts.setupMode?.networks ?? [];
        return { ...ok, ap_info: networks.map((n) => ({ band: '2G', ...n })) };
      }
      if (method === 'set_uplink') {
        const field = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
        if (!field('ssid')) return { err_code: -40101, err_msg: 'parameter format error' };
        // A real KC410S (fw 2.3.27) rejects key_index "0" on a WPA2 network.
        if (args['key_index'] === '0' || args['key_index'] === 0) {
          return { err_code: -31006, err_msg: 'The parameter [key_index] error.' };
        }
        if (
          this.opts.setupMode?.rejectUplinkField &&
          this.opts.setupMode.rejectUplinkField in args
        ) {
          const name = this.opts.setupMode.rejectUplinkField;
          return { err_code: -31006, err_msg: `The parameter [${name}] error.` };
        }
        this.uplink = {
          ssid: field('ssid'),
          passphrase: field('passphrase'),
          band: field('band'),
          wpa_mode: field('wpa_mode'),
          encryption: field('encryption'),
        };
        return ok;
      }
      if (method === 'get_uplink') {
        return { ...ok, uplink_info: this.uplink ? [{ ...this.uplink, connected: true }] : [] };
      }
      if (method === 'get_connect_status')
        return { err_code: -10008, err_msg: 'Unsupported API call.' };
    }
    if (cam('system')) {
      if (method === 'set_alias' && typeof args['value'] === 'string') {
        this.alias = args['value'];
        return ok;
      }
      if (method === 'set_onboarding_status' && typeof args['value'] === 'string') {
        this.onboardingStatus = args['value'];
        return ok;
      }
      if (method === 'get_onboarding_status') return { ...ok, value: this.onboardingStatus };
    }
    if (module === 'system' && method === 'get_sysinfo') {
      return {
        system: {
          alias: this.alias,
          model: 'KC410S(US)',
          sw_ver: '2.3.27 Build 20241112 rel.72250',
          type: 'IOT.IPCAMERA',
          mac: '00:00:5E:00:53:01',
          deviceId: 'FAKE0000000000000000000000000000000000',
          resolution: '2560x1440',
          rssi: -55,
          led_status: 'off',
          camera_switch: 'on',
          c_opt: [0, 1],
        },
        err_code: 0,
      };
    }
    if (module === 'smartlife.cam.ipcamera.ptz' && !this.opts.noPtz) {
      if (method === 'get_all_preset') {
        return {
          err_code: 0,
          maximum: 8,
          preset_attr: [
            { index: '1', name: 'Crib' },
            { index: '2', name: 'Door' },
          ],
        };
      }
      if (['set_move', 'set_stop', 'set_run_to_preset', 'set_target'].includes(method)) {
        return { err_code: 0 };
      }
      return { err_code: -2, err_msg: 'method not support' };
    }
    return { err_code: -1, err_msg: 'module not support' };
  }
}
