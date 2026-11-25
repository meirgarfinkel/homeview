import { describe, expect, it } from 'vitest';
import { decrypt, decryptJson, encrypt, encryptJson } from '../src/kasa/cipher.js';

describe('Kasa XOR cipher', () => {
  it('round-trips arbitrary text', () => {
    const text = '{"system":{"get_sysinfo":{}}} ünïcode ✓';
    expect(decrypt(encrypt(text)).toString('utf8')).toBe(text);
  });

  it('matches the known encoding of get_sysinfo', () => {
    // Widely documented first bytes of the encrypted discovery probe.
    expect(encrypt('{"system"').subarray(0, 4)).toEqual(Buffer.from([0xd0, 0xf2, 0x81, 0xf8]));
  });

  it('decodes a real reply captured from a KC410S', () => {
    // POST /data/LINKIE.json without credentials, firmware 2.3.27.
    const captured = '0PKX5ZfIq8Sgxefd8MHxwfHG6sit363yn+yLqZOx5IrrnuqC7Z/2jOmNreia6If116o=';
    expect(decryptJson(Buffer.from(captured, 'base64'))).toEqual({
      err_code: -10007,
      err_msg: 'Unauthorized Error',
    });
  });

  it('round-trips JSON', () => {
    const value = { a: [1, 2, { b: 'c' }] };
    expect(decryptJson(encryptJson(value))).toEqual(value);
  });
});
