import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Optional viewer password (VIEWER_PASSWORD). Being on the LAN is often
 * enough, but guest Wi-Fi users and smart TVs are on the LAN too.
 *
 * Sessions are stateless HMAC-signed tokens: "<expiresAtMs>.<signature>".
 * Changing the password or SESSION_SECRET invalidates every session.
 */

export const SESSION_COOKIE = 'kasa_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class SessionManager {
  private readonly key: Buffer;

  constructor(
    private readonly password: string,
    secret?: string,
  ) {
    // Bind sessions to the password so changing it logs everyone out.
    this.key = createHmac('sha256', secret ?? randomBytes(32).toString('hex'))
      .update(password, 'utf8')
      .digest();
  }

  checkPassword(candidate: string): boolean {
    return timingSafeEqual(digest(candidate), digest(this.password));
  }

  issue(now = Date.now()): { token: string; expires: Date } {
    const exp = now + SESSION_TTL_MS;
    return { token: `${exp}.${this.sign(String(exp))}`, expires: new Date(exp) };
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const exp = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
    const expected = Buffer.from(this.sign(exp));
    const actual = Buffer.from(sig);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookie(token: string, expires: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Fixed-window limiter for login attempts, per client IP. */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Returns false if this IP has exhausted its attempts. */
  hit(ip: string, now = Date.now()): boolean {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.maxAttempts;
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  private prune(now: number): void {
    if (this.attempts.size < 1000) return;
    for (const [ip, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(ip);
  }
}
