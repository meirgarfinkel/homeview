import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamState } from '@kasa/shared';
import type { AudioFrame, MediaFrame, VideoFrame } from '../../src/camera/driver.js';
import { startFakeRtsp, type FakeRtsp, type FakeRtspOptions } from '../../src/dev/fakeRtsp.js';
import { splitAnnexB } from '../../src/media/h264.js';
import { h265NalType } from '../../src/media/h265.js';
import { RtspSource } from '../../src/rtsp/rtspSource.js';
import { silentLogger, waitFor } from '../helpers.js';

const USER = 'admin';
const PASS = 'not-the-camera-pass-9f3b';

let fake: FakeRtsp | undefined;
let source: RtspSource | undefined;

afterEach(async () => {
  source?.stop();
  source = undefined;
  await fake?.close();
  fake = undefined;
});

async function start(opts: Partial<FakeRtspOptions> = {}, password = PASS, logger = silentLogger) {
  fake = await startFakeRtsp({
    video: 'h264',
    username: USER,
    password: PASS,
    auth: 'digest',
    ...opts,
  });
  source = new RtspSource({
    url: fake.url,
    username: USER,
    password,
    allowPublicHost: false,
    logger,
  });
  const states: StreamState[] = [];
  const details: (string | undefined)[] = [];
  const video: VideoFrame[] = [];
  const audio: AudioFrame[] = [];
  source.on('state', (s, d) => {
    states.push(s);
    details.push(d);
  });
  source.on('frame', (f: MediaFrame) => (f.kind === 'video' ? video.push(f) : audio.push(f)));
  source.start();
  return { states, details, video, audio };
}

describe('RtspSource', () => {
  it('goes live with H.264 + AAC and emits both', async () => {
    const r = await start({ audio: 'aac' });
    await waitFor(() => r.video.length > 5 && r.audio.length > 5, 5000);
    expect(source!.state).toBe('live');
    expect(r.video[0]!.codec).toBe('h264');
    expect(r.audio[0]).toMatchObject({ codec: 'aac', sampleRate: 16000, channels: 1 });
    expect(r.audio[0]!.config).toEqual(Buffer.from([0x14, 0x08]));
    // Seconds, rising with the RTP clock.
    expect(r.video[3]!.timestamp - r.video[0]!.timestamp).toBeCloseTo(3 / 15, 3);
  });

  it('goes live with H.265 and parameter sets only in the SDP', async () => {
    const r = await start({ video: 'h265', audio: 'pcma', sdpParameterSetsOnly: true });
    await waitFor(() => r.video.length > 2, 5000);
    const types = splitAnnexB(r.video[0]!.data).map(h265NalType);
    expect(types).toEqual(expect.arrayContaining([32, 33, 34]));
    expect(r.video[0]!.codec).toBe('h265');
    await waitFor(() => r.audio.length > 0, 5000);
    expect(r.audio[0]).toMatchObject({ codec: 'pcma', sampleRate: 8000 });
  });

  it('Basic auth works', async () => {
    const r = await start({ auth: 'basic' });
    await waitFor(() => r.video.length > 0, 5000);
  });

  it('wrong password: state error with the plain message', async () => {
    const r = await start({}, 'wrong');
    await waitFor(() => r.states.includes('error'), 5000);
    expect(r.details[r.states.indexOf('error')]).toBe(
      'The camera rejected the username or password.',
    );
    expect(fake!.connections).toBe(1); // the long auth wait, not a fast retry loop
  });

  it('the password never appears in any log line', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = pino({ level: 'trace' }, sink);
    const r = await start({ dropAfterMs: 300 }, PASS, logger);
    await waitFor(() => fake!.connections >= 2 && r.video.length > 0, 8000);
    source!.stop();
    await new Promise((res) => setTimeout(res, 50));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PASS);
  });

  it('a password in the stream address query never reaches the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    source = new RtspSource({
      url: `rtsp://127.0.0.1:${port}/live?user=admin&pwd=q-s3cret-9&channel=1`,
      username: 'admin',
      password: 'x',
      allowPublicHost: false,
      logger: pino({ level: 'trace' }, sink),
    });
    expect(source.safeUrl).not.toContain('q-s3cret-9');
    expect(source.safeUrl).toContain('channel=1');
    source.start();
    await waitFor(() => lines.some((l) => l.includes('channel=1')), 5000);
    source.stop();
    expect(lines.join('\n')).not.toContain('q-s3cret-9');
  });

  it('reconnects after the camera drops the connection', async () => {
    const r = await start({ dropAfterMs: 400 });
    await waitFor(() => fake!.connections >= 2, 8000);
    await waitFor(() => source!.state === 'live', 5000);
    expect(r.states).toContain('reconnecting');
  });

  it('reconnects when keepalive gets 454', async () => {
    const r = await start({ sessionTimeoutSec: 2, sessionNotFoundOnKeepalive: true });
    await waitFor(() => fake!.keepalives >= 1, 5000);
    await waitFor(() => fake!.connections >= 2, 8000);
    await waitFor(() => source!.state === 'live', 5000);
    expect(r.states).toContain('reconnecting');
  });

  it('refuses a public host unless allowPublicHost', async () => {
    const s = new RtspSource({
      url: 'rtsp://8.8.8.8:554/stream',
      username: USER,
      password: PASS,
      allowPublicHost: false,
      logger: silentLogger,
    });
    source = s;
    const details: (string | undefined)[] = [];
    s.on('state', (st, d) => st === 'error' && details.push(d));
    s.start();
    await waitFor(() => details.length > 0, 2000);
    expect(details[0]).toMatch(/not a local-network address/);
  });

  it('stop() sends TEARDOWN and emits idle', async () => {
    const r = await start();
    await waitFor(() => r.video.length > 0, 5000);
    source!.stop();
    expect(source!.state).toBe('idle');
    await waitFor(() => fake!.teardowns === 1, 2000);
  });

  it('g726 audio yields frames whose codec the hub rejects', async () => {
    const r = await start({ audio: 'g726' });
    await waitFor(() => r.audio.length > 0, 5000);
    expect(r.audio[0]!.codec).toBe('g726-32');
  });

  it('setHost moves to the new address and keeps the port and path', async () => {
    fake = await startFakeRtsp({ video: 'h264', username: USER, password: PASS, auth: 'digest' });
    const wrong = fake.url.replace('127.0.0.1', '127.0.0.2');
    source = new RtspSource({
      url: wrong,
      username: USER,
      password: PASS,
      allowPublicHost: false,
      logger: silentLogger,
    });
    source.start();
    await waitFor(() => source!.state === 'reconnecting', 3000);
    source.setHost('127.0.0.1');
    await waitFor(() => source!.state === 'live', 5000);
    expect(fake.lastPath).toBe('/stream1');
  });
});
