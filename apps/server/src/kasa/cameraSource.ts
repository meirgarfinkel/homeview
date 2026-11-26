import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { StreamState } from '@kasa/shared';
import { StreamAuthError, StreamBusyError, type MediaFrame } from '../camera/driver.js';
import type { CameraCredentials } from './credentials.js';
import { cameraRequest, type CameraResponse } from './httpClient.js';
import { boundaryFromContentType, MultipartParser, type MultipartPart } from './multipart.js';
import type { CameraTlsConfig } from './tls.js';
import type { Logger } from '../logger.js';

/**
 * Pulls the live stream from https://<cam>:19443/https/stream/mixed and emits
 * timestamped media frames. Reconnects with backoff until stop() is called.
 *
 * Video parts: Content-Type video/x-h264, one Annex-B access unit each.
 * Audio parts: Content-Type audio/g711u, 8 kHz mono mu-law.
 */

export type { AudioFrame, MediaFrame, VideoFrame } from '../camera/driver.js';

export interface CameraSourceOptions {
  host: string;
  port: number;
  /** Path + query, e.g. /https/stream/mixed?video=H264&audio=G711 */
  path: string;
  credentials: CameraCredentials;
  tls?: CameraTlsConfig;
  logger: Logger;
  /** Reconnect if no data arrives for this long. */
  stallTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface CameraSourceEvents {
  frame: [MediaFrame];
  state: [StreamState, string | undefined];
  /** Fired when a new upstream connection begins delivering data. */
  connected: [];
}

export const AUDIO_SAMPLE_RATE = 8000;

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const AUTH_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 15_000;

export { StreamAuthError, StreamBusyError } from '../camera/driver.js';

export class CameraSource extends EventEmitter<CameraSourceEvents> {
  private running = false;
  private current: CameraResponse | undefined;
  private abort: AbortController | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private _state: StreamState = 'idle';
  private readonly playerId = randomUUID();
  private readonly unknownTypes = new Set<string>();

  constructor(private readonly opts: CameraSourceOptions) {
    super();
  }

  get state(): StreamState {
    return this._state;
  }

  /** Switch to a new camera address, reconnecting right away if streaming. */
  setHost(host: string): void {
    if (host === this.opts.host) return;
    this.opts.host = host;
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.abort?.abort();
    this.current?.close();
    this.attempt = 0;
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
    clearTimeout(this.retryTimer);
    this.abort?.abort();
    this.current?.close();
    this.current = undefined;
    this.setState('idle');
  }

  private setState(state: StreamState, detail?: string): void {
    if (state === this._state && state !== 'error' && state !== 'reconnecting') return;
    this._state = state;
    this.emit('state', state, detail);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const { logger } = this.opts;
    const abort = new AbortController();
    this.abort = abort;

    try {
      const res = await this.open(abort.signal);
      // Stopped, or replaced by a newer connection, while this one opened.
      if (!this.running || this.abort !== abort) {
        res.close();
        return;
      }
      this.current = res;
      await this.pump(res);
      if (this.abort !== abort) return;
      // Stream ended cleanly (camera closed it). Reconnect promptly.
      if (this.running) logger.info('Camera stream ended; reconnecting');
      this.scheduleRetry(BACKOFF_MS[0]!, 'Stream ended');
    } catch (err) {
      // A stopped connection failing late (its stall timer, say) must not
      // touch the run that replaced it.
      if (!this.running || this.abort !== abort) return;
      const message = (err as Error).message;
      if (err instanceof StreamAuthError) {
        logger.error(message);
        this.setState('error', message);
        this.scheduleRetry(AUTH_RETRY_MS, message, false);
      } else if (err instanceof StreamBusyError) {
        logger.warn(message);
        this.scheduleRetry(BUSY_RETRY_MS, message);
      } else {
        logger.warn({ err: message }, 'Camera stream failed');
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
        this.scheduleRetry(delay, message);
      }
    } finally {
      if (this.abort === abort) this.current = undefined;
    }
  }

  private scheduleRetry(delayMs: number, reason: string, announce = true): void {
    if (!this.running) return;
    this.attempt++;
    if (announce) this.setState('reconnecting', reason);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delayMs);
  }

  /** Open the stream, trying each candidate password encoding on 401. */
  private async open(signal: AbortSignal): Promise<CameraResponse> {
    const { credentials, logger } = this.opts;
    for (const encoding of credentials.candidates()) {
      const res = await cameraRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'GET',
        path: this.opts.path,
        headers: {
          Authorization: credentials.header(encoding),
          'X-PLAYER-ID': this.playerId,
        },
        tls: this.opts.tls,
        timeoutMs: this.opts.connectTimeoutMs ?? 10_000,
        ignoreContentLength: true,
        signal,
      });
      if (res.statusCode === 200) {
        if (credentials.resolvedEncoding !== encoding) {
          logger.info({ encoding }, 'Camera stream accepted credentials');
          credentials.markWorking(encoding);
        }
        return res;
      }
      res.close();
      if (res.statusCode === 401 || res.statusCode === 403) {
        logger.debug({ encoding }, 'Stream rejected password encoding');
        continue;
      }
      if (res.statusCode === 503) {
        throw new StreamBusyError(
          'Camera is busy (HTTP 503). It allows only a few simultaneous viewers; close the Kasa app or other viewers.',
        );
      }
      throw new Error(`Camera stream returned HTTP ${res.statusCode} ${res.statusMessage}`);
    }
    throw new StreamAuthError(
      'Camera rejected the Kasa account credentials. Check KASA_USERNAME / KASA_PASSWORD.',
    );
  }

  private pump(res: CameraResponse): Promise<void> {
    const { logger } = this.opts;
    const boundary = boundaryFromContentType(res.headers['content-type']);
    logger.debug({ contentType: res.headers['content-type'] }, 'Camera stream opened');
    const parser = new MultipartParser({ boundary });
    const stallMs = this.opts.stallTimeoutMs ?? 15_000;

    return new Promise<void>((resolve, reject) => {
      let stall: NodeJS.Timeout | undefined;
      let gotData = false;
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          parser.destroy(new Error(`No data from camera for ${stallMs / 1000}s`));
        }, stallMs);
      };
      armStall();

      parser.on('data', (part: MultipartPart) => {
        armStall();
        if (!gotData) {
          gotData = true;
          this.attempt = 0;
          this.setState('live');
          this.emit('connected');
        }
        const frame = this.toFrame(part);
        if (frame) this.emit('frame', frame);
      });
      const finish = (err?: Error | null) => {
        clearTimeout(stall);
        res.close();
        if (err) reject(err);
        else resolve();
      };
      parser.once('end', () => finish());
      parser.once('error', (err) => finish(err));
      res.body.once('error', (err) => parser.destroy(err));
      // close() destroys the body, which a pipe doesn't pass on: end here so
      // the stall timer of a closed stream can't fire later.
      res.body.once('close', () => {
        if (!parser.destroyed && !parser.writableEnded) parser.end();
      });
      res.body.pipe(parser);
    });
  }

  private toFrame(part: MultipartPart): MediaFrame | undefined {
    const type = (part.headers['content-type'] ?? '').toLowerCase().split(';', 1)[0]!.trim();
    const timestamp = parseTimestamp(part.headers);
    if (type === 'video/x-h264' || type === 'video/h264') {
      return { kind: 'video', codec: 'h264', data: part.body, timestamp };
    }
    if (type === 'audio/g711u' || type === 'audio/pcmu' || type === 'audio/x-mulaw') {
      return {
        kind: 'audio',
        codec: 'pcmu',
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: 1,
        data: part.body,
        timestamp,
      };
    }
    if (!this.unknownTypes.has(type)) {
      this.unknownTypes.add(type);
      this.opts.logger.info({ type, headers: part.headers }, 'Ignoring unknown stream part type');
    }
    return undefined;
  }
}

/** Camera timestamp in seconds, falling back to the local monotonic clock. */
export function parseTimestamp(headers: Record<string, string>): number {
  for (const name of ['x-timestamp', 'x-currentframetimestamp']) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
      // Some firmware reports milliseconds; anything this large isn't seconds-since-boot.
      return value > 1e11 ? value / 1000 : value;
    }
  }
  return performance.now() / 1000;
}
