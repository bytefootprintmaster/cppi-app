import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate } from '../lib/format'
import { sortByRecent, useRecentSites } from '../lib/recent'
import { PageBody, PageHeader } from '../components/Layout'
import { SiteFormModal } from '../components/SiteForm'
import { Button, Card, CardMenu, Empty, ErrorNote, Loading, SiteStatusBadge, useConfirm, useToast } from '../components/ui'
import { IconChevronRight, IconEdit, IconMapPin, IconPlus, IconSearch, IconTrash } from '../components/icons'
import type { SiteRecord } from '../../server/types'

type StatusFilter = 'all' | SiteRecord['status']
type SortKey = 'recent' | 'updated' | 'name' | 'start'

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'completed', label: 'Completed' }
]

export function SitesPage() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SiteRecord | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const recent = useRecentSites()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    document.title = 'Projects · CPPI'
  }, [])

  const sites = data?.sites ?? []

  // The list had no way to narrow down: a growing portfolio forced a visual scan
  // of every card. Search covers name, code and location; the status filter and
  // sort are what a project manager reaches for first. The default sort is what
  // you last opened rather than what was last edited, since an edit can come
  // from anyone while the project you are working on is yours.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = sites.filter((site) => {
      if (status !== 'all' && site.status !== status) return false
      if (!needle) return true
      return [site.name, site.code, site.location, site.description]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(needle))
    })
    if (sort === 'recent') return sortByRecent(rows, recent, (site) => site.siteId)
    return rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'start') return (a.startDate ?? '').localeCompare(b.startDate ?? '')
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    })
  }, [sites, query, status, sort, recent])

  function open(site: SiteRecord) {
    navigate(`/sites/${site.siteId}`, { state: { site } })
  }

  async function removeSite(site: SiteRecord) {
    const ok = await confirm({
      title: 'Delete project',
      message: `Delete "${site.name}" and everything in it? Files, photos and remarks cannot be recovered.`,
      confirmLabel: 'Delete project'
    })
    if (!ok) return
    setActionError(null)
    try {
      await api(`/sites/${site.siteId}`, { method: 'DELETE' })
      await reload()
      toast.success(`"${site.name}" was deleted.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the project')
    }
  }

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="All building sites you have access to."
        actions={
          isAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <IconPlus size={16} />
              New project
            </Button>
          ) : null
        }
      />

      <PageBody>
        <ErrorNote message={error || actionError} />

        {loading && !data ? (
          <Loading />
        ) : !data || data.sites.length === 0 ? (
          <Card>
            <Empty title="No projects yet">
              {isAdmin
                ? 'Create your first building site to define its framework, files and remarks.'
                : 'An administrator has not granted you access to any project yet.'}
            </Empty>
            {isAdmin ? (
              <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 28 }}>
                <Button onClick={() => setCreating(true)}>
                  <IconPlus size={16} />
                  New project
                </Button>
              </div>
            ) : null}
          </Card>
        ) : (
          <>
            <Card className="list-toolbar">
              <div className="search-form">
                <div className="search-form-field">
                  <IconSearch size={16} className="search-form-icon" />
                  <input
                    className="input search-form-input"
                    type="search"
                    placeholder="Search by name, code or location…"
                    aria-label="Search projects"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <select
                  className="select search-form-select"
                  aria-label="Filter by status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as StatusFilter)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  className="select search-form-select"
                  aria-label="Sort projects"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                >
                  <option value="recent">Recently accessed</option>
                  <option value="updated">Recently updated</option>
                  <option value="name">Name A–Z</option>
                  <option value="start">Start date</option>
                </select>
              </div>
            </Card>

            {visible.length === 0 ? (
              <Card>
                <Empty title="No matching projects">
                  Nothing matches “{query.trim()}”. Try a different name, or clear the filters.
                </Empty>
              </Card>
            ) : (
              <div className="grid grid-3">
                {visible.map((site) => (
                  <Card
                    key={site.siteId}
                    className="is-clickable project-card"
                    role="link"
                    tabIndex={0}
                    aria-label={`Open ${site.name}`}
                    onClick={() => open(site)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        open(site)
                      }
                    }}
                  >
                    <div className="card-body">
                      <div className="row-between" style={{ alignItems: 'flex-start' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 16 }}>{site.name}</div>
                          <div className="small muted">{site.code || 'No code'}</div>
                        </div>
                        <SiteStatusBadge status={site.status} />
                      </div>

                      <div className="row small muted" style={{ marginTop: 12 }}>
                        <IconMapPin size={14} />
                        <span>{site.location || 'Location not set'}</span>
                      </div>

                      {site.description ? (
                        <p className="small muted" style={{ marginTop: 10 }}>
                          {site.description.length > 120 ? `${site.description.slice(0, 120)}…` : site.description}
                        </p>
                      ) : null}

                      <div className="row-between small muted" style={{ marginTop: 14 }}>
                        <span>Start {formatDate(site.startDate)}</span>
                        <span>Target {formatDate(site.targetDate)}</span>
                      </div>
                    </div>
                    <div className="project-card-foot">
                      <span className="small muted">Updated {formatDate(site.updatedAt)}</span>
                      {isAdmin ? (
                        <CardMenu
                          items={[
                            { label: 'Edit', icon: <IconEdit size={14} />, onClick: () => setEditing(site) },
                            {
                              label: 'Delete',
                              icon: <IconTrash size={14} />,
                              danger: true,
                              onClick: () => void removeSite(site)
                            }
                          ]}
                        />
                      ) : (
                        <span className="project-card-open">
                          <span className="small muted">Open</span>
                          <IconChevronRight size={16} />
                        </span>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        <p className="small muted" style={{ marginTop: 22 }}>
          Tip: {isAdmin ? 'admins define stages and milestones inside each project.' : 'you can upload photos, documents and remarks where you have permission.'}
        </p>
      </PageBody>

      {creating ? (
        <SiteFormModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void reload()
            navigate('/sites')
          }}
        />
      ) : null}

      {editing ? (
        <SiteFormModal
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : null}
    </>
  )
}
