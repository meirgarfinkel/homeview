/**
 * Minimal H.265 (HEVC) helpers: NAL types, access-unit splitting, and SPS
 * parsing for the picture size, the codec string and the hvcC box.
 */
import { BitReader, splitAnnexB, toRbsp } from './h264.js';

export const H265NalType = {
  VPS: 32,
  SPS: 33,
  PPS: 34,
  AUD: 35,
  PrefixSei: 39,
} as const;

const IRAP_FIRST = 16;
const IRAP_LAST = 21;
const SLICE_LAST = 31;

const START_CODE = Buffer.from([0, 0, 0, 1]);

export function h265NalType(nal: Uint8Array): number {
  return (nal[0]! >> 1) & 0x3f;
}

/** True when the access unit holds an IRAP picture (IDR, CRA or BLA). */
export function isH265Keyframe(nals: readonly Uint8Array[]): boolean {
  return nals.some((n) => {
    const t = h265NalType(n);
    return t >= IRAP_FIRST && t <= IRAP_LAST;
  });
}

/** True for the parameter sets and delimiters that don't go into a sample. */
export function isH265NonSample(nal: Uint8Array): boolean {
  const t = h265NalType(nal);
  return (
    t === H265NalType.VPS || t === H265NalType.SPS || t === H265NalType.PPS || t === H265NalType.AUD
  );
}

/**
 * Group an Annex-B H.265 stream into access units. A new one starts at a
 * delimiter, parameter set or prefix SEI after a slice, or at a slice that
 * begins a new picture (first_slice_segment_in_pic_flag).
 */
export function h265AccessUnits(annexB: Buffer): Buffer[] {
  const units: Buffer[][] = [];
  let hasSlice = false;
  for (const nal of splitAnnexB(annexB)) {
    if (nal.length < 2) continue;
    const t = h265NalType(nal);
    const isSlice = t <= SLICE_LAST;
    const firstSlice = isSlice && nal.length > 2 && (nal[2]! & 0x80) !== 0;
    const startsUnit =
      hasSlice &&
      (firstSlice ||
        t === H265NalType.AUD ||
        t === H265NalType.VPS ||
        t === H265NalType.SPS ||
        t === H265NalType.PPS ||
        t === H265NalType.PrefixSei);
    if (units.length === 0 || startsUnit) {
      units.push([]);
      hasSlice = false;
    }
    units[units.length - 1]!.push(nal);
    if (isSlice) hasSlice = true;
  }
  return units.map((nals) => Buffer.concat(nals.flatMap((n) => [START_CODE, n])));
}

export interface H265SpsInfo {
  width: number;
  height: number;
  /** RFC 6381 codec string, e.g. "hvc1.1.6.L93.B0". */
  codec: string;
  /** general_profile_space .. general_level_idc, the 12 bytes the hvcC box copies. */
  profileTierLevel: Buffer;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  maxSubLayers: number;
  temporalIdNesting: boolean;
}

const PTL_BYTES = 12;

/** Parse an SPS NAL unit (including its 2-byte NAL header). */
export function parseH265Sps(nal: Uint8Array): H265SpsInfo {
  if (nal.length < 16 || h265NalType(nal) !== H265NalType.SPS) {
    throw new Error('Not an H.265 SPS NAL unit');
  }
  const rbsp = toRbsp(nal.subarray(2));
  const r = new BitReader(rbsp);
  r.bits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  const temporalIdNesting = r.bit() === 1;
  const profileTierLevel = Buffer.from(rbsp.subarray(1, 1 + PTL_BYTES));
  r.bits(8 * PTL_BYTES);
  const subProfile: boolean[] = [];
  const subLevel: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.bit() === 1);
    subLevel.push(r.bit() === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.bits(88);
    if (subLevel[i]) r.bits(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  const separateColourPlane = chromaFormatIdc === 3 && r.bit() === 1;
  let width = r.ue();
  let height = r.ue();
  if (r.bit() === 1) {
    const chroma = separateColourPlane ? 0 : chromaFormatIdc;
    const subWidth = chroma === 1 || chroma === 2 ? 2 : 1;
    const subHeight = chroma === 1 ? 2 : 1;
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    width -= subWidth * (left + right);
    height -= subHeight * (top + bottom);
  }
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`H.265 SPS: implausible size ${width}x${height}`);
  }
  return {
    width,
    height,
    codec: codecString(profileTierLevel),
    profileTierLevel,
    chromaFormatIdc,
    bitDepthLuma,
    bitDepthChroma,
    maxSubLayers: maxSubLayersMinus1 + 1,
    temporalIdNesting,
  };
}

/** ISO/IEC 14496-15 Annex E codec string from the general profile_tier_level bytes. */
function codecString(ptl: Buffer): string {
  const space = ['', 'A', 'B', 'C'][ptl[0]! >> 6]!;
  const tier = (ptl[0]! >> 5) & 1 ? 'H' : 'L';
  const profile = ptl[0]! & 0x1f;
  const compat = ptl.readUInt32BE(1);
  let reversed = 0;
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i);
  const constraints = [...ptl.subarray(5, 11)];
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const parts = [
    'hvc1',
    `${space}${profile}`,
    (reversed >>> 0).toString(16).toUpperCase(),
    `${tier}${ptl[11]!}`,
    ...constraints.map((b) => b.toString(16).toUpperCase()),
  ];
  return parts.join('.');
}
