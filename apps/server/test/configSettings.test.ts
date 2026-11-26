import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadConfig, resolveDataDir, viewerCheck } from '../src/config.js';

describe('config with settings', () => {
  it('is not set up with empty settings and no env', () => {
    const c = loadConfig({}, {});
    expect(c.setupComplete).toBe(false);
    expect(c.viewer).toBeUndefined();
    expect(c.camera.username).toBeUndefined();
  });

  it('takes the hash and camera login from settings', () => {
    const c = loadConfig(
      {},
      {
        viewerPasswordHash: 'scrypt$1$a$b',
        camera: { username: 'u@x', password: 'p', alias: 'Nursery', localOnly: false },
      },
    );
    expect(c.setupComplete).toBe(true);
    expect(c.viewer).toEqual({ kind: 'hash', hash: 'scrypt$1$a$b' });
    expect(c.camera).toMatchObject({ username: 'u@x', password: 'p', alias: 'Nursery' });
  });

  it('config marks setup complete for an onvif camera', () => {
    const onvif = { host: '192.0.2.20', onvifPort: 80, identity: { serial: 'SN-1' } };
    const c = loadConfig(
      {},
      {
        viewerPasswordHash: 'scrypt$1$a$b',
        camera: { kind: 'onvif', username: 'admin', password: 'pw', localOnly: false, onvif },
      },
    );
    expect(c.setupComplete).toBe(true);
    expect(c.camera.kind).toBe('onvif');
    expect(c.camera.onvif).toEqual({ ...onvif, username: 'admin', password: 'pw' });
  });

  it('an onvif camera without its address is not set up', () => {
    const c = loadConfig(
      {},
      {
        viewerPasswordHash: 'scrypt$1$a$b',
        camera: { kind: 'onvif', username: 'admin', password: 'pw', localOnly: false },
      },
    );
    expect(c.setupComplete).toBe(false);
  });

  it('a kasa camera has kind kasa and no onvif part', () => {
    const c = loadConfig({}, { camera: { username: 'u', password: 'p', localOnly: false } });
    expect(c.camera.kind).toBe('kasa');
    expect(c.camera.onvif).toBeUndefined();
  });

  it('lets environment variables override settings', () => {
    const c = loadConfig(
      { KASA_USERNAME: 'env@x', KASA_PASSWORD: 'envpw', VIEWER_PASSWORD: 'long enough' },
      {
        viewerPasswordHash: 'scrypt$1$a$b',
        camera: { username: 'u@x', password: 'p', localOnly: false },
      },
    );
    expect(c.camera.username).toBe('env@x');
    expect(c.viewer).toEqual({ kind: 'plain', password: 'long enough' });
  });

  it('still refuses to start from .env alone without a viewer password', () => {
    expect(() => loadConfig({ KASA_USERNAME: 'u', KASA_PASSWORD: 'p' })).toThrow(/VIEWER_PASSWORD/);
  });

  it('counts ALLOW_NO_PASSWORD as a viewer setting but still needs a camera login', () => {
    expect(loadConfig({ ALLOW_NO_PASSWORD: 'true' }).setupComplete).toBe(false);
    expect(
      loadConfig({ ALLOW_NO_PASSWORD: 'true', KASA_USERNAME: 'u', KASA_PASSWORD: 'p' })
        .setupComplete,
    ).toBe(true);
  });

  it('builds a password check from either kind of viewer setting', async () => {
    const plain = viewerCheck(loadConfig({ VIEWER_PASSWORD: 'long enough' }));
    expect(await plain?.verify('long enough')).toBe(true);
    expect(await plain?.verify('nope nope')).toBe(false);
    expect(viewerCheck(loadConfig({ ALLOW_NO_PASSWORD: 'true' }))).toBeUndefined();
  });

  it('takes the camera login as a pair from env or from settings, never mixed', () => {
    const saved = { camera: { username: 'u@x', password: 'p', localOnly: false } };
    const onlyUser = loadConfig({ KASA_USERNAME: 'env@x' }, saved);
    expect(onlyUser.camera.username).toBe('env@x');
    expect(onlyUser.camera.password).toBeUndefined();
    expect(onlyUser.setupComplete).toBe(false);
    const onlyPass = loadConfig({ KASA_PASSWORD: 'envpw', ALLOW_NO_PASSWORD: 'true' }, saved);
    expect(onlyPass.camera.username).toBeUndefined();
    expect(onlyPass.setupComplete).toBe(false);
    const fromSettings = loadConfig({ KASA_USERNAME: '' }, saved);
    expect(fromSettings.camera).toMatchObject({ username: 'u@x', password: 'p' });
  });

  it('records ALLOW_NO_PASSWORD so the app can tell open access from not set up', () => {
    expect(loadConfig({ ALLOW_NO_PASSWORD: 'true' }).allowNoPassword).toBe(true);
    expect(loadConfig({}, {}).allowNoPassword).toBe(false);
  });

  it('uses port 8090 by default', () => {
    expect(loadConfig({}, {}).port).toBe(8090);
  });

  it('resolves the data dir from DATA_DIR or the repo data folder', () => {
    expect(resolveDataDir({ DATA_DIR: 'some/where' })).toBe(path.resolve('some/where'));
    expect(resolveDataDir({})).toBe(loadConfig({}, {}).dataDir);
    expect(path.basename(resolveDataDir({}))).toBe('data');
  });
});
