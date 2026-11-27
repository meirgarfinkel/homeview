import { useCallback, useEffect, useRef, useState } from 'react';
import type { PtzDirection, PtzPreset } from '@kasa/shared';
import { api } from '../lib/api';
import { ArrowIcon } from './Icons';

/** A press longer than this turns from a single step into continuous motion. */
const HOLD_AFTER_MS = 350;
/** A touch waits this long before moving, so a swipe that starts on an arrow can scroll the page. */
const TOUCH_DELAY_MS = 150;
/** While held, renew the hold this often (the server stops if renewals stop). */
const RENEW_MS = 400;

const ARROWS: Record<string, PtzDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

interface Props {
  onError(message: string | undefined): void;
}

interface Press {
  dir: PtzDirection;
  holdTimer: ReturnType<typeof setTimeout>;
  renewTimer?: ReturnType<typeof setInterval>;
}

/**
 * Pan/tilt pad. A tap (or arrow key press) moves one small step. Keep it
 * pressed and, after HOLD_AFTER_MS, the camera moves faster and keeps going
 * until you let go or it reaches the end of its travel.
 */
export function PtzPad({ onError }: Props) {
  const [active, setActive] = useState<PtzDirection>();
  const [presets, setPresets] = useState<PtzPreset[]>([]);
  const press = useRef<Press | undefined>(undefined);
  /** A touch that hasn't started moving the camera yet. */
  const pendingTouch = useRef<{ dir: PtzDirection; timer: ReturnType<typeof setTimeout> }>(
    undefined,
  );

  const dropPendingTouch = useCallback(() => {
    const pending = pendingTouch.current;
    if (pending) clearTimeout(pending.timer);
    pendingTouch.current = undefined;
    return pending;
  }, []);

  const report = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const release = useCallback(() => {
    const current = press.current;
    if (!current) return;
    press.current = undefined;
    clearTimeout(current.holdTimer);
    setActive(undefined);
    if (current.renewTimer !== undefined) {
      clearInterval(current.renewTimer);
      api.ptzStop().catch(report);
    }
    // A plain tap needs no stop: its single step finishes by itself.
  }, [report]);

  const begin = useCallback(
    (dir: PtzDirection) => {
      release();
      onError(undefined);
      setActive(dir);
      api.ptzMove(dir, 'step').catch(report);
      const current: Press = {
        dir,
        holdTimer: setTimeout(() => {
          if (press.current !== current) return;
          const renew = () => api.ptzMove(dir, 'hold').catch(report);
          void renew();
          current.renewTimer = setInterval(renew, RENEW_MS);
        }, HOLD_AFTER_MS),
      };
      press.current = current;
    },
    [onError, release, report],
  );

  useEffect(() => {
    api.presets().then(setPresets, () => undefined);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const dir = ARROWS[e.key];
      if (!dir || (e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      // Holding a key auto-repeats keydown; only the first press counts.
      if (!e.repeat) begin(dir);
    };
    const up = (e: KeyboardEvent) => {
      if (ARROWS[e.key] && press.current?.dir === ARROWS[e.key]) release();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      dropPendingTouch();
      release();
    };
  }, [begin, release, dropPendingTouch]);

  const button = (dir: PtzDirection) => (
    <button
      type="button"
      className={`ptz-btn ptz-${dir}${active === dir ? ' active' : ''}`}
      aria-label={`Pan ${dir}`}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') {
          dropPendingTouch();
          pendingTouch.current = {
            dir,
            timer: setTimeout(() => {
              pendingTouch.current = undefined;
              begin(dir);
            }, TOUCH_DELAY_MS),
          };
          return;
        }
        e.currentTarget.setPointerCapture?.(e.pointerId);
        begin(dir);
      }}
      onPointerUp={() => {
        // A quick tap ends before the delay: it still moves one step.
        const pending = dropPendingTouch();
        if (pending) begin(pending.dir);
        release();
      }}
      onPointerCancel={() => {
        // The browser took the touch for scrolling.
        dropPendingTouch();
        release();
      }}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ArrowIcon direction={dir} size={18} />
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
      <p className="hint">Arrow keys work too.</p>
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
