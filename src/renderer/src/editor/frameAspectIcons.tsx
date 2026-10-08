import type { ReactNode } from 'react'
import type { FrameAspect } from '@shared/models/project'
import type { FrameFitChoice } from './frameAspects'

/** A rectangle of the format's proportion, as the tile's mark. */
export function AspectShapeIcon({ ratio }: { ratio: number }) {
  const box = 22
  const width = ratio >= 1 ? box : box * ratio
  const height = ratio >= 1 ? box / ratio : box
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <rect x={(24 - width) / 2} y={(24 - height) / 2} width={width} height={height} rx="2" />
    </svg>
  )
}

const FitIconShape = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <rect x="7" y="9" width="10" height="6" rx="1" />
  </svg>
)

const FillIconShape = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3v15a2 2 0 0 0 2 2h13M3 6h15a2 2 0 0 1 2 2v13" />
  </svg>
)

const FollowIconShape = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>
)

export const FRAME_FIT_ICONS: Record<FrameFitChoice, ReactNode> = {
  fit: <FitIconShape />,
  fill: <FillIconShape />,
  follow: <FollowIconShape />
}

/** The proportion each format's mark is drawn with; the original takes the recording's. */
export const FRAME_ASPECT_RATIOS: Record<Exclude<FrameAspect, 'native'>, number> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5
}
