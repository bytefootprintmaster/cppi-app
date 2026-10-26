import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { SiteFormModal } from '../components/SiteForm'
import { Button, Card, Empty, ErrorNote, Loading, SiteStatusBadge } from '../components/ui'
import { IconMapPin, IconPlus } from '../components/icons'
import type { SiteRecord } from '../../server/types'

export function SitesPage() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    document.title = 'Projects · CPPI'
  }, [])

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
        <ErrorNote message={error} />

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
              <Card key={site.siteId}>
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
                <div className="card-header" style={{ borderBottom: 'none', borderTop: '1px solid var(--line)' }}>
                  <span className="small muted">Updated {formatDate(site.updatedAt)}</span>
                  <Link className="btn btn-ghost btn-sm" to={`/sites/${site.siteId}`} state={{ site }}>
                    Open
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}

        <p className="small muted" style={{ marginTop: 22 }}>
          Tip: {isAdmin ? 'admins define stages and milestones inside each project.' : 'contractors can upload photos, documents and remarks.'}
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
    </>
  )
}
