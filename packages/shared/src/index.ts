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
/** `step`: one tap, one small step. `hold`: keep moving while repeated. */
export const PTZ_MOVE_MODES = ['step', 'hold'] as const;
export type PtzMoveMode = (typeof PTZ_MOVE_MODES)[number];

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
  /** False until a viewer password and a camera login are both saved. */
  setupComplete: boolean;
  /** True when the request comes from this computer. */
  local: boolean;
  /** True when the server runs inside the desktop app. */
  desktop: boolean;
  /** The address phones use. Only sent to this computer, and only when it has a LAN address. */
  lanUrl?: string;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Reply to GET /api/settings. It never holds a password. */
export interface SettingsResponse {
  camera: { username: string; alias?: string; localOnly: boolean } | null;
  /** True when the request comes from this computer. */
  local: boolean;
  desktop: boolean;
  /** Start at login. Null when this server can't change it. */
  autostart: boolean | null;
  /** Settings that environment variables set, which the page shows as read-only. */
  managedByEnv: ('viewerPassword' | 'camera')[];
}

/** A camera found during setup. */
export interface SetupCamera {
  alias: string;
  model: string;
  host: string;
}

/** Reply to POST /api/setup/existing-camera when the login worked. */
export type SetupExistingResult = { saved: SetupCamera } | { choose: SetupCamera[] };

/** Camera onboarding, as served by /api/setup/onboarding. */
export type OnboardingPhase =
  | 'reset-camera' // waiting for the parent to say the camera is reset
  | 'join-camera-wifi' // auto: switching; manual: waiting to see the camera at 192.168.0.10
  | 'scanning' // asking the camera for networks
  | 'choose-wifi' // waiting for { ssid, passphrase, alias }
  | 'sending' // set_uplink
  | 'return-home' // auto: switching back; manual: waiting to be on home Wi-Fi
  | 'waiting-for-camera' // up to 120 s for the camera to appear by device ID
  | 'finishing' // alias, clock, on-video time, account link
  | 'done'
  | 'failed';

export interface OnboardingNetwork {
  ssid: string;
  /** RSSI in dBm. */
  signal?: number;
  open: boolean;
  band?: string;
  /** The camera's name for the security, such as WPA2_PSK. */
  security?: string;
}

export interface OnboardingStatus {
  phase: OnboardingPhase;
  autoWifi: boolean;
  networks?: OnboardingNetwork[]; // in choose-wifi
  cameraNetwork?: string; // e.g. Kasa_Cam_1A2B, when known
  /** The camera found on its setup network. */
  camera?: { model: string; host: string; alias: string };
  error?: { message: string; retryFrom: OnboardingPhase }; // in failed
  result?: { alias: string; host: string; linked: boolean; warnings: string[] }; // in done
}

export type OnboardingAnswer =
  | { type: 'camera-reset' }
  | { type: 'wifi'; ssid: string; passphrase: string; alias: string }
  | { type: 'retry' };
