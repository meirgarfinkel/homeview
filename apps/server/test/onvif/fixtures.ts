import type { FakeOnvifOptions } from '../../src/dev/fakeOnvif.js';

/** A fake ONVIF camera with one 1080p H.264 profile and PTZ. */
export const BASE_FAKE: FakeOnvifOptions = {
  username: 'admin',
  password: 'onvif-pass-77ad',
  auth: 'ws-security',
  profiles: [
    { token: 'main', name: 'Main', codec: 'h264', width: 1920, height: 1080, hasPtz: true },
  ],
  streamUri: 'rtsp://127.0.0.1:554/main',
  serial: 'SN-1',
  mac: '00:11:22:33:44:55',
  endpointId: 'urn:uuid:11111111-2222-3333-4444-555555555555',
};
