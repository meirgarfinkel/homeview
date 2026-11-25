import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Monitor } from './Monitor';

const FAILED =
  "This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.";

/**
 * The page a phone opens by scanning the code. The code rides in the `#` part so it is never
 * sent in a request or logged. It is read once, removed from the address bar, then traded for
 * the device and session cookies.
 */
export function Pair() {
  const [state, setState] = useState<'working' | 'failed' | 'done'>('working');
  // Once only. Strict mode runs effects twice, and a code works one time.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      setState('failed');
      return;
    }
    api.remote.pair(code).then(
      () => {
        // Reloading should open the camera, not try the spent code again.
        window.history.replaceState(null, '', '/');
        setState('done');
      },
      () => setState('failed'),
    );
  }, []);

  if (state === 'done') {
    return (
      <>
        <Monitor />
        <p className="hint pair-tip">Tip: add this page to your home screen.</p>
      </>
    );
  }
  return (
    <div className="login">
      <div className="panel login-card">
        <span className="moon big" aria-hidden="true" />
        <h1>Kasa Home</h1>
        {state === 'working' ? (
          <p role="status">Setting up this phone...</p>
        ) : (
          <p className="error-text" role="alert">
            {FAILED}
          </p>
        )}
      </div>
    </div>
  );
}
