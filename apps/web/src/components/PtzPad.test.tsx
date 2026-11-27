import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { PtzPad } from './PtzPad';

vi.mock('../lib/api', () => ({
  api: {
    presets: vi.fn(() => Promise.resolve([])),
    ptzMove: vi.fn(() => Promise.resolve()),
    ptzStop: vi.fn(() => Promise.resolve()),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.ptzMove).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const up = () => screen.getByRole('button', { name: 'Pan up' });

it('steps at once for a mouse press', () => {
  render(<PtzPad onError={() => undefined} />);
  fireEvent.pointerDown(up(), { pointerType: 'mouse', pointerId: 1 });
  expect(api.ptzMove).toHaveBeenCalledWith('up', 'step');
});

it('steps for a quick tap', () => {
  render(<PtzPad onError={() => undefined} />);
  fireEvent.pointerDown(up(), { pointerType: 'touch', pointerId: 1 });
  expect(api.ptzMove).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60);
  fireEvent.pointerUp(up(), { pointerType: 'touch', pointerId: 1 });
  expect(api.ptzMove).toHaveBeenCalledWith('up', 'step');
});

it('steps once a held touch passes the delay', () => {
  render(<PtzPad onError={() => undefined} />);
  fireEvent.pointerDown(up(), { pointerType: 'touch', pointerId: 1 });
  vi.advanceTimersByTime(150);
  expect(api.ptzMove).toHaveBeenCalledWith('up', 'step');
});

it('does not move when the touch turns into a scroll', () => {
  render(<PtzPad onError={() => undefined} />);
  fireEvent.pointerDown(up(), { pointerType: 'touch', pointerId: 1 });
  vi.advanceTimersByTime(60);
  fireEvent.pointerCancel(up(), { pointerType: 'touch', pointerId: 1 });
  vi.advanceTimersByTime(1000);
  expect(api.ptzMove).not.toHaveBeenCalled();
});
