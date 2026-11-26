import { afterEach, expect, it, vi } from 'vitest';
import { LiveConnection } from './liveConnection';

class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connect() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  const onRefused = vi.fn();
  const onDeviceRemoved = vi.fn();
  const conn = new LiveConnection({
    onMessage: () => {},
    onVideoInit: () => {},
    onVideoFragment: () => {},
    onAudio: () => {},
    onConnection: () => {},
    onRefused,
    onDeviceRemoved,
  });
  conn.start();
  return { conn, onRefused, onDeviceRemoved };
}

it('reports a socket that closes before it opens, as a refused sign-in looks', () => {
  const { conn, onRefused } = connect();
  FakeSocket.last!.onclose?.({ code: 1006 });
  expect(onRefused).toHaveBeenCalledTimes(1);
  conn.stop();
});

it('does not report a socket that opened and later dropped', () => {
  const { conn, onRefused } = connect();
  FakeSocket.last!.onopen?.();
  FakeSocket.last!.onclose?.({ code: 1006 });
  expect(onRefused).not.toHaveBeenCalled();
  conn.stop();
});

it('reports a live view closed because its phone was removed', () => {
  const { conn, onDeviceRemoved } = connect();
  FakeSocket.last!.onopen?.();
  FakeSocket.last!.onclose?.({ code: 4401 });
  expect(onDeviceRemoved).toHaveBeenCalledTimes(1);
  conn.stop();
});

it('does not report an ordinary drop as a removed phone', () => {
  const { conn, onDeviceRemoved } = connect();
  FakeSocket.last!.onopen?.();
  FakeSocket.last!.onclose?.({ code: 1006 });
  expect(onDeviceRemoved).not.toHaveBeenCalled();
  conn.stop();
});
