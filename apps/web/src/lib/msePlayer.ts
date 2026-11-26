/**
 * Feeds fMP4 fragments into a <video> via Media Source Extensions and keeps
 * playback pinned near the live edge.
 */

type MediaSourceCtor = typeof MediaSource;

export const H265_UNSUPPORTED =
  "This browser can't play this camera's video (H.265). Try another browser, or set the camera to H.264 in its own app.";

function mediaSourceCtor(): MediaSourceCtor | undefined {
  const w = window as unknown as {
    ManagedMediaSource?: MediaSourceCtor;
    MediaSource?: MediaSourceCtor;
  };
  // iOS Safari only has ManagedMediaSource.
  return w.MediaSource ?? w.ManagedMediaSource;
}

export function isMseSupported(mimeType?: string): boolean {
  const ctor = mediaSourceCtor();
  if (!ctor) return false;
  return mimeType ? ctor.isTypeSupported(mimeType) : true;
}

/** Seconds behind the live edge before we speed up / jump. */
const CATCH_UP_LAG = 0.6;
const JUMP_LAG = 2.5;
const TARGET_LAG = 0.25;
/** Seconds of history to keep in the buffer. */
const KEEP_BACK = 10;

export class MsePlayer {
  private mediaSource: MediaSource | undefined;
  private sourceBuffer: SourceBuffer | undefined;
  private objectUrl: string | undefined;
  private queue: BufferSource[] = [];
  private lastTrim = 0;

  constructor(private readonly video: HTMLVideoElement) {}

  /** Start a fresh MediaSource for a (possibly new) codec. */
  reset(mimeType: string): void {
    this.destroy();
    const Ctor = mediaSourceCtor();
    if (!Ctor) throw new Error('Media Source Extensions are not available in this browser');
    if (!Ctor.isTypeSupported(mimeType)) {
      if (/codecs="(hvc1|hev1)/.test(mimeType)) throw new Error(H265_UNSUPPORTED);
      throw new Error(`This browser cannot play ${mimeType}`);
    }
    const ms = new Ctor();
    this.mediaSource = ms;
    // ManagedMediaSource needs this unless an AirPlay alternative is offered.
    this.video.disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== ms) return;
        const sb = ms.addSourceBuffer(mimeType);
        sb.mode = 'segments';
        sb.addEventListener('updateend', () => this.onUpdateEnd());
        sb.addEventListener('error', () => console.warn('SourceBuffer error'));
        this.sourceBuffer = sb;
        this.pump();
      },
      { once: true },
    );
  }

  append(data: BufferSource): void {
    this.queue.push(data);
    // Hidden tabs can throttle appends; never build an unbounded backlog.
    if (this.queue.length > 300) this.queue.splice(1, this.queue.length - 150);
    this.pump();
  }

  destroy(): void {
    this.queue = [];
    this.sourceBuffer = undefined;
    if (this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // already ended
      }
    }
    this.mediaSource = undefined;
    if (this.objectUrl) {
      this.video.removeAttribute('src');
      this.video.load();
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
  }

  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    try {
      sb.appendBuffer(next);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        this.queue.unshift(next);
        this.trim(true);
      } else {
        console.warn('appendBuffer failed', err);
      }
    }
  }

  private onUpdateEnd(): void {
    this.followLiveEdge();
    if (!this.trim(false)) this.pump();
  }

  /** Returns true if a remove() was started (pump resumes on its updateend). */
  private trim(force: boolean): boolean {
    const sb = this.sourceBuffer;
    const v = this.video;
    if (!sb || sb.updating || sb.buffered.length === 0) return false;
    const now = performance.now();
    if (!force && now - this.lastTrim < 5000) return false;
    const start = sb.buffered.start(0);
    const cutoff = v.currentTime - KEEP_BACK;
    if (cutoff <= start + 1) return false;
    this.lastTrim = now;
    sb.remove(start, cutoff);
    return true;
  }

  private followLiveEdge(): void {
    const v = this.video;
    const ranges = v.buffered;
    if (ranges.length === 0) return;
    const end = ranges.end(ranges.length - 1);
    const lastStart = ranges.start(ranges.length - 1);
    const lag = end - v.currentTime;

    if (v.currentTime < lastStart || lag > JUMP_LAG) {
      // Joined mid-stream, fell behind, or a gap after dropped frames.
      v.currentTime = Math.max(lastStart, end - TARGET_LAG);
    } else if (lag > CATCH_UP_LAG) {
      v.playbackRate = 1.1;
    } else if (lag < TARGET_LAG + 0.1) {
      v.playbackRate = 1;
    }
    if (v.paused) void v.play().catch(() => undefined);
  }
}
