import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { plainProtector, SettingsStore, type SecretProtector } from '../src/settings/store.js';
import { silentLogger } from './helpers.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-settings-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const reversing: SecretProtector = {
  kind: 'safeStorage',
  encrypt: (s) => `x:${[...s].reverse().join('')}`,
  decrypt: (s) => [...s.slice(2)].reverse().join(''),
};

describe('SettingsStore', () => {
  it('keeps the stream resolution across a save and load', () => {
    const store = new SettingsStore(tmp(), undefined, silentLogger);
    store.save({ streamResolution: '1080P' });
    expect(store.load().streamResolution).toBe('1080P');
  });

  it('loads an older file without a stream resolution', () => {
    const store = new SettingsStore(tmp(), undefined, silentLogger);
    writeFileSync(store.file, JSON.stringify({ viewerPasswordHash: 'x' }));
    expect(store.load()).toEqual({ viewerPasswordHash: 'x' });
  });

  it('returns empty settings when there is no file', () => {
    expect(new SettingsStore(tmp(), undefined, silentLogger).load()).toEqual({});
  });

  it('round-trips, writes owner-only, and never stores the camera password in plain text with a real protector', () => {
    const dir = tmp();
    const store = new SettingsStore(dir, reversing, silentLogger);
    const value = {
      viewerPasswordHash: 'scrypt$1$a$b',
      camera: { username: 'a@b.c', password: 'pw-123', localOnly: false },
    };
    store.save(value);
    expect(new SettingsStore(dir, reversing, silentLogger).load()).toEqual(value);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(store.file, 'utf8')).not.toContain('pw-123');
  });

  it('a settings file without kind loads as kasa', () => {
    const dir = tmp();
    // The shape every settings file had before standard cameras.
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        viewerPasswordHash: 'scrypt$1$a$b',
        camera: {
          username: 'a@b.c',
          passwordProtected: 'pw',
          protector: 'plain',
          localOnly: false,
        },
      }),
    );
    const loaded = new SettingsStore(dir, undefined, silentLogger).load();
    expect(loaded.camera).toEqual({ username: 'a@b.c', password: 'pw', localOnly: false });
    expect(loaded.camera?.kind ?? 'kasa').toBe('kasa');
  });

  it('an onvif camera round-trips with the password protected, never plain on disk', () => {
    const dir = tmp();
    const store = new SettingsStore(dir, reversing, silentLogger);
    const value = {
      viewerPasswordHash: 'scrypt$1$a$b',
      camera: {
        kind: 'onvif' as const,
        username: 'admin',
        password: 'onvif-secret-9',
        localOnly: false,
        onvif: {
          host: '192.0.2.20',
          onvifPort: 8000,
          profileToken: 'main',
          identity: { endpointId: 'urn:uuid:1', serial: 'SN-1', mac: '00:11:22:33:44:55' },
        },
      },
    };
    store.save(value);
    expect(new SettingsStore(dir, reversing, silentLogger).load()).toEqual(value);
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain('onvif-secret-9');
    expect(JSON.parse(raw).camera).toMatchObject({ kind: 'onvif', onvif: { host: '192.0.2.20' } });
  });

  it('keeps a corrupt file as settings.json.broken and starts empty', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'settings.json'), '{"camera": {"user');
    expect(new SettingsStore(dir, undefined, silentLogger).load()).toEqual({});
    expect(readFileSync(path.join(dir, 'settings.json.broken'), 'utf8')).toContain('"user');
  });

  it('drops a camera password it can no longer decrypt, keeping the rest', () => {
    const dir = tmp();
    new SettingsStore(dir, reversing, silentLogger).save({
      viewerPasswordHash: 'scrypt$1$a$b',
      camera: { username: 'a@b.c', password: 'pw-123', localOnly: true },
    });
    const broken: SecretProtector = {
      kind: 'safeStorage',
      encrypt: reversing.encrypt,
      decrypt: () => {
        throw new Error('keychain changed');
      },
    };
    expect(new SettingsStore(dir, broken, silentLogger).load()).toEqual({
      viewerPasswordHash: 'scrypt$1$a$b',
    });
  });

  it('keeps a camera password it cannot decrypt through an unrelated save', () => {
    const dir = tmp();
    const camera = { username: 'a@b.c', password: 'pw-123', localOnly: true };
    new SettingsStore(dir, reversing, silentLogger).save({ viewerPasswordHash: 'old', camera });

    // A launch without the keychain falls back to plain, which can't read the password.
    const locked = new SettingsStore(dir, plainProtector, silentLogger);
    locked.save({ ...locked.load(), viewerPasswordHash: 'new' });

    expect(new SettingsStore(dir, reversing, silentLogger).load()).toEqual({
      viewerPasswordHash: 'new',
      camera,
    });
  });

  it('replaces a camera password it cannot decrypt when a new camera login is saved', () => {
    const dir = tmp();
    new SettingsStore(dir, reversing, silentLogger).save({
      camera: { username: 'a@b.c', password: 'pw-123', localOnly: true },
    });
    const camera = { username: 'new@b.c', password: 'pw-456', localOnly: false };
    new SettingsStore(dir, plainProtector, silentLogger).save({ camera });
    expect(new SettingsStore(dir, undefined, silentLogger).load()).toEqual({ camera });
  });
});
