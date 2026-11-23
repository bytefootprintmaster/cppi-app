import { useMemo } from 'react'
import { useAuth } from './auth'

/**
 * Which projects someone has opened, most recent first.
 *
 * The portfolio is ordered by the last edit by default, which is the wrong
 * question: an edit can come from anyone, while "recently accessed" is the
 * project this person is actually working on. Kept per user and per device —
 * it is a reading habit, not project data, so it does not belong on the server.
 */
const KEY_PREFIX = 'cppi.recentSites.v1'

/** Enough history to order a large portfolio, small enough to stay negligible. */
const LIMIT = 40

function keyFor(userId: string): string {
  return `${KEY_PREFIX}.${userId}`
}

export function readRecentSites(userId: string | undefined): string[] {
  if (!userId) return []
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // Blocked storage or a hand-edited value must never break a page.
    return []
  }
}

/** Notes that a project was just opened, moving it to the front of the list. */
export function recordSiteVisit(userId: string | undefined, siteId: string): void {
  if (!userId || !siteId) return
  const next = [siteId, ...readRecentSites(userId).filter((id) => id !== siteId)].slice(0, LIMIT)
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(next))
  } catch {
    /* Storage full — recency is a convenience, not a requirement. */
  }
}

/**
 * Sorts by when each item was last opened. Anything never opened keeps its
 * incoming order and follows everything that has been.
 */
export function sortByRecent<T>(items: T[], recent: string[], idOf: (item: T) => string): T[] {
  const rank = new Map(recent.map((id, index) => [id, index]))
  // The sort is stable, so equal ranks keep the order the API sent.
  return [...items].sort(
    (a, b) => (rank.get(idOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(idOf(b)) ?? Number.MAX_SAFE_INTEGER)
  )
}

/** The signed-in user's recency list. Re-read on mount, which covers a return visit. */
export function useRecentSites(): string[] {
  const { user } = useAuth()
  const userId = user?.userId
  return useMemo(() => readRecentSites(userId), [userId])
}
