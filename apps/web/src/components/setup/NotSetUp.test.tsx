import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotSetUp } from './NotSetUp';

const fetchMock = vi.fn<(path: string) => Promise<Response>>();
const session = (setupComplete: boolean) =>
  new Response(
    JSON.stringify({
      authRequired: true,
      authenticated: false,
      setupComplete,
      local: false,
      desktop: false,
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('checks every few seconds and moves on once setup is finished', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(session(false))
    .mockResolvedValue(session(true));
  const onSetUp = vi.fn();
  render(<NotSetUp onSetUp={onSetUp} />);
  expect(screen.getByText(/isn't set up yet/)).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(onSetUp).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(onSetUp).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(3);

  // Stops asking once it has moved on.
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
