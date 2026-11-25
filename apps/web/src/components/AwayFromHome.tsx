import { useCallback, useEffect, useState } from 'react';
import type { PairCodeResponse, RemoteDevice, RemotePhase, RemoteStatus } from '@kasa/shared';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { qrSvg } from '../lib/qr';

const POLL_MS = 2000;
const POLLING: RemotePhase[] = ['starting', 'sign-in', 'approve'];
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

  const load = useCallback(async () => {
    try {
      setStatus(await api.remote.status());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Ask again while the helper is working through its steps. Stops when the phase moves on
  // and when this section goes away.
  const phase = status?.phase;
  useEffect(() => {
    if (!phase || !POLLING.includes(phase)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, load]);

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
    setPairing(undefined);
    return act(() => api.remote.enable(on));
  };

  const addPhone = async () => {
    setError(undefined);
    try {
      setPairing(await api.remote.pairCode());
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
              <p>One more click: allow Kasa Home to share a web address.</p>
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
                setPairing(undefined);
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
