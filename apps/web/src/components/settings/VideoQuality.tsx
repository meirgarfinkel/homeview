import { useEffect, useState } from 'react';
import type { CameraInfo, SettingsResponse } from '@kasa/shared';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';

type Value = SettingsResponse['streamResolution'];

/** The camera sizes that count as 2K. */
const TWO_K = ['2560x1440', '2304x1296'];

const SIZES: Record<string, string> = {
  '720P': '1280×720',
  '1080P': '1920×1080',
  '360P': '640×360',
};

interface Option {
  value: Value;
  label: string;
  size?: string;
}

/** "1280x720" → "720p", a 2K size → "2K", anything else → "W×H". */
export function sizeName(size: string): string {
  if (TWO_K.includes(size)) return '2K';
  const [w, h] = size.split('x');
  const named: Record<string, string> = { '360': '360p', '720': '720p', '1080': '1080p' };
  return (h && named[h]) ?? `${w}×${h}`;
}

function optionsFor(top: string | undefined, saved: Value, defaultSize: string | null): Option[] {
  const options: Option[] = [
    {
      value: null,
      label: defaultSize ? `Camera default (${sizeName(defaultSize)})` : 'Camera default',
    },
    { value: '720P', label: '720p', size: SIZES['720P'] },
    { value: '1080P', label: '1080p', size: SIZES['1080P'] },
  ];
  const twoK = [top, saved].find((v) => v && TWO_K.includes(v)) as Value | undefined;
  if (twoK) options.push({ value: twoK, label: '2K', size: twoK.replace('x', '×') });
  if (saved && !options.some((o) => o.value === saved)) {
    options.unshift({ value: saved, label: saved.toLowerCase(), size: SIZES[saved] });
  }
  return options;
}

/** Choose the stream size. Saving reloads the server, which restarts the stream. */
export function VideoQuality({
  saved,
  fromEnv,
  defaultSize,
}: {
  saved: Value;
  fromEnv: boolean;
  /** What the camera sends at its default, as "1280x720", once HomeView has seen it. */
  defaultSize: string | null;
}) {
  const { data: status } = usePolling(api.status, 5000);
  const stream = status?.stream;
  const [top, setTop] = useState<string>();
  const [value, setValue] = useState<Value>(saved);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    api.camera().then(
      (c: CameraInfo | undefined) => live && setTop(c?.resolution),
      () => undefined, // without it, 2K is offered only when it's already saved
    );
    return () => {
      live = false;
    };
  }, []);

  const choose = async (next: Value) => {
    const before = value;
    setValue(next);
    setBusy(true);
    setDone(false);
    setError(undefined);
    try {
      await api.setStreamResolution(next === '360P' ? null : next);
      setDone(true);
    } catch (err) {
      setValue(before);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <fieldset className="quality-list" disabled={fromEnv || busy}>
        <legend className="visually-hidden">Video quality</legend>
        {optionsFor(top, saved, defaultSize).map((o) => (
          <label key={o.value ?? 'default'} className="quality-option">
            <input
              type="radio"
              name="stream-resolution"
              value={o.value ?? ''}
              checked={value === o.value}
              onChange={() => void choose(o.value)}
            />
            <span>{o.label}</span>
            {o.size && <span className="hint">{o.size}</span>}
          </label>
        ))}
      </fieldset>
      <p className="hint">Higher looks sharper and uses more data.</p>
      {stream?.state === 'live' && stream.width && stream.height && (
        <p className="hint">
          Now streaming {stream.width}×{stream.height}
          {stream.fps ? ` · ${stream.fps} fps` : ''}
          {stream.kbps ? ` · ${stream.kbps} kb/s` : ''}
          {stream.viewers > 1 ? ` · ${stream.viewers} viewers` : ''}
        </p>
      )}
      {fromEnv && <p className="hint">Set in .env</p>}
      {done && <p role="status">Saved. The picture changes in a few seconds.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
