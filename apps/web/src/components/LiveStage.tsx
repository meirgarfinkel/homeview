import type { ReactNode, RefObject } from 'react';
import type { LiveStream } from '../hooks/useLiveStream';

/** What to tell the viewer while the picture isn't live yet. Undefined once it is. */
function overlayFor(live: LiveStream): { tone: 'error' | 'wait'; text: string } | undefined {
  if (live.playerError) return { tone: 'error', text: live.playerError };
  if (live.connection !== 'open') return { tone: 'wait', text: 'Connecting to monitor server…' };
  if (live.stream === 'error') return { tone: 'error', text: live.detail ?? 'Camera error' };
  if (live.stream === 'reconnecting')
    return {
      tone: 'wait',
      text: `Reconnecting to camera…${live.detail ? ` (${live.detail})` : ''}`,
    };
  if (live.stream !== 'live') return { tone: 'wait', text: 'Waking up the camera…' };
  return undefined;
}

/** The live picture with its status overlay. Extra stage controls go in as children. */
export function LiveStage({
  live,
  videoRef,
  stageRef,
  onTap,
  children,
}: {
  live: LiveStream;
  videoRef: RefObject<HTMLVideoElement | null>;
  stageRef?: RefObject<HTMLDivElement | null>;
  /** A tap or click on the picture. */
  onTap?: () => void;
  children?: ReactNode;
}) {
  const overlay = overlayFor(live);
  return (
    <div className={`stage${onTap ? ' stage-tap' : ''}`} ref={stageRef} onClick={onTap}>
      <video ref={videoRef} muted playsInline autoPlay disablePictureInPicture={false} />
      {overlay && (
        <div className={`overlay overlay-${overlay.tone}`}>
          {overlay.tone === 'wait' && <span className="spinner" aria-hidden="true" />}
          <p>{overlay.text}</p>
        </div>
      )}
      {children}
    </div>
  );
}
