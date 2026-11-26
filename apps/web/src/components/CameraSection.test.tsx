import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SettingsResponse } from '@kasa/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Settings } from './Settings';

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
let model: string;

const nonGets = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

beforeEach(() => {
  settings = base;
  model = 'KC410S';
  fetchMock.mockReset();
  fetchMock.mockImplementation((path) => {
    if (path === '/api/settings') return Promise.resolve(json(settings));
    if (path === '/api/camera') {
      return Promise.resolve(
        json({ kind: settings.camera?.kind, alias: 'x', model, host: '192.168.1.5' }),
      );
    }
    if (path === '/api/settings/camera-profiles') {
      return Promise.resolve(
        json({
          profiles: [
            { token: 'main', name: 'Main', codec: 'h265', width: 2560, height: 1440 },
            { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360 },
          ],
          current: 'main',
        }),
      );
    }
    if (path === '/api/setup/onvif/scan') return Promise.resolve(json({ cameras: [] }));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows a Kasa camera as "Kasa <model>"', async () => {
  render(<Settings onClose={() => {}} />);
  expect(await screen.findByText('Kasa KC410S')).toBeTruthy();
});

it('shows another brand and saves a new stream choice', async () => {
  const user = userEvent.setup();
  settings = {
    ...base,
    camera: { kind: 'onvif', username: 'admin', localOnly: false, profileToken: 'main' },
  };
  model = 'Reolink E1 Pro';
  render(<Settings onClose={() => {}} />);
  expect(await screen.findByText('Reolink E1 Pro, other brand')).toBeTruthy();
  const select = (await screen.findByLabelText('Stream')) as HTMLSelectElement;
  expect(select.value).toBe('main');
  await user.selectOptions(select, 'sub');
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.find(([p]) => p === '/api/settings/camera-profile')?.[1]?.body,
    ).toBe(JSON.stringify({ profileToken: 'sub' })),
  );
  // A standard camera has no Kasa login to change.
  expect(screen.queryByLabelText('Kasa email')).toBeNull();
});

it('CameraSection Change camera then cancel changes nothing', async () => {
  const user = userEvent.setup();
  render(<Settings onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Change camera' }));
  await screen.findByRole('heading', { name: 'Which camera do you have?' });
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await screen.findByRole('heading', { name: 'Settings' });

  await user.click(await screen.findByRole('button', { name: 'Change camera' }));
  await user.click(await screen.findByRole('button', { name: /Another brand/ }));
  await screen.findByRole('heading', { name: 'Find your camera' });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByRole('heading', { name: 'Which camera do you have?' });
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await screen.findByRole('heading', { name: 'Settings' });
  // The search is the only request, and it changes nothing.
  expect(nonGets().filter(([p]) => p !== '/api/setup/onvif/scan')).toEqual([]);
});

it('a phone does not see the camera change', async () => {
  settings = { ...base, local: false };
  render(<Settings onClose={() => {}} />);
  await screen.findByRole('heading', { name: 'Viewer password' });
  expect(screen.queryByRole('button', { name: 'Change camera' })).toBeNull();
});
