/**
 * A fake RTSP camera for the tests and `pnpm dev:fake-onvif`: serves the test
 * clips in a loop as RTP over the RTSP connection (TCP interleaved), with
 * Basic or Digest auth. Not for production use.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { accessUnits } from './fakeCamera.js';
import { adtsFrames, packetizeAac, packetizeH264, packetizeH265, rtpPacket } from './packetize.js';
import { splitAnnexB } from '../media/h264.js';
import { h265AccessUnits, h265NalType } from '../media/h265.js';
import { parseChallengeParams } from '../rtsp/auth.js';

export interface FakeRtspOptions {
  video: 'h264' | 'h265';
  audio?: 'aac' | 'pcma' | 'pcmu' | 'g726';
  username: string;
  password: string;
  auth: 'basic' | 'digest';
  /** Send parameter sets only in the SDP, never in the stream. */
  sdpParameterSetsOnly?: boolean;
  /** Close each connection this long after PLAY. */
  dropAfterMs?: number;
  /** Answer keepalives with 454 Session Not Found. */
  sessionNotFoundOnKeepalive?: boolean;
  sessionTimeoutSec?: number;
  host?: string;
  port?: number;
  path?: string;
  fps?: number;
}

export interface FakeRtsp {
  readonly port: number;
  /** rtsp://host:port/path, without credentials. */
  readonly url: string;
  readonly connections: number;
  readonly keepalives: number;
  readonly teardowns: number;
  readonly lastPath: string | undefined;
  close(): Promise<void>;
}

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)));

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const START_CODE = Buffer.from([0, 0, 0, 1]);

function isParameterSet(codec: 'h264' | 'h265', nal: Buffer): boolean {
  return codec === 'h264'
    ? [7, 8].includes(nal[0]! & 0x1f)
    : [32, 33, 34].includes(h265NalType(nal));
}

export async function startFakeRtsp(opts: FakeRtspOptions): Promise<FakeRtsp> {
  const fps = opts.fps ?? 15;
  const path = opts.path ?? '/stream1';
  const host = opts.host ?? '127.0.0.1';
  const realm = 'FakeCamera';
  const nonce = randomBytes(8).toString('hex');
  const units =
    opts.video === 'h264'
      ? accessUnits(fixture('clip-320x180.h264'))
      : h265AccessUnits(fixture('clip-320x180.h265'));
  const firstNals = splitAnnexB(units[0]!);
  const parameterSets = firstNals.filter((n) => isParameterSet(opts.video, n));
  const frames = opts.sdpParameterSetsOnly
    ? units.map((u) =>
        Buffer.concat(
          splitAnnexB(u)
            .filter((n) => !isParameterSet(opts.video, n))
            .flatMap((n) => [START_CODE, n]),
        ),
      )
    : units;
  const aac = opts.audio === 'aac' ? adtsFrames(fixture('clip-16k.aac')) : undefined;
  const g711 = opts.audio === 'pcma' ? fixture('clip-8k.alaw') : Buffer.alloc(16000, 0xff);

  const stats = {
    connections: 0,
    keepalives: 0,
    teardowns: 0,
    lastPath: undefined as string | undefined,
  };
  const sockets = new Set<net.Socket>();

  const sdp = (): string => {
    const b64 = (n: Buffer) => n.toString('base64');
    const lines = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=Fake camera', 't=0 0', 'a=control:*'];
    lines.push('m=video 0 RTP/AVP 96');
    if (opts.video === 'h264') {
      lines.push('a=rtpmap:96 H264/90000');
      lines.push(
        `a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${parameterSets.map(b64).join(',')}`,
      );
    } else {
      const of = (t: number) =>
        parameterSets
          .filter((n) => h265NalType(n) === t)
          .map(b64)
          .join(',');
      lines.push('a=rtpmap:96 H265/90000');
      lines.push(`a=fmtp:96 sprop-vps=${of(32)};sprop-sps=${of(33)};sprop-pps=${of(34)}`);
    }
    lines.push('a=control:trackID=1');
    if (opts.audio === 'aac' && aac) {
      lines.push(
        'm=audio 0 RTP/AVP 97',
        `a=rtpmap:97 MPEG4-GENERIC/${aac.sampleRate}/${aac.channels}`,
      );
      lines.push(
        `a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${aac.config.toString('hex')}`,
      );
    } else if (opts.audio === 'pcma') {
      lines.push('m=audio 0 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000');
    } else if (opts.audio === 'pcmu') {
      lines.push('m=audio 0 RTP/AVP 0');
    } else if (opts.audio === 'g726') {
      lines.push('m=audio 0 RTP/AVP 98', 'a=rtpmap:98 G726-32/8000');
    }
    if (opts.audio) lines.push('a=control:trackID=2');
    return `${lines.join('\r\n')}\r\n`;
  };

  const authorized = (method: string, header: string | undefined): boolean => {
    if (!header) return false;
    if (opts.auth === 'basic') {
      return (
        header === `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`
      );
    }
    if (!/^digest\s/i.test(header)) return false;
    const p = parseChallengeParams(header);
    if (p['username'] !== opts.username || p['nonce'] !== nonce) return false;
    const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
    const ha2 = md5(`${method}:${p['uri'] ?? ''}`);
    const expected = p['qop']
      ? md5(`${ha1}:${nonce}:${p['nc']}:${p['cnonce']}:${p['qop']}:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);
    return p['response'] === expected;
  };

  const server = net.createServer((socket) => {
    stats.connections++;
    sockets.add(socket);
    const session = randomBytes(6).toString('hex');
    const channels = new Map<string, number>(); // track -> RTP channel
    let timers: NodeJS.Timeout[] = [];
    let buffered: Buffer = Buffer.alloc(0);
    const stopTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
    };
    socket.on('close', () => {
      stopTimers();
      sockets.delete(socket);
    });
    socket.on('error', () => undefined);

    const reply = (
      cseq: string,
      status: string,
      headers: Record<string, string> = {},
      body = '',
    ) => {
      const all = {
        CSeq: cseq,
        ...headers,
        ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      };
      const head = Object.entries(all)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      if (!socket.destroyed) socket.write(`RTSP/1.0 ${status}\r\n${head}\r\n${body}`);
    };
    const interleave = (channel: number, packet: Buffer) => {
      const header = Buffer.from([0x24, channel, 0, 0]);
      header.writeUInt16BE(packet.length, 2);
      if (!socket.destroyed) socket.write(Buffer.concat([header, packet]));
    };

    const play = () => {
      const videoChannel = channels.get('trackID=1');
      const audioChannel = channels.get('trackID=2');
      let i = 0;
      let videoSeq = 0;
      let audioSeq = 0;
      let audioAt = 0;
      const tick = setInterval(() => {
        if (videoChannel !== undefined) {
          const unit = frames[i % frames.length]!;
          const packetize = opts.video === 'h264' ? packetizeH264 : packetizeH265;
          const packets = packetize(unit, {
            timestamp: Math.round((i * 90000) / fps),
            sequence: videoSeq,
            mtu: 1200,
          });
          videoSeq = (videoSeq + packets.length) & 0xffff;
          for (const p of packets) interleave(videoChannel, p);
        }
        if (audioChannel !== undefined && opts.audio) {
          if (aac) {
            const k = Math.floor((i * aac.sampleRate) / 1024 / fps);
            const next = Math.floor(((i + 1) * aac.sampleRate) / 1024 / fps);
            const group = Array.from(
              { length: next - k },
              (_, j) => aac.frames[(k + j) % aac.frames.length]!,
            );
            if (group.length > 0) {
              for (const p of packetizeAac(group, {
                timestamp: k * 1024,
                sequence: audioSeq,
                perPacket: 4,
              })) {
                interleave(audioChannel, p);
                audioSeq = (audioSeq + 1) & 0xffff;
              }
            }
          } else {
            const bytes = Math.round(8000 / fps);
            const chunk = Buffer.alloc(bytes);
            for (let b = 0; b < bytes; b++) chunk[b] = g711[(audioAt + b) % g711.length]!;
            const pt = opts.audio === 'pcma' ? 8 : opts.audio === 'pcmu' ? 0 : 98;
            interleave(
              audioChannel,
              rtpPacket(
                { payloadType: pt, sequence: audioSeq, timestamp: audioAt, marker: false },
                chunk,
              ),
            );
            audioSeq = (audioSeq + 1) & 0xffff;
            audioAt += bytes;
          }
        }
        i++;
      }, 1000 / fps);
      timers.push(tick);
      if (opts.dropAfterMs !== undefined) {
        timers.push(setTimeout(() => socket.destroy(), opts.dropAfterMs));
      }
    };

    const handle = (head: string) => {
      const [requestLine = '', ...lines] = head.split('\r\n');
      const [method = '', uri = ''] = requestLine.split(' ');
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const c = l.indexOf(':');
        if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
      }
      const cseq = headers['cseq'] ?? '0';
      if (method !== 'OPTIONS' && !authorized(method, headers['authorization'])) {
        const challenge =
          opts.auth === 'basic'
            ? `Basic realm="${realm}"`
            : `Digest realm="${realm}", nonce="${nonce}"`;
        return reply(cseq, '401 Unauthorized', { 'WWW-Authenticate': challenge });
      }
      const sessionHeader = `${session};timeout=${opts.sessionTimeoutSec ?? 60}`;
      switch (method) {
        case 'OPTIONS':
          return reply(cseq, '200 OK', {
            Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER',
          });
        case 'DESCRIBE': {
          stats.lastPath = new URL(uri).pathname;
          return reply(
            cseq,
            '200 OK',
            { 'Content-Type': 'application/sdp', 'Content-Base': `${uri.replace(/\/$/, '')}/` },
            sdp(),
          );
        }
        case 'SETUP': {
          const track = uri.slice(uri.lastIndexOf('/') + 1);
          const m = /interleaved=(\d+)-(\d+)/.exec(headers['transport'] ?? '');
          if (!m) return reply(cseq, '461 Unsupported Transport');
          channels.set(track, Number(m[1]));
          return reply(cseq, '200 OK', {
            Transport: `RTP/AVP/TCP;unicast;interleaved=${m[1]}-${m[2]}`,
            Session: sessionHeader,
          });
        }
        case 'PLAY':
          play();
          return reply(cseq, '200 OK', { Session: sessionHeader, Range: 'npt=0.000-' });
        case 'GET_PARAMETER':
          stats.keepalives++;
          if (opts.sessionNotFoundOnKeepalive) return reply(cseq, '454 Session Not Found');
          return reply(cseq, '200 OK', { Session: sessionHeader });
        case 'TEARDOWN':
          stats.teardowns++;
          stopTimers();
          return reply(cseq, '200 OK');
        default:
          return reply(cseq, '501 Not Implemented');
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered[0] === 0x24) {
          // Interleaved RTCP from the client: skip it.
          if (buffered.length < 4) return;
          const len = buffered.readUInt16BE(2);
          if (buffered.length < 4 + len) return;
          buffered = buffered.subarray(4 + len);
          continue;
        }
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString('latin1');
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (buffered.length < end + 4 + length) return;
        buffered = buffered.subarray(end + 4 + length);
        handle(head);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    url: `rtsp://${host}:${port}${path}`,
    get connections() {
      return stats.connections;
    },
    get keepalives() {
      return stats.keepalives;
    },
    get teardowns() {
      return stats.teardowns;
    },
    get lastPath() {
      return stats.lastPath;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
