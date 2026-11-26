import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@kasa/shared';
import { api } from '../lib/api';

/** How often to ask whether an update is ready. */
const POLL_MS = 10 * 60 * 1000;
/** How often to ask while restarting, to show a failure or find the new copy. */
const RESTART_POLL_MS = 2000;

/**
 * A strip above the page, on this computer in the desktop app, when a downloaded update is
 * ready to install, or when updating failed.
 */
export function UpdateBar() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' });
  /** The version or error message the person said Later or Dismiss to. */
  const [hidden, setHidden] = useState<string>();
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let live = true;
    const ask = () =>
      api.update().then(
        (s) => live && setStatus(s),
        () => undefined, // try again next time
      );
    void ask();
    const timer = setInterval(() => void ask(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // While restarting: an error means it didn't install, so show it. Any other answer than
  // "ready" comes from the new copy, so load its page.
  useEffect(() => {
    if (!restarting) return;
    let live = true;
    const timer = setInterval(() => {
      api.update().then(
        (s) => {
          if (!live) return;
          if (s.state === 'error') {
            setStatus(s);
            setRestarting(false);
          } else if (s.state !== 'ready') {
            location.reload();
          }
        },
        () => undefined, // the old copy has gone; the new one isn't up yet
      );
    }, RESTART_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [restarting]);

  if (restarting) {
    return (
      <div className="update-bar" role="status">
        <span>Restarting…</span>
      </div>
    );
  }
  if (status.state === 'ready' && hidden !== status.version) {
    const restart = () => {
      setRestarting(true);
      api.installUpdate().catch(() => setRestarting(false));
    };
    return (
      <div className="update-bar" role="status">
        <span>HomeView {status.version} is ready.</span>
        <button className="btn btn-primary" type="button" onClick={restart}>
          Restart to update
        </button>
        <button className="btn" type="button" onClick={() => setHidden(status.version)}>
          Later
        </button>
      </div>
    );
  }
  if (status.state === 'error' && hidden !== status.message) {
    return (
      <div className="update-bar" role="status">
        <span>Couldn't update HomeView: {status.message}</span>
        <button className="btn" type="button" onClick={() => setHidden(status.message)}>
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}
