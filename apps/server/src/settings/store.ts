import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

export interface Settings {
  viewerPasswordHash?: string;
  camera?: { username: string; password: string; alias?: string; localOnly: boolean };
}

const diskSchema = z.object({
  viewerPasswordHash: z.string().optional(),
  camera: z
    .object({
      username: z.string(),
      passwordProtected: z.string(),
      protector: z.enum(['safeStorage', 'plain']),
      alias: z.string().optional(),
      localOnly: z.boolean(),
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
    const cam = parsed.camera;
    if (cam) {
      const password = this.decrypt(cam.passwordProtected, cam.protector);
      if (password === undefined) {
        this.logger?.warn(
          'the saved camera password could not be decrypted; it stays saved but is not used this time',
        );
      } else {
        settings.camera = {
          username: cam.username,
          password,
          ...(cam.alias !== undefined ? { alias: cam.alias } : {}),
          localOnly: cam.localOnly,
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
      ...(next.camera === undefined
        ? this.undecryptableCamera()
        : {
            camera: {
              username: next.camera.username,
              passwordProtected: this.protector.encrypt(next.camera.password),
              protector: this.protector.kind,
              ...(next.camera.alias !== undefined ? { alias: next.camera.alias } : {}),
              localOnly: next.camera.localOnly,
            },
          }),
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
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
