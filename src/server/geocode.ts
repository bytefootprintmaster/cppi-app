import { env } from './env'

/**
 * Address → coordinates, via OpenStreetMap's Nominatim.
 *
 * Free and key-less, but Nominatim enforces a strict usage policy: a descriptive
 * `User-Agent` identifying the application, and at most one request per second.
 * Both are respected here — calls are serialised through a single queue so a
 * burst (e.g. "locate every project") can never exceed the limit.
 *
 * Every failure returns `null` rather than throwing: a project that cannot be
 * located is a normal state, not an error, and must never block a site save.
 */
export interface GeocodeResult {
  lat: number
  lng: number
  /** The place Nominatim matched, e.g. "27 Mandrake St, Ajax, Ontario, Canada". */
  label: string
}

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search'
/** Nominatim allows at most one request per second. */
const MIN_GAP_MS = 1100
const TIMEOUT_MS = 8000

/** Nominatim rejects requests without a User-Agent that names the application. */
function userAgent(): string {
  return `CPPI-Portal/1.0 (${env.APP_URL})`
}

/** Successful lookups only; a failed query is retried rather than cached. */
const cache = new Map<string, GeocodeResult>()

let lastCall = 0
let queue: Promise<unknown> = Promise.resolve()

/** Run `fn` after any in-flight call, guaranteeing the one-per-second gap. */
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastCall = Date.now()
    return fn()
  })
  // Keep the chain alive even if a call rejects, so later calls are not blocked.
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const trimmed = query.trim()
  if (!trimmed) return null

  const key = trimmed.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const result = await schedule(async () => {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: trimmed, format: 'jsonv2', limit: '1' })}`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) {
        console.warn(`[cppi] geocode failed for "${trimmed}": HTTP ${res.status}`)
        return null
      }
      const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>
      const hit = rows?.[0]
      const lat = Number(hit?.lat)
      const lng = Number(hit?.lon)
      if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng, label: hit.display_name ?? trimmed }
    } catch (err) {
      console.warn(`[cppi] geocode error for "${trimmed}":`, err instanceof Error ? err.message : err)
      return null
    }
  })

  if (result) cache.set(key, result)
  return result
}
