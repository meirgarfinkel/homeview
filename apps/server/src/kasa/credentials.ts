import { createHash } from 'node:crypto';

/**
 * How the Kasa account password is transformed before it goes into the HTTP
 * Basic `Authorization` header. The username is always the account email.
 *
 * Taken from the Kasa Android app (DeviceCipherHelper): the camera lists the
 * schemes it accepts in `get_sysinfo.c_opt` (0 = BASE64, 1 = MD5) and the app
 * uses the highest one. Newer firmware reports `[0, 1]`, so MD5 wins.
 */
export type PasswordEncoding = 'md5' | 'base64';
export type PasswordEncodingSetting = PasswordEncoding | 'auto';

const CIPHER_OPTION: Record<number, PasswordEncoding> = { 0: 'base64', 1: 'md5' };

export function encodePassword(password: string, encoding: PasswordEncoding): string {
  switch (encoding) {
    case 'md5':
      return createHash('md5').update(password, 'utf8').digest('hex');
    case 'base64':
      return Buffer.from(password, 'utf8').toString('base64');
  }
}

export function basicAuthHeader(
  username: string,
  password: string,
  encoding: PasswordEncoding,
): string {
  const token = Buffer.from(`${username}:${encodePassword(password, encoding)}`, 'utf8');
  return `Basic ${token.toString('base64')}`;
}

/** Order encodings by preference given a camera's `c_opt` list (highest first). */
export function encodingsFromCipherOptions(
  cOpt: readonly number[] | undefined,
): PasswordEncoding[] {
  const known = (cOpt ?? [])
    .filter((n) => n in CIPHER_OPTION)
    .sort((a, b) => b - a)
    .map((n) => CIPHER_OPTION[n]!);
  const order = [...new Set(known)];
  for (const fallback of ['md5', 'base64'] as const) {
    if (!order.includes(fallback)) order.push(fallback);
  }
  return order;
}

/**
 * Holds the camera account and remembers which password encoding the camera
 * accepted, so the LINKIE client and the stream client share one answer.
 */
export class CameraCredentials {
  private preferred: PasswordEncoding[];
  private working: PasswordEncoding | undefined;
  private readonly fixed: boolean;

  constructor(
    readonly username: string,
    private readonly password: string,
    setting: PasswordEncodingSetting = 'auto',
  ) {
    this.fixed = setting !== 'auto';
    if (setting === 'auto') {
      this.preferred = encodingsFromCipherOptions(undefined);
    } else {
      this.preferred = [setting];
      this.working = setting;
    }
  }

  /** Apply the camera's advertised cipher options (from unauthenticated discovery). */
  applyCipherOptions(cOpt: readonly number[] | undefined): void {
    if (this.fixed || this.working) return;
    this.preferred = encodingsFromCipherOptions(cOpt);
  }

  /** Encodings to try, best guess first. Once one works, only that one. */
  candidates(): PasswordEncoding[] {
    return this.working ? [this.working] : [...this.preferred];
  }

  get resolvedEncoding(): PasswordEncoding | undefined {
    return this.working;
  }

  markWorking(encoding: PasswordEncoding): void {
    this.working = encoding;
  }

  header(encoding: PasswordEncoding): string {
    return basicAuthHeader(this.username, this.password, encoding);
  }
}
