import { randomBytes } from 'node:crypto';

/** Single-use codes that let a new device pair. Kept in memory only. */
export class PairingCodes {
  private readonly codes = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  create(now = Date.now()): { code: string; expiresAt: Date } {
    this.prune(now);
    const code = randomBytes(16).toString('base64url');
    const expires = now + this.ttlMs;
    this.codes.set(code, expires);
    return { code, expiresAt: new Date(expires) };
  }

  /** True the first time a valid code is used, false after that. */
  consume(code: string, now = Date.now()): boolean {
    const expires = this.codes.get(code);
    if (expires === undefined) return false;
    this.codes.delete(code);
    return now <= expires;
  }

  private prune(now: number): void {
    for (const [code, expires] of this.codes) {
      if (now > expires) this.codes.delete(code);
    }
  }
}
