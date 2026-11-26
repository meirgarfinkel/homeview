import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSoundDecoder } from './soundDecoder';

interface FakeChunk {
  data: Uint8Array;
  timestamp: number;
}

/** A stand-in for WebCodecs' AudioDecoder that answers each chunk with fixed AudioData. */
function installAudioDecoder(channels: number[][], supported = true) {
  const configs: unknown[] = [];
  class FakeAudioDecoder {
    static isConfigSupported = vi.fn(async () => ({ supported }));
    constructor(
      private readonly init: { output: (d: unknown) => void; error: (e: Error) => void },
    ) {}
    configure(config: unknown) {
      configs.push(config);
    }
    decode(_chunk: FakeChunk) {
      this.init.output({
        numberOfChannels: channels.length,
        numberOfFrames: channels[0]!.length,
        copyTo: (dest: Float32Array, opts: { planeIndex: number }) =>
          dest.set(channels[opts.planeIndex]!),
        close: () => undefined,
      });
    }
    close() {}
  }
  class FakeEncodedAudioChunk {
    data: Uint8Array;
    timestamp: number;
    constructor(init: FakeChunk & { type: string }) {
      this.data = init.data;
      this.timestamp = init.timestamp;
    }
  }
  vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
  vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
  return { configs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSoundDecoder', () => {
  it('decodes mu-law', async () => {
    const out: Float32Array[] = [];
    const d = await createSoundDecoder({ codec: 'pcmu', sampleRate: 8000, channels: 1 }, (p) =>
      out.push(p),
    );
    d!.decode(new Uint8Array([0xff, 0x80]));
    expect(out[0]![0]).toBe(0);
    expect(out[0]![1]).toBeGreaterThan(0.9);
  });

  it('decodes A-law', async () => {
    const out: Float32Array[] = [];
    const d = await createSoundDecoder({ codec: 'pcma', sampleRate: 8000, channels: 1 }, (p) =>
      out.push(p),
    );
    d!.decode(new Uint8Array([0xaa]));
    expect(out[0]![0]).toBeGreaterThan(0.9);
  });

  it('returns undefined for AAC without WebCodecs', async () => {
    vi.stubGlobal('AudioDecoder', undefined);
    const d = await createSoundDecoder(
      { codec: 'aac', sampleRate: 16000, channels: 1, config: 'FAg=' },
      () => undefined,
    );
    expect(d).toBeUndefined();
  });

  it('returns undefined when the browser says it cannot decode this AAC', async () => {
    installAudioDecoder([[0]], false);
    const d = await createSoundDecoder(
      { codec: 'aac', sampleRate: 16000, channels: 1, config: 'FAg=' },
      () => undefined,
    );
    expect(d).toBeUndefined();
  });

  it('configures AAC with the config bytes and mixes stereo to mono', async () => {
    const { configs } = installAudioDecoder([
      [0.5, 1],
      [0.5, 0],
    ]);
    const out: Float32Array[] = [];
    const d = await createSoundDecoder(
      { codec: 'aac', sampleRate: 16000, channels: 2, config: 'FAg=' },
      (p) => out.push(p),
    );
    expect(configs[0]).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 16000,
      numberOfChannels: 2,
    });
    expect([...(configs[0] as { description: Uint8Array }).description]).toEqual([0x14, 0x08]);
    d!.decode(new Uint8Array([1, 2, 3]));
    expect([...out[0]!]).toEqual([0.5, 0.5]);
  });
});
