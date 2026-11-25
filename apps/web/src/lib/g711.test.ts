import { describe, expect, it } from 'vitest';
import { decodeMulaw, levelFromRms, MULAW_TO_FLOAT, rms } from './g711';

describe('mu-law decoding', () => {
  it('decodes silence and full scale', () => {
    expect(MULAW_TO_FLOAT[0xff]).toBe(0);
    expect(Math.abs(MULAW_TO_FLOAT[0x7f]!)).toBe(0); // negative zero
    expect(MULAW_TO_FLOAT[0x00]).toBeCloseTo(-32124 / 32768, 5);
    expect(MULAW_TO_FLOAT[0x80]).toBeCloseTo(32124 / 32768, 5);
  });

  it('is monotonic within each sign half', () => {
    for (let i = 0x81; i < 0xff; i++) {
      expect(MULAW_TO_FLOAT[i]!).toBeLessThan(MULAW_TO_FLOAT[i - 1]!);
    }
  });

  it('decodes a buffer', () => {
    expect([...decodeMulaw(new Uint8Array([0xff, 0x80]))].map((v) => Math.round(v * 100))).toEqual([
      0, 98,
    ]);
  });
});

describe('levels', () => {
  it('computes RMS and maps it to a meter value', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(0.001)).toBe(0);
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.0316)).toBeCloseTo(0.5, 1);
  });
});
