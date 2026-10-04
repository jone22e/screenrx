import { useCallback, useEffect, useState } from 'react'
import type { AppError, IpcResult } from '@shared/models/errors'
import type { PermissionReport } from '@shared/models/permissions'
import type { RecordingSummary } from '@shared/models/session'

/** Runs `effect` now and every time the window regains focus. */
function useOnFocus(effect: () => void): void {
  useEffect(() => {
    effect()
    window.addEventListener('focus', effect)
    return () => window.removeEventListener('focus', effect)
  }, [effect])
}

export interface PermissionsState {
  report: PermissionReport | null
  /** Set when the permission status itself could not be read. */
  error: AppError | null
  request: () => void
}

/**
 * Permission status, re-read whenever the window regains focus — which is
 * exactly when the user comes back from System Settings.
 */
export function usePermissions(): PermissionsState {
  const [report, setReport] = useState<PermissionReport | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  const apply = useCallback((result: IpcResult<PermissionReport>): PermissionReport | null => {
    if (result.ok) {
      setReport(result.value)
      setError(null)
      return result.value
    }
    setError(result.error)
    return null
  }, [])

  const refresh = useCallback(() => {
    void window.screenrx.permissions.get().then(apply)
  }, [apply])
  useOnFocus(refresh)

  const request = useCallback(() => {
    void window.screenrx.permissions
      .requestScreenRecording()
      .then(apply)
      .then((latest) => {
        // macOS shows its prompt only once per app; after that the only
        // way forward is the toggle in System Settings, so take the user there.
        if (latest && latest.permissions.screenRecording !== 'granted') {
          void window.screenrx.permissions.openSettings('screenRecording')
        }
      })
  }, [apply])

  return { report, error, request }
}

/** Recordings on disk, kept in sync with the main process; `null` while loading. */
export function useLibrary(): RecordingSummary[] | null {
  const [recordings, setRecordings] = useState<RecordingSummary[] | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.screenrx.library.list().then(setRecordings)
    }
    refresh()
    return window.screenrx.library.onChanged(refresh)
  }, [])

  return recordings
}
