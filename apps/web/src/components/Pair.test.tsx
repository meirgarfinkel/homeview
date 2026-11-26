import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Pair } from './Pair';

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

const BAD_CODE =
  "This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.";
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';
const UNREACHABLE = "Couldn't reach Kasa Home. Check the computer is on and try again.";

const answer = (status: number, error: string) =>
  new Response(JSON.stringify({ error, message: 'x' }), { status });

it('sends the code from the hash, clears the hash first, and hands over to the app', async () => {
  const replace = vi.spyOn(window.history, 'replaceState');
  const onPaired = vi.fn();
  fetchMock.mockImplementation(() => {
    // The hash is gone by the time the request goes out.
    expect(window.location.hash).toBe('');
    return Promise.resolve(new Response('{"ok":true}'));
  });
  render(<Pair onPaired={onPaired} />);
  expect(screen.getByText('Setting up this phone...')).toBeTruthy();
  await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe('/');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0]!;
  expect(path).toBe('/api/remote/pair');
  expect(JSON.parse(String(init?.body))).toEqual({ code: 'c'.repeat(22) });
  expect(replace).toHaveBeenCalled();
});

it('blames the code only when the server refused the code', async () => {
  fetchMock.mockResolvedValue(answer(401, 'bad-code'));
  render(<Pair onPaired={() => undefined} />);
  expect(await screen.findByText(BAD_CODE)).toBeTruthy();
});

it('asks to wait after too many tries', async () => {
  fetchMock.mockResolvedValue(answer(429, 'rate_limited'));
  render(<Pair onPaired={() => undefined} />);
  expect(await screen.findByText(TOO_MANY)).toBeTruthy();
  expect(screen.queryByText(BAD_CODE)).toBeNull();
});

it('says Kasa Home could not be reached when the server is starting', async () => {
  fetchMock.mockResolvedValue(answer(503, 'remote-starting'));
  render(<Pair onPaired={() => undefined} />);
  expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
});

it('says Kasa Home could not be reached when the network fails', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<Pair onPaired={() => undefined} />);
  expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
});

it('fails without calling the server when there is no code', async () => {
  window.history.replaceState(null, '', '/pair');
  render(<Pair onPaired={() => undefined} />);
  expect(await screen.findByText(BAD_CODE)).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});
