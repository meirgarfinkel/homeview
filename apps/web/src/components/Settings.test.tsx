import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SettingsResponse } from '@kasa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';

vi.mock('./setup/Onboarding', () => ({
  Onboarding: ({ mode, onCancel }: { mode: string; onCancel(): void }) => (
    <button type="button" onClick={onCancel}>
      onboarding {mode}
    </button>
  ),
}));

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const base: SettingsResponse = {
  camera: { kind: 'kasa', username: 'a@b.c', alias: 'nursery', localOnly: false },
  local: true,
  desktop: true,
  autostart: false,
  version: null,
  streamResolution: null,
  managedByEnv: [],
};
let settings: SettingsResponse;
let reply: (path: string, init?: RequestInit) => Response | undefined;

const calls = (path: string) => fetchMock.mock.calls.filter(([p]) => p === path);
const sent = (path: string) => JSON.parse(String(calls(path)[0]![1]?.body)) as unknown;

beforeEach(() => {
  settings = base;
  reply = () => undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation((path, init) => {
    if (path === '/api/settings') return Promise.resolve(json(settings));
    return Promise.resolve(reply(path, init) ?? new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async (s: Partial<SettingsResponse> = {}, onClose = () => undefined) => {
  settings = { ...base, ...s };
  render(<Settings onClose={onClose} />);
  await screen.findByRole('heading', { name: 'Viewer password' });
};

it('shows every section on the desktop computer', async () => {
  await open();
  for (const name of [
    'Viewer password',
    'Camera',
    'Set up a new or reset camera',
    'Start when this computer starts',
    'Stop HomeView',
  ])
    expect(screen.getByRole('heading', { name })).toBeTruthy();
});

it('hides the computer-only sections for other devices', async () => {
  await open({ local: false });
  expect(screen.queryByRole('heading', { name: 'Set up a new or reset camera' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Start when this computer starts' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Stop HomeView' })).toBeNull();
});

it('hides the desktop-only sections outside the desktop app', async () => {
  await open({ desktop: false, autostart: null });
  expect(screen.getByRole('heading', { name: 'Set up a new or reset camera' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Start when this computer starts' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Stop HomeView' })).toBeNull();
});

it('hides autostart when the server cannot change it', async () => {
  await open({ autostart: null });
  expect(screen.queryByRole('heading', { name: 'Start when this computer starts' })).toBeNull();
});

it('shows environment-managed items as read-only', async () => {
  await open({ managedByEnv: ['viewerPassword', 'camera'] });
  expect(screen.getAllByText('Set in .env')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
});

it('changes the viewer password and stays signed in', async () => {
  const user = userEvent.setup();
  await open();
  await user.type(screen.getByLabelText('Current password'), 'old-password');
  await user.type(screen.getByLabelText('New password'), 'new-password-1');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Password changed.')).toBeTruthy();
  expect(calls('/api/settings/viewer-password')[0]![1]?.method).toBe('PUT');
  expect(sent('/api/settings/viewer-password')).toEqual({
    current: 'old-password',
    password: 'new-password-1',
  });
});

it('says plainly when the current password is wrong', async () => {
  const user = userEvent.setup();
  reply = (path) =>
    path === '/api/settings/viewer-password' ? json({ error: 'wrong-password' }, 403) : undefined;
  await open();
  await user.type(screen.getByLabelText('Current password'), 'nope-nope');
  await user.type(screen.getByLabelText('New password'), 'new-password-1');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toBe('That password was not right.');
});

it('connects a camera with a new login', async () => {
  const user = userEvent.setup();
  reply = (path) =>
    path === '/api/settings/camera'
      ? json({ saved: { alias: 'nursery', model: 'M', host: 'h' } })
      : undefined;
  await open();
  const email = screen.getByLabelText('Kasa email') as HTMLInputElement;
  expect(email.value).toBe('a@b.c');
  await user.type(screen.getByLabelText('Kasa password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Camera saved.')).toBeTruthy();
  expect(sent('/api/settings/camera')).toEqual({ username: 'a@b.c', password: 'secret' });
});

it('opens camera setup in account mode, and returns', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole('button', { name: 'Set up a camera' }));
  await user.click(screen.getByRole('button', { name: 'onboarding account' }));
  expect(await screen.findByRole('heading', { name: 'Viewer password' })).toBeTruthy();
});

it('opens camera setup in local mode for a local-only camera', async () => {
  const user = userEvent.setup();
  await open({ camera: { kind: 'kasa', username: 'a@b.c', localOnly: true } });
  await user.click(screen.getByRole('button', { name: 'Set up a camera' }));
  expect(screen.getByRole('button', { name: 'onboarding local' })).toBeTruthy();
});

it('saves the autostart choice', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByLabelText('Start HomeView when this computer starts'));
  expect(sent('/api/app/autostart')).toEqual({ enabled: true });
});

it('asks before stopping, then says it has stopped', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole('button', { name: 'Stop HomeView' }));
  expect(calls('/api/app/quit')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Yes, stop' }));
  expect(await screen.findByText('HomeView has stopped. You can close this tab.')).toBeTruthy();
  expect(calls('/api/app/quit')).toHaveLength(1);
});

it('keeps running when stopping is cancelled', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole('button', { name: 'Stop HomeView' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(calls('/api/app/quit')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Stop HomeView' })).toBeTruthy();
});

it('closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  await open({}, onClose);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onClose).toHaveBeenCalled();
});

it('shows Away from home on the desktop computer only', async () => {
  await open();
  expect(screen.getByRole('heading', { name: 'Away from home' })).toBeTruthy();
  cleanup();
  await open({ local: false });
  expect(screen.queryByRole('heading', { name: 'Away from home' })).toBeNull();
  cleanup();
  await open({ desktop: false });
  expect(screen.queryByRole('heading', { name: 'Away from home' })).toBeNull();
});

it('lets a phone at home pair itself for use away', async () => {
  const user = userEvent.setup();
  const assign = vi.fn();
  vi.stubGlobal('location', { assign });
  reply = (path) =>
    path === '/api/remote/pair-code'
      ? json({ url: 'https://homeview.ts.net/pair#abc', expiresAt: '2026-11-26T12:00:00Z' })
      : undefined;
  settings = { ...base, local: false, desktop: false };
  render(<Settings onClose={() => undefined} phoneAway />);
  await user.click(await screen.findByRole('button', { name: 'Use this phone away from home' }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://homeview.ts.net/pair#abc'));
  expect(calls('/api/remote/pair-code')[0]![1]?.method).toBe('POST');
});

it('hides the phone button unless asked to show it', async () => {
  await open({ local: false });
  expect(screen.queryByRole('button', { name: 'Use this phone away from home' })).toBeNull();
});

describe('Updates', () => {
  const updates = (status: unknown, check?: Response) => {
    reply = (path) => {
      if (path === '/api/app/update') return json(status);
      if (path === '/api/app/update/check') return check;
      return undefined;
    };
  };

  it('shows the version and checks for updates on request', async () => {
    updates({ state: 'none' }, json({ result: 'up-to-date' }));
    const user = userEvent.setup();
    await open({ version: '0.1.0' });
    expect(await screen.findByRole('heading', { name: 'Updates' })).toBeTruthy();
    expect(screen.getByText('This is HomeView 0.1.0.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('HomeView is up to date.')).toBeTruthy();
    expect(calls('/api/app/update/check')).toHaveLength(1);
  });

  it('says what it is downloading', async () => {
    updates({ state: 'none' }, json({ result: 'downloading' }));
    const user = userEvent.setup();
    await open({ version: '0.1.0' });
    await screen.findByRole('heading', { name: 'Updates' });
    updates({ state: 'downloading', version: '0.2.0' }, json({ result: 'downloading' }));
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Downloading HomeView 0.2.0…')).toBeTruthy();
  });

  it('says why a check failed', async () => {
    updates(
      { state: 'none' },
      json({ error: 'update-check-failed', message: 'GitHub answered 503' }, 502),
    );
    const user = userEvent.setup();
    await open({ version: '0.1.0' });
    await screen.findByRole('heading', { name: 'Updates' });
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText("Couldn't check for updates: GitHub answered 503")).toBeTruthy();
  });

  it('offers to restart into an update that is ready', async () => {
    updates({ state: 'ready', version: '0.2.0' });
    const user = userEvent.setup();
    await open({ version: '0.1.0' });
    expect(await screen.findByText('HomeView 0.2.0 is ready.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(await screen.findByText('Restarting…')).toBeTruthy();
    expect(calls('/api/app/update/install')).toHaveLength(1);
  });

  it('is hidden when this copy cannot update itself', async () => {
    reply = (path) =>
      path === '/api/app/update' ? json({ error: 'not-available', message: 'x' }, 404) : undefined;
    await open({ version: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Updates' })).toBeNull();
  });

  it('is hidden on other devices', async () => {
    updates({ state: 'ready', version: '0.2.0' });
    await open({ local: false, version: '0.1.0' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Updates' })).toBeNull();
    expect(calls('/api/app/update')).toHaveLength(0);
  });
});
