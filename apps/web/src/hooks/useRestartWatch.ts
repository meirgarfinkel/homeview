import { useEffect } from 'react';
import type { UpdateStatus } from '@kasa/shared';
import { api } from '../lib/api';

/** How often to ask while restarting, to show a failure or find the new copy. */
const RESTART_POLL_MS = 2000;

/**
 * While HomeView restarts into an update: an error means it didn't install, so `onError` gets
 * it. Any answer other than "ready" comes from the new copy, so the page reloads.
 */
export function useRestartWatch(restarting: boolean, onError: (s: UpdateStatus) => void): void {
  useEffect(() => {
    if (!restarting) return;
    let live = true;
    const timer = setInterval(() => {
      api.update().then(
        (s) => {
          if (!live) return;
          if (s.state === 'error') onError(s);
          else if (s.state !== 'ready') location.reload();
        },
        () => undefined, // the old copy has gone; the new one isn't up yet
      );
    }, RESTART_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [restarting, onError]);
}
