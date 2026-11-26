import { useHeadingFocus } from './useHeadingFocus';

export type CameraKind = 'existing' | 'account' | 'local';

export const TP_LINK_URL = 'https://myproducts.tp-link.com';

export function CameraChoice({
  onChoose,
  onBack,
}: {
  onChoose(kind: CameraKind): void;
  onBack?: () => void;
}) {
  const heading = useHeadingFocus();
  return (
    <div className="login">
      <div className="panel login-card">
        <h1 ref={heading} tabIndex={-1}>
          Your camera
        </h1>
        <div className="choice">
          <button type="button" className="btn choice-btn" onClick={() => onChoose('existing')}>
            It already works in the Kasa app
          </button>
        </div>
        <div className="choice">
          <button type="button" className="btn choice-btn" onClick={() => onChoose('account')}>
            It&apos;s new or reset, and I have a TP-Link account
          </button>
          <p className="hint">
            No account yet? Create one free at{' '}
            <a href={TP_LINK_URL} target="_blank" rel="noopener noreferrer">
              myproducts.tp-link.com
            </a>
            , then come back.
          </p>
        </div>
        <div className="choice">
          <button
            type="button"
            className="btn choice-btn"
            aria-describedby="local-warning"
            onClick={() => onChoose('local')}
          >
            It&apos;s new or reset, and I don&apos;t want an account
          </button>
          <p id="local-warning" className="hint">
            The camera keeps its built-in admin / admin login, so anyone on your Wi-Fi who knows it
            could watch. The Kasa app won&apos;t work with it.
          </p>
        </div>
        {onBack && (
          <button className="link" type="button" onClick={onBack}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}
