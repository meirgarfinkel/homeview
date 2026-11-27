import {
  BinaryKind,
  type AudioFormat,
  type CodecMessage,
  type StreamState,
  type StreamStats,
} from '@kasa/shared';
import type { AudioFrame, FrameSource, MediaFrame, VideoCodec } from '../camera/driver.js';
import type { Logger } from '../logger.js';
import { initSegment, mediaFragment, mimeType, VIDEO_TIMESCALE } from './fmp4.js';
import { NalType, nalType, parseSps, splitAnnexB, toAvcc } from './h264.js';
import { H265NalType, h265NalType, isH265Keyframe, parseH265Sps } from './h265.js';

/**
 * Fans one camera connection out to any number of browser viewers.
 *
 * - Converts each H.264 access unit into a single-frame fMP4 fragment.
 * - Keeps the current GOP so a new viewer starts at the latest keyframe
 *   instead of waiting for the next one.
 * - Opens the camera stream when the first viewer arrives and closes it a
 *   little after the last one leaves.
 * - Drops frames (and resyncs on the next keyframe) for viewers whose
 *   connection can't keep up, so one slow client never stalls the others.
 */

export type { FrameSource } from '../camera/driver.js';

export interface Viewer {
  sendJson(message: object): void;
  /** A binary frame: one BinaryKind byte followed by the payload (see tagFrame). */
  sendBinary(frame: Buffer): void;
  /** Bytes queued but not yet written to the network. */
  bufferedBytes(): number;
}

interface ViewerState {
  viewer: Viewer;
  /** Skip video until the next keyframe (joined late, or dropped frames). */
  needsKeyframe: boolean;
}

interface PendingSample {
  data: Buffer;
  keyframe: boolean;
  timestamp: number;
}

export interface LiveHubOptions {
  source: FrameSource;
  logger: Logger;
  /** Keep the camera connected this long after the last viewer leaves. */
  idleTimeoutMs?: number;
  /** Called with the picture size whenever the video format is detected. */
  onVideoSize?: (width: number, height: number) => void;
  /** A viewer with more than this many bytes queued starts losing frames. */
  maxViewerBufferBytes?: number;
  /** Upper bound for the cached GOP. */
  maxGopBytes?: number;
}

const PLAYABLE_AUDIO = new Set<string>(['pcmu', 'pcma', 'aac']);

function audioFormatOf(frame: AudioFrame): AudioFormat | null {
  if (!PLAYABLE_AUDIO.has(frame.codec)) return null;
  if (frame.codec === 'aac' && !frame.config) return null;
  return {
    codec: frame.codec as AudioFormat['codec'],
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    ...(frame.codec === 'aac' && frame.config ? { config: frame.config.toString('base64') } : {}),
  };
}

function sameAudioFormat(a: AudioFormat | null | undefined, b: AudioFormat | null | undefined) {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface ParameterSets {
  codec: VideoCodec;
  vps?: Buffer | undefined;
  sps?: Buffer | undefined;
  pps?: Buffer | undefined;
}

function sameSets(a: ParameterSets, b: ParameterSets): boolean {
  const same = (x: Buffer | undefined, y: Buffer | undefined) =>
    x === undefined ? y === undefined : y !== undefined && x.equals(y);
  return a.codec === b.codec && same(a.vps, b.vps) && same(a.sps, b.sps) && same(a.pps, b.pps);
}

type NalRole = 'vps' | 'sps' | 'pps' | 'skip' | 'keyframe' | 'sample';

/** What a NAL unit is for the muxer: a parameter set, a delimiter to drop, or sample data. */
function classify(codec: VideoCodec, nal: Buffer): NalRole {
  if (codec === 'h264') {
    switch (nalType(nal)) {
      case NalType.Sps:
        return 'sps';
      case NalType.Pps:
        return 'pps';
      case NalType.AccessUnitDelimiter:
        return 'skip';
      case NalType.IdrSlice:
        return 'keyframe';
      default:
        return 'sample';
    }
  }
  switch (h265NalType(nal)) {
    case H265NalType.VPS:
      return 'vps';
    case H265NalType.SPS:
      return 'sps';
    case H265NalType.PPS:
      return 'pps';
    case H265NalType.AUD:
      return 'skip';
    default:
      return isH265Keyframe([nal]) ? 'keyframe' : 'sample';
  }
}

/** Prefix a payload with its one-byte BinaryKind tag. */
export function tagFrame(kind: BinaryKind, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length + 1);
  out[0] = kind;
  payload.copy(out, 1);
  return out;
}

const DEFAULT_FRAME_DURATION = Math.round(VIDEO_TIMESCALE / 15);
const MAX_FRAME_DURATION = VIDEO_TIMESCALE; // 1 s; anything longer is a gap, not a frame

export class LiveHub {
  private readonly viewers = new Map<Viewer, ViewerState>();
  private readonly idleTimeoutMs: number;
  private readonly maxViewerBufferBytes: number;
  private readonly maxGopBytes: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private sourceRunning = false;

  private state: StreamState = 'idle';
  private stateDetail: string | undefined;

  // Video track state
  /** The parameter sets the current init segment was built from. */
  private active: ParameterSets | undefined;
  /** The latest parameter sets seen in the stream, per codec. */
  private seen: ParameterSets | undefined;
  private codec: CodecMessage | undefined;
  /** The sound format, once known; null when it can't be played. */
  private audioFormat: AudioFormat | null | undefined;
  /** Tagged init segment, ready to send. */
  private init: Buffer | undefined;
  private sequence = 0;
  private decodeTime = 0;
  private lastDuration = DEFAULT_FRAME_DURATION;
  private pending: PendingSample | undefined;
  private waitingForKeyframe = true;
  private gop: Buffer[] = [];
  private gopBytes = 0;

  // Rolling stats over the last few seconds
  private readonly frameTimes: number[] = [];
  private readonly byteWindow: { t: number; n: number }[] = [];

  constructor(private readonly opts: LiveHubOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.maxViewerBufferBytes = opts.maxViewerBufferBytes ?? 4 * 1024 * 1024;
    this.maxGopBytes = opts.maxGopBytes ?? 16 * 1024 * 1024;

    opts.source.on('frame', (frame) => this.onFrame(frame));
    opts.source.on('state', (state, detail) => this.onState(state, detail));
    opts.source.on('connected', () => this.onUpstreamConnected());
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  stats(): StreamStats {
    const now = Date.now();
    this.trimStats(now);
    const seconds = 5;
    return {
      state: this.state,
      ...(this.stateDetail ? { detail: this.stateDetail } : {}),
      viewers: this.viewers.size,
      ...(this.codec ? { width: this.codec.video.width, height: this.codec.video.height } : {}),
      ...(this.state === 'live'
        ? {
            fps: Math.round((this.frameTimes.length / seconds) * 10) / 10,
            kbps: Math.round((this.byteWindow.reduce((s, b) => s + b.n, 0) * 8) / seconds / 1000),
          }
        : {}),
    };
  }

  addViewer(viewer: Viewer): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const state: ViewerState = { viewer, needsKeyframe: true };
    this.viewers.set(viewer, state);

    viewer.sendJson({ type: 'status', state: this.state, detail: this.stateDetail });
    if (this.codec && this.init) {
      viewer.sendJson(this.codec);
      viewer.sendBinary(this.init);
      if (this.gop.length > 0) {
        for (const fragment of this.gop) viewer.sendBinary(fragment);
        state.needsKeyframe = false;
      }
    }

    if (!this.sourceRunning) {
      this.sourceRunning = true;
      this.opts.logger.info('First viewer connected; opening camera stream');
      this.opts.source.start();
    }
  }

  removeViewer(viewer: Viewer): void {
    if (!this.viewers.delete(viewer)) return;
    if (this.viewers.size === 0 && this.sourceRunning && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        if (this.viewers.size > 0) return;
        this.opts.logger.info('No viewers; closing camera stream');
        this.sourceRunning = false;
        this.opts.source.stop();
        this.resetTrack();
      }, this.idleTimeoutMs);
    }
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.viewers.clear();
    if (this.sourceRunning) this.opts.source.stop();
    this.sourceRunning = false;
  }

  private onState(state: StreamState, detail: string | undefined): void {
    this.state = state;
    this.stateDetail = detail;
    this.broadcastJson({ type: 'status', state, ...(detail ? { detail } : {}) });
  }

  private onUpstreamConnected(): void {
    // The previous connection's last frame has no successor; flush it with
    // the last known duration so decode time stays contiguous.
    this.flushPending(this.lastDuration);
    this.waitingForKeyframe = true;
  }

  private resetTrack(): void {
    this.pending = undefined;
    this.gop = [];
    this.gopBytes = 0;
    this.waitingForKeyframe = true;
  }

  private onFrame(frame: MediaFrame): void {
    if (frame.kind === 'audio') {
      this.onAudio(frame);
      return;
    }
    this.recordStats(frame.data.length);

    const { codec } = frame;
    if (this.seen?.codec !== codec) this.seen = { codec };
    const seen = this.seen;
    let keyframe = false;
    let changed = false;
    const sampleNals: Buffer[] = [];
    for (const nal of splitAnnexB(frame.data)) {
      if (nal.length === 0) continue;
      const role = classify(codec, nal);
      if (role === 'vps' || role === 'sps' || role === 'pps') {
        seen[role] = nal;
        changed = true;
      } else if (role === 'sample' || role === 'keyframe') {
        if (role === 'keyframe') keyframe = true;
        sampleNals.push(nal);
      }
    }

    // Parameter sets normally travel with the keyframe's access unit, but
    // don't depend on it: some cameras send them once, or only in the SDP.
    if (changed && seen.sps && seen.pps && (codec === 'h264' || seen.vps)) {
      this.updateParameterSets(seen);
    }
    if (!this.init || sampleNals.length === 0) return;
    if (this.waitingForKeyframe) {
      if (!keyframe) return;
      this.waitingForKeyframe = false;
    }

    const sample: PendingSample = {
      data: toAvcc(sampleNals),
      keyframe,
      timestamp: frame.timestamp,
    };
    if (this.pending) {
      this.flushPending(this.durationBetween(this.pending.timestamp, sample.timestamp));
    }
    this.pending = sample;
  }

  private durationBetween(prev: number, next: number): number {
    const ticks = Math.round((next - prev) * VIDEO_TIMESCALE);
    if (ticks > 0 && ticks <= MAX_FRAME_DURATION) {
      this.lastDuration = ticks;
      return ticks;
    }
    // Clock jumped (reconnect, wrap, or missing timestamps): reuse the last good duration.
    return this.lastDuration;
  }

  private flushPending(duration: number): void {
    const sample = this.pending;
    if (!sample) return;
    this.pending = undefined;
    const fragment = tagFrame(
      BinaryKind.VideoFragment,
      mediaFragment({
        sequence: ++this.sequence,
        decodeTime: this.decodeTime,
        duration,
        keyframe: sample.keyframe,
        data: sample.data,
      }),
    );
    this.decodeTime += duration;

    if (sample.keyframe) {
      this.gop = [fragment];
      this.gopBytes = fragment.length;
    } else if (this.gopBytes + fragment.length <= this.maxGopBytes) {
      this.gop.push(fragment);
      this.gopBytes += fragment.length;
    }
    this.broadcastVideo(fragment, sample.keyframe);
  }

  private updateParameterSets(sets: ParameterSets): void {
    if (this.active && sameSets(this.active, sets)) return;
    let info: { width: number; height: number; codec: string };
    try {
      info = sets.codec === 'h264' ? parseSps(sets.sps!) : parseH265Sps(sets.sps!);
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, 'Could not parse SPS');
      return;
    }
    const copy = (b: Buffer | undefined) => (b ? Buffer.from(b) : undefined);
    this.active = {
      codec: sets.codec,
      vps: copy(sets.vps),
      sps: copy(sets.sps),
      pps: copy(sets.pps),
    };
    const { width, height } = info;
    const sps = [this.active.sps!];
    const pps = [this.active.pps!];
    this.init = tagFrame(
      BinaryKind.VideoInit,
      initSegment(
        sets.codec === 'h264'
          ? { codec: 'h264', width, height, sps, pps }
          : { codec: 'h265', width, height, vps: [this.active.vps!], sps, pps },
      ),
    );
    this.codec = {
      type: 'codec',
      video: { mimeType: mimeType(info.codec), width: info.width, height: info.height },
      ...(this.audioFormat !== undefined ? { audio: this.audioFormat } : {}),
    };
    this.opts.logger.info(
      { codec: info.codec, width: info.width, height: info.height },
      'Video format detected',
    );
    this.opts.onVideoSize?.(info.width, info.height);
    // Any queued frame belongs to the old format.
    this.pending = undefined;
    this.waitingForKeyframe = true;
    this.gop = [];
    this.gopBytes = 0;
    for (const state of this.viewers.values()) {
      state.viewer.sendJson(this.codec);
      state.viewer.sendBinary(this.init);
      state.needsKeyframe = true;
    }
  }

  private broadcastVideo(fragment: Buffer, keyframe: boolean): void {
    for (const state of this.viewers.values()) {
      if (state.needsKeyframe) {
        if (!keyframe) continue;
        state.needsKeyframe = false;
      }
      if (state.viewer.bufferedBytes() > this.maxViewerBufferBytes) {
        state.needsKeyframe = true;
        continue;
      }
      state.viewer.sendBinary(fragment);
    }
  }

  private onAudio(frame: AudioFrame): void {
    const format = audioFormatOf(frame);
    if (!sameAudioFormat(format, this.audioFormat)) {
      this.audioFormat = format;
      if (format === null) {
        this.opts.logger.warn({ codec: frame.codec }, "The camera's sound format isn't supported");
      }
      // Tell viewers without touching the video: no new init segment.
      if (this.codec) {
        this.codec = { ...this.codec, audio: format };
        for (const state of this.viewers.values()) state.viewer.sendJson(this.codec);
      }
    }
    if (format !== null) this.broadcastAudio(frame.data);
  }

  private broadcastAudio(data: Buffer): void {
    if (this.viewers.size === 0) return;
    const frame = tagFrame(BinaryKind.Audio, data);
    for (const state of this.viewers.values()) {
      if (state.viewer.bufferedBytes() > this.maxViewerBufferBytes) continue;
      state.viewer.sendBinary(frame);
    }
  }

  private broadcastJson(message: object): void {
    for (const state of this.viewers.values()) state.viewer.sendJson(message);
  }

  private recordStats(bytes: number): void {
    const now = Date.now();
    this.frameTimes.push(now);
    this.byteWindow.push({ t: now, n: bytes });
    this.trimStats(now);
  }

  private trimStats(now: number): void {
    const cutoff = now - 5000;
    while (this.frameTimes.length && this.frameTimes[0]! < cutoff) this.frameTimes.shift();
    while (this.byteWindow.length && this.byteWindow[0]!.t < cutoff) this.byteWindow.shift();
  }
}
