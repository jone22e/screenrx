/** Tunables of dubbing: speech in another language, placed on the recording's clock. */
export const DUB_CONFIG = {
  /** Captions further apart than this are separate stretches of speech. */
  pauseBetweenUnitsMs: 700,
  /** A stretch is spoken in one breath: past this length it is split at the next caption. */
  maxUnitMs: 12_000,
  /**
   * The voice reference: enough speech to capture the timbre. A short one,
   * ending at a pause, clones more reliably than a long one cut mid-phrase.
   */
  reference: { minMs: 3_000, maxMs: 6_500 },
  /**
   * A word the recognizer stretches this long is followed by a pause: a good
   * place to end the reference, and how much of that word is kept in it.
   */
  referencePauseWordMs: 600,
  /** Silence kept between a stretch that ran over and the one after it. */
  gapAfterOverrunMs: 80,
  /** Most stretches one dubbing may have. */
  maxUnits: 2_000,
  /**
   * Every synthesized stretch is listened to by the speech recognizer; one it
   * understands less than this share of is spoken again, up to `attempts`
   * times, and the best take is kept.
   */
  verification: { acceptAt: 0.8, attempts: 3 }
} as const
