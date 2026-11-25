import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { accessUnits } from '../src/dev/fakeCamera.js';
import { initSegment, mediaFragment, VIDEO_TIMESCALE } from '../src/media/fmp4.js';
import { NalType, nalType, parseSps, splitAnnexB, toAvcc } from '../src/media/h264.js';
import { boxes, fixture } from './helpers.js';

const run = promisify(execFile);

function buildMp4(): { mp4: Buffer; frames: number } {
  const units = accessUnits(fixture('stream-320x180.h264'));
  const nals = splitAnnexB(units[0]!);
  const sps = nals.find((n) => nalType(n) === NalType.Sps)!;
  const pps = nals.find((n) => nalType(n) === NalType.Pps)!;
  const info = parseSps(sps);
  const parts = [initSegment({ width: info.width, height: info.height, sps: [sps], pps: [pps] })];
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
});
