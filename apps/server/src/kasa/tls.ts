import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';

/**
 * TLS settings for talking to the camera.
 *
 * Kasa cameras present a self-signed certificate, so CA validation is off.
 * To still detect a different device answering on the camera's IP, the
 * certificate's SHA-256 fingerprint can be pinned with KASA_CERT_SHA256
 * (`pnpm probe` prints the current value).
 */
export interface CameraTlsConfig {
  /** Hex SHA-256 fingerprint, colons optional. */
  pinnedSha256?: string | undefined;
}

export const cameraTlsOptions: ConnectionOptions = {
  rejectUnauthorized: false,
  minVersion: 'TLSv1.2',
};

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

export function peerFingerprint(socket: TLSSocket): string {
  return normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? '');
}

/**
 * Throws if a fingerprint is pinned and the connected peer does not match.
 * Call after 'secureConnect' and before sending credentials.
 */
export function assertPinnedCertificate(socket: TLSSocket, config: CameraTlsConfig): void {
  if (!config.pinnedSha256) return;
  const expected = normalizeFingerprint(config.pinnedSha256);
  const actual = peerFingerprint(socket);
  if (actual !== expected) {
    throw new Error(
      `Camera certificate fingerprint ${actual || '(none)'} does not match KASA_CERT_SHA256`,
    );
  }
}

/** Connect, read the camera's certificate fingerprint, and disconnect. */
export function fetchFingerprint(host: string, port: number, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...cameraTlsOptions, host, port }, () => {
      const fp = peerFingerprint(socket);
      socket.end();
      resolve(fp);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('TLS handshake timed out')));
    socket.on('error', reject);
  });
}
