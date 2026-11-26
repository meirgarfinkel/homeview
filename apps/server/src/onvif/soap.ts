/**
 * ONVIF SOAP 1.2 over HTTP. Signs requests with WS-Security UsernameToken
 * (PasswordDigest), corrected for the camera's clock, and falls back to HTTP
 * Digest for cameras that want that instead.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Logger } from '../logger.js';
import { authorizationFor, pickChallenge } from '../rtsp/auth.js';
import { isPrivateAddress } from '../security/network.js';
import { child, escapeXml, MAX_XML_BYTES, parseXml, text } from './xml.js';

export class OnvifAuthError extends Error {
  constructor() {
    super("The camera didn't accept that username or password.");
  }
}
export class OnvifUnreachableError extends Error {}
export class OnvifFaultError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`The camera refused the request (${code}${reason ? `: ${reason}` : ''})`);
  }
}

export interface SoapClientOptions {
  deviceUrl: string;
  username: string;
  password: string;
  allowPublicHost: boolean;
  logger: Logger;
  now?: () => Date;
  timeoutMs?: number;
}

/** Base64(SHA1(nonce + created + password)), WS-Security UsernameToken Profile 1.0. */
export function passwordDigest(nonce: Buffer, created: string, password: string): string {
  return createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
    .digest('base64');
}

const SOAP_ENV = 'http://www.w3.org/2003/05/soap-envelope';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const DIGEST_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const NONCE_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary';

interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type AuthMode = 'ws-security' | 'digest';

export class SoapClient {
  private clockOffsetMs: number | undefined;
  private mode: AuthMode | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: SoapClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Call one operation; `body` is the inner XML of the SOAP Body. Returns the parsed Body. */
  async call(serviceUrl: string, body: string): Promise<unknown> {
    await this.readClock();
    if (this.mode === 'digest') return this.callDigest(serviceUrl, body);
    if (this.mode === 'ws-security') return this.callWs(serviceUrl, body);
    try {
      const result = await this.callWs(serviceUrl, body);
      this.mode = 'ws-security';
      return result;
    } catch (err) {
      if (!(err instanceof OnvifAuthError)) throw err;
    }
    const result = await this.callDigest(serviceUrl, body);
    this.mode = 'digest';
    return result;
  }

  /** The camera's clock, read once without a login, so WS-Security times match it. */
  private async readClock(): Promise<void> {
    if (this.clockOffsetMs !== undefined) return;
    this.clockOffsetMs = 0;
    try {
      const answer = await this.post(
        this.opts.deviceUrl,
        envelope('<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>'),
      );
      const parsed = this.parseAnswer(answer);
      const utc = child(parsed, 'GetSystemDateAndTimeResponse', 'SystemDateAndTime', 'UTCDateTime');
      const n = (...path: string[]) => Number(text(child(utc, ...path)));
      const camera = Date.UTC(
        n('Date', 'Year'),
        n('Date', 'Month') - 1,
        n('Date', 'Day'),
        n('Time', 'Hour'),
        n('Time', 'Minute'),
        n('Time', 'Second'),
      );
      if (Number.isFinite(camera)) this.clockOffsetMs = camera - this.now().getTime();
    } catch (err) {
      if (err instanceof OnvifUnreachableError) {
        this.clockOffsetMs = undefined;
        throw err;
      }
      this.opts.logger.debug({ err: (err as Error).message }, "Couldn't read the camera clock");
    }
  }

  private async callWs(serviceUrl: string, body: string): Promise<unknown> {
    const nonce = randomBytes(16);
    const created = new Date(this.now().getTime() + (this.clockOffsetMs ?? 0))
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const security =
      `<Security s:mustUnderstand="1" xmlns="${WSSE}"><UsernameToken>` +
      `<Username>${escapeXml(this.opts.username)}</Username>` +
      `<Password Type="${DIGEST_TYPE}">${passwordDigest(nonce, created, this.opts.password)}</Password>` +
      `<Nonce EncodingType="${NONCE_TYPE}">${nonce.toString('base64')}</Nonce>` +
      `<Created xmlns="${WSU}">${created}</Created>` +
      `</UsernameToken></Security>`;
    const answer = await this.post(serviceUrl, envelope(body, security));
    if (answer.status === 401) throw new OnvifAuthError();
    return this.parseAnswer(answer);
  }

  private async callDigest(serviceUrl: string, body: string): Promise<unknown> {
    const xml = envelope(body);
    let answer = await this.post(serviceUrl, xml);
    if (answer.status === 401) {
      const raw = answer.headers['www-authenticate'];
      const challenge = pickChallenge(Array.isArray(raw) ? raw : raw ? [raw] : [], {
        allowBasic: false,
      });
      if (!challenge) throw new OnvifAuthError();
      const path = new URL(serviceUrl).pathname;
      const authorization = authorizationFor(
        challenge,
        'POST',
        path,
        this.opts.username,
        this.opts.password,
      );
      answer = await this.post(serviceUrl, xml, { Authorization: authorization });
      if (answer.status === 401) throw new OnvifAuthError();
    }
    return this.parseAnswer(answer);
  }

  private parseAnswer(answer: HttpAnswer): unknown {
    let doc: unknown;
    try {
      doc = parseXml(answer.body);
    } catch (err) {
      if (answer.status !== 200) {
        throw new OnvifFaultError(`HTTP ${answer.status}`, '');
      }
      throw err;
    }
    const bodyNode = child(doc, 'Envelope', 'Body');
    const fault = child(bodyNode, 'Fault');
    if (fault !== undefined) {
      const codes = [
        text(child(fault, 'Code', 'Value')),
        text(child(fault, 'Code', 'Subcode', 'Value')),
        text(child(fault, 'Code', 'Subcode', 'Subcode', 'Value')),
      ].filter((c): c is string => c !== undefined);
      const reason = text(child(fault, 'Reason', 'Text')) ?? '';
      if (codes.some((c) => /NotAuthorized|FailedAuthentication|InvalidSecurity/i.test(c))) {
        throw new OnvifAuthError();
      }
      if (/not authori[sz]ed|authority failure|sender not authori/i.test(reason)) {
        throw new OnvifAuthError();
      }
      const code = (codes.at(-1) ?? 'Fault').replace(/^.*:/, '');
      throw new OnvifFaultError(code, reason);
    }
    if (answer.status !== 200 || bodyNode === undefined) {
      throw new OnvifFaultError(`HTTP ${answer.status}`, '');
    }
    return bodyNode;
  }

  private async post(
    url: string,
    xml: string,
    headers: Record<string, string> = {},
  ): Promise<HttpAnswer> {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    let address: string;
    try {
      address = net.isIP(host) ? host : (await lookup(host)).address;
    } catch {
      throw new OnvifUnreachableError(`Can't find the camera at ${host}`);
    }
    if (!this.opts.allowPublicHost && !isPrivateAddress(address)) {
      throw new OnvifUnreachableError(
        `The camera address ${host} is not a local-network address. Refusing to send the camera login off the local network.`,
      );
    }
    const isHttps = target.protocol === 'https:';
    const request = isHttps ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: address,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            Host: target.host,
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(xml),
            ...headers,
          },
          // Cameras use self-signed certificates; the login is digest-protected either way.
          ...(isHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            req.destroy();
            reject(
              new OnvifUnreachableError(
                'The camera tried to redirect the request; not following it.',
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_XML_BYTES) {
              req.destroy();
              reject(new Error('Camera answer too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', (err) => reject(new OnvifUnreachableError(err.message)));
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new OnvifUnreachableError(`No answer from the camera at ${target.host}`));
      });
      req.on('error', (err) =>
        reject(new OnvifUnreachableError(`Can't reach the camera: ${err.message}`)),
      );
      req.end(xml);
    });
  }
}

function envelope(body: string, security = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${SOAP_ENV}"><s:Header>${security}</s:Header><s:Body>${body}</s:Body></s:Envelope>`
  );
}
