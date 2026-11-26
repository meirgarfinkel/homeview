import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  OnvifCheckError,
  OnvifCheckResult,
  OnvifProfileInfo,
  OnvifScanCamera,
} from '@kasa/shared';
import { api, ApiRequestError } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useHeadingFocus } from './useHeadingFocus';

const RESTART_RETRY_MS = 500;

const ERRORS: Record<OnvifCheckError, string> = {
  'camera-login': "The camera didn't accept that username or password.",
  'onvif-off':
    "The camera answered, but ONVIF looks turned off. Turn it on in the camera's own app.",
  'no-answer': 'No answer from that address. Check the camera is on and on the same Wi-Fi.',
  'video-format': "This camera's video format isn't supported.",
  'bad-address': "That doesn't look like a camera address.",
};

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError && err.code in ERRORS) {
    return ERRORS[err.code as OnvifCheckError];
  }
  return errorText(err);
}

/** "1920×1080, H.265", or just the format when the size isn't known. */
export function profileLabel(p: OnvifProfileInfo): string {
  const codec = p.codec === 'h265' ? 'H.265' : 'H.264';
  return p.width && p.height ? `${p.width}×${p.height}, ${codec}` : codec;
}

/** Where the camera is: found by the search, or typed in. */
type Target =
  { host: string; port?: number; endpointId?: string; name?: string } | { rtspUrl: string };

/** "192.168.1.5", "192.168.1.5:8000", "[fe80::1]:80" or an rtsp:// address. */
export function parseAddress(text: string): Target | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^rtsp:\/\//i.test(t)) return { rtspUrl: t };
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (bracketed) {
    return { host: bracketed[1]!, ...(bracketed[2] ? { port: Number(bracketed[2]) } : {}) };
  }
  const parts = t.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    return { host: parts[0]!, port: Number(parts[1]) };
  }
  return { host: t };
}

/** The ONVIF part of a request body: where the camera is, without the name. */
function where(target: Target) {
  if ('rtspUrl' in target) return { rtspUrl: target.rtspUrl };
  return { host: target.host, ...(target.port ? { port: target.port } : {}) };
}

/** Retry once when the server is restarting after the password step. */
async function once<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    await new Promise((resolve) => setTimeout(resolve, RESTART_RETRY_MS));
    return call();
  }
}

export function OnvifSetup({ onDone, onBack }: { onDone(): void; onBack(): void }) {
  const [target, setTarget] = useState<Target>();
  if (target) {
    return <OnvifLogin target={target} onDone={onDone} onBack={() => setTarget(undefined)} />;
  }
  return <FindCamera onPick={setTarget} onBack={onBack} />;
}

function FindCamera({ onPick, onBack }: { onPick(t: Target): void; onBack(): void }) {
  const heading = useHeadingFocus();
  const [cameras, setCameras] = useState<OnvifScanCamera[]>();
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();

  const scan = useCallback(() => {
    setScanning(true);
    setError(undefined);
    once(() => api.setup.onvif.scan())
      .then(
        (r) => setCameras(r.cameras),
        (err: unknown) => setError(errorText(err)),
      )
      .finally(() => setScanning(false));
  }, []);
  useEffect(scan, [scan]);

  const typed = (e: FormEvent) => {
    e.preventDefault();
    const t = parseAddress(address);
    if (t) onPick(t);
    else setError(ERRORS['bad-address']);
  };

  return (
    <div className="login">
      <div className="panel login-card">
        <h1 ref={heading} tabIndex={-1}>
          Find your camera
        </h1>
        <p>Make sure the camera is set up in its own app and on your Wi-Fi.</p>
        <p className="hint">
          Tapo: in the Tapo app, create a &quot;Camera account&quot; (Advanced settings). Use that,
          not your Tapo login.
        </p>
        <p className="hint">
          Reolink: turn on ONVIF and RTSP in the camera&apos;s network settings if they are off.
        </p>
        <p className="hint">Others: use the camera&apos;s admin username and password.</p>

        {scanning && <p role="status">Searching…</p>}
        {!scanning && cameras && cameras.length === 0 && <p>No cameras found yet.</p>}
        {cameras?.map((c) => (
          <button
            key={c.endpointId}
            type="button"
            className="btn choice-btn camera-found"
            onClick={() =>
              onPick({
                host: c.host,
                port: c.port,
                endpointId: c.endpointId,
                ...(c.name ? { name: c.name } : {}),
              })
            }
          >
            {c.name ?? 'Camera'} <span className="hint">{c.host}</span>
          </button>
        ))}
        <button className="btn" type="button" disabled={scanning} onClick={scan}>
          Search again
        </button>

        {typing ? (
          <form className="stack" onSubmit={typed}>
            <label className="field">
              <span>Camera address</span>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                placeholder="192.168.1.20 or rtsp://…"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={!address.trim()}>
              Next
            </button>
          </form>
        ) : (
          <button className="link" type="button" onClick={() => setTyping(true)}>
            Not in the list? Type its address.
          </button>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="link" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function OnvifLogin({
  target,
  onDone,
  onBack,
}: {
  target: Target;
  onDone(): void;
  onBack(): void;
}) {
  const heading = useHeadingFocus();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [checked, setChecked] = useState<OnvifCheckResult>();
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setChecked(undefined);
    try {
      const result = await once(() =>
        api.setup.onvif.check({ ...where(target), username, password }),
      );
      setChecked(result);
      setToken(result.picked);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.setup.onvif.save({
        ...where(target),
        username,
        password,
        ...(token ? { profileToken: token } : {}),
        ...('endpointId' in target && target.endpointId ? { endpointId: target.endpointId } : {}),
      });
      onDone();
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  const chosen = checked?.profiles.find((p) => p.token === token);
  const name = 'rtspUrl' in target ? target.rtspUrl : (target.name ?? target.host);

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={(e) => void connect(e)}>
        <h1 ref={heading} tabIndex={-1}>
          Sign in to the camera
        </h1>
        <p className="hint">{name}</p>
        <label className="field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
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
        {!checked && (
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !username || !password}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {checked && chosen && (
          <>
            <p>
              {checked.model ? `${checked.model}. ` : ''}Stream:{' '}
              <strong>{profileLabel(chosen)}</strong>
            </p>
            {checked.profiles.length > 1 && (
              <label className="field">
                <span>Change</span>
                <select value={token} onChange={(e) => setToken(e.target.value)}>
                  {checked.profiles.map((p) => (
                    <option key={p.token} value={p.token}>
                      {profileLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
        <button className="link" type="button" onClick={onBack}>
          Back
        </button>
      </form>
    </div>
  );
}
