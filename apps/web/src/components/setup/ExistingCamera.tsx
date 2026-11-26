import { useState, type FormEvent } from 'react';
import type { SetupCamera } from '@kasa/shared';
import { api, ApiRequestError } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useHeadingFocus } from './useHeadingFocus';

const RESTART_RETRY_MS = 500;

export function ExistingCamera({ onDone, onBack }: { onDone(): void; onBack(): void }) {
  const heading = useHeadingFocus();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<SetupCamera[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const connect = async (alias?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      let result;
      try {
        result = await api.setup.existingCamera(username, password, alias);
      } catch (err) {
        // The server reloads after the password step, so the first try can miss it.
        if (err instanceof ApiRequestError) throw err;
        await new Promise((resolve) => setTimeout(resolve, RESTART_RETRY_MS));
        result = await api.setup.existingCamera(username, password, alias);
      }
      if ('saved' in result) onDone();
      else setChoices(result.choose);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void connect();
  };

  if (choices) {
    return (
      <div className="login">
        <div className="panel login-card">
          <h1 ref={heading} tabIndex={-1}>
            Which camera?
          </h1>
          <p>More than one camera uses this login. Pick the one to watch.</p>
          {choices.map((camera) => (
            <button
              key={camera.host}
              type="button"
              className="btn choice-btn"
              disabled={busy}
              onClick={() => void connect(camera.alias)}
            >
              {camera.alias}
            </button>
          ))}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit}>
        <h1 ref={heading} tabIndex={-1}>
          Connect your camera
        </h1>
        <label className="field">
          <span>Kasa email</span>
          <input
            type="text"
            inputMode="email"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Kasa password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button className="link" type="button" onClick={onBack}>
          Back
        </button>
      </form>
    </div>
  );
}
