import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepLogSmall, openLogFile } from '../src/logs.js';

describe('openLogFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kasa-logs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rotates the log past the size limit', () => {
    const current = path.join(dir, 'kasa-home.log');
    writeFileSync(current, Buffer.alloc(6_000_000, 'a'));

    expect(openLogFile(dir, 5_000_000)).toBe(current);

    expect(statSync(path.join(dir, 'kasa-home.old.log')).size).toBe(6_000_000);
    expect(statSync(current).size).toBe(0);
  });

  it('keeps appending to a log under the limit', () => {
    const current = path.join(dir, 'kasa-home.log');
    writeFileSync(current, 'earlier line\n');

    openLogFile(dir, 5_000_000);

    expect(readFileSync(current, 'utf8')).toBe('earlier line\n');
    expect(existsSync(path.join(dir, 'kasa-home.old.log'))).toBe(false);
  });

  it('creates the folder and an owner-only log file', () => {
    const nested = path.join(dir, 'logs');
    const file = openLogFile(nested);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('keepLogSmall', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kasa-logs-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates a running log once it passes the limit', () => {
    const file = openLogFile(dir, 1000);
    const dest = pino.destination({ dest: file, sync: true });
    const timer = keepLogSmall(dir, dest, 1000, 60_000);
    try {
      dest.write(`${'a'.repeat(1500)}\n`);
      vi.advanceTimersByTime(60_000);
      dest.write('after the rotation\n');

      expect(statSync(path.join(dir, 'kasa-home.old.log')).size).toBe(1501);
      expect(readFileSync(file, 'utf8')).toBe('after the rotation\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      clearInterval(timer);
      dest.end();
    }
  });

  it('leaves a log under the limit alone', () => {
    const file = openLogFile(dir, 1000);
    const dest = pino.destination({ dest: file, sync: true });
    const timer = keepLogSmall(dir, dest, 1000, 60_000);
    try {
      dest.write('short\n');
      vi.advanceTimersByTime(60_000);
      expect(readFileSync(file, 'utf8')).toBe('short\n');
      expect(existsSync(path.join(dir, 'kasa-home.old.log'))).toBe(false);
    } finally {
      clearInterval(timer);
      dest.end();
    }
  });
});
