import type { Logger } from '../logger.js';
import type { LinkieClient } from './linkieClient.js';

/**
 * The camera stamps the time on its video (when its OSD time is on) using a
 * fixed UTC offset such as "UTC+2:00", plus an `area` label. It doesn't
 * follow daylight saving by itself, so HomeView keeps it in step with the
 * time zone of the computer running it (or KASA_TIMEZONE), re-checking
 * regularly so DST changes are picked up.
 */

export interface CameraTimeZone {
  /** The camera's format: "UTC+2:00", "UTC-5:00", "UTC+5:30", "UTC+0:00". */
  timezone: string;
  /** IANA name, e.g. "Asia/Jerusalem". */
  area: string;
}

/** The IANA time zone of this computer. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The camera's time zone setting for an IANA zone at a given moment. */
export function cameraTimeZone(zone: string, at: Date = new Date()): CameraTimeZone {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  const timezone = m ? `UTC${m[1]}${Number(m[2])}:${m[3] ?? '00'}` : 'UTC+0:00';
  return { timezone, area: zone };
}

export type SyncResult = 'unchanged' | 'updated';

export async function syncTimeZone(
  linkie: LinkieClient,
  zone: string,
  logger: Logger,
): Promise<SyncResult> {
  const want = cameraTimeZone(zone);
  const have = await linkie.call('dateTime', 'get_time_zone');
  if (have['timezone'] === want.timezone && have['area'] === want.area) return 'unchanged';
  await linkie.call('dateTime', 'set_time_zone', { ...want });
  logger.info(
    { from: have['timezone'], to: want.timezone, area: want.area },
    "Set the camera's time zone",
  );
  return 'updated';
}
