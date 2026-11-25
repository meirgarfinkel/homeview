import { safeStorage } from 'electron';
import { plainProtector, type SecretProtector } from '../../server/src/settings/store.js';

/**
 * Encrypt the camera password with the system keychain when there is one.
 * On Linux without a keyring, Electron falls back to a fixed key
 * ('basic_text'), which is no better than the owner-only file, so use plain.
 * Call it after the app is ready.
 */
export function safeStorageProtector(): SecretProtector {
  if (!safeStorage.isEncryptionAvailable()) return plainProtector;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return plainProtector;
  }
  return {
    kind: 'safeStorage',
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
  };
}
