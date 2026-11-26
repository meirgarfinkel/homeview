/**
 * Types and constants shared by the server and the browser client.
 *
 * Live media travels over one WebSocket at LIVE_WS_PATH. Text frames carry JSON
 * control messages (ServerMessage). Binary frames start with a one-byte
 * BinaryKind tag followed by the payload.
 */

export const LIVE_WS_PATH = '/api/live';

/** Close code for a live view whose phone was removed from remote access. */
export const DEVICE_REMOVED_CLOSE = 4401;

export const BinaryKind = {
  /** Fragmented-MP4 initialization segment (ftyp + moov). */
  VideoInit: 1,
  /** One fMP4 media fragment (moof + mdat) holding a single video frame. */
  VideoFragment: 2,
  /** One encoded sound frame in the format CodecMessage.audio names (AAC without ADTS). */
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
  /**
   * The sound format. Absent until the camera's sound starts; null when the
   * page can't play it (a format we don't support).
   */
  audio?: AudioFormat | null;
}

export interface AudioFormat {
  codec: 'pcmu' | 'pcma' | 'aac';
  sampleRate: number;
  channels: number;
  /** AAC AudioSpecificConfig, base64. AAC only. */
  config?: string;
}

export type ServerMessage = StatusMessage | CodecMessage;

/** Which kind of camera driver runs the camera. */
export type CameraKind = 'kasa' | 'onvif';

export interface CameraInfo {
  kind: CameraKind;
  alias: string;
  model: string;
  firmware?: string;
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
  /** True when this request came through the remote tunnel. Absent means false. */
  remote?: boolean;
  /** True when remote access is on and reachable. Absent means false. */
  remoteOn?: boolean;
  /** The address phones use. Only sent to this computer, and only when it has a LAN address. */
  lanUrl?: string;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Reply to GET /api/settings. It never holds a password. */
export interface SettingsResponse {
  camera: {
    kind: CameraKind;
    username: string;
    alias?: string;
    localOnly: boolean;
    /** The stream profile a standard camera uses. */
    profileToken?: string;
  } | null;
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

export type RemotePhase = 'off' | 'starting' | 'sign-in' | 'approve' | 'on' | 'problem';

export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
}

export interface RemoteStatus {
  /** The helper is installed (desktop app). */
  available: boolean;
  enabled: boolean;
  phase: RemotePhase;
  /** Set when the phase is 'on'. */
  url?: string;
  /** Set when the phase is 'problem'. */
  message?: string;
  devices: RemoteDevice[];
}

export interface PairCodeResponse {
  url: string;
  expiresAt: string;
}

/** A standard (ONVIF) camera found on the network. */
export interface OnvifScanCamera {
  endpointId: string;
  host: string;
  port: number;
  name?: string;
}

export interface OnvifScanResult {
  cameras: OnvifScanCamera[];
}

/** How to reach a standard camera: its ONVIF address, or a typed-in stream address. */
export type OnvifLogin =
  | { host: string; port?: number; username: string; password: string }
  | { rtspUrl: string; username: string; password: string };

/** POST /api/setup/onvif/save: the login, the chosen profile, and the id from the scan. */
export type OnvifSaveBody = OnvifLogin & { profileToken?: string; endpointId?: string };

export interface OnvifProfileInfo {
  token: string;
  name: string;
  codec: 'h264' | 'h265';
  width: number;
  height: number;
}

/** Reply to POST /api/setup/onvif/check. Nothing is saved. */
export interface OnvifCheckResult {
  model?: string;
  profiles: OnvifProfileInfo[];
  /** The profile Kasa Home would watch. */
  picked: string;
}

/** Reply to POST /api/setup/onvif/save. */
export interface OnvifSaveResult {
  saved: { model?: string; host: string };
}

/** Error codes for the standard-camera checks. */
export type OnvifCheckError =
  'bad-address' | 'camera-login' | 'video-format' | 'no-answer' | 'onvif-off';
