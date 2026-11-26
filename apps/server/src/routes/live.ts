import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { DEVICE_REMOVED_CLOSE, LIVE_WS_PATH } from '@kasa/shared';
import type { LiveHub, Viewer } from '../media/liveHub.js';
import type { DeviceStore } from '../remote/devices.js';
import { clientIp } from '../security/remoteRequest.js';

const PING_INTERVAL_MS = 20_000;

/**
 * WebSocket endpoint that streams live video/audio to one browser tab. A
 * remote viewer's socket closes when its device is removed.
 */
export async function registerLiveRoute(
  app: FastifyInstance,
  hub: LiveHub,
  devices?: DeviceStore,
): Promise<void> {
  app.get(LIVE_WS_PATH, { websocket: true }, (socket: WebSocket, req) => {
    const log = req.log.child({ viewer: clientIp(req) });
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
    const deviceId = req.remoteDeviceId;
    const onRemoved = (id: string) => {
      if (id !== deviceId) return;
      try {
        log.info('Device removed; closing its live view');
        socket.close(DEVICE_REMOVED_CLOSE, 'Device removed');
      } catch (err) {
        // The store emits this; a throw here would break its caller.
        log.debug({ err: (err as Error).message }, 'Could not close a removed device');
        socket.terminate();
      }
    };
    if (devices && deviceId) {
      devices.on('removed', onRemoved);
      // Removed after the gate let the upgrade through but before this ran.
      if (!devices.list().some((d) => d.id === deviceId)) onRemoved(deviceId);
    }

    socket.on('close', () => {
      clearInterval(ping);
      devices?.off('removed', onRemoved);
      hub.removeViewer(viewer);
      log.info({ viewers: hub.viewerCount }, 'Viewer disconnected');
    });
    socket.on('error', (err) => log.debug({ err: err.message }, 'Viewer socket error'));

    hub.addViewer(viewer);
    log.info({ viewers: hub.viewerCount }, 'Viewer connected');
  });
}
