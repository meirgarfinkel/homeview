import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useHeadingFocus } from './useHeadingFocus';

const MIN_LENGTH = 8;

export function PasswordStep({ onNext }: { onNext(): void }) {
  const heading = useHeadingFocus();
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const tooShort = password.length < MIN_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.setup.password(password);
      onNext();
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
        <h1 ref={heading} tabIndex={-1}>
          Welcome to Kasa Home
        </h1>
        <p>
          Choose a password. Everyone who watches the camera will type it, on any phone or computer.
        </p>
        <div className="field">
          <label htmlFor="setup-password">Password</label>
          <div className="row">
            <input
              id="setup-password"
              type={shown ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              aria-describedby="password-hint"
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              aria-pressed={shown}
              onClick={() => setShown((v) => !v)}
            >
              {shown ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <p id="password-hint" className="hint">
          At least 8 characters
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || tooShort}>
          {busy ? 'Saving…' : 'Next'}
        </button>
      </form>
    </div>
  );
}
