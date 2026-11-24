import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import { useAuth } from './auth'
import type { SiteReportView } from '../../server/types'

/** The office inbox, read by both the sidebar badge and the reports page. */
export const SITE_REPORTS_PATH = '/inspections/reports/inbox'

/**
 * Which reports this person has already looked at.
 *
 * "New" is a reading habit rather than project data — the same person may open
 * the portal on a laptop and on a phone, and neither should dictate the other —
 * so it lives beside the recency list, keyed per user and per device.
 */
const SEEN_PREFIX = 'cppi.siteReportsSeen.v1'

function seenKey(userId: string): string {
  return `${SEEN_PREFIX}.${userId}`
}

function readSeenAt(userId: string | undefined): string | null {
  if (!userId) return null
  try {
    return localStorage.getItem(seenKey(userId))
  } catch {
    // Blocked storage must never break the shell.
    return null
  }
}

function writeSeenAt(userId: string, at: string): void {
  try {
    localStorage.setItem(seenKey(userId), at)
  } catch {
    /* Storage full — the badge is a convenience, not a requirement. */
  }
}

/** Reports that arrived after the last time this person opened the list. */
function countUnread(reports: SiteReportView[], seenAt: string | null): number {
  if (!seenAt) return reports.length
  return reports.filter((report) => report.sentAt > seenAt).length
}

interface SiteReportsValue {
  reports: SiteReportView[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** How many reports arrived since this person last opened the list. */
  unread: number
  /** Called by the list page once it has put the reports on screen. */
  markSeen: () => void
}

const SiteReportsContext = createContext<SiteReportsValue>({
  reports: [],
  loading: false,
  error: null,
  reload: async () => {},
  unread: 0,
  markSeen: () => {}
})

/** A report filed while the portal is already open should still land. */
const POLL_MS = 60_000

/**
 * The reports a reviewer has been sent, shared by the sidebar and the page so
 * the count and the list can never disagree.
 *
 * Only admins and managers receive reports, so for anyone else this is inert —
 * no request, no badge.
 */
export function SiteReportsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.userId
  const reviewing = user?.role === 'admin' || user?.role === 'manager'

  const [reports, setReports] = useState<SiteReportView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [seenAt, setSeenAt] = useState<string | null>(() => readSeenAt(userId))

  // The session resolves after the first render, so the marker is read again
  // once the user is known — otherwise every report would start out unread.
  useEffect(() => {
    setSeenAt(readSeenAt(userId))
  }, [userId])

  const reload = useCallback(async () => {
    if (!reviewing) return
    try {
      const data = await api<{ reports: SiteReportView[] }>(SITE_REPORTS_PATH)
      setReports(data.reports)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load site reports')
    } finally {
      setLoading(false)
    }
  }, [reviewing])

  useEffect(() => {
    if (!reviewing) {
      setReports([])
      setLoading(false)
      return
    }
    void reload()
    // A long-open tab checks again on a timer and whenever it is brought back
    // to the front, so a report sent mid-morning still raises the badge.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reviewing, reload])

  const markSeen = useCallback(() => {
    const newest = reports[0]?.sentAt
    if (!userId || !newest) return
    writeSeenAt(userId, newest)
    setSeenAt((current) => (current && current >= newest ? current : newest))
  }, [reports, userId])

  const unread = useMemo(() => countUnread(reports, seenAt), [reports, seenAt])

  const value = useMemo<SiteReportsValue>(
    () => ({ reports, loading, error, reload, unread, markSeen }),
    [reports, loading, error, reload, unread, markSeen]
  )

  return <SiteReportsContext.Provider value={value}>{children}</SiteReportsContext.Provider>
}

export function useSiteReports(): SiteReportsValue {
  return useContext(SiteReportsContext)
}
