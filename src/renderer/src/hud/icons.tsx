import type { ReactNode } from 'react'

/** Line icons of the HUD, drawn on a 24×24 grid. */
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const GripIcon = () => (
  <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">
    {[2, 8, 14].flatMap((y) => [2, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" />))}
  </svg>
)

export const DisplayIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Icon>
)

export const WindowIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </Icon>
)

export const ChevronDownIcon = () => (
  <Icon size={14}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

export const MicIcon = () => (
  <Icon>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
)

export const CameraIcon = () => (
  <Icon>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 11 5-3.3v8.6L16 13" />
  </Icon>
)

export const SpeakerIcon = () => (
  <Icon size={15}>
    <path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7" />
  </Icon>
)

export const SpeakerOffIcon = () => (
  <Icon>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </Icon>
)

export const MicOffIcon = () => (
  <Icon>
    <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3" />
    <path d="M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </Icon>
)

export const CameraOffIcon = () => (
  <Icon>
    <path d="M10.7 6H14a2 2 0 0 1 2 2v3.3l5-3.3v8M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
    <path d="M3 3l18 18" />
  </Icon>
)

export const MoreIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)

export const MinimizeIcon = () => (
  <Icon>
    <path d="M6 12h12" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const PauseIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
    <rect x="3" y="2" width="3.5" height="12" rx="1" />
    <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
  </svg>
)

export const PlayIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5z" />
  </svg>
)
