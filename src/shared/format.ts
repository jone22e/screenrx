const pad = (value: number): string => String(value).padStart(2, '0')

/** `00:32`, `12:05`, `1:02:03`. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** `00:03,4` — the clock with tenths of a second, for editing. */
export function formatTimecode(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100))
  return `${formatClock(Math.floor(tenths / 10) * 1000)},${tenths % 10}`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `512 B`, `4,3 MB`, `1,2 GB` (decimal units, as Finder shows them). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace('.', ',')} ${BYTE_UNITS[unit]}`
}
