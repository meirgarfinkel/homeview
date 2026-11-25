import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { LIVE_WS_PATH } from '@kasa/shared';
import type { LiveHub, Viewer } from '../media/liveHub.js';

const PING_INTERVAL_MS = 20_000;

/** WebSocket endpoint that streams live video/audio to one browser tab. */
export async function registerLiveRoute(app: FastifyInstance, hub: LiveHub): Promise<void> {
  app.get(LIVE_WS_PATH, { websocket: true }, (socket: WebSocket, req) => {
    const log = req.log.child({ viewer: req.ip });
    const viewer: Viewer = {
      sendJson: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      sendBinary: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame, { binary: true });
      },
      bufferedBytes: () => socket.bufferedAmount,
    };

    // Detect half-open connections (laptop lid closed, Wi-Fi dropped).
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        log.info('Viewer stopped responding; closing');
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);

    // The protocol is server -> client only.
    socket.on('message', () => undefined);
    socket.on('close', () => {
      clearInterval(ping);
      hub.removeViewer(viewer);
      log.info({ viewers: hub.viewerCount }, 'Viewer disconnected');
    });
    socket.on('error', (err) => log.debug({ err: err.message }, 'Viewer socket error'));

    hub.addViewer(viewer);
    log.info({ viewers: hub.viewerCount }, 'Viewer connected');
  });
}
