import type { SVGProps } from 'react';

/**
 * Hand-drawn style line icons. Strokes use currentColor, so they follow the
 * text colour of whatever they sit in. Paths are deliberately a little
 * uneven to read as a pencil sketch rather than a pixel-perfect glyph.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A speaker cone, used by the sound icons. */
const Speaker = () => (
  <path d="M3.6 9.3c1.3-.1 2.6 0 3.9-.1l4.4-3.6c.2 4.3.3 8.6.1 12.8L7.6 14.8c-1.3 0-2.7.1-4-.1-.2-1.8-.2-3.6 0-5.4Z" />
);

export const SoundOnIcon = (p: IconProps) => (
  <Icon {...p}>
    <Speaker />
    <path d="M15.3 9.1c1.1 1.6 1.2 4.2-.1 5.9" />
    <path d="M17.9 6.6c2.4 2.9 2.5 7.9-.1 10.9" />
  </Icon>
);

export const SoundOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <Speaker />
    <path d="M15.6 9.6c1.5 1.6 3.2 3.4 4.8 5" />
    <path d="M20.3 9.4c-1.6 1.7-3.1 3.5-4.8 5.2" />
  </Icon>
);

export const ListenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.2 14.8c-.4-5.3 2.2-9.7 6.9-9.8 4.6 0 7.4 4.2 6.8 9.5" />
    <path d="M4.9 14.2c1.4-.3 2.6.2 2.8 1.6.2 1.4.3 2.8-.4 3.6-.9.6-2.1.4-2.6-.4-.3-1.5-.2-3.1.2-4.8Z" />
    <path d="M19 14.3c-1.4-.4-2.6.1-2.9 1.4-.2 1.4-.3 2.9.4 3.7.9.6 2.1.4 2.6-.4.4-1.5.3-3.1-.1-4.7Z" />
  </Icon>
);

export const FullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 9.3c-.1-1.6 0-3.3.1-4.9 1.6-.2 3.3-.1 4.9-.1" />
    <path d="M14.8 4.2c1.6 0 3.3 0 4.9.2.1 1.6.1 3.3 0 4.9" />
    <path d="M19.8 14.7c.1 1.7 0 3.3-.2 4.9-1.6.1-3.2.2-4.9.1" />
    <path d="M9.3 19.8c-1.7 0-3.3 0-4.9-.2-.2-1.6-.2-3.3-.1-4.9" />
  </Icon>
);

export const PopOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.4 6c5.5-.2 11-.2 16.6 0 .3 4.1.3 8.2 0 12.2-5.5.2-11.1.2-16.6 0-.2-4.1-.3-8.1 0-12.2Z" />
    <path d="M12.6 12.4c2.3-.1 4.6-.1 6.9 0 .1 1.8.1 3.7 0 5.5-2.3.1-4.6.1-6.9 0-.1-1.8-.1-3.7 0-5.5Z" />
  </Icon>
);

export const CameraIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.2 8.1c1.3-.2 2.7-.2 4-.1l1.5-2.4c2.2-.1 4.4-.1 6.6 0L16.8 8c1.3 0 2.7 0 4 .2.3 3.6.3 7.2 0 10.8-5.9.3-11.7.3-17.6 0-.3-3.6-.3-7.3 0-10.9Z" />
    <path d="M12.1 10.3c2 0 3.4 1.5 3.4 3.3 0 1.9-1.5 3.3-3.5 3.3-1.9-.1-3.4-1.5-3.3-3.4 0-1.8 1.5-3.2 3.4-3.2Z" />
  </Icon>
);

const ARROW_ROTATION = { up: 0, right: 90, down: 180, left: 270 } as const;

export const ArrowIcon = ({
  direction,
  ...p
}: IconProps & { direction: keyof typeof ARROW_ROTATION }) => (
  <Icon {...p}>
    <g transform={`rotate(${ARROW_ROTATION[direction]} 12 12)`}>
      <path d="M12.1 19.2c-.1-4.7 0-9.5-.2-14.2" />
      <path d="M6.6 10.4c1.9-1.8 3.7-3.7 5.5-5.6 1.8 1.9 3.6 3.8 5.4 5.7" />
    </g>
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    {/* A cog wheel: rays around a circle read as a sun. */}
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);
