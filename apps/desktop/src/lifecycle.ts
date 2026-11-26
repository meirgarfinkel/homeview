/** Small pieces of the app's start and quit, kept apart from Electron so they can be tested. */

interface Emitter {
  on(event: 'activate', listener: () => void): unknown;
}

/**
 * Open the page when macOS activates the app again (opened from Finder,
 * Launchpad or Spotlight while it runs). macOS also activates the app as it
 * launches, and startup opens the page itself then, so activations before
 * startup is done, and for settleMs after, are left alone.
 */
export function reopenOnActivate(
  app: Emitter,
  open: () => void,
  settleMs = 1500,
): { started(): void } {
  let ready = false;
  app.on('activate', () => {
    if (ready) open();
  });
  return {
    started() {
      setTimeout(() => {
        ready = true;
      }, settleMs).unref?.();
    },
  };
}

/** Stop, but give up after ms, so a stuck camera or socket can't stop the app quitting. */
export async function stopWithin(
  stop: () => Promise<void>,
  ms: number,
  log: (err: Error) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(new Error(`Stopping took longer than ${ms} ms; quitting anyway`));
      resolve();
    }, ms);
  });
  try {
    await Promise.race([stop().catch((err: unknown) => log(err as Error)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
