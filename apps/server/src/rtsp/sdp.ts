/** Just enough SDP (RFC 4566) to set up an RTSP camera stream. */

export interface SdpMedia {
  type: 'video' | 'audio' | (string & {});
  payloadType: number;
  /** Upper-case encoding name, e.g. H264, H265, MPEG4-GENERIC, PCMU, PCMA. */
  encoding: string;
  clockRate: number;
  channels: number;
  /** Absolute URL for SETUP. */
  control: string;
  /** fmtp parameters for this payload type, keys lower-cased. */
  fmtp: Record<string, string>;
}

/** RFC 3551 static payload types the cameras use without an rtpmap line. */
const STATIC: Record<number, { encoding: string; clockRate: number }> = {
  0: { encoding: 'PCMU', clockRate: 8000 },
  8: { encoding: 'PCMA', clockRate: 8000 },
};

/** Resolve a control attribute against a base URL (RFC 2326 C.1.1). */
function resolveControl(control: string | undefined, base: string): string {
  if (!control || control === '*') return base;
  if (/^rtsps?:\/\//i.test(control)) return control;
  return base.endsWith('/') ? base + control : `${base}/${control}`;
}

/**
 * Parse an SDP answer. `baseUrl` is the Content-Base (or the DESCRIBE URL).
 * Only the first payload type of each media line is used.
 */
export function parseSdp(text: string, baseUrl: string): SdpMedia[] {
  let base = baseUrl;
  const media: (Omit<SdpMedia, 'control'> & { rawControl?: string })[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const [type = '', , , pt] = line.slice(2).split(/\s+/);
      const payloadType = Number(pt);
      const known = STATIC[payloadType];
      media.push({
        type,
        payloadType,
        encoding: known?.encoding ?? '',
        clockRate: known?.clockRate ?? 0,
        channels: 1,
        fmtp: {},
      });
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const current = media.at(-1);
    const attr = line.slice(2);
    const colon = attr.indexOf(':');
    const name = colon < 0 ? attr : attr.slice(0, colon);
    const value = colon < 0 ? '' : attr.slice(colon + 1);
    if (name === 'control') {
      if (current) current.rawControl = value.trim();
      else if (/^rtsps?:\/\//i.test(value.trim())) base = value.trim();
    } else if (name === 'rtpmap' && current) {
      const m = /^(\d+)\s+([^/\s]+)\/(\d+)(?:\/(\d+))?/.exec(value);
      if (m && Number(m[1]) === current.payloadType) {
        current.encoding = m[2]!.toUpperCase();
        current.clockRate = Number(m[3]);
        current.channels = m[4] ? Number(m[4]) : 1;
      }
    } else if (name === 'fmtp' && current) {
      const space = value.indexOf(' ');
      if (Number(value.slice(0, space)) !== current.payloadType) continue;
      for (const part of value.slice(space + 1).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        current.fmtp[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
      }
    }
  }
  return media.map(({ rawControl, ...m }) => ({ ...m, control: resolveControl(rawControl, base) }));
}

const fromBase64List = (value: string | undefined): Buffer[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Buffer.from(s, 'base64'))
    .filter((b) => b.length > 0);

/** H.264 sprop-parameter-sets, or H.265 sprop-vps, -sps, -pps, in that order. */
export function parameterSetsFromFmtp(media: SdpMedia): Buffer[] {
  if (media.encoding === 'H264') return fromBase64List(media.fmtp['sprop-parameter-sets']);
  if (media.encoding === 'H265') {
    return ['sprop-vps', 'sprop-sps', 'sprop-pps'].flatMap((k) => fromBase64List(media.fmtp[k]));
  }
  return [];
}

export interface AacConfig {
  config: Buffer;
  sampleRate: number;
  channels: number;
  sizeLength: number;
  indexLength: number;
  indexDeltaLength: number;
}

/** The AAC settings from an MPEG4-GENERIC fmtp line (RFC 3640). */
export function aacConfigFromFmtp(media: SdpMedia): AacConfig {
  const f = media.fmtp;
  const hex = f['config'] ?? '';
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('AAC: missing or bad config in the SDP');
  return {
    config: Buffer.from(hex, 'hex'),
    sampleRate: media.clockRate,
    channels: media.channels,
    sizeLength: Number(f['sizelength'] ?? 13),
    indexLength: Number(f['indexlength'] ?? 3),
    indexDeltaLength: Number(f['indexdeltalength'] ?? 3),
  };
}
