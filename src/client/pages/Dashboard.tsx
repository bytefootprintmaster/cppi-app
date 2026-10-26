import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Button, Card, CardHeader, Empty, ErrorNote, Loading, Progress, SiteStatusBadge } from '../components/ui'
import { IconAlert, IconBuilding, IconPlus, IconSettings, IconTarget } from '../components/icons'
import type { SiteRecord } from '../../server/types'

interface Totals {
  projects: number
  active: number
  completed: number
  avgProgress: number
  milestonesDone: number
  milestonesTotal: number
  photos: number
  files: number
  remarks: number
  attention: number
}

interface SiteSummary {
  site: SiteRecord
  progress: {
    stages: number
    stagesCompleted: number
    milestones: number
    milestonesCompleted: number
    percent: number
  }
  files: number
  photos: number
  remarks: number
  nextMilestone?: { name: string; dueDate?: string }
  lastActivity?: string
}

interface DashboardResponse {
  rows: SiteSummary[]
  totals: Totals
  kpis: string[]
  availableKpis: string[]
}

interface KpiMeta {
  label: string
  value: (t: Totals) => string | number
  foot: (t: Totals) => string
}

const KPI_META: Record<string, KpiMeta> = {
  projects: {
    label: 'Projects',
    value: (t) => t.projects,
    foot: () => 'Building sites in your portfolio'
  },
  active: {
    label: 'Active',
    value: (t) => t.active,
    foot: () => 'Currently in progress'
  },
  completed: {
    label: 'Completed',
    value: (t) => t.completed,
    foot: () => 'Handed over or closed out'
  },
  avg_progress: {
    label: 'Avg progress',
    value: (t) => `${t.avgProgress}%`,
    foot: () => 'Mean completion across projects'
  },
  milestones_done: {
    label: 'Milestones done',
    value: (t) => t.milestonesDone,
    foot: (t) => `of ${t.milestonesTotal} defined`
  },
  photos: {
    label: 'Site photos',
    value: (t) => t.photos,
    foot: () => 'Progress imagery captured'
  },
  files: {
    label: 'Documents',
    value: (t) => t.files,
    foot: () => 'Plans, permits and invoices'
  },
  remarks: {
    label: 'Remarks',
    value: (t) => t.remarks,
    foot: () => 'Notes logged by the team'
  },
  attention: {
    label: 'Needs attention',
    value: (t) => t.attention,
    foot: () => 'On hold or still open'
  }
}

export function DashboardPage() {
  const { user } = useAuth()
  const { data, error, loading, reload, setData } = useApi<DashboardResponse>('/dashboard')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Dashboard · CPPI'
  }, [])

  function openPicker() {
    setDraft(data?.kpis ?? [])
    setSaveError(null)
    setPickerOpen(true)
  }

  async function saveKpis() {
    if (draft.length === 0) {
      setSaveError('Keep at least one KPI on the dashboard.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await api('/dashboard/kpis', { method: 'PUT', body: { kpis: draft } })
      if (data) setData({ ...data, kpis: draft })
      setPickerOpen(false)
      await reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save your dashboard')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <Loading />
  if (error && !data) {
    return (
      <PageBody>
        <ErrorNote message={error} />
      </PageBody>
    )
  }
  if (!data) return null

  const { rows, totals, kpis, availableKpis } = data
  const visible = kpis.filter((id) => KPI_META[id])

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name?.split(' ')[0] ?? 'there'}`}
        subtitle="A live view of every building project you have access to."
        actions={
          <>
            <Button variant="ghost" onClick={openPicker}>
              <IconSettings size={16} />
              Customise KPIs
            </Button>
            <Link className="btn btn-primary" to="/sites">
              <IconPlus size={16} />
              Projects
            </Link>
          </>
        }
      />

      <PageBody>
        <div className="grid grid-4" style={{ marginBottom: 22 }}>
          {visible.map((id) => {
            const meta = KPI_META[id]
            return (
              <div className="kpi" key={id}>
                <div className="kpi-label">{meta.label}</div>
                <div className="kpi-value">{meta.value(totals)}</div>
                <div className="kpi-foot">{meta.foot(totals)}</div>
              </div>
            )
          })}
        </div>

        <Card>
          <CardHeader
            title="Project tracker"
            sub={`${rows.length} project${rows.length === 1 ? '' : 's'}`}
            action={
              <Link className="btn btn-ghost btn-sm" to="/sites">
                Manage projects
              </Link>
            }
          />
          {rows.length === 0 ? (
            <Empty title="No projects yet">
              {user?.role === 'admin'
                ? 'Create your first building site to start tracking stages, files and remarks.'
                : 'You have not been given access to any project yet. Ask an administrator for an invitation.'}
            </Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th style={{ width: 220 }}>Progress</th>
                    <th>Status</th>
                    <th>Next milestone</th>
                    <th>Activity</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.site.siteId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{row.site.name}</div>
                        <div className="small muted">
                          {[row.site.code, row.site.location].filter(Boolean).join(' · ') || 'No location set'}
                        </div>
                      </td>
                      <td>
                        <Progress percent={row.progress.percent} />
                        <div className="small muted" style={{ marginTop: 5 }}>
                          {row.progress.percent}% · {row.progress.milestonesCompleted}/{row.progress.milestones}{' '}
                          milestones
                        </div>
                      </td>
                      <td>
                        <SiteStatusBadge status={row.site.status} />
                      </td>
                      <td>
                        {row.nextMilestone ? (
                          <div>
                            <div style={{ fontWeight: 600 }}>{row.nextMilestone.name}</div>
                            <div className="small muted">Due {formatDate(row.nextMilestone.dueDate)}</div>
                          </div>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td>
                        <span className="small muted">{relativeTime(row.lastActivity)}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Link className="btn btn-ghost btn-sm" to={`/sites/${row.site.siteId}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {rows.length > 0 && totals.attention > 0 ? (
          <div className="alert alert-info" style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
            <IconAlert size={16} />
            <span>
              {totals.attention} project{totals.attention === 1 ? '' : 's'} need attention — on hold or not yet
              complete.
            </span>
          </div>
        ) : null}
      </PageBody>

      {pickerOpen ? (
        <div className="modal-backdrop" onClick={() => setPickerOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Dashboard KPIs</h2>
              <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)} aria-label="Close">
                ✕
              </Button>
            </div>
            <div className="modal-body">
              <p className="small muted" style={{ marginBottom: 14 }}>
                Pick the metrics that should headline your dashboard. {draft.length} selected.
              </p>
              {saveError ? <ErrorNote message={saveError} /> : null}
              <div className="kpi-picker">
                {availableKpis.map((id) => {
                  const meta = KPI_META[id]
                  if (!meta) return null
                  const on = draft.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`chip${on ? ' on' : ''}`}
                      onClick={() =>
                        setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                      }
                    >
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setDraft(availableKpis)}>
                Select all
              </Button>
              <Button loading={saving} onClick={saveKpis}>
                <IconTarget size={16} />
                Save dashboard
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {rows.length === 0 && user?.role === 'admin' ? (
        <div style={{ marginTop: 18 }}>
          <Link className="btn btn-primary" to="/sites">
            <IconBuilding size={16} />
            Create your first project
          </Link>
        </div>
      ) : null}
    </>
  )
}
