import { useCallback, useEffect, useRef, useState } from 'react';
import type { StreamState } from '@kasa/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { usePolling } from '../hooks/usePolling';
import { api } from '../lib/api';
import {
  CameraIcon,
  FullscreenIcon,
  PopOutIcon,
  SettingsIcon,
  SoundOffIcon,
  SoundOnIcon,
} from './Icons';
import { LiveStage } from './LiveStage';
import { PtzPad } from './PtzPad';
import { SoundMeter } from './SoundMeter';

const STATE_LABEL: Record<StreamState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Error',
};

function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    const acquire = () =>
      navigator.wakeLock.request('screen').then(
        (l) => (lock = l),
        () => undefined, // needs a secure context (localhost/https); optional
      );
    void acquire();
    const onVisible = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [enabled]);
}

export function Monitor({
  onSignOut,
  onOpenSettings,
}: {
  onSignOut?: () => void;
  onOpenSettings?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useLiveStream(videoRef);
  const { data: status } = usePolling(api.status, 5000);
  const { data: camera, error: cameraError } = usePolling(api.camera, 60_000);
  const [ptzError, setPtzError] = useState<string>();
  const [soundActive, setSoundActive] = useState(false);
  const [sensitivity, setSensitivity] = useState(() => {
    const saved = Number(localStorageGet('soundThreshold'));
    return saved > 0 && saved < 1 ? saved : 0.55;
  });

  const isLive = live.stream === 'live' && live.connection === 'open';
  useWakeLock(isLive);

  useEffect(() => {
    const name = camera?.alias ?? 'HomeView';
    document.title = soundActive ? `Sound — ${name}` : `${name} · Monitor`;
  }, [soundActive, camera?.alias]);

  useEffect(() => localStorageSet('soundThreshold', String(sensitivity)), [sensitivity]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void v.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  const snapshot = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `homeview-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'm') void (live.listening ? live.stopListening() : live.startListening());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen, live]);

  const ptz = status?.ptz;
  const showPtz = ptz !== 'unsupported' && ptz !== 'disabled';
  const stats = status?.stream;

  return (
    <div className={`app${soundActive ? ' sound-active' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="moon" aria-hidden="true" />
          <div>
            <h1>{camera?.alias ?? 'HomeView'}</h1>
            <p className="sub">
              {camera
                ? `${camera.model} · ${camera.host}`
                : cameraError
                  ? cameraError.message
                  : '…'}
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`pill pill-${isLive ? 'live' : live.stream}`}>
            <span className="dot" />
            {live.connection === 'open' ? STATE_LABEL[live.stream] : 'Offline'}
          </span>
          {onOpenSettings && (
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Settings"
              title="Settings"
              onClick={onOpenSettings}
            >
              <SettingsIcon />
            </button>
          )}
          {onSignOut && (
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </header>

      <main className="layout">
        <LiveStage
          live={live}
          videoRef={videoRef}
          stageRef={stageRef}
          onDoubleClick={toggleFullscreen}
        >
          {soundActive && <div className="sound-badge">Sound detected</div>}
          {stats?.width && (
            <div className="stage-meta">
              {stats.width}×{stats.height}
              {stats.fps ? ` · ${stats.fps} fps` : ''}
              {stats.kbps ? ` · ${stats.kbps} kb/s` : ''}
              {stats.viewers > 1 ? ` · ${stats.viewers} viewers` : ''}
            </div>
          )}
        </LiveStage>

        <aside className="side">
          <section className="panel">
            <h2>Sound</h2>
            {live.soundUnsupported ? (
              <p className="hint">This camera&apos;s sound format isn&apos;t supported yet.</p>
            ) : (
              <>
                <SoundMeter
                  levelRef={live.levelRef}
                  threshold={sensitivity}
                  onSound={setSoundActive}
                />
                <div className="row">
                  <button
                    type="button"
                    className={`btn btn-icon${live.listening ? ' btn-on' : ''}`}
                    onClick={() =>
                      void (live.listening ? live.stopListening() : live.startListening())
                    }
                    aria-pressed={live.listening}
                    aria-label={live.listening ? 'Mute sound' : 'Listen'}
                    title={live.listening ? 'Mute sound (M)' : 'Listen (M)'}
                  >
                    {live.listening ? <SoundOnIcon /> : <SoundOffIcon />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={live.volume}
                    onChange={(e) => live.setVolume(Number(e.target.value))}
                    aria-label="Volume"
                    disabled={!live.listening}
                  />
                </div>
                <label className="field">
                  <span>Alert when louder than</span>
                  <input
                    type="range"
                    min={0.2}
                    max={0.95}
                    step={0.05}
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                  />
                </label>
              </>
            )}
          </section>

          {showPtz && <PtzPad onError={setPtzError} />}
          {ptzError && <p className="error-text">{ptzError}</p>}

          <section className="panel">
            <h2>View</h2>
            <div className="row wrap">
              <button type="button" className="btn" onClick={toggleFullscreen}>
                <FullscreenIcon /> Fullscreen
              </button>
              {'pictureInPictureEnabled' in document && (
                <button type="button" className="btn" onClick={togglePip}>
                  <PopOutIcon /> Pop out
                </button>
              )}
              <button type="button" className="btn" onClick={snapshot} disabled={!isLive}>
                <CameraIcon /> Snapshot
              </button>
            </div>
            <p className="hint">Shortcuts: F fullscreen · M sound · arrows pan</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode); setting just won't persist
  }
}
