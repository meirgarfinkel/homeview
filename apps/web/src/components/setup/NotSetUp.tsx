import { AppLogo } from '../AppLogo';
import { useEffect } from 'react';
import { api } from '../../lib/api';

const CHECK_MS = 5000;

/** Shown to other devices before setup. It checks now and then, and moves on once setup is done. */
export function NotSetUp({ onSetUp }: { onSetUp(): void }) {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const session = await api.session();
        if (stopped) return;
        if (session.setupComplete) {
          onSetUp();
          return;
        }
      } catch {
        // HomeView may be restarting; ask again later.
      }
      if (!stopped) timer = setTimeout(() => void check(), CHECK_MS);
    };
    timer = setTimeout(() => void check(), CHECK_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [onSetUp]);

  return (
    <div className="login">
      <div className="panel login-card">
        <AppLogo big />
        <h1>HomeView</h1>
        <p>HomeView isn&apos;t set up yet. Finish setup on the computer it&apos;s installed on.</p>
      </div>
    </div>
  );
}
