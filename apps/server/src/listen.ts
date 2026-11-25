import http from 'node:http';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { isLoopback } from './security/network.js';

/**
 * Listen on one port for both HTTPS and plain HTTP.
 *
 * Fastify owns an HTTPS server that is never bound directly. A small TCP
 * front-end peeks at the first byte of each connection: a TLS ClientHello
 * (0x16) is handed to the HTTPS server. Plain HTTP from this computer is
 * served as is, so http://localhost:8090 opens with no certificate warning.
 * Plain HTTP from anywhere else gets a redirect to the https:// URL, so
 * typing http://192.168.1.20:8090 still works.
 */

const TLS_HANDSHAKE = 0x16;

/** How long open requests get to finish when the server closes. */
export const CLOSE_GRACE_MS = 1000;

export interface DualListener {
  close(): Promise<void>;
  address(): net.AddressInfo;
}

export async function listenHttpsWithRedirect(
  app: FastifyInstance,
  opts: {
    host: string;
    port: number;
    allowClient: (ip: string | undefined) => boolean;
    /** Who gets plain HTTP. Decided from the TCP peer address, never a header. */
    isLocalClient?: (ip: string | undefined) => boolean;
  },
): Promise<DualListener> {
  await app.ready();
  const https = app.server;
  const isLocalClient = opts.isLocalClient ?? isLoopback;
  // Plain HTTP for this computer. Like the HTTPS server it never listens;
  // the front-end hands it connections. The live WebSocket's upgrade
  // handler is on app.server, so pass upgrades on to it.
  const plain = http.createServer(app.routing);
  plain.on('upgrade', (req, socket, head) => https.emit('upgrade', req, socket, head));

  let boundPort = opts.port;
  const sockets = trackSockets();
  // Neither server listens itself, so Node doesn't track their connections
  // and closeIdleConnections() does nothing. Track them here.
  const handed = new Set<net.Socket>();
  const busy = new Set<net.Socket>();
  const trackConnection = (socket: net.Socket) => {
    handed.add(socket);
    socket.once('close', () => {
      handed.delete(socket);
      busy.delete(socket);
    });
  };
  https.on('secureConnection', trackConnection);
  for (const server of [https, plain]) {
    server.on(
      'request',
      (req: { socket: net.Socket }, res: { once(e: 'close', f: () => void): void }) => {
        busy.add(req.socket);
        res.once('close', () => busy.delete(req.socket));
      },
    );
    // Upgraded sockets belong to the WebSocket server, which closes them.
    server.on('upgrade', (req: { socket: net.Socket }) => busy.add(req.socket));
  }
  const closeIdle = () => {
    for (const socket of handed) if (!busy.has(socket)) socket.destroy();
  };
  const front = net.createServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
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
      } else if (isLocalClient(socket.remoteAddress)) {
        trackConnection(socket);
        plain.emit('connection', socket);
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
    // front.close() waits for every socket it accepted, including the ones
    // handed to the HTTPS server, so close those too rather than wait.
    close: () =>
      closeGracefully(
        app,
        sockets,
        () => new Promise<void>((r) => front.close(() => r())),
        closeIdle,
      ),
  };
}

/** Plain HTTP, with the same close behaviour as the HTTPS listener. */
export async function listenHttp(
  app: FastifyInstance,
  opts: { host: string; port: number },
): Promise<DualListener> {
  await app.listen({ host: opts.host, port: opts.port });
  // No connection is handled before the listen callback, so none are missed.
  const sockets = trackSockets();
  app.server.on('connection', (socket: net.Socket) => sockets.add(socket));
  return {
    address: () => app.server.address() as net.AddressInfo,
    close: () =>
      closeGracefully(
        app,
        sockets,
        async () => undefined,
        () => app.server.closeIdleConnections(),
      ),
  };
}

function trackSockets(): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  const add = sockets.add.bind(sockets);
  sockets.add = (socket) => {
    socket.once('close', () => sockets.delete(socket));
    return add(socket);
  };
  return sockets;
}

/**
 * Stop accepting and close idle keep-alive connections at once. app.close()
 * closes the WebSockets. Whatever is still open after CLOSE_GRACE_MS is destroyed.
 */
async function closeGracefully(
  app: FastifyInstance,
  sockets: Set<net.Socket>,
  stopAccepting: () => Promise<void>,
  closeIdle: () => void,
): Promise<void> {
  const stopped = stopAccepting();
  const force = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, CLOSE_GRACE_MS);
  try {
    closeIdle();
    await app.close();
    closeIdle();
    await stopped;
  } finally {
    clearTimeout(force);
  }
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
