import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OnboardingStatus } from '@kasa/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Onboarding } from './Onboarding';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const status = (s: Partial<OnboardingStatus>): OnboardingStatus => ({
  phase: 'reset-camera',
  autoWifi: false,
  ...s,
});

/** Polls (GET) answer from this queue; the last entry repeats. */
let polls: (OnboardingStatus | 'network-error')[] = [];
let startReply: Response | undefined;
let answerReply: OnboardingStatus | undefined;

function bodies(path: string, method: string) {
  return fetchMock.mock.calls
    .filter(([p, init]) => p === path && (init?.method ?? 'GET') === method)
    .map(([, init]) => (init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  polls = [status({ phase: 'reset-camera' })];
  startReply = undefined;
  answerReply = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation((path, init) => {
    const method = init?.method ?? 'GET';
    if (path === '/api/settings') return Promise.resolve(json({ camera: null }));
    if (path === '/api/setup/onboarding' && method === 'POST') {
      const first = polls[0];
      return Promise.resolve(
        startReply ?? json(first === 'network-error' ? status({}) : first, 202),
      );
    }
    if (path === '/api/setup/onboarding' && method === 'GET') {
      const next = polls.length > 1 ? polls.shift()! : polls[0]!;
      return next === 'network-error'
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(json(next));
    }
    if (path === '/api/setup/onboarding/answer') {
      return Promise.resolve(json(answerReply ?? status({ phase: 'scanning' })));
    }
    if (path === '/api/setup/onboarding' && method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(json({}, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// userEvent waits on real timers, which hang under fake ones, so use plain events.
const setup = () => ({
  type: (el: HTMLElement, text: string) => fireEvent.change(el, { target: { value: text } }),
  click: (el: HTMLElement) => fireEvent.click(el),
});
const tick = (ms = 1000) => act(() => vi.advanceTimersByTimeAsync(ms));
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

async function renderLocal(extra: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  const props = { onDone: vi.fn(), onCancel: vi.fn(), ...extra };
  render(<Onboarding mode="local" {...props} />);
  await flush();
  return props;
}

it('asks for the TP-Link account first and sends it in the start request', async () => {
  const user = setup();
  render(<Onboarding mode="account" onDone={vi.fn()} onCancel={vi.fn()} />);
  await flush();
  expect(screen.getByRole('heading', { name: 'Your TP-Link account' })).toBeTruthy();
  expect(bodies('/api/setup/onboarding', 'POST')).toEqual([]);
  expect(screen.getByText(/No account yet\? Create one free at/)).toBeTruthy();

  user.type(screen.getByLabelText('TP-Link email'), 'mom@example.com');
  user.type(screen.getByLabelText('TP-Link password'), 'hunter22');
  user.click(screen.getByRole('button', { name: 'Next' }));
  await flush();

  expect(bodies('/api/setup/onboarding', 'POST')).toEqual([
    { mode: 'account', account: { username: 'mom@example.com', password: 'hunter22' } },
  ]);
  expect(screen.getByRole('heading', { name: 'Reset the camera' })).toBeTruthy();
});

it('fills the email with the saved camera account', async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(json({ camera: { username: 'saved@example.com', localOnly: false } })),
  );
  render(<Onboarding mode="account" onDone={vi.fn()} onCancel={vi.fn()} />);
  await flush();
  expect((screen.getByLabelText('TP-Link email') as HTMLInputElement).value).toBe(
    'saved@example.com',
  );
});

it('local mode skips the account screen and starts at once', async () => {
  await renderLocal();
  expect(bodies('/api/setup/onboarding', 'POST')).toEqual([{ mode: 'local' }]);
  expect(screen.getByRole('heading', { name: 'Reset the camera' })).toBeTruthy();
  expect(document.activeElement?.tagName).toBe('H1');
});

it('sends camera-reset and shows each phase heading', async () => {
  const user = setup();
  answerReply = status({ phase: 'join-camera-wifi', autoWifi: true });
  await renderLocal();
  user.click(screen.getByRole('button', { name: 'The camera is reset' }));
  await flush();
  expect(bodies('/api/setup/onboarding/answer', 'POST')).toEqual([{ type: 'camera-reset' }]);
  expect(screen.getByRole('heading', { name: 'Connecting to the camera…' })).toBeTruthy();

  polls = [status({ phase: 'scanning' })];
  await tick();
  expect(
    screen.getByRole('heading', { name: 'Asking the camera which networks it can see…' }),
  ).toBeTruthy();

  polls = [status({ phase: 'waiting-for-camera' })];
  await tick();
  const waiting = 'Waiting for the camera to join your Wi-Fi (up to 2 minutes)…';
  expect(screen.getByRole('heading', { name: waiting })).toBeTruthy();

  polls = [status({ phase: 'return-home', autoWifi: false })];
  await tick();
  expect(screen.getByRole('heading', { name: 'Rejoin your home Wi-Fi' })).toBeTruthy();
});

it('shows different join text for manual and auto', async () => {
  polls = [status({ phase: 'join-camera-wifi', autoWifi: false, cameraNetwork: 'Kasa_Cam_1A2B' })];
  await renderLocal();
  expect(screen.getByRole('heading', { name: "Join the camera's Wi-Fi" })).toBeTruthy();
  expect(screen.getByText(/It has no password\. This page carries on by itself/)).toBeTruthy();
});

it('sends the chosen network, password and name; open networks hide the password', async () => {
  const user = setup();
  polls = [
    status({
      phase: 'choose-wifi',
      networks: [
        { ssid: 'Cafe', open: true, signal: -40 },
        { ssid: 'HomeNet', open: false, signal: -50 },
        { ssid: 'Far', open: false, signal: -80 },
      ],
    }),
  ];
  await renderLocal();
  expect(screen.getByText('The camera only works on 2.4 GHz Wi-Fi.')).toBeTruthy();
  expect((screen.getByLabelText('Camera name') as HTMLInputElement).value).toBe('nursery');
  const names = screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent?.trim());
  expect(names).toEqual(['Cafe (open)', 'HomeNet', 'Far']);
  expect(screen.queryByLabelText('Wi-Fi password')).toBeNull();

  user.click(screen.getByLabelText('HomeNet'));
  user.type(screen.getByLabelText('Wi-Fi password'), 'secret-pass');
  user.click(screen.getByRole('button', { name: 'Connect the camera' }));
  await flush();
  expect(bodies('/api/setup/onboarding/answer', 'POST')).toEqual([
    { type: 'wifi', ssid: 'HomeNet', passphrase: 'secret-pass', alias: 'nursery' },
  ]);
});

it('lets the parent type the network name when none were found', async () => {
  const user = setup();
  polls = [status({ phase: 'choose-wifi', networks: [] })];
  await renderLocal();
  user.type(screen.getByLabelText('Wi-Fi name'), 'MyHome');
  user.type(screen.getByLabelText('Wi-Fi password'), 'pw123456');
  user.click(screen.getByRole('button', { name: 'Connect the camera' }));
  await flush();
  expect(bodies('/api/setup/onboarding/answer', 'POST')).toEqual([
    { type: 'wifi', ssid: 'MyHome', passphrase: 'pw123456', alias: 'nursery' },
  ]);
});

it('shows the failure message; Try again sends retry; Cancel stops and goes back', async () => {
  const user = setup();
  polls = [
    status({
      phase: 'failed',
      error: { message: 'The camera did not answer.', retryFrom: 'scanning' },
    }),
  ];
  const { onCancel } = await renderLocal();
  expect(screen.getByText('The camera did not answer.')).toBeTruthy();
  user.click(screen.getByRole('button', { name: 'Try again' }));
  await flush();
  expect(bodies('/api/setup/onboarding/answer', 'POST')).toEqual([{ type: 'retry' }]);

  polls = [status({ phase: 'failed', error: { message: 'Nope.', retryFrom: 'scanning' } })];
  await tick();
  user.click(screen.getByRole('button', { name: 'Cancel' }));
  await flush();
  expect(bodies('/api/setup/onboarding', 'DELETE')).toHaveLength(1);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('calls onDone once and stops polling when the job is done', async () => {
  polls = [status({ phase: 'scanning' })];
  const { onDone } = await renderLocal();
  polls = [status({ phase: 'done' })];
  await tick();
  expect(onDone).toHaveBeenCalledTimes(1);
  const getsBefore = bodies('/api/setup/onboarding', 'GET').length;
  await tick(5000);
  expect(bodies('/api/setup/onboarding', 'GET')).toHaveLength(getsBefore);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('keeps polling through failed polls and only complains after several', async () => {
  polls = ['network-error'];
  await renderLocal();
  await tick();
  await tick();
  expect(screen.queryByText(/Could not reach Kasa Home/)).toBeNull();
  await tick(4000);
  expect(screen.getByText(/Could not reach Kasa Home/)).toBeTruthy();

  polls = [status({ phase: 'scanning' })];
  await tick();
  expect(screen.queryByText(/Could not reach Kasa Home/)).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Asking the camera which networks it can see…' }),
  ).toBeTruthy();
});

it('never overlaps polls and stops on unmount', async () => {
  let release: (() => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  fetchMock.mockImplementation((path, init) => {
    if (path === '/api/setup/onboarding' && (init?.method ?? 'GET') === 'POST') {
      return Promise.resolve(json(status({}), 202));
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve) => {
      release = () => {
        inFlight--;
        resolve(json(status({})));
      };
    });
  });
  render(<Onboarding mode="local" onDone={vi.fn()} onCancel={vi.fn()} />);
  await flush();
  await tick(5000);
  expect(maxInFlight).toBe(1);
  cleanup();
  const calls = fetchMock.mock.calls.length;
  release?.();
  await tick(5000);
  expect(fetchMock.mock.calls.length).toBe(calls);
});
