import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { accessUnits } from '../src/dev/fakeCamera.js';
import { initSegment, mediaFragment, VIDEO_TIMESCALE } from '../src/media/fmp4.js';
import { NalType, nalType, parseSps, splitAnnexB, toAvcc } from '../src/media/h264.js';
import {
  h265AccessUnits,
  H265NalType,
  h265NalType,
  isH265Keyframe,
  parseH265Sps,
} from '../src/media/h265.js';
import { boxes, fixture } from './helpers.js';

const run = promisify(execFile);

function buildMp4(): { mp4: Buffer; frames: number } {
  const units = accessUnits(fixture('stream-320x180.h264'));
  const nals = splitAnnexB(units[0]!);
  const sps = nals.find((n) => nalType(n) === NalType.Sps)!;
  const pps = nals.find((n) => nalType(n) === NalType.Pps)!;
  const info = parseSps(sps);
  const parts = [
    initSegment({ codec: 'h264', width: info.width, height: info.height, sps: [sps], pps: [pps] }),
  ];
  const duration = VIDEO_TIMESCALE / 15;
  units.forEach((unit, i) => {
    const sample = splitAnnexB(unit).filter((n) => ![7, 8, 9].includes(nalType(n)));
    parts.push(
      mediaFragment({
        sequence: i + 1,
        decodeTime: i * duration,
        duration,
        keyframe: sample.some((n) => nalType(n) === NalType.IdrSlice),
        data: toAvcc(sample),
      }),
    );
  });
  return { mp4: Buffer.concat(parts), frames: units.length };
}

const PARAMETER_SETS: number[] = [H265NalType.VPS, H265NalType.SPS, H265NalType.PPS];

function buildHevcMp4(): { mp4: Buffer; frames: number } {
  const units = h265AccessUnits(fixture('clip-320x180.h265'));
  const nals = splitAnnexB(units[0]!);
  const of = (t: number) => nals.filter((n) => h265NalType(n) === t);
  const sps = of(H265NalType.SPS);
  const info = parseH265Sps(sps[0]!);
  const parts = [
    initSegment({
      codec: 'h265',
      width: info.width,
      height: info.height,
      vps: of(H265NalType.VPS),
      sps,
      pps: of(H265NalType.PPS),
    }),
  ];
  const duration = VIDEO_TIMESCALE / 15;
  units.forEach((unit, i) => {
    const all = splitAnnexB(unit);
    const sample = all.filter((n) => !PARAMETER_SETS.includes(h265NalType(n)));
    parts.push(
      mediaFragment({
        sequence: i + 1,
        decodeTime: i * duration,
        duration,
        keyframe: isH265Keyframe(all),
        data: toAvcc(sample),
      }),
    );
  });
  return { mp4: Buffer.concat(parts), frames: units.length };
}

/** The payloads of every box named `type`, searched through nested boxes. */
function findBox(buf: Buffer, type: string): Buffer | undefined {
  const at = buf.indexOf(type, 0, 'latin1');
  if (at < 4) return undefined;
  const size = buf.readUInt32BE(at - 4);
  return buf.subarray(at + 4, at - 4 + size);
}

async function decodedFrames(mp4: Buffer): Promise<{ frames: number; stderr: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-fmp4-'));
  try {
    const file = path.join(dir, 'out.mp4');
    writeFileSync(file, mp4);
    const { stderr } = await run('ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-stats',
      '-i',
      file,
      '-f',
      'null',
      '-',
    ]);
    return { frames: Number(/frame=\s*(\d+)/.exec(stderr)?.[1]), stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = await hasFfmpeg();

describe('fMP4 muxer', () => {
  it('writes ftyp+moov then moof/mdat pairs', () => {
    const { mp4, frames } = buildMp4();
    const types = boxes(mp4).map((b) => b.type);
    expect(types.slice(0, 2)).toEqual(['ftyp', 'moov']);
    expect(types.filter((t) => t === 'moof')).toHaveLength(frames);
    expect(types.filter((t) => t === 'mdat')).toHaveLength(frames);
  });

  it('points trun data_offset at the mdat payload', () => {
    const fragment = mediaFragment({
      sequence: 1,
      decodeTime: 0,
      duration: 6000,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });
    const [moof, mdat] = boxes(fragment);
    expect(moof!.type).toBe('moof');
    expect(mdat!.type).toBe('mdat');
    const trun = fragment.indexOf('trun');
    const dataOffset = fragment.readUInt32BE(trun + 4 + 4 + 4);
    expect(dataOffset).toBe(mdat!.start + 8);
    expect(fragment.subarray(dataOffset)).toEqual(Buffer.from([0, 0, 0, 1, 0x65]));
  });

  it.runIf(ffmpegAvailable)('produces a file ffmpeg decodes frame-for-frame', async () => {
    const { mp4, frames } = buildMp4();
    const dir = mkdtempSync(path.join(tmpdir(), 'kasa-fmp4-'));
    try {
      const file = path.join(dir, 'out.mp4');
      writeFileSync(file, mp4);
      const { stderr } = await run('ffmpeg', [
        '-hide_banner',
        '-v',
        'error',
        '-stats',
        '-i',
        file,
        '-f',
        'null',
        '-',
      ]);
      const decoded = Number(/frame=\s*(\d+)/.exec(stderr)?.[1]);
      expect(decoded).toBe(frames);
      expect(stderr).not.toMatch(/error|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H.265 init segment has hvc1 and hvcC with all three parameter-set arrays', () => {
    const { mp4 } = buildHevcMp4();
    expect(mp4.indexOf('hvc1', 0, 'latin1')).toBeGreaterThan(0);
    expect(mp4.indexOf('avc1', 0, 'latin1')).toBe(-1);
    const hvcC = findBox(mp4, 'hvcC')!;
    expect(hvcC[0]).toBe(1); // configurationVersion
    let o = 22;
    const arrays = hvcC[o++]!;
    expect(arrays).toBe(3);
    const types: number[] = [];
    for (let a = 0; a < arrays; a++) {
      types.push(hvcC[o]! & 0x3f);
      const count = hvcC.readUInt16BE(o + 1);
      o += 3;
      for (let n = 0; n < count; n++) o += 2 + hvcC.readUInt16BE(o);
    }
    expect(types).toEqual([32, 33, 34]);
    expect(o).toBe(hvcC.length);
  });

  it.runIf(ffmpegAvailable)('produces an H.265 file ffmpeg decodes frame-for-frame', async () => {
    const { mp4, frames } = buildHevcMp4();
    const out = await decodedFrames(mp4);
    expect(out.frames).toBe(frames);
    expect(out.stderr).not.toMatch(/error|invalid/i);
  });
});
