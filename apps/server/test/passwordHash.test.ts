import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/security/passwordHash.js';

describe('passwordHash', () => {
  it('hashes with a fresh salt and verifies only the right password', async () => {
    const a = await hashPassword('sleepy-owl-42');
    const b = await hashPassword('sleepy-owl-42');
    expect(a).toMatch(/^scrypt\$32768\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('sleepy-owl-42', a)).toBe(true);
    expect(await verifyPassword('sleepy-owl-43', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
