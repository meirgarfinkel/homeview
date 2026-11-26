import { describe, expect, it, vi } from 'vitest';
import { retryFetch } from '../src/retryFetch.js';

describe('retryFetch', () => {
  it('tries again once after a dropped connection', async () => {
    const ok = new Response('fine');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok);
    await expect(retryFetch('http://127.0.0.1:1/api/health', fetchImpl)).resolves.toBe(ok);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second try', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(retryFetch('http://127.0.0.1:1/api/health', fetchImpl)).rejects.toThrow(
      'fetch failed',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
