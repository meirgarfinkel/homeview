import { useHeadingFocus } from './useHeadingFocus';

export type Brand = 'kasa' | 'other';

export function BrandChoice({
  onChoose,
  onCancel,
}: {
  onChoose(brand: Brand): void;
  /** Shown when changing the camera from settings. */
  onCancel?: () => void;
}) {
  const heading = useHeadingFocus();
  return (
    <div className="login">
      <div className="panel login-card">
        <h1 ref={heading} tabIndex={-1}>
          Which camera do you have?
        </h1>
        <div className="choice">
          <button type="button" className="btn choice-btn" onClick={() => onChoose('kasa')}>
            Kasa
          </button>
        </div>
        <div className="choice">
          <button
            type="button"
            className="btn choice-btn"
            aria-describedby="other-brands"
            onClick={() => onChoose('other')}
          >
            Another brand
          </button>
          <p id="other-brands" className="hint">
            Reolink, Tapo, Amcrest and others
          </p>
        </div>
        {onCancel && (
          <button className="link" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
