import { describe, expect, it } from 'vitest';
import {
  adtsFrames,
  packetizeAac,
  packetizeH264,
  packetizeH265,
  rtpPacket,
} from '../../src/dev/packetize.js';
import { accessUnits } from '../../src/dev/fakeCamera.js';
import { h265AccessUnits } from '../../src/media/h265.js';
import { AudioDepacketizer, parseRtp, VideoDepacketizer } from '../../src/rtsp/depacketize.js';
import type { SdpMedia } from '../../src/rtsp/sdp.js';
import { fixture } from '../helpers.js';

const FRAME_TICKS = 6000; // 90 kHz at 15 fps

/** Packetize every access unit, then feed every packet through one depacketizer. */
function roundTrip(
  units: Buffer[],
  packetize: typeof packetizeH264,
  depacketizer: VideoDepacketizer,
  drop?: (seq: number) => boolean,
) {
  let seq = 65530; // crosses the 16-bit wrap
  const out: { data: Buffer; rtpTime: number }[] = [];
  units.forEach((unit, i) => {
    for (const pkt of packetize(unit, { timestamp: i * FRAME_TICKS, sequence: seq, mtu: 1200 })) {
      const s = seq;
      seq = (seq + 1) & 0xffff;
      if (drop?.(s)) continue;
      out.push(...depacketizer.push(parseRtp(pkt)));
    }
  });
  return out;
}

describe('parseRtp', () => {
  it('reads the header fields', () => {
    const p = parseRtp(
      rtpPacket(
        { payloadType: 96, sequence: 7, timestamp: 1234, marker: true },
        Buffer.from([1, 2]),
      ),
    );
    expect(p).toMatchObject({ payloadType: 96, sequence: 7, timestamp: 1234, marker: true });
    expect([...p.payload]).toEqual([1, 2]);
  });

  it('a header extension and padding are skipped', () => {
    const base = rtpPacket(
      { payloadType: 96, sequence: 1, timestamp: 0, marker: false },
      Buffer.from([9, 9]),
    );
    const header = Buffer.from(base.subarray(0, 12));
    header[0] = header[0]! | 0x10 | 0x20 | 2; // extension, padding, 2 CSRCs
    const csrcs = Buffer.alloc(8);
    const extension = Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]);
    const padding = Buffer.from([0, 0, 3]);
    const p = parseRtp(Buffer.concat([header, csrcs, extension, Buffer.from([9, 9]), padding]));
    expect([...p.payload]).toEqual([9, 9]);
  });

  it('rejects a packet that is not RTP version 2', () => {
    expect(() => parseRtp(Buffer.alloc(12))).toThrow(/RTP/);
  });
});

describe('VideoDepacketizer', () => {
  const h264 = accessUnits(fixture('clip-320x180.h264'));
  const h265 = h265AccessUnits(fixture('clip-320x180.h265'));

  it('the clips hold one access unit per frame', () => {
    expect(h264).toHaveLength(30);
    expect(h265).toHaveLength(30);
  });

  it('round-trips every H.264 access unit', () => {
    const out = roundTrip(h264, packetizeH264, new VideoDepacketizer('h264'));
    expect(out).toHaveLength(h264.length);
    out.forEach((au, i) => {
      expect(au.data.equals(h264[i]!)).toBe(true);
      expect(au.rtpTime).toBe(i * FRAME_TICKS);
    });
  });

  it('round-trips every H.265 access unit', () => {
    const out = roundTrip(h265, packetizeH265, new VideoDepacketizer('h265'));
    expect(out).toHaveLength(h265.length);
    out.forEach((au, i) => expect(au.data.equals(h265[i]!)).toBe(true));
  });

  it('uses fragmentation and aggregation for these clips', () => {
    const kinds = new Set<number>();
    for (const unit of h264.slice(0, 2)) {
      for (const p of packetizeH264(unit, { timestamp: 0, sequence: 0, mtu: 1200 })) {
        kinds.add(parseRtp(p).payload[0]! & 0x1f);
      }
    }
    expect(kinds).toContain(24); // STAP-A
    expect(kinds).toContain(28); // FU-A
  });

  it('a lost packet drops only that access unit', () => {
    let firstSeqOfThird = -1;
    let seq = 65530;
    h264.forEach((unit, i) => {
      const n = packetizeH264(unit, { timestamp: 0, sequence: 0, mtu: 1200 }).length;
      if (i === 2) firstSeqOfThird = seq;
      seq = (seq + n) & 0xffff;
    });
    const out = roundTrip(
      h264,
      packetizeH264,
      new VideoDepacketizer('h264'),
      (s) => s === firstSeqOfThird,
    );
    expect(out).toHaveLength(h264.length - 1);
    expect(out.map((a) => a.rtpTime)).not.toContain(2 * FRAME_TICKS);
  });

  it('an access unit over 4 MiB is dropped', () => {
    const warnings: string[] = [];
    const d = new VideoDepacketizer('h264', (w) => warnings.push(w));
    const big = Buffer.alloc(1100, 0x41);
    big[0] = 0x41; // non-IDR slice
    const fu = (i: number, last: boolean) =>
      rtpPacket(
        { payloadType: 96, sequence: i, timestamp: 0, marker: last },
        Buffer.concat([Buffer.from([0x5c, (i === 0 ? 0x80 : 0) | (last ? 0x40 : 0) | 1]), big]),
      );
    const out = [];
    for (let i = 0; i < 4000; i++) out.push(...d.push(parseRtp(fu(i, i === 3999))));
    expect(out).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    // The next one goes through.
    const next = d.push(
      parseRtp(
        rtpPacket(
          { payloadType: 96, sequence: 4000, timestamp: 6000, marker: true },
          Buffer.from([0x41, 1, 2]),
        ),
      ),
    );
    expect(next).toHaveLength(1);
  });
});

describe('AudioDepacketizer', () => {
  const aacMedia: SdpMedia = {
    type: 'audio',
    payloadType: 97,
    encoding: 'MPEG4-GENERIC',
    clockRate: 16000,
    channels: 1,
    control: 'rtsp://192.0.2.1/a',
    fmtp: {
      mode: 'AAC-hbr',
      sizelength: '13',
      indexlength: '3',
      indexdeltalength: '3',
      config: '1408',
    },
  };

  it('splits AAC-hbr packets with several AUs', () => {
    const { frames } = adtsFrames(fixture('clip-16k.aac'));
    const d = new AudioDepacketizer(aacMedia);
    const out = packetizeAac(frames, { timestamp: 0, sequence: 0, perPacket: 3 }).flatMap((p) =>
      d.push(parseRtp(p)),
    );
    expect(out.map((f) => f.data)).toEqual(frames);
    expect(out[4]!.rtpTime).toBe(4 * 1024);
  });

  it('PCMA payload passes through', () => {
    const d = new AudioDepacketizer({
      ...aacMedia,
      payloadType: 8,
      encoding: 'PCMA',
      clockRate: 8000,
      fmtp: {},
    });
    const payload = fixture('clip-8k.alaw').subarray(0, 160);
    const out = d.push(
      parseRtp(rtpPacket({ payloadType: 8, sequence: 1, timestamp: 320, marker: false }, payload)),
    );
    expect(out).toEqual([{ data: payload, rtpTime: 320 }]);
  });
});
