/**
 * A fake ONVIF camera for the tests and `pnpm dev:fake-onvif`: device, media
 * and PTZ services on one HTTP endpoint, WS-Security or HTTP Digest login,
 * and WS-Discovery replies. Not for production use.
 */
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { passwordDigest } from '../onvif/soap.js';
import type { OnvifProfile } from '../onvif/device.js';
import { attr, child, escapeXml, firstElementName, parseXml, text } from '../onvif/xml.js';
import { parseChallengeParams } from '../rtsp/auth.js';

export interface FakeOnvifOptions {
  username: string;
  password: string;
  auth: 'ws-security' | 'digest';
  /** How far the camera's clock is from this computer's. */
  clockSkewMs?: number;
  profiles: OnvifProfile[];
  /** What GetStreamUri answers, as a camera would (possibly with a wrong host). */
  streamUri: string;
  /** Offer the PTZ service. Default true. */
  ptz?: boolean;
  /** Support RelativeMove. Default false. */
  relativeMove?: boolean;
  presets?: string[];
  serial: string;
  mac: string;
  endpointId: string;
  name?: string;
  /** Answer WS-Discovery probes on this UDP port (0 = any free port). */
  discoveryPort?: number;
  /** The XAddr to advertise in discovery instead of the real one. */
  advertiseXaddr?: string;
  /** Send each ProbeMatch this many times. */
  repeatMatches?: number;
  /** Name services by this host in GetServices, as cameras behind NAT do. */
  serviceHost?: string;
  host?: string;
  port?: number;
}

export interface FakeOnvif {
  readonly deviceUrl: string;
  readonly discoveryPort: number | undefined;
  /** PTZ commands received, e.g. "ContinuousMove main 0.5 0". */
  readonly moves: string[];
  /** Requests that carried a WS-Security header. */
  readonly wsSecurityAttempts: number;
  close(): Promise<void>;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const CREATED_WINDOW_MS = 5 * 60_000;

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
};

function envelope(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
    'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" ' +
    'xmlns:ter="http://www.onvif.org/ver10/error">' +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

function fault(subcode: string, reason: string): string {
  return envelope(
    '<s:Fault><s:Code><s:Value>s:Sender</s:Value>' +
      `<s:Subcode><s:Value>${subcode}</s:Value></s:Subcode></s:Code>` +
      `<s:Reason><s:Text xml:lang="en">${reason}</s:Text></s:Reason></s:Fault>`,
  );
}

export async function startFakeOnvif(opts: FakeOnvifOptions): Promise<FakeOnvif> {
  const host = opts.host ?? '127.0.0.1';
  const realm = 'FakeOnvif';
  const nonce = randomBytes(8).toString('hex');
  const moves: string[] = [];
  const stats = { ws: 0 };
  const hasPtz = opts.ptz ?? true;
  const cameraNow = () => new Date(Date.now() + (opts.clockSkewMs ?? 0));
  let deviceUrl = '';
  let port = 0;

  const wsOk = (security: unknown): boolean => {
    const token = child(security, 'UsernameToken');
    const password = child(token, 'Password');
    const nonceText = text(child(token, 'Nonce'));
    const created = text(child(token, 'Created'));
    if (text(child(token, 'Username')) !== opts.username || !nonceText || !created) return false;
    if (Math.abs(Date.parse(created) - cameraNow().getTime()) > CREATED_WINDOW_MS) return false;
    if (!/PasswordDigest$/.test(attr(password, 'Type') ?? '')) return false;
    return (
      text(password) === passwordDigest(Buffer.from(nonceText, 'base64'), created, opts.password)
    );
  };

  const digestOk = (header: string | undefined, path: string): boolean => {
    if (!header || !/^digest\s/i.test(header)) return false;
    const p = parseChallengeParams(header);
    if (p['username'] !== opts.username || p['nonce'] !== nonce || p['uri'] !== path) return false;
    const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
    const ha2 = md5(`POST:${path}`);
    const expected = p['qop']
      ? md5(`${ha1}:${nonce}:${p['nc']}:${p['cnonce']}:${p['qop']}:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);
    return p['response'] === expected;
  };

  const serviceUrl = () => `http://${opts.serviceHost ?? host}:${port}/onvif/device_service`;

  const answer = (op: string, req: unknown): string | undefined => {
    const token = text(child(req, 'ProfileToken')) ?? '';
    switch (op) {
      case 'GetServices': {
        const service = (ns: string) =>
          `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${serviceUrl()}</tds:XAddr>` +
          '<tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version></tds:Service>';
        return (
          `<tds:GetServicesResponse>${service(NS.device)}${service(NS.media)}` +
          `${hasPtz ? service(NS.ptz) : ''}</tds:GetServicesResponse>`
        );
      }
      case 'GetCapabilities':
        return (
          '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
          `<tt:Media><tt:XAddr>${serviceUrl()}</tt:XAddr></tt:Media>` +
          (hasPtz ? `<tt:PTZ><tt:XAddr>${serviceUrl()}</tt:XAddr></tt:PTZ>` : '') +
          '</tds:Capabilities></tds:GetCapabilitiesResponse>'
        );
      case 'GetDeviceInformation':
        return (
          '<tds:GetDeviceInformationResponse><tds:Manufacturer>FakeCam</tds:Manufacturer>' +
          '<tds:Model>FC-1</tds:Model><tds:FirmwareVersion>1.0</tds:FirmwareVersion>' +
          `<tds:SerialNumber>${escapeXml(opts.serial)}</tds:SerialNumber>` +
          '<tds:HardwareId>FC-1</tds:HardwareId></tds:GetDeviceInformationResponse>'
        );
      case 'GetNetworkInterfaces':
        return (
          '<tds:GetNetworkInterfacesResponse><tds:NetworkInterfaces token="eth0">' +
          `<tt:Enabled>true</tt:Enabled><tt:Info><tt:HwAddress>${opts.mac}</tt:HwAddress></tt:Info>` +
          '</tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>'
        );
      case 'GetProfiles':
        return (
          '<trt:GetProfilesResponse>' +
          opts.profiles
            .map(
              (p) =>
                `<trt:Profiles token="${escapeXml(p.token)}" fixed="true"><tt:Name>${escapeXml(p.name)}</tt:Name>` +
                `<tt:VideoEncoderConfiguration token="v-${escapeXml(p.token)}"><tt:Name>enc</tt:Name>` +
                `<tt:Encoding>${p.codec === 'h264' ? 'H264' : p.codec === 'h265' ? 'H265' : 'JPEG'}</tt:Encoding>` +
                `<tt:Resolution><tt:Width>${p.width}</tt:Width><tt:Height>${p.height}</tt:Height></tt:Resolution>` +
                '</tt:VideoEncoderConfiguration>' +
                (p.hasPtz && hasPtz
                  ? '<tt:PTZConfiguration token="ptz"><tt:Name>ptz</tt:Name></tt:PTZConfiguration>'
                  : '') +
                '</trt:Profiles>',
            )
            .join('') +
          '</trt:GetProfilesResponse>'
        );
      case 'GetStreamUri':
        return (
          '<trt:GetStreamUriResponse><trt:MediaUri>' +
          `<tt:Uri>${escapeXml(opts.streamUri)}</tt:Uri><tt:Timeout>PT0S</tt:Timeout>` +
          '</trt:MediaUri></trt:GetStreamUriResponse>'
        );
      case 'ContinuousMove': {
        const pt = child(req, 'Velocity', 'PanTilt');
        moves.push(`ContinuousMove ${token} ${attr(pt, 'x')} ${attr(pt, 'y')}`);
        return '<tptz:ContinuousMoveResponse/>';
      }
      case 'Stop':
        moves.push(`Stop ${token}`);
        return '<tptz:StopResponse/>';
      case 'RelativeMove': {
        if (!opts.relativeMove) return undefined;
        const pt = child(req, 'Translation', 'PanTilt');
        moves.push(`RelativeMove ${token} ${attr(pt, 'x')} ${attr(pt, 'y')}`);
        return '<tptz:RelativeMoveResponse/>';
      }
      case 'GetPresets':
        return (
          '<tptz:GetPresetsResponse>' +
          (opts.presets ?? [])
            .map(
              (name, i) =>
                `<tptz:Preset token="p${i + 1}"><tt:Name>${escapeXml(name)}</tt:Name></tptz:Preset>`,
            )
            .join('') +
          '</tptz:GetPresetsResponse>'
        );
      case 'GotoPreset':
        moves.push(`GotoPreset ${token} ${text(child(req, 'PresetToken'))}`);
        return '<tptz:GotoPresetResponse/>';
      default:
        return undefined;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, xml: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          ...headers,
        });
        res.end(xml);
      };
      let doc: unknown;
      try {
        doc = parseXml(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, fault('ter:WellFormed', 'Bad XML'));
      }
      const body = child(doc, 'Envelope', 'Body');
      const op = firstElementName(body) ?? '';
      const reqNode = child(body, op);

      if (op === 'GetSystemDateAndTime') {
        const d = cameraNow();
        return send(
          200,
          envelope(
            '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType>' +
              '<tt:DaylightSavings>false</tt:DaylightSavings><tt:UTCDateTime>' +
              `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
              `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>` +
              '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
          ),
        );
      }

      const security = child(doc, 'Envelope', 'Header', 'Security');
      if (security !== undefined) stats.ws++;
      if (opts.auth === 'ws-security') {
        if (!wsOk(security)) return send(400, fault('ter:NotAuthorized', 'Sender not authorized'));
      } else if (!digestOk(req.headers.authorization, req.url ?? '')) {
        return send(401, '', {
          'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"`,
        });
      }

      const out = answer(op, reqNode);
      if (out === undefined)
        return send(400, fault('ter:ActionNotSupported', `${op} is not supported`));
      return send(200, envelope(out));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  deviceUrl = `http://${host}:${port}/onvif/device_service`;

  let udp: dgram.Socket | undefined;
  let discoveryPort: number | undefined;
  if (opts.discoveryPort !== undefined) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const socket = udp;
    socket.on('message', (msg, from) => {
      let relates: string;
      try {
        const doc = parseXml(msg.toString('utf8'));
        if (firstElementName(child(doc, 'Envelope', 'Body')) !== 'Probe') return;
        relates = text(child(doc, 'Envelope', 'Header', 'MessageID')) ?? '';
      } catch {
        return;
      }
      const scopes = [
        `onvif://www.onvif.org/name/${encodeURIComponent(opts.name ?? 'FakeCam')}`,
        'onvif://www.onvif.org/hardware/FC-1',
        'onvif://www.onvif.org/type/video_encoder',
      ].join(' ');
      const reply =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
        `<e:Header><w:MessageID>uuid:${randomBytes(8).toString('hex')}</w:MessageID>` +
        `<w:RelatesTo>${escapeXml(relates)}</w:RelatesTo></e:Header>` +
        '<e:Body><d:ProbeMatches><d:ProbeMatch>' +
        `<w:EndpointReference><w:Address>${opts.endpointId}</w:Address></w:EndpointReference>` +
        '<d:Types>dn:NetworkVideoTransmitter</d:Types>' +
        `<d:Scopes>${escapeXml(scopes)}</d:Scopes>` +
        `<d:XAddrs>${escapeXml(opts.advertiseXaddr ?? deviceUrl)}</d:XAddrs>` +
        '<d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>';
      for (let i = 0; i < (opts.repeatMatches ?? 1); i++)
        socket.send(reply, from.port, from.address);
    });
    await new Promise<void>((resolve) => socket.bind(opts.discoveryPort, host, () => resolve()));
    discoveryPort = socket.address().port;
  }

  return {
    deviceUrl,
    discoveryPort,
    moves,
    get wsSecurityAttempts() {
      return stats.ws;
    },
    close: async () => {
      udp?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
