import path from 'node:path';
import { findRepoRoot } from './env.js';
import { z } from 'zod';

/** Treat empty strings from .env files as "not set". */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

const csv = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.split(',').map((s) => s.trim()) : []),
  z.array(z.string().min(1)),
);

const bool = (fallback: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : undefined),
    z
      .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
      .optional()
      .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes', 'on'].includes(v))),
  );

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const schema = z.object({
  // Web server
  HOST: z.string().default('0.0.0.0'),
  PORT: port(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_CIDRS: csv,
  ALLOWED_HOSTS: csv,
  VIEWER_PASSWORD: z.preprocess(
    (v) => (typeof v === 'string' && v === '' ? undefined : v),
    z.string().min(8, 'VIEWER_PASSWORD must be at least 8 characters').optional(),
  ),
  ALLOW_NO_PASSWORD: bool(false),
  SESSION_SECRET: optionalString,
  STATIC_DIR: optionalString,
  DATA_DIR: optionalString,
  HTTPS: bool(true),
  TLS_CERT_FILE: optionalString,
  TLS_KEY_FILE: optionalString,

  // Camera
  KASA_HOST: optionalString,
  KASA_ALIAS: optionalString,
  KASA_USERNAME: z.string().trim().min(1, 'KASA_USERNAME (your Kasa account email) is required'),
  KASA_PASSWORD: z.string().min(1, 'KASA_PASSWORD (your Kasa account password) is required'),
  KASA_PASSWORD_ENCODING: z.enum(['auto', 'md5', 'base64']).default('auto'),
  KASA_STREAM_PORT: port(19443),
  KASA_API_PORT: port(10443),
  KASA_STREAM_RESOLUTION: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['2560x1440', '2304x1296', '1080P', '720P', '360P']).optional(),
    )
    .optional(),
  KASA_CERT_SHA256: optionalString,
  KASA_ALLOW_PUBLIC_HOST: bool(false),

  // Behaviour
  IDLE_DISCONNECT_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  PTZ_ENABLED: bool(true),
  // The camera accepts 1-10 (11+ returns err_code -41203).
  PTZ_SPEED: z.coerce.number().int().min(1).max(10).default(8),
});

export type Env = z.infer<typeof schema>;

export interface Config {
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  allowedCidrs: string[] | undefined;
  allowedHosts: string[];
  viewerPassword: string | undefined;
  sessionSecret: string | undefined;
  staticDir: string;
  dataDir: string;
  https: { enabled: boolean; certFile: string | undefined; keyFile: string | undefined };
  camera: {
    host: string | undefined;
    alias: string | undefined;
    username: string;
    password: string;
    passwordEncoding: Env['KASA_PASSWORD_ENCODING'];
    streamPort: number;
    apiPort: number;
    streamPath: string;
    certSha256: string | undefined;
    allowPublicHost: boolean;
  };
  idleDisconnectMs: number;
  ptz: { enabled: boolean; speed: number };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Stream path + query as the Kasa app requests it (TPLocalStreamingClient). */
export function streamPath(resolution?: string): string {
  const params = new URLSearchParams({ video: 'H264' });
  if (resolution) params.set('resolution', resolution);
  params.set('audio', 'G711');
  return `/https/stream/mixed?${params.toString()}`;
}

const repoRoot = findRepoRoot() ?? process.cwd();
const defaultStaticDir = path.join(repoRoot, 'apps', 'web', 'dist');
const defaultDataDir = path.join(repoRoot, 'data');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  if (!e.VIEWER_PASSWORD && !e.ALLOW_NO_PASSWORD) {
    throw new ConfigError(
      'VIEWER_PASSWORD is not set.\n' +
        'The page shows a live camera, so it needs a password. Add a line like\n' +
        '  VIEWER_PASSWORD=<at least 8 characters>\n' +
        'to .env (or set ALLOW_NO_PASSWORD=true to run without one).',
    );
  }
  if (Boolean(e.TLS_CERT_FILE) !== Boolean(e.TLS_KEY_FILE)) {
    throw new ConfigError('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.');
  }
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    allowedCidrs: e.ALLOWED_CIDRS.length > 0 ? e.ALLOWED_CIDRS : undefined,
    allowedHosts: e.ALLOWED_HOSTS,
    viewerPassword: e.VIEWER_PASSWORD,
    sessionSecret: e.SESSION_SECRET,
    staticDir: e.STATIC_DIR ? path.resolve(e.STATIC_DIR) : defaultStaticDir,
    dataDir: e.DATA_DIR ? path.resolve(e.DATA_DIR) : defaultDataDir,
    https: { enabled: e.HTTPS, certFile: e.TLS_CERT_FILE, keyFile: e.TLS_KEY_FILE },
    camera: {
      host: e.KASA_HOST,
      alias: e.KASA_ALIAS,
      username: e.KASA_USERNAME,
      password: e.KASA_PASSWORD,
      passwordEncoding: e.KASA_PASSWORD_ENCODING,
      streamPort: e.KASA_STREAM_PORT,
      apiPort: e.KASA_API_PORT,
      streamPath: streamPath(e.KASA_STREAM_RESOLUTION),
      certSha256: e.KASA_CERT_SHA256,
      allowPublicHost: e.KASA_ALLOW_PUBLIC_HOST,
    },
    idleDisconnectMs: e.IDLE_DISCONNECT_SECONDS * 1000,
    ptz: { enabled: e.PTZ_ENABLED, speed: e.PTZ_SPEED },
  };
}
