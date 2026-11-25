import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { isLoopback } from './security/network.js';

/**
 * Listen on one port, and keep it and its connections open while the app
 * behind it changes.
 *
 * A small TCP front-end owns the port. It hands each connection to an HTTP
 * server (and with HTTPS on, an HTTPS server) that belongs to the listener,
 * not to an app, and never listens itself. Each request goes to whichever
 * app is current when it arrives. swap() makes a new app current and then
 * closes the old one, so a rebuild never refuses a connection or closes a
 * keep-alive one under a client that is about to reuse it.
 *
 * With HTTPS on, the front-end peeks at the first byte of each connection: a
 * TLS ClientHello (0x16) goes to the HTTPS server. Plain HTTP from this
 * computer is served as is, so http://localhost:8090 opens with no
 * certificate warning. Plain HTTP from anywhere else gets a redirect to the
 * https:// URL, so typing http://192.168.1.20:8090 still works.
 */

const TLS_HANDSHAKE = 0x16;

/** How long open requests get to finish when the server closes or swaps apps. */
export const CLOSE_GRACE_MS = 1000;

export interface DualListener {
  close(): Promise<void>;
  address(): net.AddressInfo;
  /**
   * Send requests to this app from now on, then close the previous app once
   * its open requests finish (or after CLOSE_GRACE_MS). The port and its
   * connections stay open. allowClient, if given, replaces the check on
   * new connections from then on. onSwitched runs at the moment requests
   * start going to the new app.
   */
  swap(app: FastifyInstance, opts?: SwapOptions): Promise<void>;
}

export interface SwapOptions {
  /** Which clients may connect, worked out again for the new app. */
  allowClient?: (ip: string | undefined) => boolean;
  onSwitched?: () => void;
}

interface FrontOptions {
  host: string;
  port: number;
  /** The HTTPS key pair. Without it the listener serves plain HTTP only. */
  tls?: { key: string; cert: string };
  allowClient?: (ip: string | undefined) => boolean;
  /** Who gets plain HTTP. Decided from the TCP peer address, never a header. */
  isLocalClient?: (ip: string | undefined) => boolean;
}

export async function listenHttpsWithRedirect(
  app: FastifyInstance,
  opts: {
    host: string;
    port: number;
    tls: { key: string; cert: string };
    allowClient: (ip: string | undefined) => boolean;
    /** Who gets plain HTTP. Decided from the TCP peer address, never a header. */
    isLocalClient?: (ip: string | undefined) => boolean;
  },
): Promise<DualListener> {
  return listenFront(app, opts);
}

/** Plain HTTP, with the same close and swap behaviour as the HTTPS listener. */
export async function listenHttp(
  app: FastifyInstance,
  opts: { host: string; port: number },
): Promise<DualListener> {
  return listenFront(app, opts);
}

async function listenFront(app: FastifyInstance, opts: FrontOptions): Promise<DualListener> {
  await app.ready();
  let current = app;
  let allowClient = opts.allowClient ?? (() => true);
  const isLocalClient = opts.isLocalClient ?? isLoopback;
  let boundPort = opts.port;

  /** Open requests per app, so a swap can let the old app's finish. */
  const open = new Map<FastifyInstance, number>();
  const finished = new Map<FastifyInstance, () => void>();
  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const target = current;
    open.set(target, (open.get(target) ?? 0) + 1);
    res.once('close', () => {
      const left = (open.get(target) ?? 1) - 1;
      if (left > 0) {
        open.set(target, left);
        return;
      }
      open.delete(target);
      finished.get(target)?.();
    });
    target.routing(req, res);
  };

  // Neither server listens itself, so Node doesn't track their connections
  // and closeIdleConnections() does nothing. Track them here. A TLS socket
  // counts once its handshake is done.
  const sockets = trackSockets();
  const handed = new Set<net.Socket>();
  const busy = new Set<net.Socket>();
  let closing = false;
  const trackConnection = (socket: net.Socket) => {
    handed.add(socket);
    socket.once('close', () => {
      handed.delete(socket);
      busy.delete(socket);
    });
  };
  const servers: (http.Server | https.Server)[] = [];
  const plain = http.createServer(dispatch);
  servers.push(plain);
  let secure: https.Server | undefined;
  if (opts.tls) {
    secure = https.createServer(
      { key: opts.tls.key, cert: opts.tls.cert, minVersion: 'TLSv1.2' },
      dispatch,
    );
    secure.on('secureConnection', trackConnection);
    servers.push(secure);
  }
  for (const server of servers) {
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      busy.add(req.socket);
      res.once('close', () => {
        busy.delete(req.socket);
        // Once closing, a keep-alive connection ends with its last reply.
        if (closing) req.socket.destroy();
      });
    });
    server.on('upgrade', upgrade);
  }
  const closeIdle = () => {
    for (const socket of handed) if (!busy.has(socket)) socket.destroy();
  };
  // The live WebSocket's upgrade handler is on app.server. Upgraded sockets
  // belong to that app's WebSocket server, which closes them with the app.
  function upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    busy.add(socket);
    current.server.emit('upgrade', req, socket, head);
  }

  const front = net.createServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    if (closing || !allowClient(socket.remoteAddress)) {
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
      if (secure && first[0] === TLS_HANDSHAKE) {
        secure.emit('connection', socket);
      } else if (!secure || isLocalClient(socket.remoteAddress)) {
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

  /** Resolves once the app has no open requests, or after CLOSE_GRACE_MS. */
  const settled = (target: FastifyInstance) =>
    new Promise<void>((resolve) => {
      if (!open.get(target)) {
        resolve();
        return;
      }
      const timer = setTimeout(done, CLOSE_GRACE_MS);
      function done() {
        clearTimeout(timer);
        finished.delete(target);
        resolve();
      }
      finished.set(target, done);
    });

  return {
    address: () => front.address() as net.AddressInfo,
    swap: async (next, { allowClient: nextAllowClient, onSwitched } = {}) => {
      if (closing) throw new Error('The listener is closed');
      // Get the new app fully ready first, so the switch itself is instant.
      await next.ready();
      const previous = current;
      current = next;
      if (nextAllowClient) allowClient = nextAllowClient;
      onSwitched?.();
      await settled(previous);
      // Closes the old app's WebSockets. Its connections stay with the listener.
      await previous.close();
    },
    close: () =>
      closeGracefully(
        current,
        sockets,
        () => new Promise<void>((r) => front.close(() => r())),
        () => {
          closing = true;
          closeIdle();
        },
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
