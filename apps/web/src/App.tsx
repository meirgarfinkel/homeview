import { useCallback, useEffect, useState } from 'react';
import type { SessionResponse } from '@kasa/shared';
import { api } from './lib/api';
import { Login } from './components/Login';
import { Monitor } from './components/Monitor';
import { Settings } from './components/Settings';
import { AllSet } from './components/setup/AllSet';
import { SetupWizard } from './components/setup/SetupWizard';
import { NotSetUp } from './components/setup/NotSetUp';

const RETRIES = 40;

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
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

export function App({ retryMs = 500 }: { retryMs?: number } = {}) {
  const [session, setSession] = useState<SessionResponse>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    api.session().then(setSession, (err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

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
    return session.local ? <SetupWizard onDone={afterSetup} /> : <NotSetUp />;
  }
  if (session.authRequired && !session.authenticated) {
    return <Login local={session.local} onSuccess={refresh} />;
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
  if (settingsOpen) return <Settings onClose={() => setSettingsOpen(false)} />;
  return (
    <Monitor
      onSignOut={session.authRequired ? () => void api.logout().then(refresh) : undefined}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}
