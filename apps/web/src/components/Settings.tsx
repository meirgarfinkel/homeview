import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SettingsResponse, SetupCamera } from '@kasa/shared';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { AutostartBox } from './setup/AutostartBox';
import { Onboarding } from './setup/Onboarding';

const MIN_LENGTH = 8;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const Failure = ({ text }: { text: string | undefined }) =>
  text ? (
    <p className="error-text" role="alert">
      {text}
    </p>
  ) : null;

function ViewerPassword({ fromEnv }: { fromEnv: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (fromEnv) {
    return (
      <Section title="Viewer password">
        <p className="hint">Set in .env</p>
      </Section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      // The server sends a fresh cookie, so this browser stays signed in.
      await api.changeViewerPassword(current, next);
      setCurrent('');
      setNext('');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Viewer password">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <p className="hint">At least 8 characters</p>
        <Failure text={error} />
        {done && <p role="status">Password changed.</p>}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || !current || next.length < MIN_LENGTH}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Section>
  );
}

function CameraLogin({ saved, fromEnv }: { saved: string | undefined; fromEnv: boolean }) {
  const [username, setUsername] = useState(saved ?? '');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<SetupCamera[]>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (fromEnv) {
    return (
      <Section title="Camera">
        <p className="hint">Set in .env</p>
      </Section>
    );
  }

  const connect = async (alias?: string) => {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      const result = await api.changeCamera(username, password, alias);
      if ('saved' in result) {
        setChoices(undefined);
        setPassword('');
        setDone(true);
      } else setChoices(result.choose);
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

  return (
    <Section title="Camera">
      {choices ? (
        <>
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
          <Failure text={error} />
        </>
      ) : (
        <form className="stack" onSubmit={submit}>
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
          <Failure text={error} />
          {done && <p role="status">Camera saved.</p>}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !username || !password}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
    </Section>
  );
}

function StopSection() {
  const [asking, setAsking] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string>();

  const stop = async () => {
    setError(undefined);
    try {
      await api.quit();
      setStopped(true);
    } catch (err) {
      setError(errorText(err));
      setAsking(false);
    }
  };

  return (
    <Section title="Stop Kasa Home">
      {stopped ? (
        <p role="status">Kasa Home has stopped. You can close this tab.</p>
      ) : asking ? (
        <>
          <p>Stop Kasa Home? Nobody can watch until you open it again.</p>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={() => void stop()}>
              Yes, stop
            </button>
            <button className="btn" type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <button className="btn" type="button" onClick={() => setAsking(true)}>
            Stop Kasa Home
          </button>
          <Failure text={error} />
        </>
      )}
    </Section>
  );
}

export function Settings({ onClose }: { onClose(): void }) {
  const [settings, setSettings] = useState<SettingsResponse>();
  const [error, setError] = useState<string>();
  const [onboarding, setOnboarding] = useState(false);

  const load = useCallback(() => {
    api.settings().then(setSettings, (err: unknown) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  if (onboarding && settings) {
    const back = () => {
      setOnboarding(false);
      load();
    };
    return (
      <Onboarding
        mode={settings.camera && !settings.camera.localOnly ? 'account' : 'local'}
        onDone={back}
        onCancel={back}
      />
    );
  }

  return (
    <div className="login settings">
      <div className="settings-page">
        <header className="settings-head">
          <h1>Settings</h1>
          <button className="btn" type="button" onClick={onClose}>
            Back
          </button>
        </header>
        {error && <Failure text={error} />}
        {settings && (
          <>
            <ViewerPassword fromEnv={settings.managedByEnv.includes('viewerPassword')} />
            <CameraLogin
              saved={settings.camera?.username}
              fromEnv={settings.managedByEnv.includes('camera')}
            />
            {settings.local && (
              <Section title="Set up a new or reset camera">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setOnboarding(true)}
                >
                  Set up a camera
                </button>
              </Section>
            )}
            {settings.local && settings.desktop && settings.autostart !== null && (
              <Section title="Start when this computer starts">
                <AutostartBox initial={settings.autostart} />
              </Section>
            )}
            {settings.local && settings.desktop && <StopSection />}
          </>
        )}
      </div>
    </div>
  );
}
