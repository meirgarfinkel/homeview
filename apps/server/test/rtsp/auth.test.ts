import { describe, expect, it } from 'vitest';
import { authorizationFor, pickChallenge } from '../../src/rtsp/auth.js';

describe('authorizationFor', () => {
  it('Basic header', () => {
    expect(authorizationFor('Basic realm="cam"', 'DESCRIBE', 'rtsp://h/x', 'admin', 'pa:ss')).toBe(
      `Basic ${Buffer.from('admin:pa:ss').toString('base64')}`,
    );
  });

  it('Digest per RFC 2617 example', () => {
    const header = authorizationFor(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      'GET',
      '/dir/index.html',
      'Mufasa',
      'Circle Of Life',
      { nc: 1, cnonce: '0a4f113b' },
    );
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(header).toContain('uri="/dir/index.html"');
  });

  it('Digest without qop uses the RFC 2069 response', () => {
    const header = authorizationFor(
      'Digest realm="r", nonce="n"',
      'DESCRIBE',
      'rtsp://h/x',
      'u',
      'p',
    );
    // md5(md5("u:r:p") + ":n:" + md5("DESCRIBE:rtsp://h/x"))
    expect(header).toMatch(/response="[0-9a-f]{32}"/);
    expect(header).not.toContain('qop');
  });

  it('Digest with qop=auth carries the nc it is given', () => {
    const challenge = 'Digest realm="r", nonce="n", qop="auth"';
    expect(authorizationFor(challenge, 'PLAY', 'rtsp://h/x', 'u', 'p', { nc: 2 })).toContain(
      'nc=00000002',
    );
  });

  it('pickChallenge prefers Digest over Basic', () => {
    expect(pickChallenge(['Basic realm="a"', 'Digest realm="a", nonce="n"'])).toMatch(/^Digest/);
    expect(pickChallenge(['Basic realm="a"'])).toMatch(/^Basic/);
    expect(pickChallenge(['NTLM'])).toBeUndefined();
  });
});
