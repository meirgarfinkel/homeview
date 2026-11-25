import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { OnboardingAnswer, OnboardingNetwork, OnboardingStatus } from '@kasa/shared';
import { api, ApiRequestError } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { TP_LINK_URL } from './CameraChoice';
import { useHeadingFocus } from './useHeadingFocus';

const POLL_MS = 1000;
/** Failed polls in a row before the page says it can't reach Kasa Home. */
const QUIET_FAILURES = 4;
const DEFAULT_ALIAS = 'nursery';

type Account = { username: string; password: string };

function Screen({ title, children }: { title: string; children?: ReactNode }) {
  const heading = useHeadingFocus();
  return (
    <div className="login">
      <div className="panel login-card">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

function bySignal(a: OnboardingNetwork, b: OnboardingNetwork) {
  return (b.signal ?? -Infinity) - (a.signal ?? -Infinity);
}

function ChooseWifi({
  networks,
  busy,
  onSubmit,
}: {
  networks: OnboardingNetwork[];
  busy: boolean;
  onSubmit(ssid: string, passphrase: string, alias: string): void;
}) {
  const sorted = [...networks].sort(bySignal);
  const [picked, setPicked] = useState<string>();
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [alias, setAlias] = useState(DEFAULT_ALIAS);
  const manual = sorted.length === 0;
  const ssid = manual ? typed.trim() : (picked ?? sorted[0]!.ssid);
  const open = !manual && (sorted.find((n) => n.ssid === ssid)?.open ?? false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(ssid, open ? '' : passphrase, alias.trim() || DEFAULT_ALIAS);
  };

  return (
    <form onSubmit={submit}>
      {manual ? (
        <label className="field">
          <span>Wi-Fi name</span>
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      ) : (
        <fieldset className="field">
          <legend>Wi-Fi network</legend>
          {sorted.map((n) => (
            <label key={n.ssid} className="network">
              <input
                type="radio"
                name="network"
                checked={n.ssid === ssid}
                onChange={() => setPicked(n.ssid)}
              />{' '}
              {n.ssid}
              {n.open ? ' (open)' : ''}
            </label>
          ))}
        </fieldset>
      )}
      {!open && (
        <label className="field">
          <span>Wi-Fi password</span>
          <input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>Camera name</span>
        <input type="text" value={alias} onChange={(e) => setAlias(e.target.value)} />
      </label>
      <p className="hint">The camera only works on 2.4 GHz Wi-Fi.</p>
      <button className="btn btn-primary" type="submit" disabled={busy || !ssid}>
        Connect the camera
      </button>
    </form>
  );
}

export function Onboarding({
  mode,
  account: presetAccount,
  onDone,
  onCancel,
}: {
  mode: 'account' | 'local';
  /** Skips the account screen when given. */
  account?: Account;
  onDone(): void;
  onCancel(): void;
}) {
  const needsAccount = mode === 'account' && !presetAccount;
  const [account, setAccount] = useState<Account | undefined>(presetAccount);
  const [email, setEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [status, setStatus] = useState<OnboardingStatus>();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  /** Bumped by every answer, so a poll that began earlier can't overwrite a newer status. */
  const version = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Fill the email from a saved camera account, when there is one.
  useEffect(() => {
    if (!needsAccount) return;
    api.settings().then(
      (s) => {
        const saved = s.camera?.username;
        if (saved && mounted.current) setEmail((current) => current || saved);
      },
      () => undefined,
    );
  }, [needsAccount]);

  const start = async () => {
    if (mode === 'account' && !account) return;
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await api.setup.startOnboarding(mode, mode === 'account' ? account : undefined));
      setStarted(true);
    } catch (err) {
      // A run is already going: pick it up instead of starting another.
      if (err instanceof ApiRequestError && err.code === 'onboarding-running') setStarted(true);
      else if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // Local mode starts at once; account mode starts once the account is typed.
  const autoStarted = useRef(false);
  useEffect(() => {
    if ((mode === 'account' && !account) || autoStarted.current) return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const phase = status?.phase;
  const finished = phase === 'done';

  useEffect(() => {
    if (!started || finished) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      const seen = version.current;
      try {
        const next = await api.setup.onboarding();
        if (stopped) return;
        failures = 0;
        setUnreachable(false);
        if (seen === version.current) setStatus(next);
        if (next.phase === 'done') return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setError(errorText(err));
          return;
        }
        failures += 1;
        if (failures > QUIET_FAILURES) setUnreachable(true);
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [started, finished]);

  useEffect(() => {
    if (finished) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const answer = async (a: OnboardingAnswer) => {
    setBusy(true);
    setError(undefined);
    version.current += 1;
    try {
      const next = await api.setup.answer(a);
      if (mounted.current) setStatus(next);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    if (started) {
      try {
        await api.setup.cancelOnboarding();
      } catch {
        // Going back matters more than a clean stop.
      }
    }
    if (mounted.current) onCancel();
  };

  const cancelButton = (
    <button className="link" type="button" disabled={busy && !error} onClick={() => void cancel()}>
      Cancel
    </button>
  );
  const errorLine = error && (
    <p className="error-text" role="alert">
      {error}
    </p>
  );
  const notice = unreachable && (
    <p className="error-text" role="status">
      Could not reach Kasa Home. Still trying…
    </p>
  );

  // Automatic Wi-Fi switching has nothing to ask, so it shares this screen.
  const waiting = (
    <Screen key="waiting" title="Waiting for the camera to join your Wi-Fi (up to 2 minutes)…">
      {notice}
      {cancelButton}
    </Screen>
  );

  if (needsAccount && !account) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      setAccount({ username: email.trim(), password: accountPassword });
    };
    return (
      <div className="login">
        <form className="panel login-card" onSubmit={submit}>
          <AccountHeading />
          <label className="field">
            <span>TP-Link email</span>
            <input
              type="text"
              inputMode="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>TP-Link password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={accountPassword}
              onChange={(e) => setAccountPassword(e.target.value)}
            />
          </label>
          <p className="hint">
            No account yet? Create one free at{' '}
            <a href={TP_LINK_URL} target="_blank" rel="noopener noreferrer">
              myproducts.tp-link.com
            </a>
            , then come back.
          </p>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!email.trim() || !accountPassword}
          >
            Next
          </button>
          <button className="link" type="button" onClick={onCancel}>
            Cancel
          </button>
        </form>
      </div>
    );
  }

  if (!started || !status) {
    // The account was typed (or none is needed) and the job is starting.
    if (error) {
      return (
        <Screen title="Could not start camera setup">
          {errorLine}
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => void start()}
          >
            Try again
          </button>
          {cancelButton}
        </Screen>
      );
    }
    return <Screen key="starting" title="Starting camera setup…" />;
  }

  switch (status.phase) {
    case 'reset-camera':
      return (
        <Screen key="reset" title="Reset the camera">
          <p>
            Hold the camera&apos;s reset button until it resets (its manual says how long). After
            about a minute it starts its own Wi-Fi network, named like Kasa_Cam_1A2B.
          </p>
          {errorLine}
          {notice}
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => void answer({ type: 'camera-reset' })}
          >
            The camera is reset
          </button>
          {cancelButton}
        </Screen>
      );
    case 'join-camera-wifi':
      return status.autoWifi ? (
        <Screen key="join-auto" title="Connecting to the camera…">
          {notice}
          {cancelButton}
        </Screen>
      ) : (
        <Screen key="join-manual" title="Join the camera's Wi-Fi">
          <p>
            On this computer, open the Wi-Fi menu and join the network named like Kasa_Cam_1A2B. It
            has no password. This page carries on by itself once you have.
          </p>
          {notice}
          {cancelButton}
        </Screen>
      );
    case 'scanning':
      return (
        <Screen key="scanning" title="Asking the camera which networks it can see…">
          {notice}
          {cancelButton}
        </Screen>
      );
    case 'choose-wifi':
      return (
        <Screen key="choose" title="Choose your home Wi-Fi">
          <ChooseWifi
            networks={status.networks ?? []}
            busy={busy}
            onSubmit={(ssid, passphrase, alias) =>
              void answer({ type: 'wifi', ssid, passphrase, alias })
            }
          />
          {errorLine}
          {notice}
          {cancelButton}
        </Screen>
      );
    case 'return-home':
      return status.autoWifi ? (
        waiting
      ) : (
        <Screen key="return" title="Rejoin your home Wi-Fi">
          <p>Switch this computer back to your home Wi-Fi. This page carries on by itself.</p>
          {notice}
          {cancelButton}
        </Screen>
      );
    case 'sending':
    case 'waiting-for-camera':
    case 'finishing':
    case 'done':
      return waiting;
    case 'failed':
      return (
        <Screen key="failed" title="Camera setup did not finish">
          <p role="alert">{status.error?.message ?? 'Something went wrong. Try again.'}</p>
          {errorLine}
          {notice}
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => void answer({ type: 'retry' })}
          >
            Try again
          </button>
          {cancelButton}
        </Screen>
      );
  }
}

function AccountHeading() {
  const heading = useHeadingFocus();
  return (
    <h1 ref={heading} tabIndex={-1}>
      Your TP-Link account
    </h1>
  );
}
