/** One RTSP 1.0 connection over TCP, with RTP interleaved on it (RFC 2326 10.12). */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { authorizationFor, pickChallenge } from './auth.js';

export interface RtspResponse {
  status: number;
  reason: string;
  /** Header values by lower-case name; repeated headers keep every value. */
  headers: Record<string, string[]>;
  body: Buffer;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const USER_AGENT = 'Kasa Home';

export function header(res: RtspResponse, name: string): string | undefined {
  return res.headers[name.toLowerCase()]?.[0];
}

interface Pending {
  resolve: (res: RtspResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface SessionEvents {
  interleaved: [channel: number, packet: Buffer];
  close: [error: Error | undefined];
}

export class RtspSession extends EventEmitter<SessionEvents> {
  private cseq = 0;
  private pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private challenge: string | undefined;
  private nc = 0;
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly username: string,
    private readonly password: string,
    private readonly requestTimeoutMs: number,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(err));
    socket.on('close', () => this.shutdown(new Error('The camera closed the stream connection')));
  }

  static connect(opts: {
    host: string;
    port: number;
    username: string;
    password: string;
    timeoutMs: number;
  }): Promise<RtspSession> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: opts.host, port: opts.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No answer from the camera at ${opts.host}:${opts.port}`));
      }, opts.timeoutMs);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.setNoDelay(true);
        resolve(new RtspSession(socket, opts.username, opts.password, opts.timeoutMs));
      });
    });
  }

  /** Send a request; on 401 answer the camera's challenge once. */
  async request(
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ): Promise<RtspResponse> {
    let res = await this.send(method, url, headers);
    if (res.status === 401) {
      const challenge = pickChallenge(res.headers['www-authenticate'] ?? []);
      if (!challenge) return res;
      this.challenge = challenge;
      this.nc = 0;
      res = await this.send(method, url, headers);
    }
    return res;
  }

  close(): void {
    this.socket.destroy();
    this.shutdown(undefined);
  }

  private send(
    method: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<RtspResponse> {
    if (this.closed) return Promise.reject(new Error('The stream connection is closed'));
    const cseq = ++this.cseq;
    const all: Record<string, string> = {
      CSeq: String(cseq),
      'User-Agent': USER_AGENT,
      ...headers,
    };
    if (this.challenge) {
      all['Authorization'] = authorizationFor(
        this.challenge,
        method,
        url,
        this.username,
        this.password,
        {
          nc: ++this.nc,
        },
      );
    }
    const head = Object.entries(all)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cseq);
        reject(new Error(`The camera didn't answer ${method} in time`));
      }, this.requestTimeoutMs);
      this.pending.set(cseq, { resolve, reject, timer });
      this.socket.write(`${method} ${url} RTSP/1.0\r\n${head}\r\n`);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length > 0 && !this.closed) {
        if (this.buffer[0] === 0x24) {
          if (this.buffer.length < 4) return;
          const length = this.buffer.readUInt16BE(2);
          if (this.buffer.length < 4 + length) return;
          const channel = this.buffer[1]!;
          const packet = this.buffer.subarray(4, 4 + length);
          this.buffer = this.buffer.subarray(4 + length);
          this.emit('interleaved', channel, packet);
          continue;
        }
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new Error('RTSP: header too large');
          return;
        }
        const head = this.buffer.subarray(0, end).toString('latin1');
        const res = parseHead(head);
        const length = Number(header(res, 'content-length') ?? 0);
        if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
          throw new Error('RTSP: bad Content-Length');
        }
        if (this.buffer.length < end + 4 + length) return;
        res.body = Buffer.from(this.buffer.subarray(end + 4, end + 4 + length));
        this.buffer = this.buffer.subarray(end + 4 + length);
        const cseq = Number(header(res, 'cseq'));
        const waiting = this.pending.get(cseq);
        if (waiting) {
          this.pending.delete(cseq);
          clearTimeout(waiting.timer);
          waiting.resolve(res);
        }
      }
    } catch (err) {
      this.socket.destroy();
      this.shutdown(err as Error);
    }
  }

  private shutdown(err: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err ?? new Error('The stream connection is closed'));
    }
    this.pending.clear();
    this.emit('close', err);
  }
}

function parseHead(head: string): RtspResponse {
  const [statusLine = '', ...lines] = head.split('\r\n');
  const m = /^RTSP\/1\.0 (\d{3}) ?(.*)$/.exec(statusLine);
  if (!m) throw new Error('RTSP: not a response');
  const headers: Record<string, string[]> = {};
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    (headers[name] ??= []).push(line.slice(c + 1).trim());
  }
  return { status: Number(m[1]), reason: m[2] ?? '', headers, body: Buffer.alloc(0) };
}
