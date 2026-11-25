import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteStatus } from '@kasa/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AwayFromHome } from './AwayFromHome';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const base: RemoteStatus = { available: true, enabled: true, phase: 'off', devices: [] };
let status: RemoteStatus;

const calls = (path: string, method?: string) =>
  fetchMock.mock.calls.filter(([p, init]) => p === path && (!method || init?.method === method));

beforeEach(() => {
  status = base;
  fetchMock.mockReset();
  fetchMock.mockImplementation((path, init) => {
    if (path === '/api/remote' && !init?.method) return Promise.resolve(json(status));
    if (path === '/api/remote/pair-code')
      return Promise.resolve(
        json({ url: 'https://kasa-home.ts.net/pair#abc', expiresAt: '2026-11-26T12:00:00Z' }),
      );
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = async (s: Partial<RemoteStatus>) => {
  status = { ...base, ...s };
  render(<AwayFromHome />);
  await screen.findByRole('heading', { name: 'Away from home' });
  await screen.findByRole('checkbox');
};

it('shows the off text', async () => {
  await show({ enabled: false, phase: 'off' });
  expect(screen.getByText("Watch from anywhere with your phone's browser.")).toBeTruthy();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

it('shows each step of turning on', async () => {
  await show({ phase: 'starting' });
  expect(screen.getByText('Connecting...')).toBeTruthy();
  cleanup();
  await show({ phase: 'sign-in' });
  expect(
    screen.getByText(
      'Sign in once to the free Tailscale service that carries the encrypted video.',
    ),
  ).toBeTruthy();
  cleanup();
  await show({ phase: 'approve' });
  expect(screen.getByText('One more click: allow Kasa Home to share a web address.')).toBeTruthy();
  cleanup();
  await show({ phase: 'problem', message: 'The helper stopped.' });
  expect(screen.getByText('The helper stopped.')).toBeTruthy();
});

it('turns it on and off with the toggle', async () => {
  const user = userEvent.setup();
  await show({ enabled: false, phase: 'off' });
  await user.click(screen.getByRole('checkbox'));
  expect(JSON.parse(String(calls('/api/remote/enable')[0]![1]?.body))).toEqual({ on: true });
});

it('opens the browser from Sign in and Approve', async () => {
  const user = userEvent.setup();
  await show({ phase: 'sign-in' });
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(calls('/api/remote/open-link', 'POST')).toHaveLength(1);
  cleanup();
  await show({ phase: 'approve' });
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(calls('/api/remote/open-link', 'POST')).toHaveLength(2);
});

it('shows the address and lists devices when on', async () => {
  await show({
    phase: 'on',
    url: 'https://kasa-home.ts.net',
    devices: [{ id: 'd1', name: 'iPhone', createdAt: '2026-11-20T10:00:00Z' }],
  });
  expect(screen.getByText('https://kasa-home.ts.net')).toBeTruthy();
  expect(screen.getByText(/^iPhone, added .+, used never$/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out of Tailscale' })).toBeTruthy();
});

it('shows a QR code for the pairing address', async () => {
  const user = userEvent.setup();
  await show({ phase: 'on', url: 'https://kasa-home.ts.net' });
  await user.click(screen.getByRole('button', { name: 'Add a phone' }));
  expect(
    await screen.findByText(
      "Scan this with the phone's camera. The code works once, for 10 minutes.",
    ),
  ).toBeTruthy();
  expect(calls('/api/remote/pair-code', 'POST')).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'Pairing code' }).querySelector('svg')).toBeTruthy();
});

it('removes a device', async () => {
  const user = userEvent.setup();
  await show({
    phase: 'on',
    url: 'https://kasa-home.ts.net',
    devices: [{ id: 'd1', name: 'iPhone', createdAt: '2026-11-20T10:00:00Z' }],
  });
  await user.click(screen.getByRole('button', { name: 'Remove iPhone' }));
  expect(calls('/api/remote/devices/d1', 'DELETE')).toHaveLength(1);
});

it('tries again by turning off and on', async () => {
  const user = userEvent.setup();
  await show({ phase: 'problem', message: 'Stopped.' });
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  const bodies = calls('/api/remote/enable').map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toEqual([{ on: false }, { on: true }]);
});

it('signs out of Tailscale', async () => {
  const user = userEvent.setup();
  await show({ phase: 'problem', message: 'Stopped.' });
  await user.click(screen.getByRole('button', { name: 'Sign out of Tailscale' }));
  expect(calls('/api/remote/sign-out', 'POST')).toHaveLength(1);
});

it('polls every 2 seconds while starting, and stops on unmount', async () => {
  vi.useFakeTimers();
  status = { ...base, phase: 'starting' };
  const { unmount } = render(<AwayFromHome />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const reads = () => calls('/api/remote').length;
  const first = reads();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(reads()).toBe(first + 1);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(reads()).toBe(first + 2);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(reads()).toBe(first + 2);
});

it('does not poll once on', async () => {
  vi.useFakeTimers();
  status = { ...base, phase: 'on', url: 'https://kasa-home.ts.net' };
  render(<AwayFromHome />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const first = calls('/api/remote').length;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(calls('/api/remote')).toHaveLength(first);
});
