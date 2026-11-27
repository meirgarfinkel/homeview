import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { defaultSizeToSave } from '../src/settings/defaultSize.js';

const kasa = { username: 'u', password: 'p', alias: 'Nursery', localOnly: false };

describe('defaultSizeToSave', () => {
  it('saves the size a Kasa camera sends at its default', () => {
    const config = loadConfig({ KASA_HOST: '192.0.2.10' }, { camera: kasa });
    expect(defaultSizeToSave(config, { camera: kasa }, 1280, 720)).toBe('1280x720');
  });

  it('saves nothing when the size is already saved', () => {
    const settings = { camera: kasa, cameraDefaultSize: '1280x720' };
    const config = loadConfig({ KASA_HOST: '192.0.2.10' }, settings);
    expect(defaultSizeToSave(config, settings, 1280, 720)).toBeUndefined();
  });

  it('saves nothing while streaming at a chosen size', () => {
    const settings = { camera: kasa, streamResolution: '1080P' as const };
    const config = loadConfig({ KASA_HOST: '192.0.2.10' }, settings);
    expect(defaultSizeToSave(config, settings, 1920, 1080)).toBeUndefined();
  });

  it('saves nothing while .env picks the size', () => {
    const config = loadConfig(
      { KASA_HOST: '192.0.2.10', KASA_STREAM_RESOLUTION: '720P' },
      { camera: kasa },
    );
    expect(defaultSizeToSave(config, { camera: kasa }, 1280, 720)).toBeUndefined();
  });

  it('saves nothing for another brand', () => {
    const onvif = { host: '192.0.2.20', onvifPort: 80, identity: { serial: 'SN-1' } };
    const settings = { camera: { ...kasa, kind: 'onvif' as const, onvif } };
    const config = loadConfig({}, settings);
    expect(defaultSizeToSave(config, settings, 1920, 1080)).toBeUndefined();
  });
});
