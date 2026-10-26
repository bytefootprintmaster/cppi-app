import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { formatDate, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Loading, Modal, RoleBadge } from '../components/ui'
import { IconCopy, IconMail, IconPlus, IconTrash } from '../components/icons'
import type { InviteRecord, Role, SiteRecord } from '../../server/types'

type InviteWithUrl = InviteRecord & { url: string }

const ROLES: Role[] = ['admin', 'contractor', 'viewer']

const INVITE_TONE: Record<string, 'green' | 'amber' | 'gray' | 'red'> = {
  pending: 'amber',
  accepted: 'green',
  revoked: 'gray'
}

export function AdminInvitesPage() {
  const { data, error, loading, reload } = useApi<{ invites: InviteWithUrl[] }>('/admin/invites')
  const { data: siteData } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [creating, setCreating] = useState(false)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Invitations · CPPI'
  }, [])

  async function copyLink(invite: InviteWithUrl) {
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopied(invite.token)
      window.setTimeout(() => setCopied(null), 2000)
    } catch {
      setActionError('Could not access the clipboard. Copy the link manually.')
    }
  }

  async function revoke(invite: InviteWithUrl) {
    if (!window.confirm('Revoke this invitation? The link will stop working.')) return
    setBusyToken(invite.token)
    setActionError(null)
    try {
      await api(`/admin/invites/${invite.token}`, { method: 'DELETE' })
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not revoke the invitation')
    } finally {
      setBusyToken(null)
    }
  }

  const invites = data?.invites ?? []
  const sites = siteData?.sites ?? []

  return (
    <>
      <PageHeader
        title="Invitations"
        subtitle="Invite people to CPPI and scope exactly which projects they can open."
        actions={
          <Button onClick={() => setCreating(true)}>
            <IconPlus size={16} />
            New invitation
          </Button>
        }
      />

      <PageBody>
        <ErrorNote message={error ?? actionError} />

        <Card>
          <CardHeader title="Sent invitations" sub={`${invites.length} total`} />
          {loading && !data ? (
            <Loading />
          ) : invites.length === 0 ? (
            <Empty title="No invitations yet">
              Create an invitation, then share the generated link with your contractor or colleague.
            </Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Projects</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <tr key={invite.token}>
                      <td>
                        <RoleBadge role={invite.role} />
                      </td>
                      <td>
                        <div>{invite.email || <span className="muted small">Open link</span>}</div>
                        {invite.note ? <div className="small muted">{invite.note}</div> : null}
                      </td>
                      <td className="small">
                        {invite.siteIds.length === 0 ? (
                          <span className="muted">No projects {invite.role === 'admin' ? '(sees all)' : ''}</span>
                        ) : (
                          `${invite.siteIds.length} project(s)`
                        )}
                      </td>
                      <td>
                        <Badge tone={INVITE_TONE[invite.status] ?? 'gray'}>{invite.status}</Badge>
                        <div className="small muted" style={{ marginTop: 3 }}>
                          {relativeTime(invite.createdAt)}
                        </div>
                      </td>
                      <td className="small">{formatDate(invite.expiresAt)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Button variant="ghost" size="sm" onClick={() => void copyLink(invite)}>
                          <IconCopy size={14} />
                          {copied === invite.token ? 'Copied' : 'Copy link'}
                        </Button>
                        {invite.status === 'pending' ? (
                          <Button
                            variant="danger"
                            size="sm"
                            style={{ marginLeft: 6 }}
                            loading={busyToken === invite.token}
                            onClick={() => void revoke(invite)}
                          >
                            <IconTrash size={14} />
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <p className="small muted" style={{ marginTop: 16 }}>
          <IconMail size={13} /> Share the invitation link over any channel — email delivery is a planned follow-up.
        </p>
      </PageBody>

      {creating ? (
        <CreateInviteModal
          sites={sites}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void reload()
          }}
        />
      ) : null}
    </>
  )
}

function CreateInviteModal({
  sites,
  onClose,
  onSaved
}: {
  sites: SiteRecord[]
  onClose: () => void
  onSaved: () => void
}) {
  const [role, setRole] = useState<Role>('contractor')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('14')
  const [siteIds, setSiteIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleSite(id: string) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/admin/invites', {
        method: 'POST',
        body: {
          role,
          email: email.trim() || undefined,
          note: note.trim() || undefined,
          siteIds,
          expiresInDays: Number(expiresInDays) || 14
        }
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invitation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title="New invitation"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="invite-form" type="submit" loading={busy}>
            Create invitation
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}

        <div className="grid grid-2">
          <Field label="Role">
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Expires in (days)">
            <input
              className="input"
              type="number"
              min="1"
              max="90"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Restrict to email (optional)" hint="Leave empty to allow anyone holding the link">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contractor@example.com"
          />
        </Field>

        <Field label="Note (optional)">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Site foreman" />
        </Field>

        <Field
          label="Project access"
          hint={role === 'admin' ? 'Admins can see every project regardless of this list.' : 'Select the projects this person may open.'}
        >
          {sites.length === 0 ? (
            <div className="small muted">No projects exist yet.</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {sites.map((site) => (
                <label key={site.siteId} className="row small" style={{ gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={siteIds.includes(site.siteId)}
                    onChange={() => toggleSite(site.siteId)}
                  />
                  <span style={{ fontWeight: 600 }}>{site.name}</span>
                  <span className="muted">{site.location}</span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="alert alert-info">
          Role behaviour: <strong>admin</strong> manages projects, framework and users; <strong>contractor</strong> can
          upload photos, documents and remarks; <strong>viewer</strong> has read-only access.
        </div>
      </form>
    </Modal>
  )
}
