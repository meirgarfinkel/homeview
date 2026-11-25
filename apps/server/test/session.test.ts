import { describe, expect, it } from 'vitest';
import {
  LoginRateLimiter,
  parseCookies,
  SESSION_TTL_MS,
  SessionManager,
} from '../src/security/session.js';

describe('SessionManager', () => {
  const sessions = new SessionManager('hunter2', 'a'.repeat(32));

  it('checks the password', () => {
    expect(sessions.checkPassword('hunter2')).toBe(true);
    expect(sessions.checkPassword('hunter3')).toBe(false);
    expect(sessions.checkPassword('')).toBe(false);
  });

  it('issues tokens that verify until they expire', () => {
    const now = 1_000_000;
    const { token } = sessions.issue(now);
    expect(sessions.verify(token, now + 1000)).toBe(true);
    expect(sessions.verify(token, now + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('rejects tampered tokens', () => {
    const { token } = sessions.issue();
    const [exp, sig] = token.split('.');
    expect(sessions.verify(`${Number(exp) + 1}.${sig}`)).toBe(false);
    expect(sessions.verify(`${exp}.${sig}x`)).toBe(false);
    expect(sessions.verify('garbage')).toBe(false);
    expect(sessions.verify(undefined)).toBe(false);
  });

  it('invalidates sessions when the password changes', () => {
    const { token } = sessions.issue();
    expect(new SessionManager('other', 'a'.repeat(32)).verify(token)).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; kasa_session=x.y%3D; bad')).toEqual({ a: '1', kasa_session: 'x.y=' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after the limit and resets after the window', () => {
    const limiter = new LoginRateLimiter(3, 1000);
    expect([1, 2, 3].map(() => limiter.hit('ip', 0))).toEqual([true, true, true]);
    expect(limiter.hit('ip', 10)).toBe(false);
    expect(limiter.hit('other', 10)).toBe(true);
    expect(limiter.hit('ip', 1001)).toBe(true);
  });
});
