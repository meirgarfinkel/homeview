import { describe, expect, it } from 'vitest';
import { deviceName } from '../src/remote/deviceName.js';
import { PairingCodes } from '../src/remote/pairing.js';

describe('PairingCodes', () => {
  it('makes a 22 character base64url code', () => {
    const { code, expiresAt } = new PairingCodes().create(1000);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt.getTime()).toBe(1000 + 10 * 60_000);
  });

  it('accepts a code once', () => {
    const codes = new PairingCodes();
    const { code } = codes.create(0);
    expect(codes.consume(code, 1)).toBe(true);
    expect(codes.consume(code, 2)).toBe(false);
    expect(codes.consume('nope', 2)).toBe(false);
  });

  it('rejects a code after 10 minutes', () => {
    const codes = new PairingCodes();
    const { code } = codes.create(0);
    expect(codes.consume(code, 10 * 60_000 + 1)).toBe(false);
    const fresh = codes.create(0);
    expect(codes.consume(fresh.code, 10 * 60_000 - 1)).toBe(true);
  });
});

describe('deviceName', () => {
  const cases: [string, string | undefined][] = [
    [
      'iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ],
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ],
    [
      'Android phone',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    ],
    [
      'Mac',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    ],
    [
      'Windows PC',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
    [
      'Linux PC',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
    ['Phone', 'curl/8.0'],
    ['Phone', undefined],
  ];
  it.each(cases)('names %s', (name, ua) => {
    expect(deviceName(ua)).toBe(name);
  });
});
