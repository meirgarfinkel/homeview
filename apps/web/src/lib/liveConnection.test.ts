import { afterEach, expect, it, vi } from 'vitest';
import { LiveConnection } from './liveConnection';

class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.onclose?.();
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
  const conn = new LiveConnection({
    onMessage: () => {},
    onVideoInit: () => {},
    onVideoFragment: () => {},
    onAudio: () => {},
    onConnection: () => {},
    onRefused,
  });
  conn.start();
  return { conn, onRefused };
}

it('reports a socket that closes before it opens, as a refused sign-in looks', () => {
  const { conn, onRefused } = connect();
  FakeSocket.last!.onclose?.();
  expect(onRefused).toHaveBeenCalledTimes(1);
  conn.stop();
});

it('does not report a socket that opened and later dropped', () => {
  const { conn, onRefused } = connect();
  FakeSocket.last!.onopen?.();
  FakeSocket.last!.onclose?.();
  expect(onRefused).not.toHaveBeenCalled();
  conn.stop();
});
