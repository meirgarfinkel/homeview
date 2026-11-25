import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupWizard } from './SetupWizard';

type Reply = { status?: number; body?: unknown };
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

function reply({ status = 200, body }: Reply): Response {
  return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
}

function calls(path: string) {
  return fetchMock.mock.calls
    .filter(([p]) => p === path)
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function toExistingCamera(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Password'), 'sleepy-owl-42');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: /It already works in the Kasa app/ }));
  await screen.findByRole('heading', { name: 'Connect your camera' });
}

it('walks from password to the existing-camera form and connects', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  fetchMock.mockImplementation((path) =>
    Promise.resolve(
      path === '/api/setup/password'
        ? reply({ status: 204 })
        : reply({ body: { saved: { alias: 'Nursery', model: 'EC70', host: '192.168.1.5' } } }),
    ),
  );
  render(<SetupWizard onDone={onDone} />);
  expect(screen.getByRole('heading', { name: 'Welcome to Kasa Home' })).toBeTruthy();

  await toExistingCamera(user);
  expect(calls('/api/setup/password')).toEqual([{ password: 'sleepy-owl-42' }]);

  await user.type(screen.getByLabelText('Kasa email'), 'mom@example.com');
  await user.type(screen.getByLabelText('Kasa password'), 'hunter22');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(calls('/api/setup/existing-camera')).toEqual([
    { username: 'mom@example.com', password: 'hunter22' },
  ]);
});

it('blocks a short password with the 8-character hint', async () => {
  const user = userEvent.setup();
  render(<SetupWizard onDone={() => {}} />);
  await user.type(screen.getByLabelText('Password'), 'short');
  expect(screen.getByText('At least 8 characters')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows the camera list when several accept the login', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  const a = { alias: 'Nursery', model: 'EC70', host: '192.168.1.5' };
  const b = { alias: 'Porch', model: 'EC70', host: '192.168.1.6' };
  fetchMock.mockImplementation((path) => {
    if (path === '/api/setup/password') return Promise.resolve(reply({ status: 204 }));
    const body = fetchMock.mock.calls.some(([, i]) => String(i?.body).includes('alias'))
      ? { saved: b }
      : { choose: [a, b] };
    return Promise.resolve(reply({ body }));
  });
  render(<SetupWizard onDone={onDone} />);
  await toExistingCamera(user);
  await user.type(screen.getByLabelText('Kasa email'), 'mom@example.com');
  await user.type(screen.getByLabelText('Kasa password'), 'hunter22');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  await user.click(await screen.findByRole('button', { name: /Porch/ }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(calls('/api/setup/existing-camera')[1]).toEqual({
    username: 'mom@example.com',
    password: 'hunter22',
    alias: 'Porch',
  });
});

it('shows the server message for a wrong login and keeps the form', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation((path) =>
    Promise.resolve(
      path === '/api/setup/password'
        ? reply({ status: 204 })
        : reply({
            status: 401,
            body: { error: 'wrong-login', message: 'That email or password was not accepted.' },
          }),
    ),
  );
  render(<SetupWizard onDone={() => {}} />);
  await toExistingCamera(user);
  await user.type(screen.getByLabelText('Kasa email'), 'mom@example.com');
  await user.type(screen.getByLabelText('Kasa password'), 'nope');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  expect(await screen.findByText('That email or password was not accepted.')).toBeTruthy();
  expect((screen.getByLabelText('Kasa email') as HTMLInputElement).value).toBe('mom@example.com');
  expect((screen.getByLabelText('Kasa password') as HTMLInputElement).value).toBe('nope');
});

it('falls back to plain wording when the server sends no message', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation((path) =>
    Promise.resolve(
      path === '/api/setup/password'
        ? reply({ status: 204 })
        : reply({ status: 502, body: { error: 'camera-unreachable' } }),
    ),
  );
  render(<SetupWizard onDone={() => {}} />);
  await toExistingCamera(user);
  await user.type(screen.getByLabelText('Kasa email'), 'a@b.c');
  await user.type(screen.getByLabelText('Kasa password'), 'x');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).not.toContain('camera-unreachable');
  expect(alert.textContent).toMatch(/camera/i);
});

it('sends the other two camera choices to the onboarding callback', async () => {
  const user = userEvent.setup();
  const onOnboarding = vi.fn();
  fetchMock.mockResolvedValue(reply({ status: 204 }));
  render(<SetupWizard onDone={() => {}} onOnboarding={onOnboarding} />);
  await user.type(screen.getByLabelText('Password'), 'sleepy-owl-42');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const link = await screen.findByRole('link', { name: /myproducts\.tp-link\.com/ });
  expect(link.getAttribute('href')).toBe('https://myproducts.tp-link.com');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  await user.click(screen.getByRole('button', { name: /I have a TP-Link account/ }));
  expect(onOnboarding).toHaveBeenLastCalledWith('account');
});

it('retries once quietly when the server is restarting', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  let tries = 0;
  fetchMock.mockImplementation((path) => {
    if (path === '/api/setup/password') return Promise.resolve(reply({ status: 204 }));
    if (tries++ === 0) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(reply({ body: { saved: { alias: 'N', model: 'E', host: 'h' } } }));
  });
  render(<SetupWizard onDone={onDone} />);
  await toExistingCamera(user);
  await user.type(screen.getByLabelText('Kasa email'), 'a@b.c');
  await user.type(screen.getByLabelText('Kasa password'), 'x');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(screen.queryByRole('alert')).toBeNull();
});
