import { useCallback, useEffect, useState } from 'react';
import type { SessionResponse } from '@kasa/shared';
import { api } from './lib/api';
import { Login } from './components/Login';
import { Monitor } from './components/Monitor';

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    api.session().then(setSession, (err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

  if (error) {
    return (
      <div className="login">
        <p className="error-text">Cannot reach the monitor server: {error}</p>
      </div>
    );
  }
  if (!session) return null;
  if (session.authRequired && !session.authenticated) return <Login onSuccess={refresh} />;
  return (
    <Monitor onSignOut={session.authRequired ? () => void api.logout().then(refresh) : undefined} />
  );
}
