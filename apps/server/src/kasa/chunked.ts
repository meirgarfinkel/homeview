import { Transform, type TransformCallback } from 'node:stream';

/**
 * Incremental decoder for HTTP/1.1 `Transfer-Encoding: chunked` bodies.
 * Input may be split at any byte boundary.
 */
export class ChunkedDecoder extends Transform {
  private state: 'size' | 'data' | 'data-crlf' | 'trailer' | 'done' = 'size';
  private line = '';
  private remaining = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    try {
      this.consume(chunk);
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    // A live stream usually ends by the socket closing mid-chunk; that's fine.
    done();
  }

  private consume(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length && this.state !== 'done') {
      switch (this.state) {
        case 'size':
        case 'trailer': {
          const nl = chunk.indexOf(0x0a, i);
          const end = nl === -1 ? chunk.length : nl;
          this.line += chunk.toString('latin1', i, end);
          if (this.line.length > 1024) throw new Error('Chunked encoding: line too long');
          i = end;
          if (nl === -1) break;
          i = nl + 1;
          const line = this.line.replace(/\r$/, '');
          this.line = '';
          if (this.state === 'trailer') {
            if (line === '') {
              this.state = 'done';
              this.push(null);
            }
            break;
          }
          if (line === '') break; // tolerate stray blank lines between chunks
          const size = Number.parseInt(line.split(';', 1)[0]!.trim(), 16);
          if (!Number.isFinite(size) || size < 0) {
            throw new Error(`Chunked encoding: bad chunk size "${line.slice(0, 40)}"`);
          }
          if (size === 0) {
            this.state = 'trailer';
          } else {
            this.remaining = size;
            this.state = 'data';
          }
          break;
        }
        case 'data': {
          const take = Math.min(this.remaining, chunk.length - i);
          this.push(chunk.subarray(i, i + take));
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.state = 'data-crlf';
          break;
        }
        case 'data-crlf': {
          const byte = chunk[i]!;
          i++;
          if (byte === 0x0a) this.state = 'size';
          else if (byte !== 0x0d) throw new Error('Chunked encoding: missing CRLF after chunk');
          break;
        }
      }
    }
  }
}
