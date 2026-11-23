import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, formatMoney, relativeTime } from '../lib/format'
import { sortByRecent, useRecentSites } from '../lib/recent'
import { PageBody, PageHeader } from '../components/Layout'
import {
  Button,
  Card,
  CardHeader,
  CardMenu,
  Empty,
  ErrorNote,
  Loading,
  Modal,
  Progress,
  SiteStatusBadge,
  TabPanel,
  Tabs
} from '../components/ui'
import { MapView, type MapSite } from '../components/MapView'
import {
  IconBuilding,
  IconChevronRight,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTarget,
  IconX
} from '../components/icons'
import type { SiteRecord } from '../../server/types'
import type { BudgetSummary } from '../../server/services'

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
  budgetTotal: number
  budgetSpent: number
  budgetPaid: number
  budgetRemaining: number
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
  budget: BudgetSummary
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

/** A project's worst problem, and how urgent it is. Lower rank sorts first. */
interface Attention {
  rank: number
  reason: string
}

const DAY = 86_400_000

/**
 * Why a project needs attention, or null when it is fine. Ordered by how much it
 * should worry someone: a stopped job, then a milestone that has slipped, then a
 * project that has simply gone quiet.
 */
function attentionFor(row: SiteSummary): Attention | null {
  if (row.site.status === 'on_hold') return { rank: 0, reason: 'On hold' }
  if (row.site.status === 'completed') return null

  const due = row.nextMilestone?.dueDate
  if (due) {
    const days = Math.floor((Date.now() - new Date(due).getTime()) / DAY)
    if (days > 0) {
      return { rank: 1, reason: `${row.nextMilestone?.name} is ${days} day${days === 1 ? '' : 's'} overdue` }
    }
  }

  if (row.lastActivity) {
    const idle = Math.floor((Date.now() - new Date(row.lastActivity).getTime()) / DAY)
    if (idle >= 30) return { rank: 2, reason: `No activity for ${idle} days` }
  }

  return null
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
  budget_total: {
    label: 'Total budget',
    value: (t) => formatMoney(t.budgetTotal, { compact: true }),
    foot: () => 'Approved cost across projects'
  },
  budget_spent: {
    label: 'Spent',
    value: (t) => formatMoney(t.budgetSpent, { compact: true }),
    foot: (t) =>
      t.budgetTotal > 0
        ? `${Math.round((t.budgetSpent / t.budgetTotal) * 100)}% of budget, excl. HST`
        : 'No budget set yet'
  },
  budget_remaining: {
    label: 'Budget left',
    value: (t) => formatMoney(t.budgetRemaining, { compact: true }),
    foot: (t) => (t.budgetRemaining < 0 ? 'Over budget' : 'Still to be spent')
  },
  attention: {
    label: 'Needs attention',
    value: (t) => t.attention,
    foot: () => 'On hold or still open'
  }
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { data, error, loading, reload, setData } = useApi<DashboardResponse>('/dashboard')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [view, setView] = useState<'tracker' | 'map'>('tracker')
  const [locating, setLocating] = useState(false)
  const [locateMsg, setLocateMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const recent = useRecentSites()

  useEffect(() => {
    document.title = 'Dashboard · CPPI'
  }, [])

  async function locateMissing() {
    setLocating(true)
    setLocateMsg(null)
    try {
      const res = await api<{ located: number; failed: number; considered: number }>(
        '/sites/geocode-missing',
        { method: 'POST' }
      )
      setLocateMsg(
        `Located ${res.located} of ${res.considered} project${res.considered === 1 ? '' : 's'}${res.failed ? `, ${res.failed} could not be found` : ''}.`
      )
      await reload()
    } catch (err) {
      setLocateMsg(err instanceof Error ? err.message : 'Could not locate the projects')
    } finally {
      setLocating(false)
    }
  }

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
  const isAdmin = user?.role === 'admin'
  const needle = query.trim().toLowerCase()

  // The tracker led with whatever was edited last, which is someone else's
  // question. It leads with what this person last opened instead, and the search
  // narrows that list — the KPIs above stay portfolio-wide and are labelled as such.
  // (Computed inline, not memoised: this sits below the early returns above, so a
  // hook here would change the hook count between renders.)
  const ordered = sortByRecent(rows, recent, (row) => row.site.siteId)
  const projects = needle
    ? ordered.filter((row) =>
        [row.site.name, row.site.code, row.site.location, row.site.address]
          .filter((field): field is string => Boolean(field))
          .some((field) => field.toLowerCase().includes(needle))
      )
    : ordered

  const mapSites: MapSite[] = projects
    .filter((row) => typeof row.site.lat === 'number' && typeof row.site.lng === 'number')
    .map((row) => ({
      siteId: row.site.siteId,
      name: row.site.name,
      code: row.site.code,
      location: row.site.location,
      status: row.site.status,
      lat: row.site.lat as number,
      lng: row.site.lng as number,
      budgeted: row.budget.budgeted
    }))

  const located = rows.filter(
    (row) => typeof row.site.lat === 'number' && typeof row.site.lng === 'number'
  ).length

  // The attention KPI only counted "on hold or unfinished", so a project that has
  // quietly blown a milestone date looked healthy. This ranks the real problems,
  // worst first, and names them — a bare number was a dead end.
  const attention = projects
    .map((row) => ({ row, flag: attentionFor(row) }))
    .filter((entry): entry is { row: SiteSummary; flag: Attention } => entry.flag !== null)
    .sort((a, b) => a.flag.rank - b.flag.rank)

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name?.split(' ')[0] ?? 'there'}`}
        subtitle="A live view of every building project you have access to."
        actions={
          <>
            <div className="page-actions page-actions-full">
              <Button variant="ghost" onClick={openPicker}>
                <IconSettings size={16} />
                Customise KPIs
              </Button>
              <Link className="btn btn-primary" to="/sites">
                <IconPlus size={16} />
                Projects
              </Link>
            </div>
            <div className="page-actions page-actions-compact">
              <CardMenu
                label="Dashboard actions"
                items={[
                  { label: 'Customise KPIs', icon: <IconSettings size={16} />, onClick: openPicker },
                  { label: 'Projects', icon: <IconPlus size={16} />, onClick: () => navigate('/sites') }
                ]}
              />
            </div>
          </>
        }
      />

      <PageBody>
        <div className="grid grid-4 kpi-grid" style={{ marginBottom: 22 }}>
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

        {/* One search for the whole page: it narrows the tracker, the map and the
            attention list together, so the results never disagree with each other. */}
        {rows.length > 0 ? (
          <Card className="list-toolbar">
            <div className="search-form" role="search">
              <div className="search-form-field">
                <IconSearch size={16} className="search-form-icon" />
                <input
                  className={`input search-form-input${query ? ' has-clear' : ''}`}
                  type="search"
                  placeholder="Search your projects by name, code or location…"
                  aria-label="Search projects"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="search-form-clear"
                    aria-label="Clear the project search"
                    onClick={() => setQuery('')}
                  >
                    <IconX size={14} />
                  </button>
                ) : null}
              </div>
              {needle ? (
                <span className="small muted" role="status">
                  {projects.length} of {rows.length} project{rows.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          </Card>
        ) : null}

        <Tabs
          id="dashboard-view"
          tabs={[
            { key: 'tracker', label: 'Tracker' },
            { key: 'map', label: 'Map' }
          ]}
          value={view}
          onChange={setView}
          className="dash-tabs"
        />

        <TabPanel id="dashboard-view" activeKey={view}>
        {view === 'map' ? (
          <Card>
            <CardHeader
              title="Portfolio map"
              sub={
                needle
                  ? `${mapSites.length} of ${projects.length} matching project${projects.length === 1 ? '' : 's'} on the map`
                  : located === rows.length
                    ? `${rows.length} project${rows.length === 1 ? '' : 's'} on the map`
                    : `${located} of ${rows.length} projects located`
              }
              action={
                // Geocoding is a portfolio-wide job, so this stays keyed to every
                // project rather than to whatever the search is showing.
                isAdmin && located < rows.length ? (
                  <Button variant="ghost" size="sm" loading={locating} onClick={locateMissing}>
                    <IconMapPin size={16} />
                    Locate missing
                  </Button>
                ) : undefined
              }
            />
            <div className="card-body">
              {locateMsg ? (
                <div className="alert alert-info" style={{ marginBottom: 12 }}>
                  {locateMsg}
                </div>
              ) : null}
              {mapSites.length === 0 ? (
                needle ? (
                  <Empty title="No matching projects">
                    Nothing matches “{query.trim()}”. Try a different name, or clear the search.
                  </Empty>
                ) : (
                  <Empty title="Nothing on the map yet">
                    {isAdmin
                      ? 'Give a project an address, then use "Locate missing" to drop it on the map.'
                      : 'Projects will appear here once an administrator adds their addresses.'}
                  </Empty>
                )
              ) : (
                <>
                  <MapView
                    sites={mapSites}
                    mode="portfolio"
                    height={520}
                    onSelect={(id) => navigate(`/sites/${id}`)}
                  />
                  <div className="map-legend">
                    <span>
                      <i className="map-legend-dot map-dot-planning" />
                      Planning
                    </span>
                    <span>
                      <i className="map-legend-dot map-dot-active" />
                      In progress
                    </span>
                    <span>
                      <i className="map-legend-dot map-dot-hold" />
                      On hold
                    </span>
                    <span>
                      <i className="map-legend-dot map-dot-done" />
                      Completed
                    </span>
                    <span>
                      <i className="map-legend-dot map-legend-ward" />
                      Ward boundary
                    </span>
                    <span>
                      <i className="map-legend-dot map-legend-neigh" />
                      Neighbourhood
                    </span>
                    <span className="muted">Pin size reflects budget · clusters show nearby projects</span>
                  </div>
                </>
              )}
            </div>
          </Card>
        ) : (
        <Card>
          <CardHeader
            title="Project tracker"
            sub={
              needle
                ? `${projects.length} of ${rows.length} project${rows.length === 1 ? '' : 's'} match`
                : `${rows.length} project${rows.length === 1 ? '' : 's'} · most recently opened first`
            }
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
          ) : projects.length === 0 ? (
            <Empty title="No matching projects">
              Nothing matches “{query.trim()}”. Try a different name, or clear the search.
            </Empty>
          ) : (
            <>
            <div className="table-wrap tracker-table">
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th style={{ width: 220 }}>Progress</th>
                    <th>Status</th>
                    <th style={{ width: 180 }}>Budget</th>
                    <th>Next milestone</th>
                    <th>Activity</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((row) => (
                    <tr
                      key={row.site.siteId}
                      className="tracker-row"
                      tabIndex={0}
                      onClick={() => navigate(`/sites/${row.site.siteId}`)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          navigate(`/sites/${row.site.siteId}`)
                        }
                      }}
                    >
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
                        {row.budget.lines === 0 ? (
                          <span className="muted small">Not budgeted</span>
                        ) : (
                          <>
                            <Progress percent={row.budget.percentUsed} />
                            <div className="small muted" style={{ marginTop: 5 }}>
                              {formatMoney(row.budget.spent, { compact: true })} of{' '}
                              {formatMoney(row.budget.budgeted, { compact: true })} · {row.budget.percentUsed}%
                            </div>
                          </>
                        )}
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

            {/* Phones: the same rows as tappable cards — no sideways scrolling. */}
            <div className="tracker-cards">
              {projects.map((row) => (
                <Link className="tracker-card" to={`/sites/${row.site.siteId}`} key={row.site.siteId}>
                  <div className="tracker-card-top">
                    <div style={{ minWidth: 0 }}>
                      <div className="tracker-card-name">{row.site.name}</div>
                      <div className="small muted">
                        {[row.site.code, row.site.location].filter(Boolean).join(' · ') ||
                          'No location set'}
                      </div>
                    </div>
                    <SiteStatusBadge status={row.site.status} />
                  </div>

                  <div className="tracker-card-grid">
                    <div>
                      <div className="tracker-card-label">Progress</div>
                      <div className="tracker-card-value">{row.progress.percent}%</div>
                      <div className="small muted">
                        {row.progress.milestonesCompleted}/{row.progress.milestones} milestones
                      </div>
                    </div>
                    <div>
                      <div className="tracker-card-label">Budget</div>
                      {row.budget.lines === 0 ? (
                        <div className="tracker-card-value muted">Not budgeted</div>
                      ) : (
                        <>
                          <div className="tracker-card-value">
                            {formatMoney(row.budget.spent, { compact: true })}
                          </div>
                          <div className="small muted">
                            of {formatMoney(row.budget.budgeted, { compact: true })} ·{' '}
                            {row.budget.percentUsed}%
                          </div>
                        </>
                      )}
                    </div>
                    <div>
                      <div className="tracker-card-label">Next milestone</div>
                      {row.nextMilestone ? (
                        <>
                          <div className="tracker-card-value">{row.nextMilestone.name}</div>
                          <div className="small muted">Due {formatDate(row.nextMilestone.dueDate)}</div>
                        </>
                      ) : (
                        <div className="tracker-card-value muted">—</div>
                      )}
                    </div>
                    <div>
                      <div className="tracker-card-label">Activity</div>
                      <div className="tracker-card-value">{relativeTime(row.lastActivity)}</div>
                    </div>
                  </div>

                  <div className="tracker-card-foot">
                    <span className="small muted">Open project</span>
                    <IconChevronRight size={16} />
                  </div>
                </Link>
              ))}
            </div>
            </>
          )}
        </Card>
        )}
        </TabPanel>

        {attention.length > 0 ? (
          <Card className="attention-card">
            <CardHeader
              title="Needs attention"
              sub={`${attention.length} project${attention.length === 1 ? '' : 's'} flagged — worst first`}
            />
            <ul className="attention-list">
              {attention.map(({ row, flag }) => (
                <li key={row.site.siteId}>
                  <Link className="attention-row" to={`/sites/${row.site.siteId}`}>
                    <span className={`attention-dot attention-dot-${flag.rank}`} aria-hidden="true" />
                    <span className="attention-main">
                      <span className="attention-name">{row.site.name}</span>
                      <span className="small muted">{flag.reason}</span>
                    </span>
                    <SiteStatusBadge status={row.site.status} />
                    <IconChevronRight size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </PageBody>

      {pickerOpen ? (
        <Modal
          title="Dashboard KPIs"
          onClose={() => setPickerOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(availableKpis)}>
                Select all
              </Button>
              <Button loading={saving} onClick={saveKpis}>
                <IconTarget size={16} />
                Save dashboard
              </Button>
            </>
          }
        >
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
                  aria-pressed={on}
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
        </Modal>
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
