import { describe, expect, it } from 'vitest';
import {
  createHostAllowlist,
  createIpAllowlist,
  hostnameOf,
  isLoopback,
  isPrivateAddress,
  isSameOrigin,
  normalizeIp,
} from '../src/security/network.js';

describe('IP allowlist', () => {
  it.each([
    '127.0.0.1',
    '192.168.1.20',
    '172.16.5.4',
    '172.31.255.255',
    '10.42.7.9',
    '169.254.1.1',
    '::1',
    'fe80::1',
    'fd12::1',
    '::ffff:10.0.0.5',
  ])('allows local address %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '100.64.0.1',
    '2001:4860::8888',
    '::ffff:8.8.8.8',
    'not-an-ip',
    '',
  ])('blocks non-local address %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('honours a custom list', () => {
    const allow = createIpAllowlist(['10.0.0.0/24']);
    expect(allow('10.0.0.200')).toBe(true);
    expect(allow('10.0.1.1')).toBe(false);
    expect(allow('127.0.0.1')).toBe(false);
  });

  it('rejects malformed CIDRs', () => {
    expect(() => createIpAllowlist(['10.0.0.0/40'])).toThrow();
    expect(() => createIpAllowlist(['banana/8'])).toThrow();
  });

  it('normalizes mapped and zoned addresses', () => {
    expect(normalizeIp('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('recognises loopback clients', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(isLoopback)).toBe(true);
    expect(['192.168.1.20', '::ffff:10.0.0.1', undefined].some(isLoopback)).toBe(false);
  });
});

describe('Host allowlist (DNS rebinding)', () => {
  const allow = createHostAllowlist(['nursery.home']);

  it.each([
    '192.168.1.20:8080',
    'localhost:5173',
    '[::1]:8080',
    'baby-pc.local',
    'nursery.home',
    'NURSERY.HOME:8080',
  ])('allows %s', (h) => expect(allow(h)).toBe(true));

  it.each(['evil.example.com', 'rebind.attacker.net:8080', ''])('blocks %s', (h) =>
    expect(allow(h)).toBe(false),
  );

  it('parses hostnames', () => {
    expect(hostnameOf('[fe80::1]:80')).toBe('fe80::1');
    expect(hostnameOf('Example.COM:8080')).toBe('example.com');
    expect(hostnameOf('fe80::1')).toBe('fe80::1');
  });
});

describe('isSameOrigin', () => {
  it('accepts matching or absent origins', () => {
    expect(isSameOrigin('http://192.168.1.20:8080', '192.168.1.20:8080')).toBe(true);
    expect(isSameOrigin(undefined, '192.168.1.20:8080')).toBe(true);
  });

  it('rejects foreign or opaque origins', () => {
    expect(isSameOrigin('http://evil.com', '192.168.1.20:8080')).toBe(false);
    expect(isSameOrigin('null', '192.168.1.20:8080')).toBe(false);
    expect(isSameOrigin('http://192.168.1.20:9999', '192.168.1.20:8080')).toBe(false);
  });
});
