import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../lib/api';

const BAD_CODE =
  "This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.";
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';
const UNREACHABLE = "Couldn't reach Kasa Home. Check the computer is on and try again.";

/** What to tell the phone when pairing failed. Only the server's bad-code answer blames the code. */
function failureText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'bad-code') return BAD_CODE;
    if (err.status === 429) return TOO_MANY;
  }
  return UNREACHABLE;
}

/**
 * The page a phone opens by scanning the code. The code rides in the `#` part so it is never
 * sent in a request or logged. It is read once, removed from the address bar, then traded for
 * the device and session cookies. On success onPaired runs, and the app takes over.
 */
export function Pair({ onPaired }: { onPaired(): void }) {
  const [failure, setFailure] = useState<string>();
  // Once only. Strict mode runs effects twice, and a code works one time.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      setFailure(BAD_CODE);
      return;
    }
    api.remote.pair(code).then(
      () => {
        // Reloading should open the camera, not try the spent code again.
        window.history.replaceState(null, '', '/');
        onPaired();
      },
      (err: unknown) => setFailure(failureText(err)),
    );
  }, [onPaired]);

  return (
    <div className="login">
      <div className="panel login-card">
        <span className="moon big" aria-hidden="true" />
        <h1>Kasa Home</h1>
        {failure ? (
          <p className="error-text" role="alert">
            {failure}
          </p>
        ) : (
          <p role="status">Setting up this phone...</p>
        )}
      </div>
    </div>
  );
}
