/** The HomeView app icon, the same picture as the favicon and the desktop app. */
export function AppLogo({ big = false }: { big?: boolean }) {
  return (
    <img className={`logo${big ? ' big' : ''}`} src="/favicon.svg" alt="" aria-hidden="true" />
  );
}
