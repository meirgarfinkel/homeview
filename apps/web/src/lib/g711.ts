/** G.711 mu-law -> float32 [-1, 1], per ITU-T G.711. */
export const MULAW_TO_FLOAT = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    table[i] = ((u & 0x80 ? -magnitude : magnitude) / 32768) as number;
  }
  return table;
})();

export function decodeMulaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TO_FLOAT[bytes[i]!]!;
  return out;
}

/** Root-mean-square of a block of samples. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** Map RMS to 0..1 on a -60 dBFS..0 dBFS scale, which suits a level meter. */
export function levelFromRms(value: number): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}
