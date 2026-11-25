/**
 * The "TP-Link Smart Home" autokey XOR cipher.
 *
 * Used by Kasa devices for UDP discovery on port 9999 and, wrapped in base64,
 * for the camera's LINKIE.json control API on port 10443. It is obfuscation,
 * not encryption: the key is a public constant.
 */

const INITIAL_KEY = 0xab;

export function encrypt(plain: string | Uint8Array): Buffer {
  const input = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const out = Buffer.allocUnsafe(input.length);
  let key = INITIAL_KEY;
  for (let i = 0; i < input.length; i++) {
    key ^= input[i]!;
    out[i] = key;
  }
  return out;
}

export function decrypt(cipher: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(cipher.length);
  let key = INITIAL_KEY;
  for (let i = 0; i < cipher.length; i++) {
    const byte = cipher[i]!;
    out[i] = byte ^ key;
    key = byte;
  }
  return out;
}

export function encryptJson(value: unknown): Buffer {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T = unknown>(cipher: Uint8Array): T {
  return JSON.parse(decrypt(cipher).toString('utf8')) as T;
}
