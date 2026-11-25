import { useEffect, useRef, type RefObject } from 'react';

interface Props {
  levelRef: RefObject<number>;
  /** 0..1; levels above it count as "sound detected". */
  threshold: number;
  onSound(active: boolean): void;
}

const BARS = 16;
const HOLD_MS = 4000;

/** A segmented level meter driven by requestAnimationFrame (no React re-renders). */
export function SoundMeter({ levelRef, threshold, onSound }: Props) {
  const barsRef = useRef<HTMLDivElement>(null);
  const onSoundRef = useRef(onSound);
  onSoundRef.current = onSound;

  useEffect(() => {
    let frame = 0;
    let lastLoud = 0;
    let active = false;
    const draw = () => {
      const level = levelRef.current ?? 0;
      const lit = Math.round(level * BARS);
      const bars = barsRef.current?.children;
      if (bars) {
        for (let i = 0; i < bars.length; i++) bars[i]!.classList.toggle('on', i < lit);
      }
      const now = performance.now();
      if (level >= threshold) lastLoud = now;
      const nowActive = now - lastLoud < HOLD_MS && lastLoud > 0;
      if (nowActive !== active) {
        active = nowActive;
        onSoundRef.current(active);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelRef, threshold]);

  return (
    <div
      className="meter"
      role="meter"
      aria-label="Sound level"
      aria-valuemin={0}
      aria-valuemax={1}
    >
      <div className="meter-bars" ref={barsRef}>
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} className={i >= BARS * threshold ? 'hot' : undefined} />
        ))}
      </div>
    </div>
  );
}
