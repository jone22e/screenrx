/**
 * macOS cannot tell "never asked" apart from "denied" for Screen Recording
 * without prompting, so both are reported as `not-granted`.
 */
export type PermissionState = 'granted' | 'not-granted' | 'unsupported'

/** Permissions the app depends on. */
export interface PermissionSnapshot {
  screenRecording: PermissionState
  microphone: PermissionState
  camera: PermissionState
}

export type PermissionKind = keyof PermissionSnapshot

/** Permissions the system grants per device type, through its own prompt. */
export type MediaPermissionKind = 'microphone' | 'camera'

/** What the UI needs to guide the user through granting permissions. */
export interface PermissionReport {
  permissions: PermissionSnapshot
  /**
   * The application macOS attributes the permissions to, as listed in System
   * Settings. The packaged app is its own grantee; a development build
   * inherits the identity of whatever launched it (Terminal, an IDE…), and
   * the name is `null` when that could not be determined.
   */
  grantee: { name: string | null; isLauncher: boolean }
}

export function isPermissionKind(value: unknown): value is PermissionKind {
  return value === 'screenRecording' || value === 'microphone' || value === 'camera'
}
