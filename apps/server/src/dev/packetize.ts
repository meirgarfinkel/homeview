/**
 * RTP packetizers for the fake RTSP camera and the tests: the inverse of
 * rtsp/depacketize.ts. Not for production use.
 */
import { splitAnnexB } from '../media/h264.js';

export interface RtpHeader {
  payloadType: number;
  sequence: number;
  timestamp: number;
  marker: boolean;
  ssrc?: number;
}

export function rtpPacket(h: RtpHeader, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (h.marker ? 0x80 : 0) | (h.payloadType & 0x7f);
  header.writeUInt16BE(h.sequence & 0xffff, 2);
  header.writeUInt32BE(h.timestamp >>> 0, 4);
  header.writeUInt32BE(h.ssrc ?? 0x4b415341, 8);
  return Buffer.concat([header, payload]);
}

export interface PacketizeOptions {
  timestamp: number;
  sequence: number;
  mtu: number;
  payloadType?: number;
}

type Payloads = Buffer[];

/** Payloads for one access unit: aggregate small NALs, fragment big ones. */
function payloadsFor(
  nals: Buffer[],
  mtu: number,
  headerLength: number,
  aggregate: (group: Buffer[]) => Buffer,
  fragment: (nal: Buffer, mtu: number) => Buffer[],
): Payloads {
  const out: Payloads = [];
  let group: Buffer[] = [];
  let groupSize = headerLength;
  const flush = () => {
    if (group.length === 1) out.push(group[0]!);
    else if (group.length > 1) out.push(aggregate(group));
    group = [];
    groupSize = headerLength;
  };
  for (const nal of nals) {
    if (nal.length > mtu) {
      flush();
      out.push(...fragment(nal, mtu));
    } else if (groupSize + 2 + nal.length > mtu) {
      flush();
      group.push(nal);
      groupSize += 2 + nal.length;
    } else {
      group.push(nal);
      groupSize += 2 + nal.length;
    }
  }
  flush();
  return out;
}

function toPackets(payloads: Payloads, o: PacketizeOptions, payloadType: number): Buffer[] {
  return payloads.map((p, i) =>
    rtpPacket(
      {
        payloadType: o.payloadType ?? payloadType,
        sequence: (o.sequence + i) & 0xffff,
        timestamp: o.timestamp,
        marker: i === payloads.length - 1,
      },
      p,
    ),
  );
}

const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};

/** RFC 6184: single NAL, STAP-A (24) and FU-A (28). */
export function packetizeH264(accessUnit: Buffer, o: PacketizeOptions): Buffer[] {
  const payloads = payloadsFor(
    splitAnnexB(accessUnit),
    o.mtu,
    1,
    (group) =>
      Buffer.concat([
        Buffer.from([(Math.max(...group.map((n) => n[0]! & 0x60)) & 0x60) | 24]),
        ...group.flatMap((n) => [u16(n.length), n]),
      ]),
    (nal, mtu) => {
      const out: Buffer[] = [];
      const indicator = (nal[0]! & 0xe0) | 28;
      const type = nal[0]! & 0x1f;
      for (let at = 1; at < nal.length; at += mtu - 2) {
        const end = Math.min(nal.length, at + mtu - 2);
        const flags = (at === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
        out.push(Buffer.concat([Buffer.from([indicator, flags | type]), nal.subarray(at, end)]));
      }
      return out;
    },
  );
  return toPackets(payloads, o, 96);
}

/** RFC 7798: single NAL, AP (48) and FU (49). */
export function packetizeH265(accessUnit: Buffer, o: PacketizeOptions): Buffer[] {
  const payloads = payloadsFor(
    splitAnnexB(accessUnit),
    o.mtu,
    2,
    (group) =>
      Buffer.concat([
        Buffer.from([(48 << 1) | (group[0]![0]! & 0x81), group[0]![1]!]),
        ...group.flatMap((n) => [u16(n.length), n]),
      ]),
    (nal, mtu) => {
      const out: Buffer[] = [];
      const header = Buffer.from([(49 << 1) | (nal[0]! & 0x81), nal[1]!]);
      const type = (nal[0]! >> 1) & 0x3f;
      for (let at = 2; at < nal.length; at += mtu - 3) {
        const end = Math.min(nal.length, at + mtu - 3);
        const flags = (at === 2 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
        out.push(Buffer.concat([header, Buffer.from([flags | type]), nal.subarray(at, end)]));
      }
      return out;
    },
  );
  return toPackets(payloads, o, 96);
}

/** RFC 3640 AAC-hbr: AU-headers of 13-bit size + 3-bit index, several AUs per packet. */
export function packetizeAac(
  frames: Buffer[],
  o: { timestamp: number; sequence: number; perPacket: number; payloadType?: number },
): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < frames.length; i += o.perPacket) {
    const group = frames.slice(i, i + o.perPacket);
    const headers = group.map((f) => u16(f.length << 3));
    out.push(
      rtpPacket(
        {
          payloadType: o.payloadType ?? 97,
          sequence: (o.sequence + out.length) & 0xffff,
          timestamp: o.timestamp + i * 1024,
          marker: true,
        },
        Buffer.concat([u16(group.length * 16), ...headers, ...group]),
      ),
    );
  }
  return out;
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Raw AAC frames and their AudioSpecificConfig, from an ADTS stream. */
export function adtsFrames(adts: Buffer): {
  config: Buffer;
  sampleRate: number;
  channels: number;
  frames: Buffer[];
} {
  const frames: Buffer[] = [];
  let config: Buffer | undefined;
  let sampleRate = 0;
  let channels = 0;
  for (let at = 0; at + 7 <= adts.length;) {
    if (adts[at] !== 0xff || (adts[at + 1]! & 0xf0) !== 0xf0) throw new Error('ADTS: lost sync');
    const protectionAbsent = adts[at + 1]! & 1;
    const objectType = (adts[at + 2]! >> 6) + 1;
    const rateIndex = (adts[at + 2]! >> 2) & 0x0f;
    channels = ((adts[at + 2]! & 1) << 2) | (adts[at + 3]! >> 6);
    const length = ((adts[at + 3]! & 3) << 11) | (adts[at + 4]! << 3) | (adts[at + 5]! >> 5);
    const header = protectionAbsent ? 7 : 9;
    sampleRate = AAC_RATES[rateIndex]!;
    config ??= u16((objectType << 11) | (rateIndex << 7) | (channels << 3));
    frames.push(adts.subarray(at + header, at + length));
    at += length;
  }
  if (!config) throw new Error('ADTS: no frames');
  return { config, sampleRate, channels, frames };
}
