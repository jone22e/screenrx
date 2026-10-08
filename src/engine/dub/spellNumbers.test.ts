import { describe, expect, it } from 'vitest'
import { spellNumbers } from './spellNumbers'

describe('spellNumbers', () => {
  it('reads ratios, ranges and decimals in English', () => {
    expect(spellNumbers('the output is 0 to 5 amps.', 'en')).toBe('the output is zero to five amps.')
    expect(spellNumbers('So it can be 300:5, 500:5, 1000:5', 'en')).toBe(
      'So it can be three hundred to five, five hundred to five, one thousand to five'
    )
    expect(spellNumbers('about 2.5 volts and 1,250 units', 'en')).toBe('about two point five volts and one thousand two hundred and fifty units')
    expect(spellNumbers('15% of 118', 'en')).toBe('fifteen percent of one hundred and eighteen')
    expect(spellNumbers('21 and 99 and 1000000', 'en')).toBe('twenty-one and ninety-nine and one million')
  })

  it('reads them in Spanish', () => {
    expect(spellNumbers('de 0 a 5 amperios', 'es')).toBe('de cero a cinco amperios')
    expect(spellNumbers('300:5 y 1000:5', 'es')).toBe('trescientos a cinco y mil a cinco')
    expect(spellNumbers('100, 101, 21, 35, 2.500 y 0,5', 'es')).toBe('cien, ciento uno, veintiuno, treinta y cinco, dos mil quinientos y cero coma cinco')
    expect(spellNumbers('15%', 'es')).toBe('quince por ciento')
    expect(spellNumbers('2000000', 'es')).toBe('dos millones')
  })

  it('reads them in Portuguese', () => {
    expect(spellNumbers('de 0 a 5 ampères', 'pt')).toBe('de zero a cinco ampères')
    expect(spellNumbers('300:5, 500:5, 1000:5', 'pt')).toBe('trezentos para cinco, quinhentos para cinco, mil para cinco')
    expect(spellNumbers('100, 116, 21, 1.250, 1100, 2005 e 0,5', 'pt')).toBe(
      'cem, cento e dezesseis, vinte e um, mil duzentos e cinquenta, mil e cem, dois mil e cinco e zero vírgula cinco'
    )
    expect(spellNumbers('15%', 'pt')).toBe('quinze por cento')
    expect(spellNumbers('1000000 e 3000000', 'pt')).toBe('um milhão e três milhões')
  })

  it('reads them in Chinese', () => {
    expect(spellNumbers('输出是0到5安培', 'zh')).toBe('输出是零到五安培')
    expect(spellNumbers('300:5', 'zh')).toBe('三百比五')
    expect(spellNumbers('10, 15, 20, 105, 110, 1005, 10000, 12345', 'zh')).toBe('十, 十五, 二十, 一百零五, 一百一十, 一千零五, 一万, 一万二千三百四十五')
    expect(spellNumbers('15%', 'zh')).toBe('百分之十五')
    expect(spellNumbers('2.5', 'zh')).toBe('二点五')
  })

  it('reads a very long number digit by digit and leaves text without numbers alone', () => {
    expect(spellNumbers('code 12345678901234', 'en')).toBe('code one two three four five six seven eight nine zero one two three four')
    expect(spellNumbers('no numbers here', 'en')).toBe('no numbers here')
  })
})
