import * as nm from './nmcli.js';
import { OnboardingError } from './onboarding.js';

/**
 * Moves this computer between the home Wi-Fi and the camera's setup Wi-Fi
 * during onboarding. The automatic one uses nmcli on Linux. The manual one
 * does nothing: the person switches networks by hand and onboarding waits
 * until it sees the camera (or the home network) answer.
 */
export interface WifiSwitcher {
  readonly auto: boolean;
  /** Join the camera's setup network; returns its name when known. */
  joinCameraNetwork(): Promise<string | undefined>;
  returnHome(): Promise<void>;
}

export function manualSwitcher(): WifiSwitcher {
  return {
    auto: false,
    joinCameraNetwork: async () => undefined,
    returnHome: async () => {},
  };
}

export interface NmcliSwitcherOptions {
  /**
   * Choose the camera's network from the visible ones. Without it the
   * strongest open network that looks like a camera is joined.
   */
  pickNetwork?(
    networks: nm.VisibleNetwork[],
  ): Promise<{ ssid: string; password?: string | undefined }>;
  /** Progress lines for a terminal. */
  onNote?(text: string): void;
  /** Called when nmcli is there but this computer isn't on Wi-Fi. */
  onNotOnWifi?(): void;
  /** Time to let the network settle after a switch (default 3 s). */
  settleMs?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickLikelyCamera(networks: nm.VisibleNetwork[]): { ssid: string } {
  const pick = networks.find((n) => nm.looksLikeCameraNetwork(n.ssid) && !n.security);
  if (!pick) {
    throw new OnboardingError(
      'No Wi-Fi network that looks like a camera is in range. Check that the camera is reset and close by.',
    );
  }
  return pick;
}

export function nmcliSwitcher(homeProfile: string, opts: NmcliSwitcherOptions = {}): WifiSwitcher {
  const note = (text: string) => opts.onNote?.(text);
  const settle = () => wait(opts.settleMs ?? 3000);
  return {
    auto: true,
    async joinCameraNetwork() {
      note('Scanning for Wi-Fi networks…');
      const all = await nm.listWifi();
      const pick: { ssid: string; password?: string | undefined } = opts.pickNetwork
        ? await opts.pickNetwork(all)
        : pickLikelyCamera(all);
      note(`Joining ${pick.ssid}…`);
      await nm.joinSetupNetwork(pick.ssid, pick.password);
      await settle();
      return pick.ssid;
    },
    async returnHome() {
      note(`\nRejoining ${homeProfile}…`);
      try {
        await nm.reconnect(homeProfile);
      } finally {
        await nm.deleteSetupProfile();
      }
      await settle();
    },
  };
}

/**
 * nmcli when this computer is on Wi-Fi through NetworkManager, otherwise
 * manual. KASA_WIFI_SWITCH=manual always picks manual, without running nmcli.
 */
export async function createWifiSwitcher(opts: NmcliSwitcherOptions = {}): Promise<WifiSwitcher> {
  if (process.env['KASA_WIFI_SWITCH'] === 'manual') return manualSwitcher();
  if (!(await nm.nmcliAvailable())) return manualSwitcher();
  const home = await nm.activeWifiConnection().catch(() => undefined);
  if (!home) {
    opts.onNotOnWifi?.();
    return manualSwitcher();
  }
  return nmcliSwitcher(home, opts);
}
