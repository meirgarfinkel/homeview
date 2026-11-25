/**
 * Minimal H.264 bitstream helpers: Annex-B splitting, AVCC conversion and SPS
 * parsing for the codec string and picture size.
 */

export const NalType = {
  NonIdrSlice: 1,
  IdrSlice: 5,
  Sei: 6,
  Sps: 7,
  Pps: 8,
  AccessUnitDelimiter: 9,
} as const;

export function nalType(nal: Uint8Array): number {
  return nal[0]! & 0x1f;
}

/** Split an Annex-B buffer (00 00 01 / 00 00 00 01 start codes) into NAL units. */
export function splitAnnexB(buf: Buffer): Buffer[] {
  const nals: Buffer[] = [];
  const n = buf.length;
  let start = -1;
  let i = 0;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        // Trailing zero belongs to a 4-byte start code of the next NAL.
        let end = i;
        while (end > start && buf[end - 1] === 0) end--;
        if (end > start) nals.push(buf.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nals.push(buf.subarray(start));
  // No start code at all: treat the whole buffer as one NAL.
  if (start < 0 && n > 0) nals.push(buf);
  return nals;
}

/** Join NAL units as 4-byte big-endian length-prefixed AVCC samples. */
export function toAvcc(nals: readonly Uint8Array[]): Buffer {
  const total = nals.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  for (const nal of nals) {
    out.writeUInt32BE(nal.length, o);
    out.set(nal, o + 4);
    o += 4 + nal.length;
  }
  return out;
}

/** Remove emulation-prevention bytes (00 00 03 -> 00 00). */
export function toRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS: unexpected end of data');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error('SPS: invalid Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** Signed Exp-Golomb. */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

export interface SpsInfo {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  width: number;
  height: number;
  /** RFC 6381 codec string, e.g. "avc1.640028". */
  codec: string;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      next = (last + r.se() + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

/** Parse an SPS NAL unit (including its 1-byte NAL header). */
export function parseSps(nal: Uint8Array): SpsInfo {
  if (nalType(nal) !== NalType.Sps || nal.length < 4) throw new Error('Not an SPS NAL unit');
  const r = new BitReader(toRbsp(nal.subarray(1)));
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit();
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const count = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < count; i++) {
        if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.bit(); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
  r.bit(); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.bit()) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
  const subWidthC = chromaArrayType === 3 ? 1 : 2;
  const subHeightC = chromaArrayType === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);

  const width = widthMbs * 16 - (cropLeft + cropRight) * cropUnitX;
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * cropUnitY;

  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    width,
    height,
    codec: `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`,
  };
}
