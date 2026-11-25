import type {
  ApiError,
  CameraInfo,
  PtzDirection,
  PtzMoveMode,
  PtzPreset,
  SessionResponse,
  StatusResponse,
} from '@kasa/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  });
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
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T = void>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

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
};
