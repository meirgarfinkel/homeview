/**
 * RTP payloads back into media: H.264 (RFC 6184), H.265 (RFC 7798), AAC-hbr
 * (RFC 3640) and G.711 (RFC 3551).
 */
import type { VideoCodec } from '../camera/driver.js';
import { aacConfigFromFmtp, type AacConfig, type SdpMedia } from './sdp.js';

export interface RtpPacket {
  payloadType: number;
  sequence: number;
  timestamp: number;
  marker: boolean;
  payload: Buffer;
}

/** One output unit with its RTP timestamp. */
export interface Depacketized {
  data: Buffer;
  rtpTime: number;
}

/** Access units bigger than this are dropped. */
export const MAX_ACCESS_UNIT_BYTES = 4 * 1024 * 1024;

export function parseRtp(buf: Buffer): RtpPacket {
  if (buf.length < 12 || buf[0]! >> 6 !== 2) throw new Error('Not an RTP version 2 packet');
  const csrcs = buf[0]! & 0x0f;
  let offset = 12 + csrcs * 4;
  if (buf[0]! & 0x10) {
    if (offset + 4 > buf.length) throw new Error('RTP: truncated header extension');
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (buf[0]! & 0x20) end -= buf[buf.length - 1]!;
  if (offset > end) throw new Error('RTP: truncated packet');
  return {
    payloadType: buf[1]! & 0x7f,
    marker: (buf[1]! & 0x80) !== 0,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    payload: buf.subarray(offset, end),
  };
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** Rebuilds Annex-B access units from video RTP packets. */
export class VideoDepacketizer {
  private nals: Buffer[] = [];
  private bytes = 0;
  private fragment: Buffer[] | undefined;
  private rtpTime: number | undefined;
  private broken = false;
  private tooBig = false;
  private warnedTooBig = false;
  private lastSequence: number | undefined;

  constructor(
    private readonly codec: VideoCodec,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  push(p: RtpPacket): Depacketized[] {
    const out: Depacketized[] = [];
    if (this.rtpTime !== undefined && p.timestamp !== this.rtpTime) {
      // A new picture began without the marker on the last one.
      this.finish(out);
    }
    if (this.lastSequence !== undefined && p.sequence !== ((this.lastSequence + 1) & 0xffff)) {
      this.broken = true;
      this.fragment = undefined;
    }
    this.lastSequence = p.sequence;
    this.rtpTime = p.timestamp;
    try {
      if (this.codec === 'h264') this.h264(p.payload);
      else this.h265(p.payload);
    } catch {
      this.broken = true;
    }
    if (p.marker) this.finish(out);
    return out;
  }

  private add(nal: Buffer): void {
    if (nal.length === 0) return;
    this.bytes += nal.length + 4;
    if (this.bytes > MAX_ACCESS_UNIT_BYTES) {
      this.tooBig = true;
      return;
    }
    this.nals.push(nal);
  }

  private h264(payload: Buffer): void {
    const type = payload[0]! & 0x1f;
    if (type >= 1 && type <= 23) return this.add(payload);
    if (type === 24) return this.aggregate(payload, 1);
    if (type === 28) {
      const header = payload[1]!;
      const nalHeader = (payload[0]! & 0xe0) | (header & 0x1f);
      return this.fragmentPart(header, Buffer.from([nalHeader]), payload.subarray(2));
    }
    // STAP-B, MTAP, FU-B: not used by cameras in packetization-mode 1.
  }

  private h265(payload: Buffer): void {
    const type = (payload[0]! >> 1) & 0x3f;
    if (type < 48) return this.add(payload);
    if (type === 48) return this.aggregate(payload, 2);
    if (type === 49) {
      const header = payload[2]!;
      const nalHeader = Buffer.from([(payload[0]! & 0x81) | ((header & 0x3f) << 1), payload[1]!]);
      return this.fragmentPart(header, nalHeader, payload.subarray(3));
    }
    // PACI (50) is not used by cameras.
  }

  private aggregate(payload: Buffer, headerLength: number): void {
    for (let at = headerLength; at + 2 <= payload.length;) {
      const size = payload.readUInt16BE(at);
      at += 2;
      if (at + size > payload.length) throw new Error('aggregation packet overrun');
      this.add(payload.subarray(at, at + size));
      at += size;
    }
  }

  private fragmentPart(header: number, nalHeader: Buffer, data: Buffer): void {
    const start = (header & 0x80) !== 0;
    const end = (header & 0x40) !== 0;
    if (start) this.fragment = [nalHeader];
    if (!this.fragment) return; // lost the start
    this.fragment.push(data);
    if (end) {
      this.add(Buffer.concat(this.fragment));
      this.fragment = undefined;
    }
  }

  private finish(out: Depacketized[]): void {
    const rtpTime = this.rtpTime;
    if (this.tooBig && !this.warnedTooBig) {
      this.warnedTooBig = true;
      this.warn(`Dropped a video frame over ${MAX_ACCESS_UNIT_BYTES / 1024 / 1024} MiB`);
    }
    if (!this.broken && !this.tooBig && this.nals.length > 0 && rtpTime !== undefined) {
      out.push({ data: Buffer.concat(this.nals.flatMap((n) => [START_CODE, n])), rtpTime });
    }
    this.nals = [];
    this.bytes = 0;
    this.fragment = undefined;
    this.broken = false;
    this.tooBig = false;
    this.rtpTime = undefined;
  }
}

/** Splits audio RTP packets into encoded frames. */
export class AudioDepacketizer {
  private readonly aac: AacConfig | undefined;

  constructor(private readonly media: SdpMedia) {
    this.aac = media.encoding === 'MPEG4-GENERIC' ? aacConfigFromFmtp(media) : undefined;
  }

  push(p: RtpPacket): Depacketized[] {
    if (!this.aac) return p.payload.length > 0 ? [{ data: p.payload, rtpTime: p.timestamp }] : [];
    return this.aacFrames(p, this.aac);
  }

  private aacFrames(p: RtpPacket, cfg: AacConfig): Depacketized[] {
    const { payload } = p;
    if (payload.length < 2) return [];
    const headerBits = payload.readUInt16BE(0);
    const headerBytes = Math.ceil(headerBits / 8);
    const auHeaderBits = cfg.sizeLength + cfg.indexLength;
    if (auHeaderBits === 0 || 2 + headerBytes > payload.length) return [];
    const count = Math.floor(headerBits / auHeaderBits);
    const sizes: number[] = [];
    let bit = 16;
    const readBits = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v = v * 2 + ((payload[bit >> 3]! >> (7 - (bit & 7))) & 1);
      return v;
    };
    for (let i = 0; i < count; i++) {
      sizes.push(readBits(cfg.sizeLength));
      readBits(i === 0 ? cfg.indexLength : cfg.indexDeltaLength);
    }
    const out: Depacketized[] = [];
    let at = 2 + headerBytes;
    sizes.forEach((size, i) => {
      if (at + size > payload.length) return;
      out.push({ data: payload.subarray(at, at + size), rtpTime: (p.timestamp + i * 1024) >>> 0 });
      at += size;
    });
    return out;
  }
}
