import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEnvValue, setEnvValues, updateEnvFile } from '../src/setup/envFile.js';
import { looksLikeCameraNetwork, parseWifiList, splitTerse } from '../src/setup/nmcli.js';

describe('nmcli output parsing', () => {
  it('splits terse fields and unescapes colons and backslashes', () => {
    expect(splitTerse('My\\:Net:72:WPA2')).toEqual(['My:Net', '72', 'WPA2']);
    expect(splitTerse('back\\\\slash::')).toEqual(['back\\slash', '', '']);
  });

  it('keeps the strongest entry per network, sorted by signal, skipping hidden ones', () => {
    const out = 'Home:40:WPA2\nKasa_Cam_1A2B:90:\n:99:WPA2\nHome:70:WPA2\n';
    expect(parseWifiList(out)).toEqual([
      { ssid: 'Kasa_Cam_1A2B', signal: 90, security: '' },
      { ssid: 'Home', signal: 70, security: 'WPA2' },
    ]);
  });

  it('spots likely camera setup networks', () => {
    expect(looksLikeCameraNetwork('Kasa_Camera_1A2B')).toBe(true);
    expect(looksLikeCameraNetwork('TP-LINK_Cam_99')).toBe(true);
    expect(looksLikeCameraNetwork('KC410S_ABCD')).toBe(true);
    expect(looksLikeCameraNetwork('HomeNet')).toBe(false);
  });
});

describe('.env editing', () => {
  it('replaces existing keys, appends new ones and keeps everything else', () => {
    const before = '# comment\nKASA_HOST=\nPORT=8090\n';
    expect(setEnvValues(before, { KASA_HOST: '10.1.2.3', KASA_USERNAME: 'admin' })).toBe(
      '# comment\nKASA_HOST=10.1.2.3\nPORT=8090\nKASA_USERNAME=admin\n',
    );
  });

  it('quotes values with special characters and refuses ones it cannot write safely', () => {
    expect(formatEnvValue('plain-value_1@x.y')).toBe('plain-value_1@x.y');
    expect(formatEnvValue('has space#hash')).toBe("'has space#hash'");
    expect(formatEnvValue('')).toBe('');
    expect(() => formatEnvValue("it's #1")).toThrow();
    expect(() => formatEnvValue('two\nlines')).toThrow();
  });

  it('writes the file readable only by its owner, and Node reads values back', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'kasa-env-')), '.env');
    writeFileSync(file, 'PORT=8090\n', { mode: 0o644 });
    updateEnvFile(file, { KASA_PASSWORD: 'p@ss word#1' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe("PORT=8090\nKASA_PASSWORD='p@ss word#1'\n");
    delete process.env['KASA_PASSWORD'];
    process.loadEnvFile(file);
    expect(process.env['KASA_PASSWORD']).toBe('p@ss word#1');
    delete process.env['KASA_PASSWORD'];
  });
});
