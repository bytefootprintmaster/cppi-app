import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { SiteFormModal } from '../components/SiteForm'
import { Button, Card, CardMenu, Empty, ErrorNote, Loading, SiteStatusBadge } from '../components/ui'
import { IconChevronRight, IconEdit, IconMapPin, IconPlus, IconTrash } from '../components/icons'
import type { SiteRecord } from '../../server/types'

export function SitesPage() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SiteRecord | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    document.title = 'Projects · CPPI'
  }, [])

  function open(site: SiteRecord) {
    navigate(`/sites/${site.siteId}`, { state: { site } })
  }

  async function removeSite(site: SiteRecord) {
    if (!window.confirm(`Delete "${site.name}" and everything in it? This cannot be undone.`)) return
    setActionError(null)
    try {
      await api(`/sites/${site.siteId}`, { method: 'DELETE' })
      await reload()
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
          <div className="grid grid-3">
            {data.sites.map((site) => (
              <Card key={site.siteId} className="is-clickable project-card">
                <div
                  className="card-body"
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
