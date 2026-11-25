import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLogFile } from '../src/logs.js';

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
