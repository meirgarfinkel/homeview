import { describe, expect, it } from 'vitest';
import { pickProfile, rewriteStreamHost } from '../../src/onvif/pickProfile.js';
import type { OnvifProfile } from '../../src/onvif/device.js';

const p = (
  token: string,
  codec: OnvifProfile['codec'],
  width: number,
  height: number,
): OnvifProfile => ({
  token,
  name: token,
  codec,
  width,
  height,
  hasPtz: false,
});

describe('pickProfile', () => {
  it('main 1080p H.265 is kept', () => {
    expect(pickProfile([p('main', 'h265', 1920, 1080), p('sub', 'h264', 640, 360)])?.token).toBe(
      'main',
    );
  });

  it('main 4K, sub 640x360 H.264 and 1080p H.265 → 1080p', () => {
    expect(
      pickProfile([
        p('main', 'h265', 3840, 2160),
        p('sub', 'h264', 640, 360),
        p('mid', 'h265', 1920, 1080),
      ])?.token,
    ).toBe('mid');
  });

  it('two 1080p, H.264 preferred', () => {
    expect(
      pickProfile([
        p('a', 'h264', 3840, 2160),
        p('b', 'h265', 1920, 1080),
        p('c', 'h264', 1920, 1080),
      ])?.token,
    ).toBe('c');
  });

  it('only 4K and 5MP → the smaller one', () => {
    expect(pickProfile([p('a', 'h265', 3840, 2160), p('b', 'h265', 2560, 1920)])?.token).toBe('b');
  });

  it('only MJPEG → undefined', () => {
    expect(pickProfile([p('a', 'other', 640, 480)])).toBeUndefined();
  });

  it('skips an unplayable main profile', () => {
    expect(pickProfile([p('a', 'other', 1280, 720), p('b', 'h264', 640, 360)])?.token).toBe('b');
  });
});

describe('rewriteStreamHost', () => {
  it('keeps port and path, replaces the host, drops credentials', () => {
    expect(rewriteStreamHost('rtsp://u:p@192.168.1.250:8554/live?ch=1', '192.0.2.5')).toBe(
      'rtsp://192.0.2.5:8554/live?ch=1',
    );
  });

  it('defaults the port to 554', () => {
    expect(rewriteStreamHost('rtsp://cam.local/stream', '192.168.1.9')).toBe(
      'rtsp://192.168.1.9:554/stream',
    );
  });

  it('refuses a non-RTSP address', () => {
    expect(() => rewriteStreamHost('http://192.168.1.250/x', '192.0.2.5')).toThrow();
  });
});
