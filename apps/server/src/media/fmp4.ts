/**
 * Just enough ISO-BMFF (fragmented MP4) writing to feed H.264 to the browser's
 * Media Source Extensions: one init segment, then one moof+mdat per frame.
 * Reference: ISO/IEC 14496-12 and 14496-15.
 */

export const VIDEO_TIMESCALE = 90_000;
const TRACK_ID = 1;

function u8(v: number): Buffer {
  return Buffer.from([v & 0xff]);
}
function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}
function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(v))));
  return b;
}
function zeros(n: number): Buffer {
  return Buffer.alloc(n);
}
/** version (8 bits) + flags (24 bits) */
function fullBoxHeader(version: number, flags: number): Buffer {
  return u32(((version & 0xff) << 24) | (flags & 0xffffff));
}

export function box(type: string, ...payload: Buffer[]): Buffer {
  const size = 8 + payload.reduce((s, p) => s + p.length, 0);
  return Buffer.concat([u32(size), Buffer.from(type, 'latin1'), ...payload]);
}

const UNITY_MATRIX = Buffer.concat(
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map((v) => u32(v)),
);

export interface VideoTrackConfig {
  width: number;
  height: number;
  sps: Buffer[];
  pps: Buffer[];
}

function avcC(cfg: VideoTrackConfig): Buffer {
  const first = cfg.sps[0];
  if (!first || first.length < 4) throw new Error('avcC: missing SPS');
  return box(
    'avcC',
    u8(1), // configurationVersion
    u8(first[1]!), // AVCProfileIndication
    u8(first[2]!), // profile_compatibility
    u8(first[3]!), // AVCLevelIndication
    u8(0xfc | 3), // reserved + lengthSizeMinusOne (4-byte lengths)
    u8(0xe0 | cfg.sps.length),
    ...cfg.sps.flatMap((s) => [u16(s.length), s]),
    u8(cfg.pps.length),
    ...cfg.pps.flatMap((p) => [u16(p.length), p]),
  );
}

function avc1(cfg: VideoTrackConfig): Buffer {
  return box(
    'avc1',
    zeros(6), // reserved
    u16(1), // data_reference_index
    zeros(16), // pre_defined + reserved
    u16(cfg.width),
    u16(cfg.height),
    u32(0x00480000), // 72 dpi
    u32(0x00480000),
    zeros(4),
    u16(1), // frame_count
    zeros(32), // compressorname
    u16(0x0018), // depth
    Buffer.from([0xff, 0xff]), // pre_defined = -1
    avcC(cfg),
  );
}

export function initSegment(cfg: VideoTrackConfig): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.from('isom', 'latin1'),
    u32(0x200),
    Buffer.from('isomiso6avc1mp41', 'latin1'),
  );

  const mvhd = box(
    'mvhd',
    fullBoxHeader(0, 0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1000), // timescale
    u32(0), // duration (unknown / live)
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10),
    UNITY_MATRIX,
    zeros(24),
    u32(TRACK_ID + 1), // next_track_ID
  );

  const tkhd = box(
    'tkhd',
    fullBoxHeader(0, 0x000003), // enabled + in_movie
    u32(0),
    u32(0),
    u32(TRACK_ID),
    zeros(4),
    u32(0), // duration
    zeros(8),
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (video)
    zeros(2),
    UNITY_MATRIX,
    u32(cfg.width << 16),
    u32(cfg.height << 16),
  );

  const mdhd = box(
    'mdhd',
    fullBoxHeader(0, 0),
    u32(0),
    u32(0),
    u32(VIDEO_TIMESCALE),
    u32(0),
    u16(0x55c4), // language "und"
    u16(0),
  );
  const hdlr = box(
    'hdlr',
    fullBoxHeader(0, 0),
    u32(0),
    Buffer.from('vide', 'latin1'),
    zeros(12),
    Buffer.from('VideoHandler\0', 'latin1'),
  );
  const vmhd = box('vmhd', fullBoxHeader(0, 1), zeros(8));
  const dinf = box(
    'dinf',
    box('dref', fullBoxHeader(0, 0), u32(1), box('url ', fullBoxHeader(0, 1))),
  );
  const stbl = box(
    'stbl',
    box('stsd', fullBoxHeader(0, 0), u32(1), avc1(cfg)),
    box('stts', fullBoxHeader(0, 0), u32(0)),
    box('stsc', fullBoxHeader(0, 0), u32(0)),
    box('stsz', fullBoxHeader(0, 0), u32(0), u32(0)),
    box('stco', fullBoxHeader(0, 0), u32(0)),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));
  const mvex = box(
    'mvex',
    box('trex', fullBoxHeader(0, 0), u32(TRACK_ID), u32(1), u32(0), u32(0), u32(0)),
  );
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/** sample_flags for a sync sample (keyframe) and a dependent sample. */
const SYNC_SAMPLE_FLAGS = 0x02000000;
const NON_SYNC_SAMPLE_FLAGS = 0x01010000;

export interface FragmentSample {
  /** Sequence number, starting at 1 and increasing per fragment. */
  sequence: number;
  /** Decode time in VIDEO_TIMESCALE units. */
  decodeTime: number;
  /** Duration in VIDEO_TIMESCALE units. */
  duration: number;
  keyframe: boolean;
  /** AVCC (length-prefixed) sample data. */
  data: Buffer;
}

export function mediaFragment(s: FragmentSample): Buffer {
  const mfhd = box('mfhd', fullBoxHeader(0, 0), u32(s.sequence));
  const tfhd = box('tfhd', fullBoxHeader(0, 0x020000), u32(TRACK_ID)); // default-base-is-moof
  const tfdt = box('tfdt', fullBoxHeader(1, 0), u64(s.decodeTime));
  // data-offset, sample-duration, sample-size, sample-flags present
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  const build = (dataOffset: number) =>
    box(
      'moof',
      mfhd,
      box(
        'traf',
        tfhd,
        tfdt,
        box(
          'trun',
          fullBoxHeader(0, trunFlags),
          u32(1),
          u32(dataOffset),
          u32(s.duration),
          u32(s.data.length),
          u32(s.keyframe ? SYNC_SAMPLE_FLAGS : NON_SYNC_SAMPLE_FLAGS),
        ),
      ),
    );
  const moofSize = build(0).length;
  const moof = build(moofSize + 8); // sample data starts right after the mdat header
  return Buffer.concat([moof, box('mdat', s.data)]);
}

export function mimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}
