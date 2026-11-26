import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTempDir } from '../src/tempDir.js';

describe('removeTempDir', () => {
  it('removes the folder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kasa-temp-test-'));
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw when the folder is still in use', () => {
    // Windows refuses to delete files another part of the app holds open.
    const busy = () => {
      throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    };
    expect(() => removeTempDir('C:\\busy', busy)).not.toThrow();
  });
});
