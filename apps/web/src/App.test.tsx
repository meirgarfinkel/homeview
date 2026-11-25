import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('./components/Monitor', () => ({ Monitor: () => <p>Monitor screen</p> }));

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const session = (setupComplete: boolean) =>
  new Response(
    JSON.stringify({
      authRequired: true,
      authenticated: true,
      setupComplete,
      local: true,
      desktop: true,
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
    .mockResolvedValue(session(true));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: /already works/ }));
  await user.type(screen.getByLabelText('Kasa email'), 'a@b.c');
  await user.type(screen.getByLabelText('Kasa password'), 'x');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  expect(await screen.findByText('Finishing setup…')).toBeTruthy();
  expect(screen.queryByLabelText('Kasa email')).toBeNull();
  expect(await screen.findByText('Monitor screen')).toBeTruthy();
  expect(screen.queryByText('Finishing setup…')).toBeNull();
});
