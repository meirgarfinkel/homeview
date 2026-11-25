import { describe, expect, it } from 'vitest';
import {
  boundaryFromContentType,
  MultipartParser,
  type MultipartPart,
} from '../src/kasa/multipart.js';

const BOUNDARY = 'data-boundary--';

function part(type: string, body: Buffer, withLength = true): Buffer {
  const head =
    `--${BOUNDARY}\r\nContent-Type: ${type}\r\n` +
    (withLength ? `Content-Length: ${body.length}\r\n` : '') +
    'X-Timestamp: 12.5\r\n\r\n';
  return Buffer.concat([Buffer.from(head), body, Buffer.from('\r\n')]);
}

async function parse(
  input: Buffer,
  chunkSize: number,
  boundary?: string,
): Promise<MultipartPart[]> {
  const parser = new MultipartParser({ boundary });
  const parts: MultipartPart[] = [];
  parser.on('data', (p: MultipartPart) => parts.push(p));
  const done = new Promise<void>((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
  });
  for (let i = 0; i < input.length; i += chunkSize) parser.write(input.subarray(i, i + chunkSize));
  parser.end();
  await done;
  return parts;
}

// Bodies include CRLF and "--" sequences to make sure lengths, not content, delimit parts.
const video = Buffer.from([0, 0, 0, 1, 0x65, 0x0d, 0x0a, 0x2d, 0x2d, 0x0d, 0x0a, 0xff]);
const audio = Buffer.alloc(400, 0x7f);

describe('MultipartParser', () => {
  it.each([1, 3, 7, 64, 100_000])(
    'parses parts with Content-Length (chunk size %i)',
    async (size) => {
      const input = Buffer.concat([part('video/x-h264', video), part('audio/g711u', audio)]);
      const parts = await parse(input, size);
      expect(parts).toHaveLength(2);
      expect(parts[0]!.headers['content-type']).toBe('video/x-h264');
      expect(parts[0]!.headers['x-timestamp']).toBe('12.5');
      expect(parts[0]!.body).toEqual(video);
      expect(parts[1]!.body).toEqual(audio);
    },
  );

  it('falls back to boundary scanning without Content-Length', async () => {
    const body = Buffer.from('frame-data\r\nstill frame data');
    const input = Buffer.concat([
      part('video/x-h264', body, false),
      part('audio/g711u', audio, false),
      Buffer.from(`--${BOUNDARY}\r\n`),
    ]);
    const parts = await parse(input, 5, BOUNDARY);
    expect(parts.map((p) => p.body)).toEqual([body, audio]);
  });

  it('errors on garbage instead of a boundary', async () => {
    await expect(parse(Buffer.from('HELLO\r\n'), 100)).rejects.toThrow(/expected boundary/);
  });

  it('extracts the boundary from Content-Type', () => {
    expect(boundaryFromContentType('multipart/x-mixed-replace;boundary=data-boundary--')).toBe(
      'data-boundary--',
    );
    expect(boundaryFromContentType('multipart/x-mixed-replace; boundary="abc"')).toBe('abc');
    expect(boundaryFromContentType('video/mp4')).toBeUndefined();
  });
});
