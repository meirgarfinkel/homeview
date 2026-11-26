import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reopenOnActivate, stopWithin } from '../src/lifecycle.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('reopenOnActivate', () => {
  it('opens the page when macOS activates the app again, but not for the launch itself', () => {
    const app = new EventEmitter();
    const open = vi.fn();
    const reopen = reopenOnActivate(app, open, 1000);
    // macOS activates the app as it launches, before and just after startup.
    app.emit('activate');
    reopen.started();
    app.emit('activate');
    expect(open).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    // Opened again from Finder or Launchpad.
    app.emit('activate');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('stopWithin', () => {
  it('gives up on a stop that hangs, so quitting still works', async () => {
    const logged = vi.fn();
    const done = vi.fn();
    void stopWithin(() => new Promise(() => {}), 5000, logged).then(done);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/5000 ms/) }),
    );
  });

  it('logs a stop that fails and carries on', async () => {
    const logged = vi.fn();
    await stopWithin(() => Promise.reject(new Error('boom')), 5000, logged);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('returns as soon as the stop finishes', async () => {
    const logged = vi.fn();
    await stopWithin(() => Promise.resolve(), 5000, logged);
    expect(logged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
