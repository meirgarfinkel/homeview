import { ApiRequestError } from './api';

/** Plain wording for each error code the server can send. Parents never see the raw code. */
const FALLBACKS: Record<string, string> = {
  'account-required': 'This needs a TP-Link account. Sign in and try again.',
  'already-set-up': 'Kasa Home is already set up.',
  'bad-answer': 'That answer did not fit this step. Go back and try again.',
  'camera-from-env': 'The camera login is set on the computer and cannot be changed here.',
  'camera-unreachable':
    'Could not reach the camera. Check that it is plugged in and on your Wi-Fi, then try again.',
  forbidden: 'This is not allowed from here.',
  forbidden_host: 'Open Kasa Home on the computer it is installed on to do this.',
  forbidden_origin: 'Open Kasa Home on the computer it is installed on to do this.',
  'local-only': 'Do this on the computer Kasa Home is installed on.',
  'no-camera': 'No camera was found with that login. Check the email and password and try again.',
  'no-onboarding': 'Camera setup has not started. Go back and start it again.',
  'not-available': 'This is not available on this computer.',
  not_found: 'That was not found.',
  'onboarding-running': 'Camera setup is already running.',
  'password-from-env': 'The password is set on the computer and cannot be changed here.',
  'password-too-short': 'Use at least 8 characters.',
  unauthorized: 'Sign in and try again.',
  'wrong-login': 'That email or password was not accepted.',
  'wrong-password': 'That password was not right.',
  'wrong-step': 'That step is not ready yet. Go back and try again.',
};

const GENERIC = 'Something went wrong. Try again.';
const OFFLINE = 'Could not reach Kasa Home. Check that it is still running.';

/** The text to show for a failed request: the server's message, else a plain fallback. */
export function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const fromServer = err.serverMessage?.trim();
    return fromServer || FALLBACKS[err.code] || GENERIC;
  }
  return OFFLINE;
}
