import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('./components/Monitor', async () => {
  const { api } = await import('./lib/api');
  return {
    Monitor: ({ onOpenSettings }: { onOpenSettings?: () => void }) => (
      <>
        <button type="button" onClick={onOpenSettings}>
          Monitor screen
        </button>
        <button type="button" onClick={() => void api.status().catch(() => undefined)}>
          Poll status
        </button>
      </>
    ),
  };
});
vi.mock('./components/setup/AllSet', () => ({
  AllSet: ({ lanUrl, onContinue }: { lanUrl?: string; onContinue(): void }) => (
    <button type="button" onClick={onContinue}>
      All set page {lanUrl}
    </button>
  ),
}));
vi.mock('./components/Settings', () => ({
  Settings: ({ onClose }: { onClose(): void }) => (
    <button type="button" onClick={onClose}>
      Settings screen
    </button>
  ),
}));

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const session = (setupComplete: boolean, extra: object = {}) =>
  new Response(
    JSON.stringify({
      authRequired: true,
      authenticated: true,
      setupComplete,
      local: true,
      desktop: true,
      ...extra,
    }),
  );

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps polling after setup until the server reports it complete', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(session(false)); // first page load
  render(<App retryMs={10} />);
  await user.type(await screen.findByLabelText('Password'), 'sleepy-owl-42');
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 204 })) // password
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ saved: { alias: 'A', model: 'M', host: 'h' } })),
    ) // existing camera
    .mockRejectedValueOnce(new TypeError('fetch failed')) // session, switching
    .mockResolvedValueOnce(session(false)) // session, old settings
    .mockResolvedValueOnce(session(true, { lanUrl: 'https://192.168.1.20:8090' })) // session, done
    .mockResolvedValue(new Response(JSON.stringify({ autostart: null }))); // settings
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: /already works/ }));
  await user.type(screen.getByLabelText('Kasa email'), 'a@b.c');
  await user.type(screen.getByLabelText('Kasa password'), 'x');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  expect(await screen.findByText('Finishing setup…')).toBeTruthy();
  expect(screen.queryByLabelText('Kasa email')).toBeNull();
  const allSet = await screen.findByRole('button', { name: /All set page/ });
  expect(allSet.textContent).toContain('https://192.168.1.20:8090');
  expect(screen.queryByText('Finishing setup…')).toBeNull();
  expect(screen.queryByText('Monitor screen')).toBeNull();

  await user.click(allSet);
  await user.click(await screen.findByRole('button', { name: 'Monitor screen' }));
  await user.click(await screen.findByRole('button', { name: 'Settings screen' }));
  expect(await screen.findByRole('button', { name: 'Monitor screen' })).toBeTruthy();
});

it('goes straight to the monitor on a later visit', async () => {
  fetchMock.mockResolvedValue(session(true));
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Monitor screen' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /All set page/ })).toBeNull();
});

/** Answers by path, so a test can say what each endpoint returns right now. */
function route(replies: Record<string, () => Response>) {
  fetchMock.mockImplementation((path) => {
    const reply = replies[path];
    return Promise.resolve(reply ? reply() : new Response('{}', { status: 404 }));
  });
}

it('signs in after "Set a new password" even if the first check still says signed out', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  let checks = 0;
  route({
    '/api/session': () => {
      checks += 1;
      // The first load, then one answer from the old settings, then signed in.
      return session(true, { authenticated: checks > 2 });
    },
    '/api/setup/reset-password': () => new Response(null, { status: 204 }),
  });
  render(<App retryMs={10} />);
  await user.click(await screen.findByRole('button', { name: /Set a new password/ }));
  await user.type(screen.getByLabelText('New password'), 'sleepy-owl-42');
  await user.type(screen.getByLabelText('New password again'), 'sleepy-owl-42');
  await user.click(screen.getByRole('button', { name: 'Save password' }));
  expect(await screen.findByRole('button', { name: 'Monitor screen' })).toBeTruthy();
});

it('goes back to sign in when the server stops accepting this browser', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  let signedIn = true;
  route({
    '/api/session': () => session(true, { authenticated: signedIn }),
    '/api/status': () =>
      new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in required' }), {
        status: 401,
      }),
  });
  render(<App />);
  await screen.findByRole('button', { name: 'Monitor screen' });
  // The password was changed somewhere else.
  signedIn = false;
  await user.click(screen.getByRole('button', { name: 'Poll status' }));
  expect(await screen.findByLabelText('Password')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Monitor screen' })).toBeNull();
});
