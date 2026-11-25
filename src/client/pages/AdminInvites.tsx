import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { isSuperAdminRole, useAuth } from '../lib/auth'
import { useApi } from '../lib/useApi'
import { formatDate, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Card, CardHeader, CardMenu, Empty, ErrorNote, Field, Loading, Modal, RoleBadge, useConfirm, useDiscardGuard, useToast, type MenuItem } from '../components/ui'
import { IconCopy, IconMail, IconPlus, IconTrash } from '../components/icons'
import type { InviteRecord, Role, RoleRecord, SiteRecord } from '../../server/types'

type InviteWithUrl = InviteRecord & { url: string }

const INVITE_TONE: Record<string, 'green' | 'amber' | 'gray' | 'red'> = {
  pending: 'amber',
  accepted: 'green',
  revoked: 'gray'
}

export function AdminInvitesPage() {
  const { data, error, loading, reload } = useApi<{ invites: InviteWithUrl[] }>('/admin/invites')
  const { data: siteData } = useApi<{ sites: SiteRecord[] }>('/sites')
  const { data: roleData } = useApi<{ roles: RoleRecord[] }>('/admin/roles')
  const { user } = useAuth()
  // Only a platform super admin may bring a new customer — a whole new
  // workspace — into CPPI; org admins invite people into their own workspace.
  const isSuper = isSuperAdminRole(user?.role)
  const {
    data: workspaceData,
    error: workspaceError,
    loading: workspaceLoading,
    reload: reloadWorkspaces
  } = useApi<{ invites: InviteWithUrl[] }>(isSuper ? '/admin/workspace-invites' : null)
  const [creating, setCreating] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    document.title = 'Invitations · CPPI'
  }, [])

  async function copyLink(invite: InviteWithUrl) {
    try {
      await navigator.clipboard.writeText(invite.url)
      toast.success('Invitation link copied to the clipboard.')
    } catch {
      setActionError('Could not access the clipboard. Copy the link manually.')
    }
  }

  async function revoke(invite: InviteWithUrl) {
    const ok = await confirm({
      title: 'Revoke invitation',
      message: 'The link will stop working immediately. Anyone who already accepted keeps their access.',
      confirmLabel: 'Revoke link'
    })
    if (!ok) return
    setBusyToken(invite.token)
    setActionError(null)
    try {
      await api(`/admin/invites/${invite.token}`, { method: 'DELETE' })
      await reload()
      toast.success('Invitation revoked.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not revoke the invitation')
    } finally {
      setBusyToken(null)
    }
  }

  async function revokeWorkspace(invite: InviteWithUrl) {
    const ok = await confirm({
      title: 'Revoke workspace invitation',
      message: 'The link will stop working immediately. A workspace already created from it keeps working.',
      confirmLabel: 'Revoke link'
    })
    if (!ok) return
    setBusyToken(invite.token)
    setActionError(null)
    try {
      await api(`/admin/workspace-invites/${invite.token}`, { method: 'DELETE' })
      await reloadWorkspaces()
      toast.success('Workspace invitation revoked.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not revoke the invitation')
    } finally {
      setBusyToken(null)
    }
  }

  const invites = data?.invites ?? []
  const workspaceInvites = workspaceData?.invites ?? []
  const sites = siteData?.sites ?? []
  const roles = roleData?.roles ?? []
  const roleLabel = (id: string) => roles.find((r) => r.roleId === id)?.name ?? id

  function inviteMenuItems(invite: InviteWithUrl): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: busyToken === invite.token ? 'Revoking…' : 'Copy link',
        icon: <IconCopy size={14} />,
        onClick: () => void copyLink(invite)
      }
    ]
    if (invite.status === 'pending') {
      items.push({ label: 'Revoke', icon: <IconTrash size={14} />, danger: true, onClick: () => void revoke(invite) })
    }
    return items
  }

  function workspaceMenuItems(invite: InviteWithUrl): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Copy link',
        icon: <IconCopy size={14} />,
        onClick: () => void copyLink(invite)
      }
    ]
    if (invite.status === 'pending') {
      items.push({
        label: busyToken === invite.token ? 'Revoking…' : 'Revoke',
        icon: <IconTrash size={14} />,
        danger: true,
        onClick: () => void revokeWorkspace(invite)
      })
    }
    return items
  }

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
            <>
              {/* Desktop: full table. */}
              <div className="table-wrap invites-table">
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
                          <RoleBadge role={invite.role} label={roleLabel(invite.role)} />
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
                          <CardMenu items={inviteMenuItems(invite)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same invitations as cards — no sideways scrolling. */}
              <div className="invites-cards">
                {invites.map((invite) => (
                  <div className="user-card" key={invite.token}>
                    <div className="user-card-top">
                      <div style={{ minWidth: 0 }}>
                        <div className="user-card-name">{invite.email || 'Open link'}</div>
                        {invite.note ? <div className="small muted user-card-email">{invite.note}</div> : null}
                      </div>
                      <CardMenu items={inviteMenuItems(invite)} />
                    </div>
                    <div className="user-card-grid">
                      <div>
                        <div className="user-card-label">Role</div>
                        <div className="user-card-value">
                          <RoleBadge role={invite.role} label={roleLabel(invite.role)} />
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Status</div>
                        <div className="user-card-value">
                          <Badge tone={INVITE_TONE[invite.status] ?? 'gray'}>{invite.status}</Badge>
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Projects</div>
                        <div className="user-card-value small">
                          {invite.siteIds.length === 0 ? (
                            <span className="muted">No projects {invite.role === 'admin' ? '(sees all)' : ''}</span>
                          ) : (
                            `${invite.siteIds.length} project(s)`
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Expires</div>
                        <div className="user-card-value small">{formatDate(invite.expiresAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {/* Workspaces are a platform concern: only a super admin brings a new
            customer in, and each one gets a workspace of their own. */}
        {isSuper ? (
          <Card style={{ marginTop: 20 }}>
            <CardHeader
              title="Workspaces"
              sub="Separate customers. Each one owns its projects, people and data."
              action={
                <Button onClick={() => setCreatingWorkspace(true)}>
                  <IconPlus size={16} />
                  New workspace
                </Button>
              }
            />
            <ErrorNote message={workspaceError} />
            {workspaceLoading && !workspaceData ? (
              <Loading />
            ) : workspaceInvites.length === 0 ? (
              <Empty title="No workspace invitations yet">
                Invite a contractor and they get a workspace of their own to start from scratch.
              </Empty>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                {workspaceInvites.map((invite) => (
                  <div className="user-card" key={invite.token}>
                    <div className="user-card-top">
                      <div style={{ minWidth: 0 }}>
                        <div className="user-card-name">{invite.orgName || 'Untitled workspace'}</div>
                        <div className="small muted user-card-email">{invite.email || 'Open link'}</div>
                      </div>
                      <CardMenu items={workspaceMenuItems(invite)} />
                    </div>
                    <div className="user-card-grid">
                      <div>
                        <div className="user-card-label">Status</div>
                        <div className="user-card-value">
                          <Badge tone={INVITE_TONE[invite.status] ?? 'gray'}>{invite.status}</Badge>
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Expires</div>
                        <div className="user-card-value small">{formatDate(invite.expiresAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : null}

        <p className="small muted" style={{ marginTop: 16 }}>
          <IconMail size={13} /> Share the invitation link over any channel — email delivery is a planned follow-up.
        </p>
      </PageBody>

      {creating ? (
        <CreateInviteModal
          sites={sites}
          roles={roles}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void reload()
          }}
        />
      ) : null}

      {creatingWorkspace ? (
        <CreateWorkspaceInviteModal
          onClose={() => setCreatingWorkspace(false)}
          onSaved={() => {
            setCreatingWorkspace(false)
            void reloadWorkspaces()
          }}
        />
      ) : null}
    </>
  )
}

function CreateInviteModal({
  sites,
  roles,
  onClose,
  onSaved
}: {
  sites: SiteRecord[]
  roles: RoleRecord[]
  onClose: () => void
  onSaved: () => void
}) {
  const [role, setRole] = useState<Role>('viewer')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('14')
  const [siteIds, setSiteIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  // The defaults above are the baseline; anything else means work in progress.
  const dirty =
    role !== 'viewer' || email !== '' || note !== '' || expiresInDays !== '14' || siteIds.length > 0
  const guardClose = useDiscardGuard(dirty, onClose)

  function requestClose() {
    if (busy) return
    void guardClose()
  }

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
      toast.success('Invitation created — copy the link from the list.')
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
      onClose={requestClose}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose} disabled={busy}>
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
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.roleId} value={r.roleId}>
                  {r.name}
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
          The invitation carries the role you pick here; permissions and upload limits can be fine-tuned afterwards on
          the Users &amp; roles page.
        </div>
      </form>
    </Modal>
  )
}

/**
 * Invite a new customer. The workspace itself is created when the invitee
 * accepts, so nothing of theirs exists until they sign in — and they see none
 * of our projects from the moment they do.
 */
function CreateWorkspaceInviteModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('14')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const dirty = orgName !== '' || email !== '' || note !== '' || expiresInDays !== '14'
  const guardClose = useDiscardGuard(dirty, onClose)

  function requestClose() {
    if (busy) return
    void guardClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ url: string }>('/admin/workspace-invites', {
        method: 'POST',
        body: {
          orgName: orgName.trim(),
          email: email.trim() || undefined,
          note: note.trim() || undefined,
          expiresInDays: Number(expiresInDays) || 14
        }
      })
      // The link is what gets passed on, so put it on the clipboard straight away.
      await navigator.clipboard.writeText(res.url).catch(() => undefined)
      toast.success('Invitation created — the link is on your clipboard.')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invitation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New workspace"
      onClose={requestClose}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="workspace-invite-form" type="submit" loading={busy}>
            Create invitation
          </Button>
        </>
      }
    >
      <form id="workspace-invite-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}

        <Field label="Workspace name">
          <input
            className="input"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. Sunrise Builders"
            required
          />
        </Field>

        <div className="grid grid-2">
          <Field label="Restrict to email (optional)" hint="Leave empty to allow anyone holding the link">
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contractor@example.com"
            />
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

        <Field label="Note (optional)">
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Met at the builders' expo"
          />
        </Field>

        <div className="alert alert-info">
          Accepting this link creates a new workspace with the invitee as its admin. They start empty — no projects,
          no files — and can invite their own team from there.
        </div>
      </form>
    </Modal>
  )
}
