import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

export interface TrayActions {
  localUrl: string;
  open(): void;
  getAutostart(): boolean;
  setAutostart(on: boolean): void;
  showLogs(): void;
  quit(): void;
}

/** Until the real icons arrive: a filled blue dot. */
function placeholderIcon(): NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 > (r - 1) ** 2) continue;
      // BGRA
      pixels.set([0xd0, 0x7a, 0x2a, 0xff], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

export interface TrayHandle {
  /** Rebuild the menu, after the autostart setting changes somewhere else. */
  refresh(): void;
}

export function createTray(actions: TrayActions): TrayHandle {
  const tray = new Tray(placeholderIcon());
  tray.setToolTip(`Kasa Home: ${actions.localUrl}`);

  const refresh = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Kasa Home', click: () => actions.open() },
        {
          label: 'Start with this computer',
          type: 'checkbox',
          checked: actions.getAutostart(),
          click: (item) => {
            actions.setAutostart(item.checked);
            refresh();
          },
        },
        { label: 'Show logs', click: () => actions.showLogs() },
        { type: 'separator' },
        { label: 'Quit', click: () => actions.quit() },
      ]),
    );
  refresh();
  return { refresh };
}
