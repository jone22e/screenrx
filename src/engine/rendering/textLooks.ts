import type { CaptionStyle } from '@shared/models/project'

/**
 * Ready-made looks for a text: the font, weight, case, colours and backdrop
 * together, as one click. A look leaves the text's size and place alone,
 * so it can be tried on a text already laid out.
 */
export type TextLookStyle = Pick<CaptionStyle, 'font' | 'bold' | 'uppercase' | 'color' | 'backdrop' | 'backdropColor'>

export interface TextLook {
  id: string
  label: string
  hint: string
  style: TextLookStyle
}

const look = (id: string, label: string, hint: string, style: TextLookStyle): TextLook => ({ id, label, hint, style })

export const TEXT_LOOKS: readonly TextLook[] = [
  look('simple', 'Simples', 'Sem enfeite, com uma sombra para ler sobre qualquer fundo.', {
    font: 'system',
    bold: false,
    uppercase: false,
    color: '#ffffff',
    backdrop: 'shadow',
    backdropColor: '#000000'
  }),
  look('bold', 'Negrito', 'O mesmo, em negrito.', { font: 'system', bold: true, uppercase: false, color: '#ffffff', backdrop: 'shadow', backdropColor: '#000000' }),
  look('serif', 'Serifada', 'Clássica, de editorial.', { font: 'serif', bold: false, uppercase: false, color: '#ffffff', backdrop: 'shadow', backdropColor: '#000000' }),
  look('cursive', 'Cursiva', 'Manuscrita, para um toque pessoal.', {
    font: 'cursive',
    bold: false,
    uppercase: false,
    color: '#ffffff',
    backdrop: 'shadow',
    backdropColor: '#000000'
  }),
  look('typewriter', 'Máquina', 'Monoespaçada, de código e de máquina de escrever.', {
    font: 'mono',
    bold: false,
    uppercase: false,
    color: '#ffffff',
    backdrop: 'shadow',
    backdropColor: '#000000'
  }),
  look('box', 'Caixa', 'Branco sobre uma caixa escura, como uma tarja.', { font: 'system', bold: true, uppercase: false, color: '#ffffff', backdrop: 'box', backdropColor: '#111111' }),
  look('label', 'Etiqueta', 'Escuro sobre uma caixa clara, para um nome ou um dado.', {
    font: 'rounded',
    bold: true,
    uppercase: false,
    color: '#111111',
    backdrop: 'box',
    backdropColor: '#ffffff'
  }),
  look('impact', 'Impacto', 'Maiúsculas pesadas, de título de vídeo.', {
    font: 'impact',
    bold: true,
    uppercase: true,
    color: '#ffffff',
    backdrop: 'shadow',
    backdropColor: '#000000'
  }),
  look('outline', 'Contorno', 'Maiúsculas com contorno preto, lê-se sobre tudo.', {
    font: 'impact',
    bold: true,
    uppercase: true,
    color: '#ffffff',
    backdrop: 'outline',
    backdropColor: '#000000'
  }),
  look('yellow', 'Amarelo', 'A chamada clássica: amarelo com contorno.', {
    font: 'impact',
    bold: true,
    uppercase: true,
    color: '#ffe14d',
    backdrop: 'outline',
    backdropColor: '#000000'
  }),
  look('neon', 'Neon', 'Verde-água com contorno escuro, de destaque.', {
    font: 'rounded',
    bold: true,
    uppercase: false,
    color: '#4df0a0',
    backdrop: 'outline',
    backdropColor: '#0b2a1c'
  }),
  look('editorial', 'Editorial', 'Serifada em maiúsculas, sem fundo: elegante e discreta.', {
    font: 'serif',
    bold: false,
    uppercase: true,
    color: '#ffffff',
    backdrop: 'none',
    backdropColor: '#000000'
  })
]

export const TEXT_LOOK_KEYS = ['font', 'bold', 'uppercase', 'color', 'backdrop', 'backdropColor'] as const

/** Whether `style` wears `look` (the fields a look sets, ignoring size and place). */
export function hasTextLook(style: CaptionStyle, look: TextLook): boolean {
  return TEXT_LOOK_KEYS.every((key) => style[key] === look.style[key])
}

/** `style` wearing `look`: the look's fields over it, size and place kept. */
export function applyTextLook(style: CaptionStyle, look: TextLook): CaptionStyle {
  return { ...style, ...look.style, position: { ...style.position } }
}
