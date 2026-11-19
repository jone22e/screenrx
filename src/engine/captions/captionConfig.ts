import type { CaptionFont, CaptionLength } from '@shared/models/project'

/** Tunables of how a transcript becomes captions. */
export const CAPTION_CONFIG = {
  /** Most characters in one caption, per length setting. */
  maxChars: { word: 84, pair: 24, short: 18, medium: 42, long: 84 } satisfies Record<CaptionLength, number>,
  /** Most words in one caption, per length setting. */
  maxWords: { word: 1, pair: 3, short: Infinity, medium: Infinity, long: Infinity } satisfies Record<CaptionLength, number>,
  /** A word that takes this long to give way to the next one is followed by a pause: the caption ends there. */
  pauseMs: 1500,
  /** A caption stays at most this long after its last word begins. */
  maxLingerMs: 2000,
  /** A caption followed by another within this long stays on until the next begins, so the text never blinks. */
  bridgeGapMs: 400,
  /** Shortest caption the timeline lets the user make. */
  minCueDurationMs: 300
} as const

/** Tunables of how a caption comes on screen and how the spoken word is marked. */
export const CAPTION_ANIMATION = {
  /** How long the `pop` entrance takes, and how far past its size it swings. */
  popMs: 180,
  popOvershoot: 1.08,
  fadeMs: 160,
  /** The spoken word, in the `highlight` mode: how much bigger it is drawn and how long it takes to get there. */
  wordScale: 1.06,
  wordPopMs: 120
} as const

/** Tunables of how a caption is drawn. Lengths are ratios of the font size unless noted. */
export const CAPTION_LAYOUT = {
  /** Widest a caption gets, as a ratio of the output width. */
  maxWidthRatio: 0.8,
  lineHeight: 1.28,
  boxPaddingX: 0.6,
  boxPaddingY: 0.32,
  boxRadius: 0.32,
  boxOpacity: 0.78,
  outlineWidth: 0.18,
  shadowBlur: 0.22,
  shadowOffsetY: 0.06,
  /** Space kept between a caption and the edges, as a ratio of the output height. */
  edgeMarginRatio: 0.02
} as const

/** Vertical positions offered as one-click choices (centre of the caption, 0…1). */
export const CAPTION_POSITIONS = { top: 0.12, middle: 0.5, bottom: 0.88 } as const

/** Font stacks: system fonts only, so nothing has to be bundled or loaded. */
export const CAPTION_FONTS: Record<CaptionFont, { label: string; family: string }> = {
  system: { label: 'Sistema', family: 'system-ui, -apple-system, "Segoe UI", "Helvetica Neue", sans-serif' },
  rounded: { label: 'Arredondada', family: '"Arial Rounded MT Bold", "Varela Round", system-ui, sans-serif' },
  serif: { label: 'Serifada', family: 'Georgia, "Times New Roman", serif' },
  impact: { label: 'Impacto', family: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  mono: { label: 'Monoespaçada', family: 'Menlo, Consolas, "Courier New", monospace' },
  cursive: { label: 'Cursiva', family: '"Snell Roundhand", "Brush Script MT", "Segoe Script", "Comic Sans MS", cursive' }
}
