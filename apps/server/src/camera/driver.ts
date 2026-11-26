import type {
  CameraInfo,
  CameraKind,
  PtzCapability,
  PtzDirection,
  PtzPreset,
  StreamState,
} from '@kasa/shared';

/**
 * What the rest of the server needs from a camera, whatever its brand. Each
 * kind of camera (Kasa, ONVIF, later cloud ones) has a driver behind this.
 */

export type VideoCodec = 'h264' | 'h265';
/** Sound formats the page can play. A source may report others; the hub drops them. */
export type AudioCodec = 'pcmu' | 'pcma' | 'aac';

export interface VideoFrame {
  kind: 'video';
  codec: VideoCodec;
  /** One Annex-B access unit. */
  data: Buffer;
  /** Seconds. */
  timestamp: number;
}

export interface AudioFrame {
  kind: 'audio';
  /** An AudioCodec, or the lower-case name of a format the page can't play. */
  codec: AudioCodec | (string & {});
  sampleRate: number;
  channels: number;
  /** AAC AudioSpecificConfig. */
  config?: Buffer;
  /** One encoded frame. */
  data: Buffer;
  timestamp: number;
}

export type MediaFrame = VideoFrame | AudioFrame;

/** What the hub needs from the camera stream. */
export interface FrameSource {
  readonly state: StreamState;
  start(): void;
  stop(): void;
  on(event: 'frame', fn: (frame: MediaFrame) => void): unknown;
  on(event: 'state', fn: (state: StreamState, detail: string | undefined) => void): unknown;
  on(event: 'connected', fn: () => void): unknown;
}

export interface PtzControl {
  readonly capability: PtzCapability;
  step(direction: PtzDirection): Promise<void>;
  hold(direction: PtzDirection): Promise<void>;
  stop(): Promise<void>;
  presets(): Promise<PtzPreset[]>;
  goToPreset(index: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface CameraDriver {
  readonly kind: CameraKind;
  readonly host: string;
  readonly source: FrameSource;
  /** Undefined when this camera has no pan/tilt. */
  readonly ptz: PtzControl | undefined;
  /** Camera details; may be cached for maxAgeMs. */
  info(maxAgeMs?: number): Promise<CameraInfo>;
  /** Background work: following the camera, clock sync. Called once the app is running. */
  start(): void;
  /** Stop the background work and pan/tilt. The hub stops the stream. */
  dispose(): Promise<void>;
}
