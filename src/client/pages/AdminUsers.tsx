import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Avatar, Badge, Button, Card, CardHeader, Empty, ErrorNote, Loading, Modal, RoleBadge } from '../components/ui'
import { IconSearch, IconTrash } from '../components/icons'
import type { Role, SiteRecord, UserRecord } from '../../server/types'

const ROLES: Role[] = ['admin', 'contractor', 'viewer']

export function AdminUsersPage() {
  const { user: me } = useAuth()
  const { data, error, loading, reload } = useApi<{ users: UserRecord[] }>('/admin/users')
  const { data: siteData } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editingAccess, setEditingAccess] = useState<UserRecord | null>(null)

  useEffect(() => {
    document.title = 'Users · CPPI'
  }, [])

  async function patch(target: UserRecord, body: Record<string, unknown>, successMessage?: string) {
    setBusyId(target.userId)
    setActionError(null)
    try {
      await api(`/admin/users/${target.userId}`, { method: 'PATCH', body })
      await reload()
      if (successMessage) window.setTimeout(() => window.alert(successMessage), 0)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update the user')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(target: UserRecord) {
    if (!window.confirm(`Remove ${target.name} from CPPI? They will lose access immediately.`)) return
    setBusyId(target.userId)
    setActionError(null)
    try {
      await api(`/admin/users/${target.userId}`, { method: 'DELETE' })
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not remove the user')
    } finally {
      setBusyId(null)
    }
  }

  const users = data?.users ?? []
  const sites = siteData?.sites ?? []
  const siteName = (id: string) => sites.find((s) => s.siteId === id)?.name ?? id
  const filtered = users.filter((u) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  return (
    <>
      <PageHeader
        title="Users & roles"
        subtitle="Everyone who can sign in to CPPI, with their role and project access."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <IconSearch size={16} />
            <input
              className="input"
              style={{ width: 220 }}
              placeholder="Search name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      />

      <PageBody>
        <ErrorNote message={error ?? actionError} />

        <Card>
          <CardHeader title="Team" sub={`${filtered.length} of ${users.length}`} />
          {loading && !data ? (
            <Loading />
          ) : filtered.length === 0 ? (
            <Empty title="No users found">Invite people from the Invitations page.</Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Projects</th>
                    <th>Status</th>
                    <th>Last login</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    <tr key={u.userId}>
                      <td>
                        <div className="row" style={{ gap: 10 }}>
                          <Avatar name={u.name} src={u.picture} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>
                              {u.name}
                              {u.userId === me?.userId ? <span className="small muted"> (you)</span> : null}
                            </div>
                            <div className="small muted">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <select
                          className="select"
                          style={{ width: 140 }}
                          value={u.role}
                          disabled={busyId === u.userId}
                          onChange={(e) => void patch(u, { role: e.target.value })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="small">
                        {u.role === 'admin' ? (
                          <span className="muted">All projects</span>
                        ) : u.siteIds.length === 0 ? (
                          <span className="muted">No access</span>
                        ) : (
                          <span title={u.siteIds.map(siteName).join(', ')}>
                            {u.siteIds.length} project(s)
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                      </td>
                      <td className="small muted">{relativeTime(u.lastLoginAt)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Button variant="ghost" size="sm" onClick={() => setEditingAccess(u)}>
                          Access
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          style={{ marginLeft: 6 }}
                          disabled={busyId === u.userId}
                          onClick={() =>
                            void patch(u, { status: u.status === 'active' ? 'disabled' : 'active' })
                          }
                        >
                          {u.status === 'active' ? 'Disable' : 'Enable'}
                        </Button>
                        {u.userId === me?.userId ? null : (
                          <Button
                            variant="danger"
                            size="sm"
                            style={{ marginLeft: 6 }}
                            disabled={busyId === u.userId}
                            onClick={() => void remove(u)}
                          >
                            <IconTrash size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <p className="small muted" style={{ marginTop: 16 }}>
          Created <strong>{users.length}</strong> account{users.length === 1 ? '' : 's'} ·{' '}
          {users.filter((u) => u.role === 'admin').length} admin(s) ·{' '}
          {users.filter((u) => u.role === 'contractor').length} contractor(s)
        </p>

        <p className="small muted">Accounts are created on first Google sign-in; last login {formatDate(users[0]?.lastLoginAt)}.</p>
      </PageBody>

      {editingAccess ? (
        <AccessModal
          user={editingAccess}
          sites={sites}
          onClose={() => setEditingAccess(null)}
          onSaved={() => {
            setEditingAccess(null)
            void reload()
          }}
        />
      ) : null}
    </>
  )
}

function AccessModal({
  user,
  sites,
  onClose,
  onSaved
}: {
  user: UserRecord
  sites: SiteRecord[]
  onClose: () => void
  onSaved: () => void
}) {
  const [siteIds, setSiteIds] = useState<string[]>(user.siteIds ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(id: string) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/users/${user.userId}`, { method: 'PATCH', body: { siteIds } })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update project access')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Project access · ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Save access
          </Button>
        </>
      }
    >
      {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}
      <div className="row" style={{ marginBottom: 14 }}>
        <RoleBadge role={user.role} />
        <span className="small muted">{user.email}</span>
      </div>

      {user.role === 'admin' ? (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          Admins can open every project. This list only matters for contractor and viewer roles.
        </div>
      ) : null}

      {sites.length === 0 ? (
        <Empty title="No projects yet" />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {sites.map((site) => (
            <label key={site.siteId} className="row small" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={siteIds.includes(site.siteId)} onChange={() => toggle(site.siteId)} />
              <span style={{ fontWeight: 600 }}>{site.name}</span>
              <span className="muted">{site.location}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  )
}
