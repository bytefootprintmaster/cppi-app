import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { formatDateTime, humanBytes, relativeTime } from '../lib/format'
import { useSiteReports } from '../lib/siteReports'
import { PageBody, PageHeader } from '../components/Layout'
import { Button, Card, CardHeader, Empty, ErrorNote, Loading, useToast } from '../components/ui'
import { IconDownload, IconRefresh } from '../components/icons'
import type { SiteReportView } from '../../server/types'

/**
 * The history of PDF site reports sent in from the field.
 *
 * Nothing new is stored for this: a report is an ordinary project file, so the
 * list is just the `site report`-tagged files on the projects the reviewer can
 * reach. Opening one hands back a short-lived signed link, exactly as the file
 * tree does.
 */
export function SiteReportsPage() {
  const { reports, loading, error, reload, markSeen } = useSiteReports()
  const [opening, setOpening] = useState<string | null>(null)
  const toast = useToast()

  useEffect(() => {
    document.title = 'Site reports · CPPI'
  }, [])

  // Putting the reports on screen is what clears the sidebar badge.
  useEffect(() => {
    if (reports.length > 0) markSeen()
  }, [reports, markSeen])

  async function open(report: SiteReportView) {
    setOpening(report.assetId)
    try {
      const res = await api<{ url: string }>(
        `/inspections/reports/${report.siteId}/${report.assetId}/url`
      )
      window.open(res.url, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The report could not be opened.')
    } finally {
      setOpening(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Site reports"
        subtitle="Every PDF a site worker has sent in from the field, newest first."
        actions={
          <Button variant="ghost" onClick={() => void reload()}>
            <IconRefresh size={16} />
            Refresh
          </Button>
        }
      />

      <PageBody>
        <ErrorNote message={error} />

        <Card>
          <CardHeader title="Received reports" sub={`${reports.length} total`} />
          {loading && reports.length === 0 ? (
            <Loading />
          ) : reports.length === 0 ? (
            <Empty title="No site reports yet">
              Reports appear here the moment a worker taps Execute on the field app.
            </Empty>
          ) : (
            <>
              {/* Desktop: full table. */}
              <div className="table-wrap reports-table">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Report</th>
                      <th>Project</th>
                      <th>Sent by</th>
                      <th>Received</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((report) => (
                      <tr key={report.assetId}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{report.name}</div>
                          {report.size ? <div className="small muted">{humanBytes(report.size)}</div> : null}
                        </td>
                        <td>{report.siteName}</td>
                        <td>{report.sentByName}</td>
                        <td className="small">
                          <div>{formatDateTime(report.sentAt)}</div>
                          <div className="muted">{relativeTime(report.sentAt)}</div>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={opening === report.assetId}
                            onClick={() => void open(report)}
                          >
                            <IconDownload size={15} />
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same reports as cards — no sideways scrolling. */}
              <div className="reports-cards">
                {reports.map((report) => (
                  <div className="user-card" key={report.assetId}>
                    <div className="user-card-top">
                      <div style={{ minWidth: 0 }}>
                        <div className="user-card-name">{report.name}</div>
                        <div className="small muted user-card-email">{report.siteName}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opening === report.assetId}
                        onClick={() => void open(report)}
                      >
                        Open
                      </Button>
                    </div>
                    <div className="user-card-grid">
                      <div>
                        <div className="user-card-label">Sent by</div>
                        <div className="user-card-value small">{report.sentByName}</div>
                      </div>
                      <div>
                        <div className="user-card-label">Received</div>
                        <div className="user-card-value small">
                          {formatDateTime(report.sentAt)}
                          <span className="muted"> · {relativeTime(report.sentAt)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}
