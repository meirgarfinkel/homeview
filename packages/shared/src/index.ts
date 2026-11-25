/**
 * Types and constants shared by the server and the browser client.
 *
 * Live media travels over one WebSocket at LIVE_WS_PATH. Text frames carry JSON
 * control messages (ServerMessage). Binary frames start with a one-byte
 * BinaryKind tag followed by the payload.
 */

export const LIVE_WS_PATH = '/api/live';

export const BinaryKind = {
  /** Fragmented-MP4 initialization segment (ftyp + moov). */
  VideoInit: 1,
  /** One fMP4 media fragment (moof + mdat) holding a single video frame. */
  VideoFragment: 2,
  /** Raw G.711 mu-law audio, mono. Sample rate comes from CodecMessage. */
  Audio: 3,
} as const;
export type BinaryKind = (typeof BinaryKind)[keyof typeof BinaryKind];

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export interface StatusMessage {
  type: 'status';
  state: StreamState;
  /** Human-readable reason, mostly set for 'error' and 'reconnecting'. */
  detail?: string;
}

export interface CodecMessage {
  type: 'codec';
  video: {
    /** Full MSE type, e.g. `video/mp4; codecs="avc1.4d0028"`. */
    mimeType: string;
    width: number;
    height: number;
  };
  audio: {
    codec: 'pcmu';
    sampleRate: number;
  };
}

export type ServerMessage = StatusMessage | CodecMessage;

export interface CameraInfo {
  alias: string;
  model: string;
  firmware: string;
  host: string;
  resolution?: string;
  /** Wi-Fi signal strength in dBm. */
  rssi?: number;
  ledOn?: boolean;
  /** False when privacy mode has turned the camera off. */
  cameraOn?: boolean;
}

export interface StreamStats {
  state: StreamState;
  detail?: string;
  viewers: number;
  width?: number;
  height?: number;
  fps?: number;
  kbps?: number;
}

export const PTZ_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type PtzDirection = (typeof PTZ_DIRECTIONS)[number];

export interface PtzPreset {
  index: number;
  name: string;
}

/** 'unknown' until the first move attempt shows whether the camera accepts it. */
export type PtzCapability = 'unknown' | 'supported' | 'unsupported' | 'disabled';

export interface StatusResponse {
  stream: StreamStats;
  ptz: PtzCapability;
}

export interface SessionResponse {
  authRequired: boolean;
  authenticated: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}
