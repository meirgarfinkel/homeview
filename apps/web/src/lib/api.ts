import type {
  ApiError,
  CameraInfo,
  PtzDirection,
  PtzMoveMode,
  PtzPreset,
  OnboardingAnswer,
  OnboardingStatus,
  OnvifCheckResult,
  OnvifLogin,
  OnvifProfilesResult,
  OnvifSaveBody,
  OnvifSaveResult,
  OnvifScanResult,
  PairCodeResponse,
  RemoteStatus,
  SessionResponse,
  SettingsResponse,
  SetupExistingResult,
  StatusResponse,
  UpdateCheckResult,
  UpdateStatus,
} from '@kasa/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The server's own wording, when it sent one. `message` falls back to the HTTP status text. */
    readonly serverMessage?: string,
  ) {
    super(message);
  }
}

let unauthorizedHandler: (() => void) | undefined;

/**
 * Called when the server stops accepting this browser's sign-in, for example
 * after the password was changed on another device. One handler at a time.
 */
export function onUnauthorized(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

/** Routes whose 401 is an answer about the request, not a sign that the session ended. */
const OWN_401 = new Set(['/api/login', '/api/session', '/api/remote/pair']);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  });
  // A 401 from sign-in only means a wrong password, and one from pairing a bad code. A 401 from
  // the session check is its own answer: re-checking the session in response would loop.
  if (res.status === 401 && !OWN_401.has(path)) notifyUnauthorized();
  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // not JSON
    }
    throw new ApiRequestError(
      res.status,
      body.error ?? 'http_error',
      body.message ?? res.statusText,
      body.message,
    );
  }
  if (res.status === 204) return undefined as T;
  // A 202 may come with a body (onboarding, pairing) or without one (the update install).
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T = void>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

const del = (path: string) => request<void>(path, { method: 'DELETE' });

const put = <T = void>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const api = {
  session: () => request<SessionResponse>('/api/session'),
  login: (password: string) => post('/api/login', { password }),
  logout: () => post('/api/logout'),
  status: () => request<StatusResponse>('/api/status'),
  camera: () => request<CameraInfo>('/api/camera'),
  ptzMove: (direction: PtzDirection, mode: PtzMoveMode) =>
    post('/api/ptz/move', { direction, mode }),
  ptzStop: () => post('/api/ptz/stop'),
  presets: () => request<PtzPreset[]>('/api/ptz/presets'),
  goToPreset: (index: number) => post(`/api/ptz/presets/${index}/go`),
  settings: () => request<SettingsResponse>('/api/settings'),
  changeViewerPassword: (current: string, password: string) =>
    put('/api/settings/viewer-password', { current, password }),
  changeCamera: (username: string, password: string, alias?: string) =>
    put<SetupExistingResult>('/api/settings/camera', {
      username,
      password,
      ...(alias === undefined ? {} : { alias }),
    }),
  cameraProfiles: () => request<OnvifProfilesResult>('/api/settings/camera-profiles'),
  setCameraProfile: (profileToken: string) =>
    post('/api/settings/camera-profile', { profileToken }),
  setAutostart: (enabled: boolean) => put('/api/app/autostart', { enabled }),
  quit: () => post('/api/app/quit'),
  update: () => request<UpdateStatus>('/api/app/update'),
  installUpdate: () => post('/api/app/update/install'),
  checkForUpdates: () => post<{ result: UpdateCheckResult }>('/api/app/update/check'),
  remote: {
    status: () => request<RemoteStatus>('/api/remote'),
    enable: (on: boolean) => post('/api/remote/enable', { on }),
    openLink: () => post('/api/remote/open-link'),
    signOut: () => post('/api/remote/sign-out'),
    removeDevice: (id: string) => del(`/api/remote/devices/${encodeURIComponent(id)}`),
    pairCode: () => post<PairCodeResponse>('/api/remote/pair-code'),
    pair: (code: string) => post('/api/remote/pair', { code }),
  },
  setup: {
    password: (password: string) => post('/api/setup/password', { password }),
    existingCamera: (username: string, password: string, alias?: string) =>
      post<SetupExistingResult>('/api/setup/existing-camera', {
        username,
        password,
        ...(alias === undefined ? {} : { alias }),
      }),
    /** Change to a Kasa camera after setup, from this computer. */
    kasaCamera: (username: string, password: string, alias?: string) =>
      post<SetupExistingResult>('/api/setup/kasa-camera', {
        username,
        password,
        ...(alias === undefined ? {} : { alias }),
      }),
    onvif: {
      scan: () => post<OnvifScanResult>('/api/setup/onvif/scan'),
      check: (login: OnvifLogin) => post<OnvifCheckResult>('/api/setup/onvif/check', login),
      save: (body: OnvifSaveBody) => post<OnvifSaveResult>('/api/setup/onvif/save', body),
    },
    resetPassword: (password: string) => post('/api/setup/reset-password', { password }),
    startOnboarding: (
      mode: 'account' | 'local',
      account?: { username: string; password: string },
    ) => post<OnboardingStatus>('/api/setup/onboarding', { mode, ...(account ? { account } : {}) }),
    onboarding: () => request<OnboardingStatus>('/api/setup/onboarding'),
    answer: (answer: OnboardingAnswer) =>
      post<OnboardingStatus>('/api/setup/onboarding/answer', answer),
    cancelOnboarding: () => request<void>('/api/setup/onboarding', { method: 'DELETE' }),
  },
};
