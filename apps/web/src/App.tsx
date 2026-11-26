import { useCallback, useEffect, useState } from 'react';
import type { SessionResponse } from '@kasa/shared';
import { api, ApiRequestError, onUnauthorized } from './lib/api';
import { Login } from './components/Login';
import { NotPaired } from './components/NotPaired';
import { Pair } from './components/Pair';
import { Monitor } from './components/Monitor';
import { Settings } from './components/Settings';
import { AllSet } from './components/setup/AllSet';
import { SetupWizard } from './components/setup/SetupWizard';
import { NotSetUp } from './components/setup/NotSetUp';

const RETRIES = 40;
/** Checks after signing in before the page believes a "signed out" answer. */
const SIGN_IN_CHECKS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The server reloads after setup, so reads may fail, or answer from the old settings, for a
 * moment. Keep asking until it says setup is complete.
 */
async function sessionAfterSetup(retryMs: number): Promise<SessionResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const session = await api.session();
      if (session.setupComplete) return session;
    } catch {
      // the server is switching over
    }
    if (attempt >= RETRIES) throw new Error('setup not confirmed');
    await sleep(retryMs);
  }
}

export function App({ retryMs = 500 }: { retryMs?: number } = {}) {
  const [session, setSession] = useState<SessionResponse>();
  const [error, setError] = useState<string>();

  /** Through the away-from-home address from a phone that was never paired. */
  const [notPaired, setNotPaired] = useState(false);
  /** On the page a phone opens by scanning the code. The session waits until it is paired. */
  const [pairing, setPairing] = useState(() => window.location.pathname === '/pair');
  /** Just paired, so the camera page shows the home screen tip. */
  const [justPaired, setJustPaired] = useState(false);

  const refresh = useCallback(() => {
    api.session().then(
      (next) => {
        setNotPaired(false);
        setSession(next);
      },
      (err: Error) => {
        if (err instanceof ApiRequestError && err.code === 'device-not-paired') setNotPaired(true);
        else setError(err.message);
      },
    );
  }, []);
  useEffect(() => {
    if (!pairing) refresh();
  }, [pairing, refresh]);

  const afterPair = useCallback(() => {
    setJustPaired(true);
    setPairing(false);
  }, []);

  // Signed out elsewhere (a password change): show the sign-in page again.
  useEffect(() => {
    onUnauthorized(refresh);
    return () => onUnauthorized(undefined);
  }, [refresh]);

  /**
   * After signing in or setting a new password. The server may still be
   * switching to the new password for a moment, so a "signed out" answer
   * is checked again a few times before the sign-in page comes back.
   */
  const afterSignIn = useCallback(() => {
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const next = await api.session();
          if (next.authenticated || attempt >= SIGN_IN_CHECKS) {
            setSession(next);
            return;
          }
        } catch (err) {
          if (attempt >= SIGN_IN_CHECKS) {
            setError((err as Error).message);
            return;
          }
        }
        await sleep(retryMs);
      }
    })();
  }, [retryMs]);

  const [finishing, setFinishing] = useState<'working' | 'stuck'>();
  /** Set once, right after the first-run wizard, to show the All set page. */
  const [allSet, setAllSet] = useState<{ autostart: boolean | null }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const afterSetup = useCallback(() => {
    setFinishing('working');
    sessionAfterSetup(retryMs).then(
      async (next) => {
        // The page only needs this for one checkbox, so a failed read just hides it.
        const autostart = await api.settings().then(
          (s) => s.autostart,
          () => null,
        );
        setSession(next);
        setAllSet({ autostart });
        setFinishing(undefined);
      },
      () => setFinishing('stuck'),
    );
  }, [retryMs]);

  if (pairing) return <Pair onPaired={afterPair} />;
  if (notPaired) return <NotPaired />;
  if (error) {
    return (
      <div className="login">
        <p className="error-text">Cannot reach the Kasa Home server: {error}</p>
      </div>
    );
  }
  if (finishing) {
    return (
      <div className="login">
        <div className="panel login-card">
          {finishing === 'working' ? (
            <p role="status">Finishing setup…</p>
          ) : (
            <>
              <p className="error-text" role="alert">
                Setup is taking longer than expected.
              </p>
              <button className="btn btn-primary" type="button" onClick={afterSetup}>
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  if (!session) return null;
  if (!session.setupComplete) {
    return session.local ? <SetupWizard onDone={afterSetup} /> : <NotSetUp onSetUp={refresh} />;
  }
  if (session.authRequired && !session.authenticated) {
    return <Login local={session.local} onSuccess={afterSignIn} />;
  }
  if (allSet) {
    return (
      <AllSet
        lanUrl={session.lanUrl}
        autostart={allSet.autostart}
        onContinue={() => setAllSet(undefined)}
      />
    );
  }
  if (settingsOpen) {
    return (
      <Settings
        onClose={() => setSettingsOpen(false)}
        phoneAway={!session.local && !session.remote && !!session.remoteOn}
      />
    );
  }
  return (
    <>
      <Monitor
        onSignOut={session.authRequired ? () => void api.logout().then(refresh) : undefined}
        // Settings never open from away: the server refuses them there.
        onOpenSettings={session.remote ? undefined : () => setSettingsOpen(true)}
      />
      {justPaired && <p className="hint pair-tip">Tip: add this page to your home screen.</p>}
    </>
  );
}
