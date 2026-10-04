import path from 'node:path'
import type { PermissionReport } from '@shared/models/permissions'

/** Outermost `.app` bundle in a path: `/Applications/Foo.app/Contents/…/Bar.app/x` → `Foo`. */
function outermostAppName(executablePath: string): string | null {
  return /(?:^|\/)([^/]+)\.app(?:\/|$)/.exec(executablePath)?.[1] ?? null
}

/**
 * Turns the executable macOS holds responsible for the capture helper into
 * the name the user will find in System Settings. When that executable is
 * not part of our own app bundle, the permission belongs to whatever
 * launched us — the normal situation for a development build.
 */
export function granteeOf(
  responsibleExecutable: string | undefined,
  ownExecutable: string
): PermissionReport['grantee'] {
  if (!responsibleExecutable) return { name: null, isLauncher: false }
  const appName = outermostAppName(responsibleExecutable)
  return {
    name: appName ?? path.basename(responsibleExecutable),
    isLauncher: appName === null || appName !== outermostAppName(ownExecutable)
  }
}
