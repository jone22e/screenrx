import type { FrameAspect, FrameFit } from '@shared/models/project'

/** The formats offered, in the order shown. The marks are in `frameAspectIcons.tsx`. */
export const FRAME_ASPECT_OPTIONS: ReadonlyArray<{ value: FrameAspect; label: string; hint: string }> = [
  { value: 'native', label: 'Nativo', hint: 'O formato da gravação.' },
  { value: 'reels', label: 'Reels', hint: 'Vertical 9:16, para o Instagram.' },
  { value: 'tiktok', label: 'TikTok', hint: 'Vertical 9:16, para o TikTok e o Shorts.' }
]

export const FRAME_ASPECT_LABELS: Record<FrameAspect, string> = Object.fromEntries(
  FRAME_ASPECT_OPTIONS.map((option) => [option.value, option.label])
) as Record<FrameAspect, string>

/** How the recording goes into the vertical frame. */
export const FRAME_FIT_OPTIONS: ReadonlyArray<{ value: FrameFit; label: string; hint: string }> = [
  { value: 'fit', label: 'Reduzir', hint: 'A gravação inteira aparece, menor, sobre o fundo.' },
  { value: 'fill', label: 'Zoom', hint: 'A gravação preenche o vídeo; arraste-a no preview para escolher a parte usada.' }
]
