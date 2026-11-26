import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoQuality } from './VideoQuality';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let cameraReply: () => Response;
let saveReply: () => Response;

const camera = (resolution?: string) => () =>
  json({
    kind: 'kasa',
    alias: 'nursery',
    model: 'KC410S(US)',
    firmware: '1',
    host: '192.0.2.10',
    ...(resolution ? { resolution } : {}),
  });

beforeEach(() => {
  cameraReply = camera('2560x1440');
  saveReply = () => new Response(null, { status: 204 });
  fetchMock.mockReset();
  fetchMock.mockImplementation((path) => {
    if (path === '/api/camera') return Promise.resolve(cameraReply());
    if (path === '/api/settings/stream-resolution') return Promise.resolve(saveReply());
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sentBodies = () =>
  fetchMock.mock.calls
    .filter(([p]) => p === '/api/settings/stream-resolution')
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

it('offers 2K when the camera reports 2560x1440', async () => {
  render(<VideoQuality saved={null} fromEnv={false} />);
  expect(await screen.findByRole('radio', { name: /2K/ })).toBeTruthy();
  expect((screen.getByRole('radio', { name: /Camera default/ }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(screen.getByText(/2560×1440/)).toBeTruthy();
});

it('leaves out 2K for a 1080p camera', async () => {
  cameraReply = camera('1080P');
  render(<VideoQuality saved={null} fromEnv={false} />);
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([p]) => p === '/api/camera')).toBe(true),
  );
  const names = (await screen.findAllByRole('radio')).map((r) => r.getAttribute('value'));
  expect(names).toEqual(['', '720P', '1080P']);
});

it('still offers the saved 2K when the camera info fails', async () => {
  cameraReply = () => json({ error: 'no-answer', message: 'No answer' }, 504);
  render(<VideoQuality saved="2304x1296" fromEnv={false} />);
  expect(((await screen.findByRole('radio', { name: /2K/ })) as HTMLInputElement).checked).toBe(
    true,
  );
});

it('saves a new choice', async () => {
  render(<VideoQuality saved={null} fromEnv={false} />);
  await userEvent.click(await screen.findByRole('radio', { name: /1080p/ }));
  expect(await screen.findByText('Saved. The picture changes in a few seconds.')).toBeTruthy();
  expect(sentBodies()).toEqual([{ resolution: '1080P' }]);
  expect((screen.getByRole('radio', { name: /1080p/ }) as HTMLInputElement).checked).toBe(true);
});

it('saves Camera default as null', async () => {
  render(<VideoQuality saved="720P" fromEnv={false} />);
  await userEvent.click(await screen.findByRole('radio', { name: /Camera default/ }));
  await screen.findByText('Saved. The picture changes in a few seconds.');
  expect(sentBodies()).toEqual([{ resolution: null }]);
});

it('goes back to the old choice when saving fails', async () => {
  saveReply = () => json({ error: 'nope', message: 'That did not work.' }, 500);
  render(<VideoQuality saved="720P" fromEnv={false} />);
  await userEvent.click(await screen.findByRole('radio', { name: /1080p/ }));
  expect((await screen.findByRole('alert')).textContent).toBe('That did not work.');
  expect((screen.getByRole('radio', { name: /720p/ }) as HTMLInputElement).checked).toBe(true);
});

it('is locked when .env sets it', async () => {
  render(<VideoQuality saved="720P" fromEnv />);
  const radios = await screen.findAllByRole('radio');
  for (const r of radios) expect(r.matches(':disabled')).toBe(true);
  expect((screen.getByRole('radio', { name: /720p/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Set in .env')).toBeTruthy();
});
