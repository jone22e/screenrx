import type { FrameAlign, FrameAspect, FrameFit } from '@shared/models/project'

/** The formats offered, in the order shown. The marks are in `frameAspectIcons.tsx`. */
export const FRAME_ASPECT_OPTIONS: ReadonlyArray<{ value: FrameAspect; label: string; ratio: string | null; hint: string }> = [
  { value: 'native', label: 'Original', ratio: null, hint: 'O formato da gravação.' },
  { value: '9:16', label: 'Vertical', ratio: '9:16', hint: 'Reels, TikTok, Shorts' },
  { value: '1:1', label: 'Quadrado', ratio: '1:1', hint: 'Feed' },
  { value: '4:5', label: 'Retrato', ratio: '4:5', hint: 'Feed' }
]

export const FRAME_ASPECT_LABELS: Record<FrameAspect, string> = Object.fromEntries(
  FRAME_ASPECT_OPTIONS.map((option) => [option.value, option.label])
) as Record<FrameAspect, string>

/** How the recording goes into a frame of another shape. */
/** The three ways in, as shown; "Seguir" stands for both follow modes. */
export type FrameFitChoice = 'fit' | 'fill' | 'follow'
export const FRAME_FIT_OPTIONS: ReadonlyArray<{ value: FrameFitChoice; label: string }> = [
  { value: 'fit', label: 'Ajustar' },
  { value: 'fill', label: 'Preencher' },
  { value: 'follow', label: 'Seguir' }
]

export const FRAME_FIT_HINTS: Record<FrameFit, string> = {
  fit: 'A gravação inteira aparece, menor, sobre o fundo.',
  fill: 'A gravação preenche o vídeo; arraste-a no preview para escolher a parte usada.',
  'follow-mouse': 'A gravação preenche o vídeo e a parte usada acompanha o mouse, com um leve atraso para não tremer.',
  'follow-zoom': 'A gravação preenche o vídeo e a parte usada acompanha os zooms da linha do tempo.',
  'follow-object': 'A gravação preenche o vídeo e a parte usada acompanha um objeto que você marca na imagem.'
}

/** What "Seguir" follows. */
export const FRAME_FOLLOW_OPTIONS: ReadonlyArray<{ value: Extract<FrameFit, 'follow-mouse' | 'follow-zoom' | 'follow-object'>; label: string }> = [
  { value: 'follow-mouse', label: 'Mouse' },
  { value: 'follow-zoom', label: 'Zoom' },
  { value: 'follow-object', label: 'Objeto' }
]

export const fitChoiceOf = (fit: FrameFit): FrameFitChoice => (fit === 'fit' || fit === 'fill' ? fit : 'follow')

export const FRAME_ALIGN_OPTIONS: ReadonlyArray<{ value: FrameAlign; label: string }> = [
  { value: 'top', label: 'Topo' },
  { value: 'center', label: 'Centro' },
  { value: 'bottom', label: 'Base' }
]

/** "16:10" for a 1920×1200 recording — the smallest whole numbers with its proportion. */
export function aspectLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height) || 1
  const w = width / divisor
  const h = height / divisor
  // Odd sizes give unreadable fractions: round them to the usual shapes.
  if (w > 32 || h > 32) {
    const ratio = width / height
    const usual: Array<[string, number]> = [['16:9', 16 / 9], ['16:10', 1.6], ['4:3', 4 / 3], ['3:2', 1.5], ['21:9', 21 / 9], ['1:1', 1], ['9:16', 9 / 16], ['4:5', 0.8], ['3:4', 0.75]]
    const closest = usual.reduce((best, candidate) => (Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio) ? candidate : best))
    return closest[0]
  }
  return `${w}:${h}`
}
