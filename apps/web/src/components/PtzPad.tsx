import { useCallback, useEffect, useRef, useState } from 'react';
import type { PtzDirection, PtzPreset } from '@kasa/shared';
import { api } from '../lib/api';

const REPEAT_MS = 400;
const ARROWS: Record<string, PtzDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
const ICON: Record<PtzDirection, string> = { up: '▲', down: '▼', left: '◀', right: '▶' };

interface Props {
  onError(message: string | undefined): void;
}

/**
 * Press-and-hold pan/tilt. While held, the move request repeats every
 * REPEAT_MS; the server stops the motor if the repeats stop arriving.
 */
export function PtzPad({ onError }: Props) {
  const [active, setActive] = useState<PtzDirection>();
  const [presets, setPresets] = useState<PtzPreset[]>([]);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const report = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const start = useCallback(
    (dir: PtzDirection) => {
      clearInterval(timer.current);
      setActive(dir);
      onError(undefined);
      const send = () => api.ptzMove(dir).catch(report);
      void send();
      timer.current = setInterval(send, REPEAT_MS);
    },
    [onError, report],
  );

  const stop = useCallback(() => {
    if (timer.current === undefined) return;
    clearInterval(timer.current);
    timer.current = undefined;
    setActive(undefined);
    api.ptzStop().catch(report);
  }, [report]);

  useEffect(() => {
    api.presets().then(setPresets, () => undefined);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const dir = ARROWS[e.key];
      if (!dir || e.repeat || (e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      start(dir);
    };
    const up = (e: KeyboardEvent) => {
      if (ARROWS[e.key]) stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
      stop();
    };
  }, [start, stop]);

  const button = (dir: PtzDirection) => (
    <button
      type="button"
      className={`ptz-btn ptz-${dir}${active === dir ? ' active' : ''}`}
      aria-label={`Pan ${dir}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start(dir);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ICON[dir]}
    </button>
  );

  return (
    <section className="panel ptz" aria-label="Pan and tilt">
      <h2>Pan &amp; tilt</h2>
      <div className="ptz-pad">
        {button('up')}
        {button('left')}
        <span className="ptz-center" aria-hidden="true" />
        {button('right')}
        {button('down')}
      </div>
      <p className="hint">Hold a button, or use the arrow keys.</p>
      {presets.length > 0 && (
        <div className="presets">
          {presets.map((p) => (
            <button
              key={p.index}
              type="button"
              className="chip"
              onClick={() => api.goToPreset(p.index).catch(report)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
