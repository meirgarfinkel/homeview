import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UpdateStatus } from '@kasa/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { UpdateBar } from './UpdateBar';

let status: UpdateStatus;
const update = vi.spyOn(api, 'update');
const installUpdate = vi.spyOn(api, 'installUpdate');

beforeEach(() => {
  vi.useFakeTimers();
  update.mockReset().mockImplementation(async () => status);
  installUpdate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Let the first request answer. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const TEN_MINUTES = 10 * 60 * 1000;

it('offers to restart into a downloaded update', async () => {
  status = { state: 'ready', version: '1.2.0' };
  render(<UpdateBar />);
  await settle();
  expect(screen.getByRole('status').textContent).toContain('HomeView 1.2.0 is ready.');
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
});

it('installs when Restart is pressed', async () => {
  status = { state: 'ready', version: '1.2.0' };
  render(<UpdateBar />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
  await settle();
  expect(installUpdate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toContain('Restarting…');
});

it('Later hides the bar until a newer version is ready', async () => {
  status = { state: 'ready', version: '1.2.0' };
  render(<UpdateBar />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('status')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES));
  expect(screen.queryByRole('status')).toBeNull();
  status = { state: 'ready', version: '1.3.0' };
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES));
  expect(screen.getByRole('status').textContent).toContain('HomeView 1.3.0 is ready.');
});

it('shows why an update failed, until dismissed', async () => {
  status = { state: 'error', message: 'The download stopped. Please try again.' };
  render(<UpdateBar />);
  await settle();
  expect(screen.getByRole('status').textContent).toContain(
    'The download stopped. Please try again.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows nothing while there is no update, or one is downloading', async () => {
  for (const s of [{ state: 'none' }, { state: 'downloading', version: '1.2.0' }] as const) {
    status = s;
    const { unmount } = render(<UpdateBar />);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
  }
});

it('asks again every ten minutes', async () => {
  status = { state: 'none' };
  render(<UpdateBar />);
  await settle();
  expect(update).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES));
  expect(update).toHaveBeenCalledTimes(2);
});
