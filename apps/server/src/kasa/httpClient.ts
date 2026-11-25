import { PassThrough, type Readable } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import { ChunkedDecoder } from './chunked.js';
import { assertPinnedCertificate, cameraTlsOptions, type CameraTlsConfig } from './tls.js';

/**
 * A deliberately small HTTPS/1.1 client for the camera.
 *
 * Node's http module is not used because the camera's stream endpoint is not
 * well-behaved HTTP (other clients need `curl --ignore-content-length`), and
 * because credentials must only be sent after the certificate pin is checked.
 */

export interface CameraRequest {
  host: string;
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  tls?: CameraTlsConfig;
  /** Time allowed for connect + TLS + response headers. */
  timeoutMs: number;
  /** Ignore Content-Length and read until the connection closes. */
  ignoreContentLength?: boolean;
  signal?: AbortSignal;
  /** An already connected socket from connectCamera(), instead of a new one. */
  socket?: TLSSocket;
}

export interface CameraResponse {
  statusCode: number;
  statusMessage: string;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: Readable;
  socket: TLSSocket;
  close(): void;
}

const MAX_HEADER_BYTES = 32 * 1024;

export class CameraHttpError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'network' | 'protocol' | 'aborted',
  ) {
    super(message);
    this.name = 'CameraHttpError';
  }
}

export function cameraRequest(req: CameraRequest): Promise<CameraResponse> {
  return new Promise<CameraResponse>((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new CameraHttpError('Request aborted', 'aborted'));
      return;
    }

    const reused = req.socket;
    const socket =
      reused ??
      tls.connect({
        ...cameraTlsOptions,
        host: req.host,
        port: req.port,
        // SNI must not be an IP address; the camera doesn't need it anyway.
        servername: '',
      });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onAbort = () => fail(new CameraHttpError('Request aborted', 'aborted'));
    const timer = setTimeout(
      () =>
        fail(new CameraHttpError(`Camera did not respond within ${req.timeoutMs} ms`, 'timeout')),
      req.timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const onError = (err: Error) => fail(new CameraHttpError(err.message, 'network'));
    const onClose = () =>
      fail(new CameraHttpError('Camera closed the connection before responding', 'network'));
    socket.on('error', onError);
    socket.on('close', onClose);

    const send = () => {
      try {
        assertPinnedCertificate(socket, req.tls ?? {});
      } catch (err) {
        fail(err as Error);
        return;
      }
      const headers: Record<string, string> = {
        Host: `${req.host}:${req.port}`,
        'User-Agent': 'kasa-home/0.1',
        Accept: '*/*',
        Connection: 'close',
        ...req.headers,
      };
      if (req.body) headers['Content-Length'] = String(req.body.length);
      const head =
        `${req.method} ${req.path} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n';
      socket.write(head);
      if (req.body) socket.write(req.body);
    };
    if (reused) {
      if (reused.destroyed || !reused.writable) {
        fail(new CameraHttpError('Spare connection already closed', 'network'));
      } else {
        send();
      }
    } else {
      socket.once('secureConnect', send);
    }

    let headBuf: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      headBuf = headBuf.length === 0 ? chunk : Buffer.concat([headBuf, chunk]);
      const end = headBuf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (headBuf.length > MAX_HEADER_BYTES) {
          fail(new CameraHttpError('Response headers too large', 'protocol'));
        }
        return;
      }
      let parsed: ReturnType<typeof parseHead>;
      try {
        parsed = parseHead(headBuf.toString('latin1', 0, end));
      } catch (err) {
        fail(err as Error);
        return;
      }
      settled = true;
      cleanup();
      socket.pause();

      const rest = headBuf.subarray(end + 4);
      const raw = new PassThrough();
      socket.on('error', (err) => raw.destroy(err));
      raw.on('close', () => socket.destroy());

      let body: Readable = raw;
      const chunked = /\bchunked\b/i.test(parsed.headers['transfer-encoding'] ?? '');
      const length = Number(parsed.headers['content-length']);
      if (chunked) {
        const decoder = new ChunkedDecoder();
        raw.pipe(decoder);
        raw.on('error', (err) => decoder.destroy(err));
        decoder.on('close', () => raw.destroy());
        body = decoder;
      } else if (!req.ignoreContentLength && Number.isFinite(length) && length >= 0) {
        body = limitStream(raw, length);
      }
      if (rest.length > 0) raw.write(rest);
      socket.pipe(raw);
      socket.resume();

      resolve({
        ...parsed,
        body,
        socket,
        close: () => {
          body.destroy();
          raw.destroy();
          socket.destroy();
        },
      });
    };
    socket.on('data', onData);
  });
}

function parseHead(text: string): Pick<CameraResponse, 'statusCode' | 'statusMessage' | 'headers'> {
  const lines = text.split(/\r?\n/);
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? '');
  if (!status) {
    throw new CameraHttpError(
      `Unexpected status line: ${(lines[0] ?? '').slice(0, 60)}`,
      'protocol',
    );
  }
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { statusCode: Number(status[1]), statusMessage: status[2] ?? '', headers };
}

function limitStream(source: Readable, length: number): Readable {
  const out = new PassThrough();
  let left = length;
  if (left === 0) {
    out.end();
    source.destroy();
    return out;
  }
  source.on('data', (chunk: Buffer) => {
    if (left <= 0) return;
    const piece = chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= piece.length;
    out.write(piece);
    if (left === 0) {
      out.end();
      source.destroy();
    }
  });
  source.on('end', () => out.end());
  source.on('error', (err) => out.destroy(err));
  return out;
}

/** Collect a (small) response body, failing if it exceeds maxBytes. */
export async function readAll(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy();
      throw new CameraHttpError(`Response larger than ${maxBytes} bytes`, 'protocol');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Open a TLS connection to the camera and finish the handshake, without
 * sending anything. The camera's handshake is slow (~0.5 s), so a socket
 * opened ahead of time lets an urgent request (stopping the motor) go out
 * at once. The camera keeps such idle connections open for at least 10 s.
 */
export function connectCamera(
  host: string,
  port: number,
  tlsConfig: CameraTlsConfig = {},
  timeoutMs = 8000,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...cameraTlsOptions, host, port, servername: '' });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CameraHttpError('TLS handshake timed out', 'timeout'));
    }, timeoutMs);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new CameraHttpError(err.message, 'network'));
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        assertPinnedCertificate(socket, tlsConfig);
      } catch (err) {
        socket.destroy();
        reject(err as Error);
        return;
      }
      socket.removeAllListeners('error');
      socket.on('error', () => socket.destroy());
      resolve(socket);
    });
  });
}
