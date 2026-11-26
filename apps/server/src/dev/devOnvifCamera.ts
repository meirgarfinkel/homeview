/**
 * A whole fake standard camera for development and the end-to-end test:
 * ONVIF (with discovery and pan/tilt) plus an RTSP stream of H.265 and AAC.
 */
import { startFakeOnvif } from './fakeOnvif.js';
import { startFakeRtsp } from './fakeRtsp.js';

export interface DevOnvifCamera {
  onvifPort: number;
  rtspPort: number;
  discoveryPort: number;
  deviceUrl: string;
  /** Pan/tilt commands received. */
  moves: string[];
  close(): Promise<void>;
}

export async function startDevOnvifCamera(opts: {
  username?: string;
  password: string;
  /** 0 picks a free port. */
  ports: { onvif: number; rtsp: number; discovery: number };
}): Promise<DevOnvifCamera> {
  const username = opts.username ?? 'admin';
  const rtsp = await startFakeRtsp({
    video: 'h265',
    audio: 'aac',
    username,
    password: opts.password,
    auth: 'digest',
    path: '/main',
    ...(opts.ports.rtsp ? { port: opts.ports.rtsp } : {}),
  });
  try {
    const onvif = await startFakeOnvif({
      username,
      password: opts.password,
      auth: 'ws-security',
      profiles: [
        { token: 'main', name: 'Main', codec: 'h265', width: 320, height: 180, hasPtz: true },
      ],
      streamUri: rtsp.url,
      presets: ['Crib', 'Door'],
      serial: 'FAKE-0001',
      mac: '02:00:00:00:00:01',
      endpointId: 'urn:uuid:6b4f0c1e-0000-4000-8000-000000000001',
      name: 'Fake nursery cam',
      discoveryPort: opts.ports.discovery,
      ...(opts.ports.onvif ? { port: opts.ports.onvif } : {}),
    });
    return {
      onvifPort: Number(new URL(onvif.deviceUrl).port),
      rtspPort: rtsp.port,
      discoveryPort: onvif.discoveryPort!,
      deviceUrl: onvif.deviceUrl,
      moves: onvif.moves,
      close: async () => {
        await onvif.close();
        await rtsp.close();
      },
    };
  } catch (err) {
    await rtsp.close();
    throw err;
  }
}
