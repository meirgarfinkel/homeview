/**
 * Pulls a camera's RTSP stream and emits timestamped media frames, like the
 * Kasa CameraSource. Reconnects with backoff until stop() is called.
 */
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { StreamState } from '@kasa/shared';
import {
  StreamAuthError,
  StreamBusyError,
  type FrameSource,
  type MediaFrame,
  type VideoCodec,
} from '../camera/driver.js';
import type { Logger } from '../logger.js';
import { isPrivateAddress } from '../security/network.js';
import { AudioDepacketizer, parseRtp, VideoDepacketizer } from './depacketize.js';
import { aacConfigFromFmtp, parameterSetsFromFmtp, parseSdp, type SdpMedia } from './sdp.js';
import { header, RtspSession, type RtspResponse } from './session.js';

export interface RtspSourceOptions {
  /** rtsp://host:port/path, without credentials. */
  url: string;
  username: string;
  password: string;
  allowPublicHost: boolean;
  logger: Logger;
  /** Reconnect if no media arrives for this long. */
  stallTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface SourceEvents {
  frame: [MediaFrame];
  state: [StreamState, string | undefined];
  connected: [];
}

/** Query parameters that carry a login in some cameras' stream addresses. */
const SECRET_PARAM = /pass|pwd|user|token|auth|key|secret/i;

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const AUTH_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 15_000;
const DEFAULT_SESSION_TIMEOUT_S = 60;
const TEARDOWN_WAIT_MS = 1000;
const VIDEO_CHANNEL = 0;
const AUDIO_CHANNEL = 2;

export const LOGIN_REJECTED = 'The camera rejected the username or password.';
export const VIDEO_FORMAT_UNSUPPORTED = "This camera's video format isn't supported.";

/** A failure that a quick retry won't fix. */
class StreamConfigError extends Error {}

/** Turns 32-bit RTP timestamps into seconds since the first packet. */
class RtpClock {
  private first: number | undefined;
  private last = 0;
  private wraps = 0;
  constructor(private readonly rate: number) {}
  seconds(rtpTime: number): number {
    if (this.first === undefined) this.first = rtpTime;
    if (rtpTime < this.last && this.last - rtpTime > 0x80000000) this.wraps++;
    this.last = rtpTime;
    return (this.wraps * 0x100000000 + rtpTime - this.first) / this.rate;
  }
}

function audioCodecName(media: SdpMedia): string {
  switch (media.encoding) {
    case 'PCMU':
      return 'pcmu';
    case 'PCMA':
      return 'pcma';
    case 'MPEG4-GENERIC':
      return 'aac';
    default:
      return media.encoding.toLowerCase();
  }
}

export class RtspSource extends EventEmitter<SourceEvents> implements FrameSource {
  private running = false;
  private url: URL;
  private session: RtspSession | undefined;
  private sessionId: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private _state: StreamState = 'idle';
  /** Bumped on every connect and stop, so stale work can tell it was replaced. */
  private generation = 0;

  constructor(private readonly opts: RtspSourceOptions) {
    super();
    this.url = new URL(opts.url);
    this.url.username = '';
    this.url.password = '';
  }

  get state(): StreamState {
    return this._state;
  }

  /**
   * Where the stream is, without credentials, for logs. Some cameras put the
   * login in the query (`?user=admin&pwd=...`), so those values are hidden too.
   */
  get safeUrl(): string {
    const url = new URL(this.url.toString());
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_PARAM.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  }

  /** Switch to a new camera address, keeping the port and path. */
  setHost(host: string): void {
    if (host === this.url.hostname) return;
    this.url.hostname = host;
    if (!this.running) return;
    this.dropSession(false);
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), 0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.dropSession(true);
    this.setState('idle');
  }

  private setState(state: StreamState, detail?: string): void {
    if (state === this._state && state !== 'error' && state !== 'reconnecting') return;
    this._state = state;
    this.emit('state', state, detail);
  }

  /** Close the current connection, saying goodbye first when asked. */
  private dropSession(teardown: boolean): void {
    const session = this.session;
    const id = this.sessionId;
    this.session = undefined;
    this.sessionId = undefined;
    if (!session) return;
    session.removeAllListeners('interleaved');
    if (teardown && id) {
      const timer = setTimeout(() => session.close(), TEARDOWN_WAIT_MS);
      session
        .request('TEARDOWN', this.url.toString(), { Session: id })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          session.close();
        });
    } else {
      session.close();
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    const { logger } = this.opts;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      await this.run(generation);
      if (generation !== this.generation) return;
      logger.info('Camera stream ended; reconnecting');
      this.scheduleRetry(BACKOFF_MS[0]!, 'Stream ended');
    } catch (err) {
      if (!this.running || generation !== this.generation) return;
      this.dropSession(false);
      const message = (err as Error).message;
      if (err instanceof StreamAuthError || err instanceof StreamConfigError) {
        logger.error({ url: this.safeUrl }, message);
        this.setState('error', message);
        this.scheduleRetry(AUTH_RETRY_MS, message, false);
      } else if (err instanceof StreamBusyError) {
        logger.warn(message);
        this.scheduleRetry(BUSY_RETRY_MS, message);
      } else {
        logger.warn({ err: message, url: this.safeUrl }, 'Camera stream failed');
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
        this.scheduleRetry(delay, message);
      }
    }
  }

  private scheduleRetry(delayMs: number, reason: string, announce = true): void {
    if (!this.running) return;
    this.attempt++;
    if (announce) this.setState('reconnecting', reason);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delayMs);
  }

  /** One connection, from DESCRIBE to the end of the stream. */
  private async run(generation: number): Promise<void> {
    const { opts } = this;
    const host = this.url.hostname.replace(/^\[|\]$/g, '');
    const address = net.isIP(host) ? host : (await lookup(host)).address;
    if (!opts.allowPublicHost && !isPrivateAddress(address)) {
      throw new StreamConfigError(
        `The camera address ${host} is not a local-network address. Refusing to send the camera login off the local network.`,
      );
    }
    const port = Number(this.url.port || 554);
    const session = await RtspSession.connect({
      host: address,
      port,
      username: opts.username,
      password: opts.password,
      timeoutMs: opts.connectTimeoutMs ?? 10_000,
    });
    if (generation !== this.generation || !this.running) {
      session.close();
      return;
    }
    this.session = session;
    const url = this.url.toString();

    const options = await session.request('OPTIONS', url);
    const keepaliveMethod = /GET_PARAMETER/i.test(header(options, 'public') ?? '')
      ? 'GET_PARAMETER'
      : 'OPTIONS';

    const describe = check(await session.request('DESCRIBE', url, { Accept: 'application/sdp' }));
    const base = header(describe, 'content-base') ?? header(describe, 'content-location') ?? url;
    const media = parseSdp(describe.body.toString('utf8'), base);
    const video = media.find(
      (m) => m.type === 'video' && (m.encoding === 'H264' || m.encoding === 'H265'),
    );
    if (!video) throw new StreamConfigError(VIDEO_FORMAT_UNSUPPORTED);
    const audio = media.find((m) => m.type === 'audio');

    const transport = (channel: number) =>
      `RTP/AVP/TCP;unicast;interleaved=${channel}-${channel + 1}`;
    const setup = check(
      await session.request('SETUP', video.control, { Transport: transport(VIDEO_CHANNEL) }),
    );
    const sessionHeader = header(setup, 'session') ?? '';
    const [id = '', ...params] = sessionHeader.split(';');
    this.sessionId = id.trim();
    const timeoutS =
      Number(/timeout=(\d+)/i.exec(params.join(';'))?.[1]) || DEFAULT_SESSION_TIMEOUT_S;

    let audioReady = false;
    if (audio) {
      const res = await session.request('SETUP', audio.control, {
        Transport: transport(AUDIO_CHANNEL),
        Session: this.sessionId,
      });
      audioReady = res.status === 200;
      if (!audioReady)
        opts.logger.info({ status: res.status }, 'The camera refused the sound track');
    }

    const codec: VideoCodec = video.encoding === 'H264' ? 'h264' : 'h265';
    const videoDepack = new VideoDepacketizer(codec, (w) => opts.logger.warn(w));
    const videoClock = new RtpClock(video.clockRate || 90000);
    const sdpSets = parameterSetsFromFmtp(video);
    let sentSets = false;

    let audioDepack: AudioDepacketizer | undefined;
    let audioClock: RtpClock | undefined;
    let audioConfig: Buffer | undefined;
    if (audio && audioReady) {
      try {
        audioDepack = new AudioDepacketizer(audio);
        audioClock = new RtpClock(audio.clockRate || 8000);
        if (audio.encoding === 'MPEG4-GENERIC') audioConfig = aacConfigFromFmtp(audio).config;
      } catch (err) {
        opts.logger.warn({ err: (err as Error).message }, "Can't read the camera's sound settings");
        audioDepack = undefined;
      }
    }
    const audioCodec = audio ? audioCodecName(audio) : '';

    return new Promise<void>((resolve, reject) => {
      let gotData = false;
      let stall: NodeJS.Timeout | undefined;
      let keepalive: NodeJS.Timeout | undefined;
      const stallMs = opts.stallTimeoutMs ?? 15_000;
      const finish = (err?: Error) => {
        clearTimeout(stall);
        clearInterval(keepalive);
        session.removeAllListeners('close');
        if (err) reject(err);
        else resolve();
      };
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          session.close();
          finish(new Error(`No data from camera for ${stallMs / 1000}s`));
        }, stallMs);
      };

      session.on('close', (err) => finish(err ?? new Error('The camera closed the stream')));
      session.on('interleaved', (channel, packet) => {
        if (channel !== VIDEO_CHANNEL && channel !== AUDIO_CHANNEL) return; // RTCP
        let rtp;
        try {
          rtp = parseRtp(packet);
        } catch {
          return;
        }
        armStall();
        if (!gotData) {
          gotData = true;
          this.attempt = 0;
          this.setState('live');
          this.emit('connected');
        }
        if (channel === VIDEO_CHANNEL) {
          for (const unit of videoDepack.push(rtp)) {
            let data = unit.data;
            if (!sentSets && sdpSets.length > 0) {
              const start = Buffer.from([0, 0, 0, 1]);
              data = Buffer.concat([...sdpSets.flatMap((s) => [start, s]), data]);
            }
            sentSets = true;
            this.emit('frame', {
              kind: 'video',
              codec,
              data,
              timestamp: videoClock.seconds(unit.rtpTime),
            });
          }
        } else if (audioDepack && audio && audioClock) {
          for (const unit of audioDepack.push(rtp)) {
            this.emit('frame', {
              kind: 'audio',
              codec: audioCodec,
              sampleRate: audio.clockRate,
              channels: audio.channels,
              ...(audioConfig ? { config: audioConfig } : {}),
              data: unit.data,
              timestamp: audioClock.seconds(unit.rtpTime),
            });
          }
        }
      });

      session
        .request('PLAY', url, { Session: this.sessionId!, Range: 'npt=0.000-' })
        .then((res) => {
          check(res);
          armStall();
          keepalive = setInterval(
            () => {
              session
                .request(keepaliveMethod, url, { Session: this.sessionId ?? '' })
                .then((r) => {
                  if (r.status === 454) {
                    session.close();
                    finish(new Error('The camera forgot the stream session'));
                  }
                })
                .catch(() => undefined);
            },
            (timeoutS * 1000) / 2,
          );
          keepalive.unref();
        })
        .catch((err: Error) => finish(err));
    });
  }
}

/** Turn a non-200 answer into the matching error. */
function check(res: RtspResponse): RtspResponse {
  if (res.status === 200) return res;
  if (res.status === 401 || res.status === 403) throw new StreamAuthError(LOGIN_REJECTED);
  if (res.status === 453 || res.status === 503) {
    throw new StreamBusyError(
      `The camera is busy (RTSP ${res.status}). It allows only a few viewers at once; close other viewers.`,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw new StreamConfigError(
      'The camera tried to send the stream elsewhere. HomeView does not follow that.',
    );
  }
  throw new Error(`The camera answered RTSP ${res.status} ${res.reason}`);
}

/**
 * Ask a stream address what it sends, without playing it: the login and the
 * video format. Used by setup when a camera's stream address is typed in.
 * Resolves the video codec, or undefined when it's neither H.264 nor H.265.
 * Throws StreamAuthError for a refused login; any other error means no answer.
 */
export async function probeRtsp(opts: {
  url: string;
  username: string;
  password: string;
  timeoutMs?: number;
}): Promise<VideoCodec | undefined> {
  const url = new URL(opts.url);
  url.username = '';
  url.password = '';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const address = net.isIP(host) ? host : (await lookup(host)).address;
  const session = await RtspSession.connect({
    host: address,
    port: Number(url.port || 554),
    username: opts.username,
    password: opts.password,
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  try {
    const describe = check(
      await session.request('DESCRIBE', url.toString(), { Accept: 'application/sdp' }),
    );
    const base = header(describe, 'content-base') ?? url.toString();
    const video = parseSdp(describe.body.toString('utf8'), base).find((m) => m.type === 'video');
    if (video?.encoding === 'H264') return 'h264';
    if (video?.encoding === 'H265') return 'h265';
    return undefined;
  } finally {
    session.close();
  }
}
