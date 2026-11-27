import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinaryKind, type StreamState } from '@kasa/shared';
import { accessUnits } from '../src/dev/fakeCamera.js';
import type { AudioFrame, MediaFrame, VideoCodec } from '../src/camera/driver.js';
import { h265AccessUnits, h265NalType } from '../src/media/h265.js';
import { splitAnnexB } from '../src/media/h264.js';
import { LiveHub, type FrameSource, type Viewer } from '../src/media/liveHub.js';
import { boxes, fixture, silentLogger } from './helpers.js';

class FakeSource extends EventEmitter implements FrameSource {
  state: StreamState = 'idle';
  start = vi.fn();
  stop = vi.fn();
  video(data: Buffer, timestamp: number, codec: VideoCodec = 'h264') {
    this.emit('frame', { kind: 'video', codec, data, timestamp } satisfies MediaFrame);
  }
  sound(frame: Omit<AudioFrame, 'kind' | 'timestamp'>) {
    this.emit('frame', { kind: 'audio', timestamp: 0, ...frame } satisfies MediaFrame);
  }
  audio(data: Buffer) {
    this.emit('frame', {
      kind: 'audio',
      codec: 'pcmu',
      sampleRate: 8000,
      channels: 1,
      data,
      timestamp: 0,
    } satisfies MediaFrame);
  }
}

class RecordingViewer implements Viewer {
  json: Record<string, unknown>[] = [];
  binary: Buffer[] = [];
  buffered = 0;
  sendJson(m: object) {
    this.json.push(m as Record<string, unknown>);
  }
  sendBinary(frame: Buffer) {
    this.binary.push(frame);
  }
  bufferedBytes() {
    return this.buffered;
  }
  kinds() {
    return this.binary.map((b) => b[0]);
  }
}

const units = accessUnits(fixture('stream-320x180.h264')); // keyframe every 15 frames

function setup(opts: Partial<ConstructorParameters<typeof LiveHub>[0]> = {}) {
  const source = new FakeSource();
  const hub = new LiveHub({ source, logger: silentLogger, idleTimeoutMs: 1000, ...opts });
  return { source, hub };
}

function feed(source: FakeSource, from: number, to: number) {
  for (let i = from; i < to; i++) source.video(units[i % units.length]!, i / 15);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveHub', () => {
  it('reports the video size once it knows it', () => {
    const onVideoSize = vi.fn();
    const { source, hub } = setup({ onVideoSize });
    hub.addViewer(new RecordingViewer());
    feed(source, 0, 10);
    expect(onVideoSize).toHaveBeenCalledWith(320, 180);
  });

  it('starts the camera on the first viewer and stops it after the idle timeout', () => {
    vi.useFakeTimers();
    const { source, hub } = setup();
    const viewer = new RecordingViewer();
    hub.addViewer(viewer);
    expect(source.start).toHaveBeenCalledOnce();
    hub.removeViewer(viewer);
    vi.advanceTimersByTime(999);
    expect(source.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(source.stop).toHaveBeenCalledOnce();
  });

  it('cancels the idle stop when a viewer comes back', () => {
    vi.useFakeTimers();
    const { source, hub } = setup();
    const a = new RecordingViewer();
    hub.addViewer(a);
    hub.removeViewer(a);
    vi.advanceTimersByTime(500);
    hub.addViewer(new RecordingViewer());
    vi.advanceTimersByTime(5000);
    expect(source.stop).not.toHaveBeenCalled();
    expect(source.start).toHaveBeenCalledOnce();
  });

  it('sends codec, init segment, then fragments that start with a keyframe', () => {
    const { source, hub } = setup();
    const viewer = new RecordingViewer();
    hub.addViewer(viewer);
    feed(source, 0, 10);

    const codec = viewer.json.find((m) => m['type'] === 'codec') as {
      video: { mimeType: string; width: number; height: number };
    };
    expect(codec.video).toMatchObject({ width: 320, height: 180 });
    expect(codec.video.mimeType).toMatch(/^video\/mp4; codecs="avc1\.4d/);
    expect(viewer.kinds()[0]).toBe(BinaryKind.VideoInit);
    // One frame is held back until the next arrives (to know its duration).
    expect(viewer.kinds().filter((k) => k === BinaryKind.VideoFragment)).toHaveLength(9);
    const firstFragment = viewer.binary[1]!.subarray(1);
    expect(boxes(firstFragment).map((b) => b.type)).toEqual(['moof', 'mdat']);
  });

  it('gives a late joiner the cached GOP so playback starts immediately', () => {
    const { source, hub } = setup();
    hub.addViewer(new RecordingViewer());
    feed(source, 0, 20); // keyframes at 0 and 15; frames 15..18 emitted
    const late = new RecordingViewer();
    hub.addViewer(late);
    expect(late.kinds()[0]).toBe(BinaryKind.VideoInit);
    expect(late.kinds().slice(1)).toEqual(Array(4).fill(BinaryKind.VideoFragment));
  });

  it('uses camera timestamps for decode time', () => {
    const { source, hub } = setup();
    const viewer = new RecordingViewer();
    hub.addViewer(viewer);
    feed(source, 0, 3);
    const tfdt = (frag: Buffer) => {
      const at = frag.indexOf('tfdt');
      return Number(frag.readBigUInt64BE(at + 8));
    };
    const frags = viewer.binary.filter((b) => b[0] === BinaryKind.VideoFragment);
    expect(frags.map(tfdt)).toEqual([0, 6000]);
  });

  it('drops a slow viewer to the next keyframe without affecting others', () => {
    const { source, hub } = setup({ maxViewerBufferBytes: 1000 });
    const fast = new RecordingViewer();
    const slow = new RecordingViewer();
    hub.addViewer(fast);
    hub.addViewer(slow);
    feed(source, 0, 5);
    slow.buffered = 10_000;
    feed(source, 5, 10);
    slow.buffered = 0;
    const before = slow.binary.length;
    feed(source, 10, 14); // no keyframe yet: slow viewer stays paused
    expect(slow.binary.length).toBe(before);
    feed(source, 14, 17); // keyframe at 15 is emitted when 16 arrives
    expect(slow.binary.length).toBeGreaterThan(before);
    expect(fast.kinds().filter((k) => k === BinaryKind.VideoFragment)).toHaveLength(16);
  });

  it('forwards audio to viewers', () => {
    const { source, hub } = setup();
    const viewer = new RecordingViewer();
    hub.addViewer(viewer);
    source.audio(Buffer.alloc(400, 0xff));
    expect(viewer.binary.at(-1)![0]).toBe(BinaryKind.Audio);
    expect(viewer.binary.at(-1)!.length).toBe(401);
  });

  it('relays stream state changes', () => {
    const { source, hub } = setup();
    const viewer = new RecordingViewer();
    hub.addViewer(viewer);
    source.emit('state', 'error', 'bad password');
    expect(viewer.json.at(-1)).toEqual({ type: 'status', state: 'error', detail: 'bad password' });
    expect(hub.stats().state).toBe('error');
  });

  describe('H.265', () => {
    const hevc = h265AccessUnits(fixture('clip-320x180.h265')); // IRAP every 15 frames
    const isParameterSet = (n: Buffer) => [32, 33, 34].includes(h265NalType(n));
    const withoutParameterSets = (unit: Buffer) =>
      Buffer.concat(
        splitAnnexB(unit)
          .filter((n) => !isParameterSet(n))
          .flatMap((n) => [Buffer.from([0, 0, 0, 1]), n]),
      );

    it('an H.265 source produces a codec message with an hvc1 type and keyframe-aligned fragments', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      for (let i = 0; i < 20; i++) source.video(hevc[i]!, i / 15, 'h265');

      const codec = viewer.json.find((m) => m['type'] === 'codec') as {
        video: { mimeType: string; width: number; height: number };
      };
      expect(codec.video).toMatchObject({ width: 320, height: 180 });
      expect(codec.video.mimeType).toMatch(/^video\/mp4; codecs="hvc1\.1\./);
      expect(viewer.kinds()[0]).toBe(BinaryKind.VideoInit);
      expect(viewer.binary[0]!.indexOf('hvcC', 0, 'latin1')).toBeGreaterThan(0);
      expect(viewer.kinds().filter((k) => k === BinaryKind.VideoFragment)).toHaveLength(19);
      // The first fragment is a sync sample.
      const first = viewer.binary[1]!.subarray(1);
      const trun = first.indexOf('trun', 0, 'latin1');
      // type, version+flags, sample_count, data_offset, duration, size, then sample_flags
      expect(first.readUInt32BE(trun + 24)).toBe(0x02000000);
    });

    it('parameter sets given only once, before the first IRAP, still start the stream for a viewer who joins later', () => {
      const { source, hub } = setup();
      hub.addViewer(new RecordingViewer());
      source.video(hevc[0]!, 0, 'h265');
      for (let i = 1; i < 20; i++) source.video(withoutParameterSets(hevc[i]!), i / 15, 'h265');

      const late = new RecordingViewer();
      hub.addViewer(late);
      expect(late.json.some((m) => m['type'] === 'codec')).toBe(true);
      expect(late.kinds()[0]).toBe(BinaryKind.VideoInit);
      expect(
        late
          .kinds()
          .slice(1)
          .every((k) => k === BinaryKind.VideoFragment),
      ).toBe(true);
      expect(late.kinds().length).toBeGreaterThan(1);
    });

    it('a switch from H.264 to H.265 sends a new codec message and init segment', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      feed(source, 0, 5);
      for (let i = 0; i < 5; i++) source.video(hevc[i]!, 1 + i / 15, 'h265');

      const codecs = viewer.json
        .filter((m) => m['type'] === 'codec')
        .map((m) => (m as { video: { mimeType: string } }).video.mimeType);
      expect(codecs).toHaveLength(2);
      expect(codecs[0]).toMatch(/avc1/);
      expect(codecs[1]).toMatch(/hvc1/);
      expect(viewer.kinds().filter((k) => k === BinaryKind.VideoInit)).toHaveLength(2);
    });
  });

  describe('sound formats', () => {
    type Codec = {
      audio?: { codec: string; sampleRate: number; channels: number; config?: string } | null;
    };
    const lastCodec = (v: RecordingViewer) =>
      v.json.filter((m) => m['type'] === 'codec').at(-1) as Codec | undefined;
    const audioFrames = (v: RecordingViewer) =>
      v.kinds().filter((k) => k === BinaryKind.Audio).length;

    it('codec message names pcma, 8000, 1 for an A-law source', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      source.sound({ codec: 'pcma', sampleRate: 8000, channels: 1, data: Buffer.alloc(160) });
      feed(source, 0, 3);
      expect(lastCodec(viewer)?.audio).toEqual({ codec: 'pcma', sampleRate: 8000, channels: 1 });
      expect(audioFrames(viewer)).toBe(1);
    });

    it('codec message carries the AAC config as base64', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      const config = Buffer.from([0x14, 0x08]);
      source.sound({
        codec: 'aac',
        sampleRate: 16000,
        channels: 1,
        config,
        data: Buffer.alloc(40),
      });
      feed(source, 0, 3);
      expect(lastCodec(viewer)?.audio).toEqual({
        codec: 'aac',
        sampleRate: 16000,
        channels: 1,
        config: config.toString('base64'),
      });
    });

    it('an unsupported audio codec gives audio: null and drops those frames', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      feed(source, 0, 3);
      source.sound({ codec: 'g726', sampleRate: 8000, channels: 1, data: Buffer.alloc(80) });
      expect(lastCodec(viewer)?.audio).toBeNull();
      expect(audioFrames(viewer)).toBe(0);
    });

    it('sound that starts after the video updates the codec message without a new init segment', () => {
      const { source, hub } = setup();
      const viewer = new RecordingViewer();
      hub.addViewer(viewer);
      feed(source, 0, 3);
      expect(lastCodec(viewer)?.audio).toBeUndefined();
      source.sound({ codec: 'pcmu', sampleRate: 8000, channels: 1, data: Buffer.alloc(160) });
      expect(lastCodec(viewer)?.audio).toEqual({ codec: 'pcmu', sampleRate: 8000, channels: 1 });
      expect(viewer.kinds().filter((k) => k === BinaryKind.VideoInit)).toHaveLength(1);
      // A late joiner gets the sound format with the video's.
      const late = new RecordingViewer();
      hub.addViewer(late);
      expect(lastCodec(late)?.audio).toEqual({ codec: 'pcmu', sampleRate: 8000, channels: 1 });
    });
  });
});
