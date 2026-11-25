import { describe, expect, it } from 'vitest';
import { ChunkedDecoder } from '../src/kasa/chunked.js';

async function decode(pieces: Buffer[]): Promise<Buffer> {
  const decoder = new ChunkedDecoder();
  const out: Buffer[] = [];
  decoder.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    decoder.on('end', resolve);
    decoder.on('error', reject);
  });
  for (const p of pieces) decoder.write(p);
  decoder.end();
  await done;
  return Buffer.concat(out);
}

const encoded = Buffer.from('5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\nX-Trailer: 1\r\n\r\n');

describe('ChunkedDecoder', () => {
  it('decodes a complete body', async () => {
    expect((await decode([encoded])).toString()).toBe('hello, world');
  });

  it('decodes when split at every byte', async () => {
    const pieces = [...encoded].map((b) => Buffer.from([b]));
    expect((await decode(pieces)).toString()).toBe('hello, world');
  });

  it('handles binary data containing CRLF', async () => {
    const payload = Buffer.from([0x0d, 0x0a, 0x00, 0x0d, 0x0a]);
    const body = Buffer.concat([Buffer.from('5\r\n'), payload, Buffer.from('\r\n0\r\n\r\n')]);
    expect(await decode([body])).toEqual(payload);
  });

  it('rejects a malformed size line', async () => {
    await expect(decode([Buffer.from('zz\r\nabc')])).rejects.toThrow(/bad chunk size/);
  });
});
