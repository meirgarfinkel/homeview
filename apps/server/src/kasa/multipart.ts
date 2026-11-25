import { Transform, type TransformCallback } from 'node:stream';

/**
 * Incremental parser for the camera's `multipart/x-mixed-replace` body.
 *
 * Each part looks like:
 *
 *   --data-boundary--\r\n
 *   Content-Type: video/x-h264\r\n
 *   Content-Length: 12345\r\n
 *   X-Timestamp: 1234.567\r\n
 *   \r\n
 *   <12345 bytes>\r\n
 *
 * Parts normally carry Content-Length. When one doesn't, the body runs to the
 * next boundary line, which needs the boundary from the response Content-Type.
 * Emits MultipartPart objects (object mode).
 */

export interface MultipartPart {
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface MultipartOptions {
  /** Boundary token from the response Content-Type, without the leading "--". */
  boundary?: string;
  maxPartBytes?: number;
}

const CRLF = Buffer.from('\r\n');
const MAX_HEADER_BYTES = 16 * 1024;

export function boundaryFromContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : undefined;
}

export class MultipartParser extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'boundary' | 'headers' | 'body' = 'boundary';
  private headers: Record<string, string> = {};
  private expected = -1;
  private readonly delimiter: Buffer | undefined;
  private readonly maxPartBytes: number;

  constructor(opts: MultipartOptions = {}) {
    super({ readableObjectMode: true });
    this.delimiter = opts.boundary ? Buffer.from(`\r\n--${opts.boundary}`) : undefined;
    this.maxPartBytes = opts.maxPartBytes ?? 8 * 1024 * 1024;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    try {
      this.drain();
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  private drain(): void {
    for (;;) {
      if (this.state === 'boundary') {
        // Skip blank lines, then expect a line starting with "--".
        const nl = this.buf.indexOf(CRLF);
        if (nl === -1) {
          this.guard(MAX_HEADER_BYTES, 'boundary line');
          return;
        }
        const line = this.buf.toString('latin1', 0, nl);
        this.buf = this.buf.subarray(nl + 2);
        if (line.trim() === '') continue;
        if (!line.startsWith('--')) {
          throw new Error(`Multipart: expected boundary, got "${line.slice(0, 40)}"`);
        }
        this.state = 'headers';
        this.headers = {};
      }

      if (this.state === 'headers') {
        if (this.buf.length < 2) return;
        if (this.buf[0] === 0x0d && this.buf[1] === 0x0a) {
          // A part with no headers: the boundary line is followed by a blank line.
          this.buf = this.buf.subarray(2);
          this.beginBody();
          continue;
        }
        const end = this.buf.indexOf('\r\n\r\n');
        if (end === -1) {
          this.guard(MAX_HEADER_BYTES, 'part headers');
          return;
        }
        for (const line of this.buf.toString('latin1', 0, end).split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            this.headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
        }
        this.buf = this.buf.subarray(end + 4);
        this.beginBody();
      }

      if (this.state === 'body') {
        if (this.expected >= 0) {
          if (this.buf.length < this.expected) return;
          this.emitPart(this.buf.subarray(0, this.expected));
          this.buf = this.buf.subarray(this.expected);
        } else {
          if (!this.delimiter) {
            throw new Error('Multipart: part has no Content-Length and no boundary is known');
          }
          const idx = this.buf.indexOf(this.delimiter);
          if (idx === -1) {
            this.guard(this.maxPartBytes, 'part body');
            return;
          }
          this.emitPart(this.buf.subarray(0, idx));
          // Leave the CRLF so the boundary state sees "--..." on its own line.
          this.buf = this.buf.subarray(idx + 2);
        }
        this.state = 'boundary';
      }
    }
  }

  private beginBody(): void {
    const len = Number(this.headers['content-length']);
    this.expected = Number.isInteger(len) && len >= 0 ? len : -1;
    if (this.expected > this.maxPartBytes) {
      throw new Error(`Multipart: part of ${this.expected} bytes exceeds limit`);
    }
    this.state = 'body';
  }

  private emitPart(body: Buffer): void {
    // Copy so the part doesn't pin the (possibly large) shared buffer.
    this.push({ headers: this.headers, body: Buffer.from(body) } satisfies MultipartPart);
  }

  private guard(limit: number, what: string): void {
    if (this.buf.length > limit) throw new Error(`Multipart: ${what} exceeds ${limit} bytes`);
  }
}
