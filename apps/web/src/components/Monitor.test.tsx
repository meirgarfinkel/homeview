import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveStream } from '../hooks/useLiveStream';
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

it("says when the camera's sound can't be played, and hides the listen button", () => {
  live.soundUnsupported = true;
  render(<Monitor />);
  expect(screen.getByText("This camera's sound format isn't supported yet.")).toBeTruthy();
  expect(screen.queryByText('Tap to listen')).toBeNull();
});

it('shows no sound message for a playable format', () => {
  render(<Monitor />);
  expect(screen.queryByText("This camera's sound format isn't supported yet.")).toBeNull();
  expect(screen.getByText('Tap to listen')).toBeTruthy();
});
