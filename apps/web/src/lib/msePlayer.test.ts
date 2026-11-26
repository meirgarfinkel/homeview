import { afterEach, describe, expect, it, vi } from 'vitest';
import { MsePlayer, H265_UNSUPPORTED } from './msePlayer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MsePlayer.reset', () => {
  it("explains when the browser can't play H.265", () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: () => false });
    const player = new MsePlayer(document.createElement('video'));
    expect(() => player.reset('video/mp4; codecs="hvc1.1.6.L60.90"')).toThrow(H265_UNSUPPORTED);
    expect(H265_UNSUPPORTED).toBe(
      "This browser can't play this camera's video (H.265). Try another browser, or set the camera to H.264 in its own app.",
    );
  });

  it('keeps the general message for other formats', () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: () => false });
    const player = new MsePlayer(document.createElement('video'));
    expect(() => player.reset('video/mp4; codecs="avc1.640028"')).toThrow(/cannot play/);
  });
});
