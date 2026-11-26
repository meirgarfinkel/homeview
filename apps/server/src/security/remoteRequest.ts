import type http from 'node:http';
import type { FastifyRequest } from 'fastify';
import { isLoopback } from './network.js';

/**
 * Requests that arrived on the remote listener, the one the tunnel helper
 * talks to. Only the listener marks them, so a header can never make a
 * request remote, or make a remote request look local.
 */
const remoteRequests = new WeakSet<http.IncomingMessage>();

export function markRemote(raw: http.IncomingMessage): void {
  remoteRequests.add(raw);
}

export function isRemote(req: FastifyRequest | http.IncomingMessage): boolean {
  return remoteRequests.has('raw' in req ? req.raw : req);
}

/**
 * True for a request from this computer. A remote request comes from the
 * tunnel helper on 127.0.0.1, so its socket address says nothing.
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  return !isRemote(req) && isLoopback(req.ip);
}

/**
 * Who sent the request, for rate limits and logs. For a remote request this
 * is the address the tunnel helper put in X-Forwarded-For. The helper
 * overwrites whatever the client sent, so it is the real client address.
 */
export function clientIp(req: FastifyRequest): string {
  if (!isRemote(req)) return req.ip;
  const header = req.headers['x-forwarded-for'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',', 1)[0]?.trim();
  return first || 'unknown';
}

/** Remote pages are HTTPS for the browser even though the last hop is plain HTTP. */
export function secureCookies(req: FastifyRequest): boolean {
  return isRemote(req) || req.protocol === 'https';
}
