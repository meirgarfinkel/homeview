import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as NodeFs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

/** Every fsync and rename, in order, with the path an fsync'd descriptor was opened for. */
const events: string[] = [];
const opened = new Map<number, string>();

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  const wrapped = {
    ...fs,
    openSync: (file: string, ...rest: unknown[]) => {
      const fd = (fs.openSync as (...a: unknown[]) => number)(file, ...rest);
      opened.set(fd, String(file));
      return fd;
    },
    fsyncSync: (fd: number) => {
      events.push(`fsync ${opened.get(fd) ?? '?'}`);
      fs.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      events.push(`rename ${String(from)} -> ${String(to)}`);
      fs.renameSync(from, to);
    },
  };
  return { ...wrapped, default: wrapped };
});

const { SettingsStore } = await import('../src/settings/store.js');

const dir = mkdtempSync(path.join(tmpdir(), 'kasa-durable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('flushes the new file to disk before it replaces the old one, then the folder', () => {
  const store = new SettingsStore(dir);
  events.length = 0;
  store.save({ viewerPasswordHash: 'scrypt$x' });
  const file = path.join(dir, 'settings.json');
  const expected = [`fsync ${file}.tmp`, `rename ${file}.tmp -> ${file}`];
  // Windows can't open a folder to flush it.
  if (process.platform !== 'win32') expected.push(`fsync ${dir}`);
  expect(events).toEqual(expected);
  expect(store.load().viewerPasswordHash).toBe('scrypt$x');
});
