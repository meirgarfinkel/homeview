/** Shown on the away-from-home address to a phone that was never paired. */
export function NotPaired() {
  return (
    <div className="login">
      <div className="panel login-card">
        <span className="moon big" aria-hidden="true" />
        <h1>HomeView</h1>
        <p>
          This phone isn&apos;t set up to watch from away. At home, scan the code in HomeView on
          your computer.
        </p>
      </div>
    </div>
  );
}
