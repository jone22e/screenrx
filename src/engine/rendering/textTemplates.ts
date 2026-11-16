import type { CaptionStyle, TextMotion } from '@shared/models/project'
import { DEFAULT_TEXT_STYLE } from '@shared/models/project'

/** A ready-made text: how it looks, where it sits, how it comes and goes, and for how long. */
export interface TextTemplate {
  id: string
  label: string
  hint: string
  placeholder: string
  style: CaptionStyle
  enter: TextMotion
  exit: TextMotion
  durationMs: number
}

const base = (change: Partial<CaptionStyle>): CaptionStyle => ({ ...DEFAULT_TEXT_STYLE, ...change, position: { ...(change.position ?? DEFAULT_TEXT_STYLE.position) } })

export const TEXT_TEMPLATES: readonly TextTemplate[] = [
  {
    id: 'title',
    label: 'Título',
    hint: 'Grande, no meio, entra com pop e sai com fade: o nome do vídeo ou do capítulo.',
    placeholder: 'Seu título',
    style: base({ font: 'impact', sizeRatio: 0.09, bold: true, uppercase: true, backdrop: 'shadow', position: { x: 0.5, y: 0.4 } }),
    enter: { kind: 'pop', durationMs: 350 },
    exit: { kind: 'fade', durationMs: 300 },
    durationMs: 3000
  },
  {
    id: 'subtitle',
    label: 'Subtítulo',
    hint: 'Menor, abaixo do título, sobe ao entrar.',
    placeholder: 'Um complemento',
    style: base({ font: 'rounded', sizeRatio: 0.045, bold: false, backdrop: 'shadow', position: { x: 0.5, y: 0.52 } }),
    enter: { kind: 'slide-up', durationMs: 400 },
    exit: { kind: 'fade', durationMs: 300 },
    durationMs: 3000
  },
  {
    id: 'lower-third',
    label: 'Lower third',
    hint: 'Nome e cargo no canto inferior esquerdo, em caixa, como na TV.',
    placeholder: 'Nome · o que faz',
    style: base({ font: 'system', sizeRatio: 0.04, bold: true, backdrop: 'box', backdropColor: '#111111', color: '#ffffff', position: { x: 0.22, y: 0.86 } }),
    enter: { kind: 'slide-up', durationMs: 350 },
    exit: { kind: 'fade', durationMs: 250 },
    durationMs: 5000
  },
  {
    id: 'callout',
    label: 'Chamada',
    hint: 'Um aviso curto em destaque, amarelo, que pula na tela.',
    placeholder: 'Olha isso!',
    style: base({ font: 'impact', sizeRatio: 0.06, bold: true, uppercase: true, color: '#ffe14d', backdrop: 'outline', backdropColor: '#000000', position: { x: 0.5, y: 0.25 } }),
    enter: { kind: 'pop', durationMs: 250 },
    exit: { kind: 'pop', durationMs: 200 },
    durationMs: 2000
  }
]
