import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Login } from './Login';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('offers the reset link on this computer only', () => {
  render(<Login local={false} onSuccess={() => undefined} />);
  expect(screen.queryByRole('button', { name: 'Forgot it? Set a new password' })).toBeNull();
  cleanup();
  render(<Login local onSuccess={() => undefined} />);
  expect(screen.getByRole('button', { name: 'Forgot it? Set a new password' })).toBeTruthy();
});

it('sets a new password, then signs in', async () => {
  const user = userEvent.setup();
  const onSuccess = vi.fn();
  render(<Login local onSuccess={onSuccess} />);
  await user.click(screen.getByRole('button', { name: 'Forgot it? Set a new password' }));
  await user.type(screen.getByLabelText('New password'), 'fresh-password');
  await user.type(screen.getByLabelText('New password again'), 'fresh-password');
  await user.click(screen.getByRole('button', { name: 'Save password' }));
  await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
  const call = fetchMock.mock.calls.find(([p]) => p === '/api/setup/reset-password')!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({ password: 'fresh-password' });
});

it('does not save when the two passwords differ or are short', async () => {
  const user = userEvent.setup();
  render(<Login local onSuccess={() => undefined} />);
  await user.click(screen.getByRole('button', { name: 'Forgot it? Set a new password' }));
  await user.type(screen.getByLabelText('New password'), 'fresh-password');
  await user.type(screen.getByLabelText('New password again'), 'fresh-passwor');
  expect(
    (screen.getByRole('button', { name: 'Save password' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText('The two passwords do not match.')).toBeTruthy();
});
