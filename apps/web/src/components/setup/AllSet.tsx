import { useRef } from 'react';
import { useLiveStream } from '../../hooks/useLiveStream';
import { qrSvg } from '../../lib/qr';
import { LiveStage } from '../LiveStage';
import { AutostartBox } from './AutostartBox';
import { useHeadingFocus } from './useHeadingFocus';

export function AllSet({
  lanUrl,
  autostart,
  onContinue,
}: {
  lanUrl: string | undefined;
  autostart: boolean | null;
  onContinue(): void;
}) {
  const heading = useHeadingFocus();
  const videoRef = useRef<HTMLVideoElement>(null);
  const live = useLiveStream(videoRef);
  const onWindows = /Windows/i.test(navigator.userAgent);

  return (
    <div className="login">
      <div className="panel all-set">
        <h1 ref={heading} tabIndex={-1}>
          All set
        </h1>
        <LiveStage live={live} videoRef={videoRef} />
        {lanUrl ? (
          <>
            <p>Watch on your phone: scan this, or type the address.</p>
            <div
              className="qr"
              role="img"
              aria-label={lanUrl}
              // Generated here from the address above; nothing from the network is rendered.
              dangerouslySetInnerHTML={{ __html: qrSvg(lanUrl) }}
            />
            <p className="address">{lanUrl}</p>
            <p className="hint">
              Phones show a security warning the first time. Tap Advanced, then Proceed. It&apos;s
              safe: Kasa Home makes its own certificate.
            </p>
            {onWindows && (
              <p className="hint">
                If Windows asks whether to allow Kasa Home on networks, allow it on private
                networks.
              </p>
            )}
          </>
        ) : (
          <p>Connect this computer to your Wi-Fi to watch on other devices.</p>
        )}
        {autostart !== null && <AutostartBox initial={autostart} />}
        <button className="btn btn-primary" type="button" onClick={onContinue}>
          Go to the monitor
        </button>
      </div>
    </div>
  );
}
