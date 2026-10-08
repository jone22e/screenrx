import type { CaptionLanguage } from '@shared/models/project'

/**
 * Numbers written in words, in the language being spoken. The voice model
 * reads digits in the language it learned the voice from, so "300:5" in an
 * English dubbing comes out in Portuguese; "three hundred to five" does not.
 * Only the text given to the voice is changed — the captions keep their digits.
 */

interface NumberWords {
  /** Written as "a point b": what is said for the decimal separator. */
  point: string
  /** What is said between the two numbers of a ratio such as "300:5". */
  ratio: string
  /** How "%" is said; `null` when the language puts it before the number (handled apart). */
  percent: string | null
  /** The thousands separator in this language's writing, which is removed; the other one is a decimal point. */
  thousands: ',' | '.'
  integer: (value: number) => string
}

const EN_SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
]
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function englishBelowThousand(value: number): string {
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const restWords = rest < 20 ? EN_SMALL[rest] : `${EN_TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${EN_SMALL[rest % 10]}` : ''}`
  if (hundreds === 0) return restWords as string
  return rest === 0 ? `${EN_SMALL[hundreds]} hundred` : `${EN_SMALL[hundreds]} hundred and ${restWords}`
}

function english(value: number): string {
  if (value === 0) return 'zero'
  const parts: string[] = []
  const scales: Array<[number, string]> = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1000, 'thousand']]
  let rest = value
  for (const [size, name] of scales) {
    if (rest >= size) {
      parts.push(`${englishBelowThousand(Math.floor(rest / size))} ${name}`)
      rest %= size
    }
  }
  if (rest > 0) parts.push(englishBelowThousand(rest))
  return parts.join(' ')
}

const ES_SMALL = [
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'
]
const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']
const ES_HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos']

function spanishBelowThousand(value: number): string {
  if (value === 100) return 'cien'
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const restWords = rest < 30 ? ES_SMALL[rest] : `${ES_TENS[Math.floor(rest / 10)]}${rest % 10 ? ` y ${ES_SMALL[rest % 10]}` : ''}`
  if (hundreds === 0) return restWords as string
  return rest === 0 ? (ES_HUNDREDS[hundreds] as string) : `${ES_HUNDREDS[hundreds]} ${restWords}`
}

function spanish(value: number): string {
  if (value === 0) return 'cero'
  const parts: string[] = []
  let rest = value
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000)
    parts.push(millions === 1 ? 'un millón' : `${spanishBelowThousand(millions)} millones`)
    rest %= 1_000_000
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000)
    parts.push(thousands === 1 ? 'mil' : `${spanishBelowThousand(thousands)} mil`)
    rest %= 1000
  }
  if (rest > 0) parts.push(spanishBelowThousand(rest))
  return parts.join(' ')
}

const PT_SMALL = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez',
  'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'
]
const PT_TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const PT_HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos']

function portugueseBelowThousand(value: number): string {
  if (value === 100) return 'cem'
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const restWords = rest < 20 ? PT_SMALL[rest] : `${PT_TENS[Math.floor(rest / 10)]}${rest % 10 ? ` e ${PT_SMALL[rest % 10]}` : ''}`
  if (hundreds === 0) return restWords as string
  return rest === 0 ? (PT_HUNDREDS[hundreds] as string) : `${PT_HUNDREDS[hundreds]} e ${restWords}`
}

function portuguese(value: number): string {
  if (value === 0) return 'zero'
  const parts: string[] = []
  let rest = value
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000)
    parts.push(millions === 1 ? 'um milhão' : `${portugueseBelowThousand(millions)} milhões`)
    rest %= 1_000_000
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000)
    parts.push(thousands === 1 ? 'mil' : `${portugueseBelowThousand(thousands)} mil`)
    rest %= 1000
  }
  if (rest > 0) {
    // "mil e cem", "dois mil e cinco": the last part joins with "e" when it is round or small.
    const joiner = parts.length > 0 && (rest < 100 || rest % 100 === 0) ? 'e ' : ''
    parts.push(`${joiner}${portugueseBelowThousand(rest)}`)
  }
  return parts.join(' ')
}

const ZH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const ZH_UNITS = ['', '十', '百', '千']

/** Up to 9999, with 零 where digits are skipped, as read aloud. */
function chineseBelowTenThousand(value: number): string {
  if (value === 0) return '零'
  if (value < 20 && value >= 10) return `十${value % 10 ? ZH_DIGITS[value % 10] : ''}`
  let text = ''
  let zeroPending = false
  for (let place = 3; place >= 0; place--) {
    const digit = Math.floor(value / 10 ** place) % 10
    if (digit === 0) {
      if (text !== '') zeroPending = true
    } else {
      if (zeroPending) text += '零'
      zeroPending = false
      text += `${ZH_DIGITS[digit]}${ZH_UNITS[place]}`
    }
  }
  return text
}

function chinese(value: number): string {
  if (value === 0) return '零'
  const parts: string[] = []
  let rest = value
  if (rest >= 100_000_000) {
    parts.push(`${chineseBelowTenThousand(Math.floor(rest / 100_000_000))}亿`)
    rest %= 100_000_000
  }
  if (rest >= 10_000) {
    if (parts.length > 0 && rest < 10_000_000) parts.push('零')
    parts.push(`${chineseBelowTenThousand(Math.floor(rest / 10_000))}万`)
    rest %= 10_000
  }
  if (rest > 0) {
    if (parts.length > 0 && rest < 1000) parts.push('零')
    parts.push(chineseBelowTenThousand(rest))
  }
  return parts.join('')
}

const LANGUAGES: Record<CaptionLanguage, NumberWords> = {
  en: { point: 'point', ratio: 'to', percent: 'percent', thousands: ',', integer: english },
  es: { point: 'coma', ratio: 'a', percent: 'por ciento', thousands: '.', integer: spanish },
  pt: { point: 'vírgula', ratio: 'para', percent: 'por cento', thousands: '.', integer: portuguese },
  zh: { point: '点', ratio: '比', percent: null, thousands: ',', integer: chinese }
}

/** Largest number written out; beyond it the digits are read one by one, which the voice gets right. */
const MAX_SPOKEN = 999_999_999_999

function spellOne(raw: string, words: NumberWords): string {
  const decimalSeparator = words.thousands === ',' ? '.' : ','
  const cleaned = raw.split(words.thousands).join('')
  const [integerPart = '', fraction] = cleaned.split(decimalSeparator)
  const integer = Number(integerPart)
  if (!Number.isSafeInteger(integer) || integer > MAX_SPOKEN) {
    return [...integerPart].map((digit) => words.integer(Number(digit))).join(' ')
  }
  const spelled = words.integer(integer)
  if (fraction === undefined || fraction === '') return spelled
  const digits = [...fraction].map((digit) => words.integer(Number(digit)))
  return words.point === '点' ? `${spelled}点${digits.join('')}` : `${spelled} ${words.point} ${digits.join(' ')}`
}

/** A number as written: digits with optional thousands groups and a decimal part. */
const NUMBER = String.raw`\d+(?:[.,]\d+)*`

/**
 * Writes every number in `text` in words, in `language`. Ratios ("300:5"),
 * decimals and percentages are read as they are said; anything else around
 * a number (units, letters) is left alone.
 */
export function spellNumbers(text: string, language: CaptionLanguage): string {
  const words = LANGUAGES[language]
  const percent = (value: string): string =>
    words.percent === null ? `百分之${spellOne(value, words)}` : `${spellOne(value, words)} ${words.percent}`
  return text
    .replace(new RegExp(`(${NUMBER})\\s*:\\s*(${NUMBER})`, 'g'), (_match, a: string, b: string) =>
      [spellOne(a, words), words.ratio, spellOne(b, words)].join(language === 'zh' ? '' : ' ')
    )
    .replace(new RegExp(`(${NUMBER})\\s*%`, 'g'), (_match, value: string) => percent(value))
    .replace(new RegExp(NUMBER, 'g'), (value) => spellOne(value, words))
}
