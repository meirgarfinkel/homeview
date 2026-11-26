import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { STREAM_RESOLUTIONS, type CameraKind, type StreamResolution } from '@kasa/shared';
import { z } from 'zod';
import type { Logger } from '../logger.js';

export interface SecretProtector {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
  readonly kind: 'safeStorage' | 'plain';
}

/** Stores secrets as they are. The owner-only file mode is the only protection. */
export const plainProtector: SecretProtector = {
  kind: 'plain',
  encrypt: (plain) => plain,
  decrypt: (stored) => stored,
};

/** Where a standard (ONVIF/RTSP) camera is and how to tell it's the same one. */
export interface OnvifSettings {
  host: string;
  onvifPort: number;
  profileToken?: string;
  /** A typed-in stream address; ONVIF isn't used when it's set. */
  rtspUrl?: string;
  identity: { endpointId?: string; serial?: string; mac?: string };
}

export interface CameraSettings {
  /** Missing means 'kasa' (every file saved before standard cameras). */
  kind?: CameraKind;
  username: string;
  password: string;
  alias?: string;
  localOnly: boolean;
  onvif?: OnvifSettings;
}

export interface Settings {
  viewerPasswordHash?: string;
  camera?: CameraSettings;
  /** The stream size chosen in Settings. Missing means the camera's default. */
  streamResolution?: StreamResolution;
}

/**
 * The settings with a new or re-entered camera. The chosen video quality stays only for the same
 * camera: a size one camera supports may be one the next can't stream.
 */
export function withCamera(saved: Settings, camera: CameraSettings): Settings {
  const before = saved.camera;
  const same =
    before !== undefined &&
    (before.kind ?? 'kasa') === (camera.kind ?? 'kasa') &&
    ((camera.kind ?? 'kasa') === 'kasa'
      ? before.alias === camera.alias
      : JSON.stringify(before.onvif?.identity) === JSON.stringify(camera.onvif?.identity));
  const { streamResolution, ...rest } = saved;
  return {
    ...rest,
    ...(same && streamResolution !== undefined ? { streamResolution } : {}),
    camera,
  };
}

const onvifSchema = z.object({
  host: z.string().min(1),
  onvifPort: z.number().int().min(0).max(65535),
  profileToken: z.string().optional(),
  rtspUrl: z.string().optional(),
  identity: z.object({
    endpointId: z.string().optional(),
    serial: z.string().optional(),
    mac: z.string().optional(),
  }),
});

const diskSchema = z.object({
  viewerPasswordHash: z.string().optional(),
  streamResolution: z.enum(STREAM_RESOLUTIONS).optional(),
  camera: z
    .object({
      username: z.string(),
      passwordProtected: z.string(),
      protector: z.enum(['safeStorage', 'plain']),
      alias: z.string().optional(),
      localOnly: z.boolean(),
      kind: z.enum(['kasa', 'onvif']).optional(),
      onvif: onvifSchema.optional(),
    })
    .optional(),
});

export class SettingsStore {
  readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly protector: SecretProtector = plainProtector,
    private readonly logger?: Logger,
  ) {
    this.file = path.join(dir, 'settings.json');
  }

  /** Never throws. A missing file gives empty settings; an unreadable one is set aside. */
  load(): Settings {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.error({ err }, 'could not read the settings file');
      }
      return {};
    }

    let parsed: z.infer<typeof diskSchema>;
    try {
      parsed = diskSchema.parse(JSON.parse(raw));
    } catch {
      this.setAside(raw);
      return {};
    }

    const settings: Settings = {};
    if (parsed.viewerPasswordHash !== undefined) {
      settings.viewerPasswordHash = parsed.viewerPasswordHash;
    }
    if (parsed.streamResolution !== undefined) {
      settings.streamResolution = parsed.streamResolution;
    }
    const cam = parsed.camera;
    if (cam) {
      const password = this.decrypt(cam.passwordProtected, cam.protector);
      if (password === undefined) {
        this.logger?.warn(
          'the saved camera password could not be decrypted; it stays saved but is not used this time',
        );
      } else {
        settings.camera = {
          ...(cam.kind !== undefined ? { kind: cam.kind } : {}),
          username: cam.username,
          password,
          ...(cam.alias !== undefined ? { alias: cam.alias } : {}),
          localOnly: cam.localOnly,
          ...(cam.onvif !== undefined ? { onvif: withoutUndefined(cam.onvif) } : {}),
        };
      }
    }
    return settings;
  }

  /** Writes to a temporary file, then renames it over the real one. */
  save(next: Settings): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const disk: z.infer<typeof diskSchema> = {
      ...(next.viewerPasswordHash !== undefined
        ? { viewerPasswordHash: next.viewerPasswordHash }
        : {}),
      ...(next.streamResolution !== undefined ? { streamResolution: next.streamResolution } : {}),
      ...(next.camera === undefined
        ? this.undecryptableCamera()
        : {
            camera: {
              username: next.camera.username,
              passwordProtected: this.protector.encrypt(next.camera.password),
              protector: this.protector.kind,
              ...(next.camera.alias !== undefined ? { alias: next.camera.alias } : {}),
              localOnly: next.camera.localOnly,
              ...(next.camera.kind !== undefined ? { kind: next.camera.kind } : {}),
              ...(next.camera.onvif !== undefined ? { onvif: next.camera.onvif } : {}),
            },
          }),
    };
    writeDurably(this.file, `${JSON.stringify(disk, null, 2)}\n`);
  }

  /**
   * The saved camera, when its password can't be decrypted now (a keychain
   * that is locked or missing at this launch). A save without a camera keeps
   * it, so the login works again once the keychain is back.
   */
  private undecryptableCamera(): { camera?: NonNullable<z.infer<typeof diskSchema>['camera']> } {
    let cam: z.infer<typeof diskSchema>['camera'];
    try {
      cam = diskSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).camera;
    } catch {
      return {};
    }
    if (!cam || this.decrypt(cam.passwordProtected, cam.protector) !== undefined) return {};
    return { camera: cam };
  }

  private decrypt(stored: string, kind: SecretProtector['kind']): string | undefined {
    const protector =
      kind === 'plain' ? plainProtector : this.protector.kind === kind ? this.protector : undefined;
    if (!protector) return undefined;
    try {
      return protector.decrypt(stored);
    } catch {
      return undefined;
    }
  }

  private setAside(raw: string): void {
    const broken = `${this.file}.broken`;
    try {
      writeFileSync(broken, raw, { mode: 0o600 });
      this.logger?.error({ broken }, 'the settings file is damaged; starting empty');
    } catch (err) {
      this.logger?.error({ err }, 'the settings file is damaged and could not be kept');
    }
  }
}

/** The ONVIF part as saved, without keys zod filled with undefined. */
function withoutUndefined(o: z.infer<typeof onvifSchema>): OnvifSettings {
  const identity = Object.fromEntries(
    Object.entries(o.identity).filter(([, v]) => v !== undefined),
  ) as OnvifSettings['identity'];
  return {
    host: o.host,
    onvifPort: o.onvifPort,
    ...(o.profileToken !== undefined ? { profileToken: o.profileToken } : {}),
    ...(o.rtspUrl !== undefined ? { rtspUrl: o.rtspUrl } : {}),
    identity,
  };
}

/**
 * Replace a file so that a power cut leaves the old or the new one, never an
 * empty file: write a temporary copy, flush it to disk, rename it over the
 * old one, then flush the folder so the rename itself is on disk.
 */
function writeDurably(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  // Windows can't open a folder to flush it, and NTFS keeps the rename anyway.
  if (process.platform === 'win32') return;
  const dir = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
