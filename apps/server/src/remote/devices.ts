import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RemoteDevice } from '@kasa/shared';
import type { Logger } from '../logger.js';
import { writePrivateFile } from '../security/dataDir.js';

export const DEVICE_COOKIE = 'kasa_device';

/** About 400 days, in seconds. */
const COOKIE_MAX_AGE = 34_560_000;
const FLUSH_EVERY_MS = 10 * 60_000;

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

const diskSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tokenHash: z.string(),
      createdAt: z.string(),
      lastSeenAt: z.string().optional(),
    }),
  ),
});
type Disk = z.infer<typeof diskSchema>;
type StoredDevice = Disk['devices'][number];

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicDevice(d: StoredDevice): RemoteDevice {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
  };
}

/** The remote access switch and the paired devices, kept in remote.json. */
export class DeviceStore extends EventEmitter<{ removed: [string] }> {
  readonly file: string;
  private state: Disk;
  private lastWrite = 0;
  private dirty = false;

  constructor(
    private readonly dir: string,
    private readonly logger?: Logger,
  ) {
    super();
    this.file = path.join(dir, 'remote.json');
    this.state = this.load();
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  setEnabled(on: boolean): void {
    this.state.enabled = on;
    this.write();
  }

  list(): RemoteDevice[] {
    return this.state.devices.map(publicDevice);
  }

  add(name: string, now = new Date()): { device: RemoteDevice; token: string } {
    const token = randomBytes(32).toString('base64url');
    const stored: StoredDevice = {
      id: randomUUID(),
      name,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
    };
    this.state.devices.push(stored);
    this.write(now.getTime());
    return { device: publicDevice(stored), token };
  }

  find(token: string | undefined): RemoteDevice | undefined {
    if (!token) return undefined;
    const given = Buffer.from(hashToken(token), 'hex');
    const match = this.state.devices.find((d) => {
      const want = Buffer.from(d.tokenHash, 'hex');
      return want.length === given.length && timingSafeEqual(want, given);
    });
    return match ? publicDevice(match) : undefined;
  }

  /** Notes that a device was seen. Writes to disk at most every 10 minutes. */
  touch(id: string, now = new Date()): void {
    const device = this.state.devices.find((d) => d.id === id);
    if (!device) return;
    device.lastSeenAt = now.toISOString();
    this.dirty = true;
    if (now.getTime() - this.lastWrite >= FLUSH_EVERY_MS) this.write(now.getTime());
  }

  remove(id: string): boolean {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    if (this.state.devices.length === before) return false;
    this.write();
    this.emit('removed', id);
    return true;
  }

  /** Writes any pending last-seen times. */
  flush(): void {
    if (this.dirty) this.write();
  }

  private write(at = Date.now()): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      writePrivateFile(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
      this.lastWrite = at;
      this.dirty = false;
    } catch (err) {
      this.logger?.error({ err }, 'could not save the remote access file');
    }
  }

  /** Never throws. A missing file is empty; a damaged one is set aside. */
  private load(): Disk {
    const empty: Disk = { enabled: false, devices: [] };
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.error({ err }, 'could not read the remote access file');
      }
      return empty;
    }
    try {
      return diskSchema.parse(JSON.parse(raw));
    } catch {
      const broken = `${this.file}.broken`;
      try {
        writeFileSync(broken, raw, { mode: 0o600 });
        this.logger?.error({ broken }, 'the remote access file is damaged; starting empty');
      } catch (err) {
        this.logger?.error({ err }, 'the remote access file is damaged and could not be kept');
      }
      return empty;
    }
  }
}
