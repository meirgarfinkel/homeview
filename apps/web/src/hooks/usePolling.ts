import { useEffect, useState } from 'react';

/** Call `load` now and every `intervalMs`; keeps the last successful value. */
export function usePolling<T>(
  load: () => Promise<T>,
  intervalMs: number,
): {
  data: T | undefined;
  error: Error | undefined;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      load().then(
        (value) => {
          if (cancelled) return;
          setData(value);
          setError(undefined);
        },
        (err: Error) => !cancelled && setError(err),
      );
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, intervalMs]);
  return { data, error };
}
