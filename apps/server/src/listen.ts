import net from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * Listen on one port for both HTTPS and plain HTTP.
 *
 * Fastify owns an HTTPS server that is never bound directly. A small TCP
 * front-end peeks at the first byte of each connection: a TLS ClientHello
 * (0x16) is handed to the HTTPS server, anything else gets a redirect to
 * the https:// URL, so typing http://192.168.1.20:8090 still works.
 */

const TLS_HANDSHAKE = 0x16;

export interface DualListener {
  close(): Promise<void>;
  address(): net.AddressInfo;
}

export async function listenHttpsWithRedirect(
  app: FastifyInstance,
  opts: { host: string; port: number; allowClient: (ip: string | undefined) => boolean },
): Promise<DualListener> {
  await app.ready();
  const https = app.server;

  let boundPort = opts.port;
  const front = net.createServer({ pauseOnConnect: true }, (socket) => {
    if (!opts.allowClient(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    // Drop connections that never send anything.
    socket.setTimeout(10_000, () => socket.destroy());
    // Peek at one byte via read()+unshift(). (Consuming a 'data' chunk and
    // unshifting it does not work: the TLS layer reads the native handle.)
    socket.once('readable', () => {
      const first = socket.read(1) as Buffer | null;
      if (!first) {
        socket.destroy();
        return;
      }
      socket.setTimeout(0);
      socket.unshift(first);
      if (first[0] === TLS_HANDSHAKE) {
        https.emit('connection', socket);
      } else {
        readRequestHead(socket, (head) => redirectToHttps(socket, head, boundPort));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    front.once('error', reject);
    front.listen(opts.port, opts.host, () => {
      front.removeListener('error', reject);
      boundPort = (front.address() as net.AddressInfo).port;
      resolve();
    });
  });

  return {
    address: () => front.address() as net.AddressInfo,
    close: async () => {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await app.close();
    },
  };
}

/** Collect a plain-HTTP request head (up to 4 KiB). */
function readRequestHead(socket: net.Socket, done: (head: string) => void): void {
  let buf = '';
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('latin1');
    if (buf.includes('\r\n\r\n') || buf.includes('\n\n') || buf.length > 4096) {
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      done(buf.slice(0, 4096));
    }
  });
}

function redirectToHttps(socket: net.Socket, head: string, port: number): void {
  const requestLine = /^[A-Z]+ (\S+) HTTP\/1\.[01]\r?\n/.exec(head);
  const hostHeader = /\r?\nhost:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '';
  // Rebuild the host from the hostname only; never echo arbitrary header text.
  const hostname = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(hostHeader)?.[1];
  const path = requestLine?.[1]?.startsWith('/') ? requestLine[1] : '/';
  if (!requestLine || !hostname) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const location = `https://${hostname}:${port}${path}`;
  socket.end(
    `HTTP/1.1 308 Permanent Redirect\r\nLocation: ${location}\r\n` +
      'Content-Length: 0\r\nConnection: close\r\n\r\n',
  );
}
