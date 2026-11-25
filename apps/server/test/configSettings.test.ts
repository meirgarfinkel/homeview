import { describe, expect, it } from 'vitest';
import { loadConfig, viewerCheck } from '../src/config.js';

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
});
