import { describe, expect, it } from 'vitest';
import {
  basicAuthHeader,
  CameraCredentials,
  encodePassword,
  encodingsFromCipherOptions,
} from '../src/kasa/credentials.js';

describe('password encoding', () => {
  it('md5 is lowercase hex', () => {
    expect(encodePassword('secret1', 'md5')).toBe('e52d98c459819a11775936d8dfbb7929');
  });

  it('base64 matches the go2rtc documentation example', () => {
    expect(encodePassword('secret1', 'base64')).toBe('c2VjcmV0MQ==');
  });

  it('builds a Basic header from email and encoded password', () => {
    const header = basicAuthHeader('me@example.com', 'secret1', 'base64');
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('me@example.com:c2VjcmV0MQ==');
  });
});

describe('encodingsFromCipherOptions', () => {
  it('prefers the highest advertised cipher, like the Kasa app', () => {
    expect(encodingsFromCipherOptions([0, 1])).toEqual(['md5', 'base64']);
    expect(encodingsFromCipherOptions([0])).toEqual(['base64', 'md5']);
  });

  it('falls back to md5 then base64 when unknown', () => {
    expect(encodingsFromCipherOptions(undefined)).toEqual(['md5', 'base64']);
    expect(encodingsFromCipherOptions([7])).toEqual(['md5', 'base64']);
  });
});

describe('CameraCredentials', () => {
  it('narrows candidates once an encoding works', () => {
    const creds = new CameraCredentials('u', 'p');
    creds.applyCipherOptions([0]);
    expect(creds.candidates()).toEqual(['base64', 'md5']);
    creds.markWorking('md5');
    expect(creds.candidates()).toEqual(['md5']);
    creds.applyCipherOptions([0]);
    expect(creds.candidates()).toEqual(['md5']);
  });

  it('respects an explicit setting', () => {
    const creds = new CameraCredentials('u', 'p', 'base64');
    creds.applyCipherOptions([0, 1]);
    expect(creds.candidates()).toEqual(['base64']);
  });
});
