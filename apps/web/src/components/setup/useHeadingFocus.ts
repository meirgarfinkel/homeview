import { useEffect, useRef } from 'react';

/** Puts keyboard focus on a screen's heading when the screen appears. */
export function useHeadingFocus() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}
