/** RTSP authentication: Basic and Digest MD5 (RFC 2617, and RFC 2069 without qop). */
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** The challenge to answer: Digest if offered, else Basic, else undefined. */
export function pickChallenge(headers: readonly string[]): string | undefined {
  return headers.find((h) => /^digest\s/i.test(h)) ?? headers.find((h) => /^basic(\s|$)/i.test(h));
}

export function parseChallengeParams(challenge: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  for (const m of challenge.slice(challenge.indexOf(' ') + 1).matchAll(re)) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return params;
}

/** An Authorization header answering `challenge` for one request. */
export function authorizationFor(
  challenge: string,
  method: string,
  uri: string,
  username: string,
  password: string,
  opts: { nc?: number; cnonce?: string } = {},
): string {
  if (/^basic/i.test(challenge)) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  const p = parseChallengeParams(challenge);
  const realm = p['realm'] ?? '';
  const nonce = p['nonce'] ?? '';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qops = (p['qop'] ?? '').split(',').map((q) => q.trim());
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
  if (qops.includes('auth')) {
    const nc = (opts.nc ?? 1).toString(16).padStart(8, '0');
    const cnonce = opts.cnonce ?? randomBytes(8).toString('hex');
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`response="${response}"`, 'qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
  }
  if (p['opaque'] !== undefined) parts.push(`opaque="${p['opaque']}"`);
  if (p['algorithm']) parts.push(`algorithm=${p['algorithm']}`);
  return `Digest ${parts.join(', ')}`;
}
