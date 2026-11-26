import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnvifSetup } from './OnvifSetup';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let reply: (path: string, init?: RequestInit) => Response | undefined;

const calls = (path: string) =>
  fetchMock.mock.calls
    .filter(([p]) => p === path)
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

const CHECKED = {
  model: 'E1 Pro',
  profiles: [
    { token: 'main', name: 'Main', codec: 'h265', width: 2560, height: 1440 },
    { token: 'sub', name: 'Sub', codec: 'h264', width: 1920, height: 1080 },
  ],
  picked: 'sub',
};

beforeEach(() => {
  reply = () => undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation((path, init) => {
    const own = reply(path, init);
    if (own) return Promise.resolve(own);
    if (path === '/api/setup/onvif/scan') {
      return Promise.resolve(
        json({
          cameras: [
            { endpointId: 'urn:uuid:1', host: '192.168.1.40', port: 8000, name: 'Nursery' },
          ],
        }),
      );
    }
    if (path === '/api/setup/onvif/check') return Promise.resolve(json(CHECKED));
    if (path === '/api/setup/onvif/save')
      return Promise.resolve(json({ saved: { host: '192.168.1.40' } }));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'cam-pass');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
}

it('OnvifSetup shows the hints verbatim', async () => {
  render(<OnvifSetup onDone={() => {}} onBack={() => {}} />);
  for (const line of [
    'Make sure the camera is set up in its own app and on your Wi-Fi.',
    'Tapo: in the Tapo app, create a "Camera account" (Advanced settings). Use that, not your Tapo login.',
    "Reolink: turn on ONVIF and RTSP in the camera's network settings if they are off.",
    "Others: use the camera's admin username and password.",
  ]) {
    expect(screen.getByText(line)).toBeTruthy();
  }
  await screen.findByRole('button', { name: /Nursery/ });
});

it('lists scanned cameras and connects to the chosen one', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<OnvifSetup onDone={onDone} onBack={() => {}} />);
  const cam = await screen.findByRole('button', { name: /Nursery/ });
  expect(cam.textContent).toContain('192.168.1.40');
  expect(screen.getByRole('button', { name: 'Search again' })).toBeTruthy();
  await user.click(cam);
  await signIn(user);
  expect(await screen.findByText('1920×1080, H.264', { selector: 'strong' })).toBeTruthy();
  expect(calls('/api/setup/onvif/check')).toEqual([
    { host: '192.168.1.40', port: 8000, username: 'admin', password: 'cam-pass' },
  ]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(calls('/api/setup/onvif/save')).toEqual([
    {
      host: '192.168.1.40',
      port: 8000,
      username: 'admin',
      password: 'cam-pass',
      profileToken: 'sub',
      endpointId: 'urn:uuid:1',
    },
  ]);
});

it('typed rtsp URL goes to check', async () => {
  const user = userEvent.setup();
  render(<OnvifSetup onDone={() => {}} onBack={() => {}} />);
  await user.click(
    await screen.findByRole('button', { name: 'Not in the list? Type its address.' }),
  );
  await user.type(screen.getByLabelText('Camera address'), 'rtsp://192.168.1.41:554/live');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  reply = (path) =>
    path === '/api/setup/onvif/check'
      ? json({
          profiles: [{ token: 'stream', name: 'Stream', codec: 'h264', width: 0, height: 0 }],
          picked: 'stream',
        })
      : undefined;
  await signIn(user);
  await screen.findByText('H.264', { selector: 'strong' });
  expect(calls('/api/setup/onvif/check')).toEqual([
    { rtspUrl: 'rtsp://192.168.1.41:554/live', username: 'admin', password: 'cam-pass' },
  ]);
});

it('a typed host and port goes to check', async () => {
  const user = userEvent.setup();
  render(<OnvifSetup onDone={() => {}} onBack={() => {}} />);
  await user.click(
    await screen.findByRole('button', { name: 'Not in the list? Type its address.' }),
  );
  await user.type(screen.getByLabelText('Camera address'), '192.168.1.42:2020');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await signIn(user);
  await screen.findByText('1920×1080, H.264', { selector: 'strong' });
  expect(calls('/api/setup/onvif/check')).toEqual([
    { host: '192.168.1.42', port: 2020, username: 'admin', password: 'cam-pass' },
  ]);
});

it('each error code shows its message', async () => {
  const user = userEvent.setup();
  const cases: [string, number, string][] = [
    ['camera-login', 401, "The camera didn't accept that username or password."],
    [
      'onvif-off',
      502,
      "The camera answered, but ONVIF looks turned off. Turn it on in the camera's own app.",
    ],
    [
      'no-answer',
      504,
      'No answer from that address. Check the camera is on and on the same Wi-Fi.',
    ],
    ['video-format', 422, "This camera's video format isn't supported."],
    ['bad-address', 400, "That doesn't look like a camera address."],
  ];
  render(<OnvifSetup onDone={() => {}} onBack={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /Nursery/ }));
  await user.type(await screen.findByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'x');
  for (const [code, status, text] of cases) {
    reply = (path) =>
      path === '/api/setup/onvif/check'
        ? json({ error: code, message: 'server words' }, status)
        : undefined;
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
  }
});

it('stream select shows size and codec and sends the token', async () => {
  const user = userEvent.setup();
  render(<OnvifSetup onDone={() => {}} onBack={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /Nursery/ }));
  await signIn(user);
  const select = (await screen.findByLabelText('Change')) as HTMLSelectElement;
  expect([...select.options].map((o) => o.textContent)).toEqual([
    '2560×1440, H.265',
    '1920×1080, H.264',
  ]);
  await user.selectOptions(select, 'main');
  expect(screen.getByText('2560×1440, H.265', { selector: 'strong' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(calls('/api/setup/onvif/save')[0]).toMatchObject({ profileToken: 'main' }),
  );
});
