/**
 * Automatic updates: the app looks for a newer version on its release page, downloads it in the
 * background and installs it the next time the app quits, or sooner when the user asks.
 */
export type UpdateStatus =
  /** Nothing to do: up to date, or not checked yet. */
  | 'idle'
  | 'checking'
  /** A newer version exists and is about to be downloaded. */
  | 'downloading'
  /** Downloaded; installed when the app quits or when the user restarts it. */
  | 'ready'
  | 'error'
  /** Not an installed build (development, or a build without a release page): nothing to check. */
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** The version running now. */
  current: string
  /** The newer version, while it downloads and once it is ready. */
  version?: string | undefined
  /** Download progress, 0 to 100. */
  percent?: number | undefined
  /** Epoch ms of the last check that finished without error. */
  checkedAt?: number | undefined
  /** Why the last check or download failed, in words for the user. */
  error?: string | undefined
}
