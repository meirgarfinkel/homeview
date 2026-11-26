import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AllSet } from './AllSet';

vi.mock('../../hooks/useLiveStream', () => ({
  useLiveStream: () => ({
    connection: 'open',
    stream: 'live',
    detail: undefined,
    codec: undefined,
    playerError: undefined,
    listening: false,
    startListening: async () => undefined,
    stopListening: () => undefined,
    volume: 1,
    setVolume: () => undefined,
    levelRef: { current: 0 },
  }),
}));

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const URL_ = 'https://192.168.1.20:8090';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the QR code, the address and the certificate hint', () => {
  render(<AllSet lanUrl={URL_} autostart={null} onContinue={() => undefined} />);
  expect(screen.getByRole('heading', { name: 'All set' })).toBeTruthy();
  expect(screen.getByText('Watch on your phone: scan this, or type the address.')).toBeTruthy();
  expect(screen.getByText(URL_)).toBeTruthy();
  expect(screen.getByRole('img', { name: URL_ })).toBeTruthy();
  expect(
    screen.getByText(
      "Phones show a security warning the first time. Tap Advanced, then Proceed. It's safe: HomeView makes its own certificate.",
    ),
  ).toBeTruthy();
});

it('asks to connect to Wi-Fi, with no QR, when there is no address', () => {
  render(<AllSet lanUrl={undefined} autostart={null} onContinue={() => undefined} />);
  expect(
    screen.getByText('Connect this computer to your Wi-Fi to watch on other devices.'),
  ).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});

it('adds the firewall note on Windows only', () => {
  const note =
    'If Windows asks whether to allow HomeView on networks, allow it on private networks.';
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  );
  render(<AllSet lanUrl={URL_} autostart={null} onContinue={() => undefined} />);
  expect(screen.getByText(note)).toBeTruthy();
  cleanup();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
  render(<AllSet lanUrl={URL_} autostart={null} onContinue={() => undefined} />);
  expect(screen.queryByText(note)).toBeNull();
});

it('hides the autostart box when the server cannot change it', () => {
  render(<AllSet lanUrl={URL_} autostart={null} onContinue={() => undefined} />);
  expect(screen.queryByLabelText('Start HomeView when this computer starts')).toBeNull();
});

it('saves the autostart choice', async () => {
  const user = userEvent.setup();
  render(<AllSet lanUrl={URL_} autostart={false} onContinue={() => undefined} />);
  await user.click(screen.getByLabelText('Start HomeView when this computer starts'));
  const call = fetchMock.mock.calls.find(([p]) => p === '/api/app/autostart')!;
  expect(call[1]?.method).toBe('PUT');
  expect(JSON.parse(String(call[1]?.body))).toEqual({ enabled: true });
});

it('puts the box back and says so when saving fails', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: 'not-available' }), { status: 404 }),
  );
  render(<AllSet lanUrl={URL_} autostart={false} onContinue={() => undefined} />);
  const box = screen.getByLabelText('Start HomeView when this computer starts') as HTMLInputElement;
  await user.click(box);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(box.checked).toBe(false);
});

it('goes to the monitor', async () => {
  const user = userEvent.setup();
  const onContinue = vi.fn();
  render(<AllSet lanUrl={URL_} autostart={null} onContinue={onContinue} />);
  await user.click(screen.getByRole('button', { name: 'Go to the monitor' }));
  expect(onContinue).toHaveBeenCalled();
});
