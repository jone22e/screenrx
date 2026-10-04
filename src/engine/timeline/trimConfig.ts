/** Tunables of cuts on the timeline. */
export const TRIM_CONFIG = {
  /** Length of a cut created at the playhead, before the user adjusts it. */
  defaultDurationMs: 2000,
  minDurationMs: 100,
  /** An edit must keep at least this much of the recording. */
  minKeptDurationMs: 500
} as const
