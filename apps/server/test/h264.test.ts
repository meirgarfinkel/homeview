import { describe, expect, it } from 'vitest';
import { accessUnits } from '../src/dev/fakeCamera.js';
import { NalType, nalType, parseSps, splitAnnexB, toAvcc, toRbsp } from '../src/media/h264.js';
import { fixture } from './helpers.js';

function firstSps(file: string) {
  const sps = splitAnnexB(fixture(file)).find((n) => nalType(n) === NalType.Sps);
  if (!sps) throw new Error('no SPS in fixture');
  return sps;
}

describe('splitAnnexB', () => {
  it('handles 3- and 4-byte start codes', () => {
    const buf = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4]);
    expect(splitAnnexB(buf).map((n) => [...n])).toEqual([
      [0x67, 1, 2],
      [0x68, 3],
      [0x65, 4],
    ]);
  });

  it('treats a buffer without start codes as one NAL', () => {
    expect(splitAnnexB(Buffer.from([0x65, 1, 2])).length).toBe(1);
  });

  it('finds SPS, PPS and IDR in the fixture', () => {
    const types = new Set(splitAnnexB(fixture('stream-320x180.h264')).map(nalType));
    expect(types).toContain(NalType.Sps);
    expect(types).toContain(NalType.Pps);
    expect(types).toContain(NalType.IdrSlice);
  });
});

describe('parseSps', () => {
  it('reads a main-profile 320x180 stream', () => {
    const info = parseSps(firstSps('stream-320x180.h264'));
    expect(info).toMatchObject({ width: 320, height: 180, profileIdc: 77 });
    expect(info.codec).toMatch(/^avc1\.4d[0-9a-f]{4}$/);
  });

  it('applies cropping for 1080p (coded as 1088 lines)', () => {
    const info = parseSps(firstSps('frame-1920x1080.h264'));
    expect(info).toMatchObject({ width: 1920, height: 1080, profileIdc: 100 });
  });

  it('rejects non-SPS input', () => {
    expect(() => parseSps(Buffer.from([0x65, 0, 0, 0]))).toThrow();
  });
});

describe('helpers', () => {
  it('toRbsp removes emulation prevention bytes', () => {
    expect([...toRbsp(Buffer.from([1, 0, 0, 3, 1, 0, 0, 3]))]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('toAvcc length-prefixes each NAL', () => {
    expect([...toAvcc([Buffer.from([9, 9]), Buffer.from([7])])]).toEqual([
      0, 0, 0, 2, 9, 9, 0, 0, 0, 1, 7,
    ]);
  });

  it('accessUnits splits the fixture into 30 frames (2 s at 15 fps)', () => {
    expect(accessUnits(fixture('stream-320x180.h264'))).toHaveLength(30);
  });
});
