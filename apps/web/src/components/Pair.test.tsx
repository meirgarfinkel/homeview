import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Pair } from './Pair';

vi.mock('./Monitor', () => ({ Monitor: () => <p>Monitor screen</p> }));

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/pair#' + 'c'.repeat(22));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('sends the code from the hash, clears the hash first, and shows the camera', async () => {
  const replace = vi.spyOn(window.history, 'replaceState');
  fetchMock.mockImplementation(() => {
    // The hash is gone by the time the request goes out.
    expect(window.location.hash).toBe('');
    return Promise.resolve(new Response('{"ok":true}'));
  });
  render(<Pair />);
  expect(screen.getByText('Setting up this phone...')).toBeTruthy();
  expect(await screen.findByText('Monitor screen')).toBeTruthy();
  expect(screen.getByText('Tip: add this page to your home screen.')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0]!;
  expect(path).toBe('/api/remote/pair');
  expect(JSON.parse(String(init?.body))).toEqual({ code: 'c'.repeat(22) });
  expect(replace).toHaveBeenCalled();
});

it('says so when the code is refused', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: 'bad-code', message: 'x' }), { status: 401 }),
  );
  render(<Pair />);
  expect(
    await screen.findByText(
      "This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.",
    ),
  ).toBeTruthy();
});

it('fails without calling the server when there is no code', async () => {
  window.history.replaceState(null, '', '/pair');
  render(<Pair />);
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(fetchMock).not.toHaveBeenCalled();
});
