import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveStream } from '../hooks/useLiveStream';
import { api } from '../lib/api';
import { Monitor } from './Monitor';

let live: LiveStream;

vi.mock('../hooks/useLiveStream', () => ({ useLiveStream: () => live }));
vi.mock('../lib/api', () => ({
  api: {
    status: vi.fn(() => new Promise(() => undefined)),
    camera: vi.fn(() => new Promise(() => undefined)),
    presets: vi.fn(() => new Promise(() => undefined)),
  },
}));

beforeEach(() => {
  live = {
    connection: 'open',
    stream: 'live',
    detail: undefined,
    codec: undefined,
    playerError: undefined,
    soundUnsupported: false,
    listening: false,
    startListening: vi.fn(async () => undefined),
    stopListening: vi.fn(),
    volume: 1,
    setVolume: vi.fn(),
    levelRef: { current: 0 },
  };
});

afterEach(cleanup);

it("says when the camera's sound can't be played", () => {
  live.soundUnsupported = true;
  render(<Monitor />);
  expect(screen.getByText("This camera's sound format isn't supported yet.")).toBeTruthy();
});

it('shows no sound message for a playable format', () => {
  render(<Monitor />);
  expect(screen.queryByText("This camera's sound format isn't supported yet.")).toBeNull();
});

it('turns sound on from the Sound panel, with no button over the video', () => {
  render(<Monitor />);
  expect(screen.queryByText('Tap to listen')).toBeNull();
  expect(screen.getByRole('button', { name: 'Listen' })).toBeTruthy();
});

it('shows the HomeView icon beside the camera name', () => {
  const { container } = render(<Monitor />);
  const logo = container.querySelector('.topbar img.logo');
  expect(logo?.getAttribute('src')).toBe('/favicon.svg');
  expect(container.querySelector('.moon')).toBeNull();
});

it('keeps the stream numbers off the video', async () => {
  vi.mocked(api.status).mockResolvedValueOnce({
    stream: { state: 'live', viewers: 1, width: 1280, height: 720, fps: 15, kbps: 42 },
    ptz: 'unsupported',
  });
  const { container } = render(<Monitor />);
  await vi.waitFor(() => expect(api.status).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(container.querySelector('.stage-meta')).toBeNull();
  expect(screen.queryByText(/kb\/s/)).toBeNull();
});

it('has no View card and puts Snapshot in the top bar', () => {
  const { container } = render(<Monitor />);
  expect(screen.queryByRole('heading', { name: 'View' })).toBeNull();
  const top = container.querySelector('.topbar') as HTMLElement;
  expect(within(top).getByRole('button', { name: 'Snapshot' })).toBeTruthy();
});

it('goes fullscreen when the video is tapped', () => {
  const requestFullscreen = vi.fn(() => Promise.resolve());
  HTMLElement.prototype.requestFullscreen = requestFullscreen;
  const { container } = render(<Monitor />);
  fireEvent.click(container.querySelector('.stage')!);
  expect(requestFullscreen).toHaveBeenCalledOnce();
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
});

it("uses the iPhone's video fullscreen when a box can't go fullscreen", () => {
  const enter = vi.fn();
  (
    HTMLVideoElement.prototype as unknown as { webkitEnterFullscreen: () => void }
  ).webkitEnterFullscreen = enter;
  const { container } = render(<Monitor />);
  fireEvent.click(container.querySelector('.stage')!);
  expect(enter).toHaveBeenCalledOnce();
  delete (HTMLVideoElement.prototype as unknown as { webkitEnterFullscreen?: () => void })
    .webkitEnterFullscreen;
});

it('lets the keyboard reach fullscreen on the video', () => {
  const requestFullscreen = vi.fn(() => Promise.resolve());
  HTMLElement.prototype.requestFullscreen = requestFullscreen;
  render(<Monitor />);
  const stage = screen.getByRole('button', { name: 'Fullscreen' });
  expect(stage.tabIndex).toBe(0);
  fireEvent.keyDown(stage, { key: 'Enter' });
  fireEvent.keyDown(stage, { key: ' ' });
  expect(requestFullscreen).toHaveBeenCalledTimes(2);
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
});
