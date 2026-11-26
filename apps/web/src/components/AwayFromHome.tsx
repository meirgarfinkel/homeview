import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairCodeResponse, RemoteDevice, RemotePhase, RemoteStatus } from '@kasa/shared';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { qrSvg } from '../lib/qr';

/** How often to ask while the helper works through its steps. */
const POLL_MS = 2000;
const POLLING: RemotePhase[] = ['starting', 'sign-in', 'approve'];
/** How often to ask while on, to see new phones and a helper that stopped. */
const ON_POLL_MS = 5000;
const SIGN_OUT_WARNING =
  'Sign out of Tailscale? Your phones may need to scan a new code afterwards.';
/** Phases where the Tailscale login exists, so signing out means something. */
const SIGNED_IN: RemotePhase[] = ['approve', 'on', 'problem'];
const DAY_MS = 24 * 60 * 60 * 1000;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** "today", "yesterday" or "3 days ago", by calendar day. */
function usedText(lastSeenAt: string | undefined, now = new Date()): string {
  if (!lastSeenAt) return 'never';
  const seen = new Date(lastSeenAt);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(seen)) / DAY_MS);
  if (days <= 0) return 'today';
  return days === 1 ? 'yesterday' : plural(days, 'day');
}

const addedText = (createdAt: string) =>
  new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const deviceLine = (d: RemoteDevice) =>
  `${d.name}, added ${addedText(d.createdAt)}, used ${usedText(d.lastSeenAt)}`;

/** The "Away from home" section of the computer's settings page. */
export function AwayFromHome() {
  const [status, setStatus] = useState<RemoteStatus>();
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<PairCodeResponse>();
  /** The phone that paired with the last code shown. */
  const [added, setAdded] = useState<string>();
  /** The devices there were when the code was shown, so a new one can be spotted. */
  const knownIds = useRef<string[]>(undefined);

  const hideCode = useCallback(() => {
    knownIds.current = undefined;
    setPairing(undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.remote.status();
      setStatus(next);
      const known = knownIds.current;
      const fresh = known && next.devices.find((d) => !known.includes(d.id));
      if (fresh) {
        hideCode();
        setAdded(fresh.name);
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, [hideCode]);
  useEffect(() => {
    void load();
  }, [load]);

  // Ask again while the helper is working through its steps, and less often while on. Stops
  // when remote access is off or has a problem, and when this section goes away.
  const phase = status?.phase;
  const pollMs = phase === 'on' ? ON_POLL_MS : phase && POLLING.includes(phase) ? POLL_MS : 0;
  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  // A code that has expired can't pair anything, so stop showing it.
  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(hideCode, Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing, hideCode]);

  /** Runs one action, shows its failure, then re-reads the status. */
  const act = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    }
    await load();
  };

  const setOn = (on: boolean) => {
    hideCode();
    setAdded(undefined);
    return act(() => api.remote.enable(on));
  };

  const addPhone = async () => {
    setError(undefined);
    setAdded(undefined);
    try {
      const code = await api.remote.pairCode();
      knownIds.current = status?.devices.map((d) => d.id) ?? [];
      setPairing(code);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (id: string) => {
    await act(() => api.remote.removeDevice(id));
  };

  if (status && !status.available) return null;

  return (
    <section className="panel">
      <h2>Away from home</h2>
      {status && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={(e) => void setOn(e.target.checked)}
            />
            <span>Watch from anywhere with your phone&apos;s browser.</span>
          </label>
          {status.enabled && status.phase === 'starting' && <p role="status">Connecting...</p>}
          {status.phase === 'sign-in' && (
            <>
              <p>Sign in once to the free Tailscale service that carries the encrypted video.</p>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void act(api.remote.openLink)}
              >
                Sign in
              </button>
            </>
          )}
          {status.phase === 'approve' && (
            <>
              <p>One more click: allow HomeView to share a web address.</p>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void act(api.remote.openLink)}
              >
                Approve
              </button>
            </>
          )}
          {status.phase === 'on' && (
            <>
              <div className="row wrap">
                <span className="address away-url">{status.url}</span>
                <button className="btn btn-primary" type="button" onClick={() => void addPhone()}>
                  Add a phone
                </button>
              </div>
              <p className="hint">
                The first time, the address can take a few minutes to start working.
              </p>
              {added && <p role="status">Added {added}.</p>}
              {pairing && (
                <div className="stack">
                  <p>
                    Scan this with the phone&apos;s camera. The code works once, for 10 minutes.
                  </p>
                  <div
                    className="qr"
                    role="img"
                    aria-label="Pairing code"
                    dangerouslySetInnerHTML={{ __html: qrSvg(pairing.url) }}
                  />
                </div>
              )}
              {status.devices.length > 0 && (
                <ul className="devices">
                  {status.devices.map((d) => (
                    <li key={d.id} className="row">
                      <span className="device-line">{deviceLine(d)}</span>
                      <button
                        className="btn"
                        type="button"
                        aria-label={`Remove ${d.name}`}
                        onClick={() => void remove(d.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {status.phase === 'problem' && (
            <>
              <p className="error-text" role="alert">
                {status.message}
              </p>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void act(async () => {
                    await api.remote.enable(false);
                    await api.remote.enable(true);
                  })
                }
              >
                Try again
              </button>
            </>
          )}
          {SIGNED_IN.includes(status.phase) && (
            <button
              className="link small-link"
              type="button"
              onClick={() => {
                if (!window.confirm(SIGN_OUT_WARNING)) return;
                hideCode();
                setAdded(undefined);
                void act(api.remote.signOut);
              }}
            >
              Sign out of Tailscale
            </button>
          )}
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
