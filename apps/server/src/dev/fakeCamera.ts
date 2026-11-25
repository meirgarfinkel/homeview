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
}

export interface RecordedCommand {
  module: string;
  method: string;
  args: unknown;
}

export class FakeCamera {
  readonly commands: RecordedCommand[] = [];
  private streamServer: https.Server | undefined;
  private apiServer: https.Server | undefined;
  private readonly active = new Set<{ end(): void }>();
  private readonly startedAt = performance.now();
  private audioTimer: NodeJS.Timeout | undefined;
  private audioPhase = 0;
  private readonly audioListeners = new Set<(chunk: Buffer) => void>();

  constructor(private readonly opts: FakeCameraOptions) {}

  get activeStreams(): number {
    return this.active.size;
  }

  async start(host = '127.0.0.1', streamPort = 0, apiPort = 0) {
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
      streamPort: (this.streamServer.address() as AddressInfo).port,
      apiPort: (this.apiServer.address() as AddressInfo).port,
    };
  }

  async stop(): Promise<void> {
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
    const expected = Buffer.from(
      `${this.opts.username}:${encodePassword(this.opts.password, this.opts.encoding)}`,
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
          moduleOut[method] = this.respond(module, method);
        }
        out[module] = moduleOut;
      }
      reply(out);
    });
  }

  private respond(module: string, method: string): Record<string, unknown> {
    if (module === 'system' && method === 'get_sysinfo') {
      return {
        system: {
          alias: this.opts.alias ?? 'fake nursery',
          model: 'KC410S(US)',
          sw_ver: '2.3.27 Build 20241112 rel.72250',
          type: 'IOT.IPCAMERA',
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
