import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deviceCookie, DeviceStore } from '../src/remote/devices.js';
import { silentLogger } from './helpers.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-remote-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('DeviceStore', () => {
  it('stores a hash of the token, never the token', () => {
    const dir = tmp();
    const store = new DeviceStore(dir, silentLogger);
    const { device, token } = store.add('iPhone');
    expect(token).toHaveLength(43);
    const text = readFileSync(path.join(dir, 'remote.json'), 'utf8');
    expect(text).not.toContain(token);
    const disk = JSON.parse(text) as { devices: { id: string; tokenHash: string }[] };
    expect(disk.devices[0]?.id).toBe(device.id);
    expect(disk.devices[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path.join(dir, 'remote.json')).mode & 0o777).toBe(0o600);
  });

  it('finds a device by its token only', () => {
    const store = new DeviceStore(tmp(), silentLogger);
    const { device, token } = store.add('Mac');
    expect(store.find(token)?.id).toBe(device.id);
    expect(store.find('wrong')).toBeUndefined();
    expect(store.find(undefined)).toBeUndefined();
  });

  it('removes a device, emits removed, and keeps that after a reload', () => {
    const dir = tmp();
    const store = new DeviceStore(dir, silentLogger);
    const { device, token } = store.add('iPad');
    const removed: string[] = [];
    store.on('removed', (id) => removed.push(id));
    expect(store.remove(device.id)).toBe(true);
    expect(store.remove(device.id)).toBe(false);
    expect(removed).toEqual([device.id]);
    const again = new DeviceStore(dir, silentLogger);
    expect(again.list()).toEqual([]);
    expect(again.find(token)).toBeUndefined();
  });

  it('reloads devices and the enabled flag from disk', () => {
    const dir = tmp();
    const store = new DeviceStore(dir, silentLogger);
    expect(store.enabled).toBe(false);
    store.setEnabled(true);
    const { token } = store.add('Windows PC');
    const again = new DeviceStore(dir, silentLogger);
    expect(again.enabled).toBe(true);
    expect(again.find(token)?.name).toBe('Windows PC');
  });

  it('loads a corrupt file as empty without throwing', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'remote.json'), '{not json');
    const store = new DeviceStore(dir, silentLogger);
    expect(store.enabled).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('writes lastSeenAt at most every 10 minutes, and on flush', () => {
    const dir = tmp();
    const file = path.join(dir, 'remote.json');
    const store = new DeviceStore(dir, silentLogger);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const { device } = store.add('Mac', t0);
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, old, old);
    store.touch(device.id, new Date(t0.getTime() + 5 * 60_000));
    expect(statSync(file).mtimeMs).toBe(old.getTime());
    expect(store.list()[0]?.lastSeenAt).toBe(new Date(t0.getTime() + 5 * 60_000).toISOString());
    store.touch(device.id, new Date(t0.getTime() + 11 * 60_000));
    expect(statSync(file).mtimeMs).toBeGreaterThan(old.getTime());
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { devices: { lastSeenAt: string }[] };
    expect(disk.devices[0]?.lastSeenAt).toBe(new Date(t0.getTime() + 11 * 60_000).toISOString());

    utimesSync(file, old, old);
    store.touch(device.id, new Date(t0.getTime() + 12 * 60_000));
    expect(statSync(file).mtimeMs).toBe(old.getTime());
    store.flush();
    expect(statSync(file).mtimeMs).toBeGreaterThan(old.getTime());
  });

  it('does not expose the token hash in the list', () => {
    const store = new DeviceStore(tmp(), silentLogger);
    store.add('Mac');
    expect(Object.keys(store.list()[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name']);
  });
});

describe('deviceCookie', () => {
  it('sets a long-lived locked-down cookie', () => {
    expect(deviceCookie('abc')).toBe(
      'kasa_device=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000',
    );
  });
});
