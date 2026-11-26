import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { ensureDataDir, writePrivateFile } from './dataDir.js';
import { isPrivateAddress, VIRTUAL_INTERFACE } from './network.js';

/**
 * HTTPS certificate for the web UI.
 *
 * Either the user supplies one (TLS_CERT_FILE / TLS_KEY_FILE, e.g. from
 * mkcert) or we generate a self-signed one covering localhost, this
 * machine's hostname and its LAN IPs. The generated one is reused until it
 * nears expiry or the machine's addresses change.
 */

export interface TlsMaterial {
  key: string;
  cert: string;
  /** SHA-256 fingerprint, shown in the browser's certificate details. */
  fingerprint: string;
  generated: boolean;
}

const VALIDITY_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** Names and addresses the certificate should cover. */
export function localIdentities(): { dns: string[]; ips: string[] } {
  const host = os.hostname().toLowerCase();
  const dns = [...new Set(['localhost', host, `${host}.local`])];
  const ips = new Set(['127.0.0.1', '::1']);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (!a.internal && isPrivateAddress(a.address) && !a.address.startsWith('fe80:')) {
        ips.add(a.address);
      }
    }
  }
  return { dns, ips: [...ips] };
}

function covers(cert: X509Certificate, want: { dns: string[]; ips: string[] }): boolean {
  return (
    want.dns.every((d) => cert.checkHost(d) !== undefined) &&
    want.ips.every((ip) => cert.checkIP(ip) !== undefined)
  );
}

export function readTlsFiles(certFile: string, keyFile: string): TlsMaterial {
  const cert = readFileSync(certFile, 'utf8');
  const key = readFileSync(keyFile, 'utf8');
  return { cert, key, fingerprint: new X509Certificate(cert).fingerprint256, generated: false };
}

export async function loadOrCreateCertificate(
  dataDir: string,
): Promise<TlsMaterial & { renewed: boolean }> {
  const dir = ensureDataDir(path.join(dataDir, 'tls'));
  const certFile = path.join(dir, 'server.crt');
  const keyFile = path.join(dir, 'server.key');
  const want = localIdentities();

  if (existsSync(certFile) && existsSync(keyFile)) {
    try {
      const existing = readTlsFiles(certFile, keyFile);
      const x509 = new X509Certificate(existing.cert);
      const fresh = new Date(x509.validTo).getTime() - Date.now() > RENEW_BEFORE_MS;
      if (fresh && covers(x509, want)) return { ...existing, generated: true, renewed: false };
    } catch {
      // unreadable or corrupt: regenerate below
    }
  }

  const now = new Date();
  const pems = await generate([{ name: 'commonName', value: `HomeView (${os.hostname()})` }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - 60_000),
    notAfterDate: new Date(now.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...want.dns.map((value) => ({ type: 2 as const, value })),
          ...want.ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  writePrivateFile(keyFile, pems.private);
  writePrivateFile(certFile, pems.cert);
  return {
    key: pems.private,
    cert: pems.cert,
    fingerprint: new X509Certificate(pems.cert).fingerprint256,
    generated: true,
    renewed: true,
  };
}
