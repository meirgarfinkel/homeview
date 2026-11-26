import { useState } from 'react';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';

/** The "start with this computer" checkbox. Used by the All set page and the settings page. */
export function AutostartBox({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [error, setError] = useState<string>();

  const change = async (next: boolean) => {
    setEnabled(next);
    setError(undefined);
    try {
      await api.setAutostart(next);
    } catch (err) {
      setEnabled(!next);
      setError(errorText(err));
    }
  };

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => void change(e.target.checked)} />
        <span>Start HomeView when this computer starts</span>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
