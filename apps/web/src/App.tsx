import { useCallback, useEffect, useState } from 'react';
import type { SessionResponse } from '@kasa/shared';
import { api } from './lib/api';
import { Login } from './components/Login';
import { Monitor } from './components/Monitor';
import { SetupWizard } from './components/setup/SetupWizard';
import { NotSetUp } from './components/setup/NotSetUp';

const RETRY_MS = 500;
const RETRIES = 20;

/** The server restarts its listeners after setup, so the next read may fail once or twice. */
async function sessionWithRetry(): Promise<SessionResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.session();
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    api.session().then(setSession, (err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

  const afterSetup = useCallback(() => {
    sessionWithRetry().then(setSession, (err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="login">
        <p className="error-text">Cannot reach the Kasa Home server: {error}</p>
      </div>
    );
  }
  if (!session) return null;
  if (!session.setupComplete) {
    return session.local ? <SetupWizard onDone={afterSetup} /> : <NotSetUp />;
  }
  if (session.authRequired && !session.authenticated) return <Login onSuccess={refresh} />;
  return (
    <Monitor onSignOut={session.authRequired ? () => void api.logout().then(refresh) : undefined} />
  );
}
