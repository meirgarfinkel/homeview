import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SettingsResponse, SetupCamera, UpdateStatus } from '@kasa/shared';
import { useRestartWatch } from '../hooks/useRestartWatch';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { AwayFromHome } from './AwayFromHome';
import { CameraSection, ChangeCamera, StreamChoice } from './CameraSection';
import { ArrowIcon } from './Icons';
import { VideoQuality } from './settings/VideoQuality';
import { AutostartBox } from './setup/AutostartBox';
import { Onboarding } from './setup/Onboarding';

const MIN_LENGTH = 8;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
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
      <Section title="Camera login">
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
    <Section title="Camera login">
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

/** How often to ask while an update downloads after "Check for updates". */
const DOWNLOAD_POLL_MS = 2000;

/** The version, a check on request, and restarting into a downloaded update. */
function UpdatesSection({ version }: { version: string }) {
  /** Undefined until the first answer, and when this copy can't update itself. */
  const [status, setStatus] = useState<UpdateStatus>();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    api.update().then(
      (s) => setStatus(s ?? undefined),
      () => setStatus(undefined), // a copy run from source: no section
    );
  }, []);

  // While it downloads, keep asking until it's ready or has failed.
  const downloading = status?.state === 'downloading';
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => {
      api.update().then(setStatus, () => undefined);
    }, DOWNLOAD_POLL_MS);
    return () => clearInterval(timer);
  }, [downloading]);

  const failed = useCallback((s: UpdateStatus) => {
    setStatus(s);
    setRestarting(false);
  }, []);
  useRestartWatch(restarting, failed);

  if (!status) return null;

  const check = async () => {
    setChecking(true);
    setNote(undefined);
    setError(undefined);
    try {
      const { result } = await api.checkForUpdates();
      const next = await api.update();
      setStatus(next);
      if (result === 'up-to-date') setNote('HomeView is up to date.');
    } catch (err) {
      setError(`Couldn't check for updates: ${errorText(err)}`);
    } finally {
      setChecking(false);
    }
  };

  const restart = () => {
    setRestarting(true);
    api.installUpdate().catch((err: unknown) => {
      setRestarting(false);
      setError(errorText(err));
    });
  };

  return (
    <Section title="Updates">
      <p>This is HomeView {version}.</p>
      {restarting ? (
        <p role="status">Restarting…</p>
      ) : status.state === 'ready' ? (
        <>
          <p role="status">HomeView {status.version} is ready.</p>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={restart}>
              Restart to update
            </button>
          </div>
        </>
      ) : status.state === 'downloading' ? (
        <p role="status">Downloading HomeView {status.version}…</p>
      ) : (
        <>
          {status.state === 'error' && (
            <p className="error-text">Couldn't update HomeView: {status.message}</p>
          )}
          <div className="row">
            <button className="btn" type="button" disabled={checking} onClick={() => void check()}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
          {note && <p role="status">{note}</p>}
        </>
      )}
      <Failure text={error} />
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
    <Section title="Stop HomeView">
      {stopped ? (
        <p role="status">HomeView has stopped. You can close this tab.</p>
      ) : asking ? (
        <>
          <p>Stop HomeView? Nobody can watch until you open it again.</p>
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
            Stop HomeView
          </button>
          <Failure text={error} />
        </>
      )}
    </Section>
  );
}

/** On a phone signed in at home: go to the away-from-home address and pair this phone there. */
function UseAway() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api.remote.pairCode();
      window.location.assign(url);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Section title="Away from home">
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void go()}>
        Use this phone away from home
      </button>
      <Failure text={error} />
    </Section>
  );
}

type GroupId = 'camera' | 'video' | 'access' | 'app';

interface Group {
  id: GroupId;
  label: string;
  content: ReactNode;
}

/** The page's categories, in order, leaving out any with nothing to show. */
function settingsGroups(
  settings: SettingsResponse,
  o: {
    cameraFromEnv: boolean;
    otherBrand: boolean;
    phoneAway: boolean;
    onChangeCamera(): void;
    onSetUpCamera(): void;
  },
): Group[] {
  const app = settings.local && settings.desktop;
  const all: { id: GroupId; label: string; parts: ReactNode[] }[] = [
    {
      id: 'camera',
      label: 'Camera',
      parts: [
        settings.local && settings.camera && !o.cameraFromEnv && (
          <CameraSection key="in-use" camera={settings.camera} onChange={o.onChangeCamera} />
        ),
        !o.otherBrand && (
          <CameraLogin key="login" saved={settings.camera?.username} fromEnv={o.cameraFromEnv} />
        ),
        settings.local && !o.otherBrand && (
          <Section key="setup" title="Set up a new or reset camera">
            <button className="btn btn-primary" type="button" onClick={o.onSetUpCamera}>
              Set up a camera
            </button>
          </Section>
        ),
      ],
    },
    {
      id: 'video',
      label: 'Video',
      parts: [
        settings.camera && !o.otherBrand && (
          <Section key="quality" title="Video quality">
            <VideoQuality
              saved={settings.streamResolution}
              fromEnv={settings.managedByEnv.includes('streamResolution')}
              defaultSize={settings.cameraDefaultSize}
            />
          </Section>
        ),
        settings.local && o.otherBrand && (
          <Section key="stream" title="Stream">
            <StreamChoice />
          </Section>
        ),
      ],
    },
    {
      id: 'access',
      label: 'Access',
      parts: [
        <ViewerPassword key="viewer" fromEnv={settings.managedByEnv.includes('viewerPassword')} />,
        app && <AwayFromHome key="away" />,
        o.phoneAway && <UseAway key="use-away" />,
      ],
    },
    {
      id: 'app',
      label: 'App',
      parts: [
        app && settings.autostart !== null && (
          <Section key="autostart" title="Start when this computer starts">
            <AutostartBox initial={settings.autostart} />
          </Section>
        ),
        app && settings.version !== null && (
          <UpdatesSection key="updates" version={settings.version} />
        ),
        app && <StopSection key="stop" />,
      ],
    },
  ];
  return all
    .map(({ id, label, parts }) => ({ id, label, content: parts.filter(Boolean) }))
    .filter((g) => g.content.length > 0);
}

export function Settings({
  onClose,
  phoneAway = false,
}: {
  onClose(): void;
  /** This is a phone signed in at home while away-from-home viewing is on. */
  phoneAway?: boolean;
}) {
  const [settings, setSettings] = useState<SettingsResponse>();
  const [error, setError] = useState<string>();
  const [onboarding, setOnboarding] = useState(false);
  const [changing, setChanging] = useState(false);
  const [selected, setSelected] = useState<GroupId>('camera');

  const load = useCallback(() => {
    api.settings().then(setSettings, (err: unknown) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  if (changing) {
    const back = () => {
      setChanging(false);
      load();
    };
    return <ChangeCamera onDone={back} onCancel={back} />;
  }

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

  const cameraFromEnv = settings?.managedByEnv.includes('camera') ?? false;
  const otherBrand = settings?.camera?.kind === 'onvif';
  const groups = settings
    ? settingsGroups(settings, {
        cameraFromEnv,
        otherBrand,
        phoneAway,
        onChangeCamera: () => setChanging(true),
        onSetUpCamera: () => setOnboarding(true),
      })
    : [];
  const active = groups.some((g) => g.id === selected) ? selected : groups[0]?.id;

  return (
    <div className="settings">
      <div className="settings-page">
        <header className="settings-head">
          <button
            className="btn btn-icon"
            type="button"
            aria-label="Back"
            title="Back"
            onClick={onClose}
          >
            <ArrowIcon direction="left" />
          </button>
          <h1>Settings</h1>
        </header>
        {error && <Failure text={error} />}
        {groups.length > 0 && (
          <div className="settings-body">
            <nav className="settings-nav" aria-label="Settings sections">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="settings-nav-item"
                  aria-current={g.id === active ? 'page' : undefined}
                  onClick={() => setSelected(g.id)}
                >
                  {g.label}
                </button>
              ))}
            </nav>
            <div className="settings-pane">
              {groups.map((g) => (
                <section
                  key={g.id}
                  className={`settings-group${g.id === active ? ' is-active' : ''}`}
                  aria-labelledby={`settings-${g.id}`}
                >
                  <h2 id={`settings-${g.id}`} className="settings-group-title">
                    {g.label}
                  </h2>
                  {g.content}
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
