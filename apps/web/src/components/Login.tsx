import { useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '../lib/api';
import { errorText } from '../lib/errors';

const MIN_LENGTH = 8;

/** On this computer, anyone at the keyboard may choose a new viewer password. */
function ResetPassword({ onSuccess, onBack }: { onSuccess(): void; onBack(): void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mismatch = again !== '' && password !== again;
  const ready = password.length >= MIN_LENGTH && password === again;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      // The server answers with a fresh cookie, so this signs in too.
      await api.setup.resetPassword(password);
      onSuccess();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit}>
        <span className="moon big" aria-hidden="true" />
        <h1>Set a new password</h1>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <p className="hint">At least 8 characters</p>
        <label className="field">
          <span>New password again</span>
          <input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
        {mismatch && <p className="error-text">The two passwords do not match.</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
        <button className="link" type="button" onClick={onBack}>
          Back
        </button>
      </form>
    </div>
  );
}

export function Login({ onSuccess, local = false }: { onSuccess(): void; local?: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  if (resetting) return <ResetPassword onSuccess={onSuccess} onBack={() => setResetting(false)} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit}>
        <span className="moon big" aria-hidden="true" />
        <h1>Kasa Home</h1>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {local && (
          <button className="link" type="button" onClick={() => setResetting(true)}>
            Forgot it? Set a new password
          </button>
        )}
      </form>
    </div>
  );
}
