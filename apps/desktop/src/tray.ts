import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

export interface TrayActions {
  localUrl: string;
  open(): void;
  getAutostart(): boolean;
  setAutostart(on: boolean): void;
  showLogs(): void;
  quit(): void;
}

/** The images tsup copies to dist/tray, next to the bundled main.mjs. */
function trayIcon(): NativeImage {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tray');
  if (process.platform === 'darwin') {
    // Picks up trayTemplate@2x.png on its own. A template image is drawn in
    // the menu bar's colour, so it works in light and dark mode.
    const image = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(path.join(dir, 'tray.png'));
}

export interface TrayHandle {
  /** Rebuild the menu, after the autostart setting changes somewhere else. */
  refresh(): void;
}

export function createTray(actions: TrayActions): TrayHandle {
  const tray = new Tray(trayIcon());
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
