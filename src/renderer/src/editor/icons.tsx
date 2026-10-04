import type { ReactNode } from 'react'

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const BackIcon = () => (
  <Icon>
    <path d="m15 18-6-6 6-6" />
  </Icon>
)

export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Icon>
)

export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Icon>
)

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
  </svg>
)

export const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <rect x="5" y="4" width="5" height="16" rx="1.5" />
    <rect x="14" y="4" width="5" height="16" rx="1.5" />
  </svg>
)

export const SkipStartIcon = () => (
  <Icon>
    <path d="M6 5v14M19 5 9 12l10 7z" />
  </Icon>
)

export const ExportIcon = () => (
  <Icon>
    <path d="M12 15V3M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Icon>
)

export const ScissorsIcon = () => (
  <Icon>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
  </Icon>
)

export const ZoomIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
  </Icon>
)

export const BackdropIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m3 16 5-5 4 4 3-3 6 6" />
    <circle cx="15.5" cy="8.5" r="1.5" />
  </Icon>
)

export const CameraIcon = () => (
  <Icon>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 11 5-3.3v8.6L16 13" />
  </Icon>
)

export const FilmIcon = () => (
  <Icon size={13}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" />
  </Icon>
)

export const MicIcon = () => (
  <Icon size={13}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
)

export const SpeakerIcon = () => (
  <Icon size={13}>
    <path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon size={13}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Icon>
)

export const SparklesIcon = () => (
  <Icon>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </Icon>
)
