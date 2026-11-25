import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinaryKind, type StreamState } from '@kasa/shared';
import { accessUnits } from '../src/dev/fakeCamera.js';
import type { MediaFrame } from '../src/kasa/cameraSource.js';
import { LiveHub, type FrameSource, type Viewer } from '../src/media/liveHub.js';
import { boxes, fixture, silentLogger } from './helpers.js';

class FakeSource extends EventEmitter implements FrameSource {
  state: StreamState = 'idle';
  start = vi.fn();
  stop = vi.fn();
  video(data: Buffer, timestamp: number) {
    this.emit('frame', { kind: 'video', data, timestamp } satisfies MediaFrame);
  }
  audio(data: Buffer) {
    this.emit('frame', { kind: 'audio', data, timestamp: 0 } satisfies MediaFrame);
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
});
