import { describe, expect, it } from 'vitest';
import { splitAnnexB } from '../src/media/h264.js';
import {
  h265AccessUnits,
  H265NalType,
  h265NalType,
  isH265Keyframe,
  parseH265Sps,
} from '../src/media/h265.js';
import { fixture } from './helpers.js';

const units = h265AccessUnits(fixture('clip-320x180.h265'));

describe('H.265 helpers', () => {
  it('splits the clip into one access unit per frame', () => {
    expect(units).toHaveLength(30); // 2 s at 15 fps
  });

  it('finds VPS, SPS, PPS and an IRAP in the first access unit', () => {
    const nals = splitAnnexB(units[0]!);
    const types = nals.map(h265NalType);
    expect(types).toEqual(
      expect.arrayContaining([H265NalType.VPS, H265NalType.SPS, H265NalType.PPS]),
    );
    expect(isH265Keyframe(nals)).toBe(true);
    expect(isH265Keyframe(splitAnnexB(units[1]!))).toBe(false);
  });

  it('parses the SPS of the 320x180 clip', () => {
    const sps = splitAnnexB(units[0]!).find((n) => h265NalType(n) === H265NalType.SPS)!;
    const info = parseH265Sps(sps);
    expect(info).toMatchObject({ width: 320, height: 180 });
    expect(info.codec).toMatch(/^hvc1\.1\.6\.L\d+(\.[0-9A-F]{1,2})+$/);
  });

  it('parses a 1920x1080 SPS with conformance cropping to 1080, not 1088', () => {
    const sps = splitAnnexB(fixture('frame-1920x1080.h265')).find(
      (n) => h265NalType(n) === H265NalType.SPS,
    )!;
    expect(parseH265Sps(sps)).toMatchObject({ width: 1920, height: 1080 });
  });

  it('rejects a NAL unit that is not an SPS', () => {
    const pps = splitAnnexB(units[0]!).find((n) => h265NalType(n) === H265NalType.PPS)!;
    expect(() => parseH265Sps(pps)).toThrow(/SPS/);
  });
});
