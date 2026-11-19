import type { PlatformFeatures, PlatformKind } from '@shared/models/platform'
import { featuresOf } from '@shared/models/platform'

/** Where this renderer runs, and what the editor may offer here (see `PlatformFeatures`). */
export const platform: PlatformKind = window.screenrx.platform.kind
export const features: PlatformFeatures = featuresOf(window.screenrx.platform)
export const isWeb = platform === 'web'
