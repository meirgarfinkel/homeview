import type { AudioFormat } from '@kasa/shared';
import { decodeAlaw, decodeMulaw } from './g711';

/** Turns the camera's sound frames into mono float samples for the player and the meter. */
export interface SoundDecoder {
  decode(frame: Uint8Array): void;
  close(): void;
}

/** How soon a decoder that failed may be rebuilt. */
const REBUILD_MS = 1000;

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * A decoder for this format, or undefined when this browser can't decode it
 * (AAC needs WebCodecs). onPcm gets mono samples at format.sampleRate.
 */
export async function createSoundDecoder(
  format: AudioFormat,
  onPcm: (pcm: Float32Array) => void,
): Promise<SoundDecoder | undefined> {
  if (format.codec === 'pcmu' || format.codec === 'pcma') {
    const decode = format.codec === 'pcmu' ? decodeMulaw : decodeAlaw;
    return { decode: (frame) => onPcm(decode(frame)), close: () => undefined };
  }
  return createAacDecoder(format, onPcm);
}

async function createAacDecoder(
  format: AudioFormat,
  onPcm: (pcm: Float32Array) => void,
): Promise<SoundDecoder | undefined> {
  if (typeof globalThis.AudioDecoder !== 'function' || !format.config) return undefined;
  const description = fromBase64(format.config);
  // The first five bits of the AudioSpecificConfig are the object type (2 = AAC-LC).
  const objectType = (description[0] ?? 0) >> 3;
  const config: AudioDecoderConfig = {
    codec: `mp4a.40.${objectType}`,
    sampleRate: format.sampleRate,
    numberOfChannels: format.channels,
    description,
  };
  try {
    const { supported } = await AudioDecoder.isConfigSupported(config);
    if (!supported) return undefined;
  } catch {
    return undefined;
  }

  const build = () => {
    const d = new AudioDecoder({
      output: (data) => {
        const frames = data.numberOfFrames;
        const mono = new Float32Array(frames);
        const plane = new Float32Array(frames);
        for (let c = 0; c < data.numberOfChannels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < frames; i++) mono[i]! += plane[i]! / data.numberOfChannels;
        }
        data.close();
        onPcm(mono);
      },
      // A frame the browser can't decode closes the decoder; decode() builds a new one.
      error: () => undefined,
    });
    d.configure(config);
    return d;
  };
  let decoder = build();
  let rebuiltAt = -Infinity;
  let closed = false;
  let timestampUs = 0;
  return {
    decode(frame) {
      if (closed) return;
      // Keep the sound meter and alert alive after a bad frame, without a rebuild loop.
      if (decoder.state === 'closed') {
        if (Date.now() - rebuiltAt < REBUILD_MS) return;
        rebuiltAt = Date.now();
        decoder = build();
      }
      if (decoder.state !== undefined && decoder.state !== 'configured') return;
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestampUs, data: frame }));
      timestampUs += Math.round((1024 / format.sampleRate) * 1e6);
    },
    close() {
      closed = true;
      if (decoder.state !== 'closed') decoder.close();
    },
  };
}
