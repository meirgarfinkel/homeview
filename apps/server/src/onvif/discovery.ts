/** WS-Discovery: find ONVIF cameras on the local network. */
import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import type { Logger } from '../logger.js';
import { isPrivateAddress } from '../security/network.js';
import { child, children, parseXml, text } from './xml.js';

export interface DiscoveredOnvif {
  /** The camera's stable id, e.g. urn:uuid:... */
  endpointId: string;
  /** The device service address. */
  xaddr: string;
  host: string;
  name?: string;
  hardware?: string;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Where to send the probe instead of the multicast group. For tests. */
  targets?: string[];
  port?: number;
  logger: Logger;
}

const MULTICAST = '239.255.255.250';
const PORT = 3702;
const MAX_NAME = 64;

function probe(messageId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>uuid:${messageId}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
  );
}

function scope(scopes: string[], kind: string): string | undefined {
  const prefix = `onvif://www.onvif.org/${kind}/`;
  const found = scopes.find((s) => s.startsWith(prefix));
  if (!found) return undefined;
  let value = found.slice(prefix.length);
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep it as sent
  }
  value = [...value]
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join('')
    .trim();
  return value ? value.slice(0, MAX_NAME) : undefined;
}

/** Parse one ProbeMatches packet into cameras with a private device address. */
export function parseProbeMatches(xml: string): DiscoveredOnvif[] {
  const doc = parseXml(xml);
  const matches = children(child(doc, 'Envelope', 'Body', 'ProbeMatches'), 'ProbeMatch');
  const out: DiscoveredOnvif[] = [];
  for (const m of matches) {
    const endpointId = text(child(m, 'EndpointReference', 'Address'));
    const xaddrs = (text(child(m, 'XAddrs')) ?? '').split(/\s+/).filter(Boolean);
    const scopes = (text(child(m, 'Scopes')) ?? '').split(/\s+/).filter(Boolean);
    if (!endpointId) continue;
    for (const xaddr of xaddrs) {
      let url: URL;
      try {
        url = new URL(xaddr);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!isPrivateAddress(host)) continue;
      const name = scope(scopes, 'name');
      const hardware = scope(scopes, 'hardware');
      out.push({
        endpointId,
        xaddr,
        host,
        ...(name ? { name } : {}),
        ...(hardware ? { hardware } : {}),
      });
      break;
    }
  }
  return out;
}

export function discoverOnvif(opts: DiscoverOptions): Promise<DiscoveredOnvif[]> {
  const found = new Map<string, DiscoveredOnvif>();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const message = Buffer.from(probe(randomUUID()));
  const port = opts.port ?? PORT;
  return new Promise((resolve) => {
    const done = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    socket.on('error', (err) => {
      opts.logger.warn({ err: err.message }, 'ONVIF search failed');
      done();
    });
    socket.on('message', (msg) => {
      try {
        for (const cam of parseProbeMatches(msg.toString('utf8'))) {
          if (!found.has(cam.endpointId)) found.set(cam.endpointId, cam);
        }
      } catch {
        // not a ProbeMatches we can read
      }
    });
    socket.bind(0, () => {
      for (const target of opts.targets ?? [MULTICAST]) socket.send(message, port, target);
      setTimeout(done, opts.timeoutMs ?? 3000).unref();
    });
  });
}
