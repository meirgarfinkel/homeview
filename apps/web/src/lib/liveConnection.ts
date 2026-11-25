import { BinaryKind, LIVE_WS_PATH, type ServerMessage } from '@kasa/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface LiveHandlers {
  onMessage(message: ServerMessage): void;
  onVideoInit(data: Uint8Array): void;
  onVideoFragment(data: Uint8Array): void;
  onAudio(data: Uint8Array): void;
  onConnection(state: ConnectionState): void;
  /** The socket closed before it ever opened, which is how a refused sign-in looks. */
  onRefused?(): void;
}

/** One WebSocket to /api/live with automatic reconnect. */
export class LiveConnection {
  private ws: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;

  constructor(private readonly handlers: LiveHandlers) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = undefined;
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${LIVE_WS_PATH}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.handlers.onConnection('connecting');
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.handlers.onConnection('open');
    };
    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') {
        try {
          this.handlers.onMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // ignore malformed control messages
        }
        return;
      }
      const bytes = new Uint8Array(event.data);
      const payload = bytes.subarray(1);
      switch (bytes[0]) {
        case BinaryKind.VideoInit:
          this.handlers.onVideoInit(payload);
          break;
        case BinaryKind.VideoFragment:
          this.handlers.onVideoFragment(payload);
          break;
        case BinaryKind.Audio:
          this.handlers.onAudio(payload);
          break;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.handlers.onConnection('closed');
      if (this.stopped) return;
      if (!opened) this.handlers.onRefused?.();
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.open(), delay);
    };
  }
}
