import type {
  ApiError,
  CameraInfo,
  PtzDirection,
  PtzMoveMode,
  PtzPreset,
  OnboardingAnswer,
  OnboardingStatus,
  SessionResponse,
  SettingsResponse,
  SetupExistingResult,
  StatusResponse,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  });
  // A 401 from sign-in itself only means a wrong password.
  if (res.status === 401 && path !== '/api/login') notifyUnauthorized();
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
  return (await res.json()) as T;
}

const post = <T = void>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

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
  setAutostart: (enabled: boolean) => put('/api/app/autostart', { enabled }),
  quit: () => post('/api/app/quit'),
  setup: {
    password: (password: string) => post('/api/setup/password', { password }),
    existingCamera: (username: string, password: string, alias?: string) =>
      post<SetupExistingResult>('/api/setup/existing-camera', {
        username,
        password,
        ...(alias === undefined ? {} : { alias }),
      }),
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
