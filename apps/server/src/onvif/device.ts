/** The ONVIF calls Kasa Home uses: device info, media profiles, stream address and PTZ. */
import type { Logger } from '../logger.js';
import { rewriteStreamHost } from './pickProfile.js';
import { OnvifFaultError, SoapClient } from './soap.js';
import { attr, child, children, escapeXml, text } from './xml.js';

export interface OnvifProfile {
  token: string;
  name: string;
  codec: 'h264' | 'h265' | 'other';
  width: number;
  height: number;
  hasPtz: boolean;
}

export interface OnvifDeviceInfo {
  manufacturer: string;
  model: string;
  firmware: string;
  serial: string;
  hardwareId: string;
}

export interface OnvifConnectOptions {
  deviceUrl: string;
  username: string;
  password: string;
  allowPublicHost: boolean;
  logger: Logger;
  timeoutMs?: number;
}

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
};

function codecOf(encoding: string | undefined): OnvifProfile['codec'] {
  const e = (encoding ?? '').toUpperCase();
  if (e === 'H264') return 'h264';
  if (e === 'H265' || e === 'HEVC') return 'h265';
  return 'other';
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);

export class OnvifDevice {
  private constructor(
    private readonly soap: SoapClient,
    /** The host we reached the camera at; every service address uses it. */
    readonly host: string,
    private readonly deviceUrl: string,
    private readonly mediaUrl: string,
    private readonly ptzUrl: string | undefined,
  ) {}

  get hasPtz(): boolean {
    return this.ptzUrl !== undefined;
  }

  /** Sign in, and find the media and PTZ service addresses. */
  static async connect(opts: OnvifConnectOptions): Promise<OnvifDevice> {
    const soap = new SoapClient(opts);
    const device = new URL(opts.deviceUrl);
    const host = device.hostname.replace(/^\[|\]$/g, '');
    // Services often name the camera by another address; keep their port and path only.
    const onDevice = (xaddr: string | undefined): string | undefined => {
      if (!xaddr) return undefined;
      try {
        const u = new URL(xaddr);
        u.hostname = device.hostname;
        return u.toString();
      } catch {
        return undefined;
      }
    };

    let media: string | undefined;
    let ptz: string | undefined;
    try {
      const body = await soap.call(
        opts.deviceUrl,
        `<GetServices xmlns="${NS.device}"><IncludeCapability>false</IncludeCapability></GetServices>`,
      );
      for (const s of children(child(body, 'GetServicesResponse'), 'Service')) {
        const ns = text(child(s, 'Namespace'));
        const xaddr = onDevice(text(child(s, 'XAddr')));
        if (ns === NS.media) media = xaddr;
        if (ns === NS.ptz) ptz = xaddr;
      }
    } catch (err) {
      if (!(err instanceof OnvifFaultError)) throw err;
      const body = await soap.call(
        opts.deviceUrl,
        `<GetCapabilities xmlns="${NS.device}"><Category>All</Category></GetCapabilities>`,
      );
      const caps = child(body, 'GetCapabilitiesResponse', 'Capabilities');
      media = onDevice(text(child(caps, 'Media', 'XAddr')));
      ptz = onDevice(text(child(caps, 'PTZ', 'XAddr')));
    }
    if (!media)
      throw new OnvifFaultError('NoMediaService', 'The camera has no ONVIF media service');
    return new OnvifDevice(soap, host, opts.deviceUrl, media, ptz);
  }

  async info(): Promise<OnvifDeviceInfo> {
    const body = await this.soap.call(
      this.deviceUrl,
      `<GetDeviceInformation xmlns="${NS.device}"/>`,
    );
    const r = child(body, 'GetDeviceInformationResponse');
    const t = (name: string) => text(child(r, name)) ?? '';
    return {
      manufacturer: t('Manufacturer'),
      model: t('Model'),
      firmware: t('FirmwareVersion'),
      serial: t('SerialNumber'),
      hardwareId: t('HardwareId'),
    };
  }

  async macAddress(): Promise<string | undefined> {
    try {
      const body = await this.soap.call(
        this.deviceUrl,
        `<GetNetworkInterfaces xmlns="${NS.device}"/>`,
      );
      const nic = children(child(body, 'GetNetworkInterfacesResponse'), 'NetworkInterfaces')[0];
      return text(child(nic, 'Info', 'HwAddress'))?.toLowerCase();
    } catch (err) {
      if (err instanceof OnvifFaultError) return undefined;
      throw err;
    }
  }

  async profiles(): Promise<OnvifProfile[]> {
    const body = await this.soap.call(this.mediaUrl, `<GetProfiles xmlns="${NS.media}"/>`);
    return children(child(body, 'GetProfilesResponse'), 'Profiles').map((p) => {
      const enc = child(p, 'VideoEncoderConfiguration');
      return {
        token: attr(p, 'token') ?? '',
        name: text(child(p, 'Name')) ?? '',
        codec: codecOf(text(child(enc, 'Encoding'))),
        width: Number(text(child(enc, 'Resolution', 'Width')) ?? 0),
        height: Number(text(child(enc, 'Resolution', 'Height')) ?? 0),
        hasPtz: child(p, 'PTZConfiguration') !== undefined,
      };
    });
  }

  /** The RTSP address for a profile, pointed at the host we know the camera by. */
  async streamUri(profileToken: string): Promise<string> {
    const body = await this.soap.call(
      this.mediaUrl,
      `<GetStreamUri xmlns="${NS.media}"><StreamSetup><Stream xmlns="${NS.schema}">RTP-Unicast</Stream>` +
        `<Transport xmlns="${NS.schema}"><Protocol>RTSP</Protocol></Transport></StreamSetup>` +
        `<ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetStreamUri>`,
    );
    const uri = text(child(body, 'GetStreamUriResponse', 'MediaUri', 'Uri'));
    if (!uri) throw new OnvifFaultError('NoStreamUri', 'The camera gave no stream address');
    return rewriteStreamHost(uri, this.host);
  }

  private ptzCall(body: string): Promise<unknown> {
    if (!this.ptzUrl) throw new OnvifFaultError('NoPtz', 'This camera has no pan/tilt');
    return this.soap.call(this.ptzUrl, body);
  }

  async continuousMove(profileToken: string, x: number, y: number): Promise<void> {
    await this.ptzCall(
      `<ContinuousMove xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profileToken)}</ProfileToken>` +
        `<Velocity><PanTilt xmlns="${NS.schema}" x="${num(x)}" y="${num(y)}"/></Velocity></ContinuousMove>`,
    );
  }

  async stop(profileToken: string): Promise<void> {
    await this.ptzCall(
      `<Stop xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profileToken)}</ProfileToken>` +
        `<PanTilt>true</PanTilt><Zoom>false</Zoom></Stop>`,
    );
  }

  async relativeMove(profileToken: string, x: number, y: number): Promise<void> {
    await this.ptzCall(
      `<RelativeMove xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profileToken)}</ProfileToken>` +
        `<Translation><PanTilt xmlns="${NS.schema}" x="${num(x)}" y="${num(y)}"/></Translation></RelativeMove>`,
    );
  }

  async presets(profileToken: string): Promise<{ token: string; name: string }[]> {
    const body = await this.ptzCall(
      `<GetPresets xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetPresets>`,
    );
    return children(child(body, 'GetPresetsResponse'), 'Preset').map((p) => ({
      token: attr(p, 'token') ?? '',
      name: text(child(p, 'Name')) ?? '',
    }));
  }

  async gotoPreset(profileToken: string, presetToken: string): Promise<void> {
    await this.ptzCall(
      `<GotoPreset xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profileToken)}</ProfileToken>` +
        `<PresetToken>${escapeXml(presetToken)}</PresetToken></GotoPreset>`,
    );
  }
}
