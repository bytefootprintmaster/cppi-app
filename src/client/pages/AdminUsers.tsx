import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Avatar, Badge, Button, Card, CardHeader, CardMenu, Empty, ErrorNote, Field, Loading, Modal, PasswordInput, RoleBadge, type MenuItem } from '../components/ui'
import { IconCheck, IconEdit, IconPlus, IconSearch, IconTrash, IconUsers, IconX } from '../components/icons'
import type {
  PermissionKey,
  PermissionOverrides,
  Permissions,
  Role,
  RoleRecord,
  SiteRecord,
  UploadLimits,
  UserRecord
} from '../../server/types'
import { DEFAULT_UPLOAD_LIMITS, PERMISSION_HINT, PERMISSION_KEYS, PERMISSION_LABEL } from '../../server/types'

/** A permission can be inherited from the role, or forced on/off for one user. */
type OverrideChoice = 'inherit' | 'allow' | 'deny'

function toChoice(value: boolean | undefined): OverrideChoice {
  return value === undefined ? 'inherit' : value ? 'allow' : 'deny'
}

function fromChoice(value: OverrideChoice): boolean | undefined {
  return value === 'inherit' ? undefined : value === 'allow'
}

export function AdminUsersPage() {
  const { user: me } = useAuth()
  const { data, error, loading, reload } = useApi<{ users: UserRecord[] }>('/admin/users')
  const { data: roleData, reload: reloadRoles } = useApi<{ roles: RoleRecord[] }>('/admin/roles')
  const { data: siteData } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editingAccess, setEditingAccess] = useState<UserRecord | null>(null)
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null)
  const [creatingUser, setCreatingUser] = useState(false)
  const [editingRole, setEditingRole] = useState<RoleRecord | null>(null)
  const [creatingRole, setCreatingRole] = useState(false)

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

  async function deleteRole(target: RoleRecord) {
    if (!window.confirm(`Delete the "${target.name}" role? Users must be reassigned first.`)) return
    setActionError(null)
    try {
      await api(`/admin/roles/${target.roleId}`, { method: 'DELETE' })
      await reloadRoles()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the role')
    }
  }

  const users = data?.users ?? []
  const roles = roleData?.roles ?? []
  const sites = siteData?.sites ?? []
  const siteName = (id: string) => sites.find((s) => s.siteId === id)?.name ?? id
  const roleOf = (id: string) => roles.find((r) => r.roleId === id)
  const roleLabel = (id: string) => roleOf(id)?.name ?? id
  const filtered = users.filter((u) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  function userMenuItems(target: UserRecord): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Edit user', icon: <IconEdit size={14} />, onClick: () => setEditingUser(target) },
      { label: 'Project access', icon: <IconUsers size={14} />, onClick: () => setEditingAccess(target) },
      target.status === 'active'
        ? { label: 'Disable', icon: <IconX size={14} />, onClick: () => void patch(target, { status: 'disabled' }) }
        : { label: 'Enable', icon: <IconCheck size={14} />, onClick: () => void patch(target, { status: 'active' }) }
    ]
    if (target.userId !== me?.userId) {
      items.push({ label: 'Remove', icon: <IconTrash size={14} />, danger: true, onClick: () => void remove(target) })
    }
    return items
  }

  function roleMenuItems(target: RoleRecord): MenuItem[] {
    return [
      { label: 'Edit role', icon: <IconEdit size={14} />, onClick: () => setEditingRole(target) },
      { label: 'Delete', icon: <IconTrash size={14} />, danger: true, onClick: () => void deleteRole(target) }
    ]
  }

  return (
    <>
      <PageHeader
        title="Users & roles"
        subtitle="Everyone who can sign in to CPPI, with their role, permissions and project access."
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            <Button variant="primary" size="sm" onClick={() => setCreatingUser(true)}>
              <IconPlus size={14} />
              Add user
            </Button>
            <IconSearch size={16} />
            <input
              className="input search-input"
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
            <Empty title="No users found">Use the Add user button or invite people from the Invitations page.</Empty>
          ) : (
            <>
              {/* Desktop: full table. */}
              <div className="table-wrap users-table">
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
                          <RoleSelect
                            value={u.role}
                            roles={roles}
                            disabled={busyId === u.userId || u.role === 'admin'}
                            locked={u.role === 'admin'}
                            onChange={(next) => void patch(u, { role: next })}
                          />
                          {u.role === 'admin' ? (
                            <div className="small muted" style={{ marginTop: 4 }}>
                              Locked
                            </div>
                          ) : null}
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
                          <CardMenu items={userMenuItems(u)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same people as cards — no sideways scrolling. */}
              <div className="users-cards">
                {filtered.map((u) => (
                  <div className="user-card" key={u.userId}>
                    <div className="user-card-top">
                      <div className="row" style={{ gap: 10, minWidth: 0 }}>
                        <Avatar name={u.name} src={u.picture} />
                        <div style={{ minWidth: 0 }}>
                          <div className="user-card-name">
                            {u.name}
                            {u.userId === me?.userId ? <span className="small muted"> (you)</span> : null}
                          </div>
                          <div className="small muted user-card-email">{u.email}</div>
                        </div>
                      </div>
                      <CardMenu items={userMenuItems(u)} />
                    </div>
                    <div className="user-card-grid">
                      <div>
                        <div className="user-card-label">Role</div>
                        <div className="user-card-value">
                          {u.role === 'admin' ? (
                            <span className="row" style={{ gap: 6 }}>
                              <RoleBadge role={u.role} label={roleLabel(u.role)} />
                              <span className="small muted">Locked</span>
                            </span>
                          ) : (
                            <RoleSelect
                              value={u.role}
                              roles={roles}
                              disabled={busyId === u.userId}
                              onChange={(next) => void patch(u, { role: next })}
                            />
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Status</div>
                        <div className="user-card-value">
                          <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Projects</div>
                        <div className="user-card-value small">
                          {u.role === 'admin' ? (
                            <span className="muted">All projects</span>
                          ) : u.siteIds.length === 0 ? (
                            <span className="muted">No access</span>
                          ) : (
                            <span>{u.siteIds.length} project(s)</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="user-card-label">Last login</div>
                        <div className="user-card-value small muted">{relativeTime(u.lastLoginAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card className="mt-16">
          <CardHeader
            title="Roles"
            sub="Named bundles of permissions. Built-in roles are fixed; add your own for anything else."
            action={
              <Button variant="ghost" size="sm" onClick={() => setCreatingRole(true)}>
                <IconPlus size={14} />
                New role
              </Button>
            }
          />
          <div className="stack" style={{ gap: 10 }}>
            {roles.map((role) => (
              <div className="role-row" key={role.roleId}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <RoleBadge role={role.roleId} label={role.name} />
                    {role.builtin ? <span className="small muted">Built-in</span> : null}
                  </div>
                  <div className="row wrap small muted" style={{ gap: 10, marginTop: 6 }}>
                    {PERMISSION_KEYS.map((key) => (
                      <span key={key}>
                        {role.permissions[key] ? '✓' : '✕'} {PERMISSION_LABEL[key]}
                      </span>
                    ))}
                  </div>
                </div>
                {role.builtin ? (
                  <span className="small muted">Fixed</span>
                ) : (
                  <CardMenu items={roleMenuItems(role)} />
                )}
              </div>
            ))}
          </div>
        </Card>

        <p className="small muted" style={{ marginTop: 16 }}>
          Created <strong>{users.length}</strong> account{users.length === 1 ? '' : 's'} ·{' '}
          {users.filter((u) => u.role === 'admin').length} admin(s) ·{' '}
          {users.filter((u) => u.role === 'manager').length} manager(s) ·{' '}
          {users.filter((u) => u.role !== 'admin' && u.role !== 'manager').length} other
        </p>

        <p className="small muted">
          Accounts can come from Google sign-in or provisioned password login; last login {formatDate(users[0]?.lastLoginAt)}.
        </p>
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

      {creatingUser ? (
        <UserModal
          sites={sites}
          roles={roles}
          onClose={() => setCreatingUser(false)}
          onSaved={() => {
            setCreatingUser(false)
            void reload()
          }}
        />
      ) : null}

      {editingUser ? (
        <UserModal
          user={editingUser}
          sites={sites}
          roles={roles}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null)
            void reload()
          }}
        />
      ) : null}

      {creatingRole ? (
        <RoleModal
          onClose={() => setCreatingRole(false)}
          onSaved={() => {
            setCreatingRole(false)
            void reloadRoles()
          }}
        />
      ) : null}

      {editingRole ? (
        <RoleModal
          role={editingRole}
          onClose={() => setEditingRole(null)}
          onSaved={() => {
            setEditingRole(null)
            void reloadRoles()
            void reload()
          }}
        />
      ) : null}
    </>
  )
}

/** The shared role picker, used in the table and in the mobile cards. */
function RoleSelect({
  value,
  roles,
  disabled,
  locked,
  onChange
}: {
  value: Role
  roles: RoleRecord[]
  disabled?: boolean
  locked?: boolean
  onChange: (role: string) => void
}) {
  return (
    <select
      className="select"
      style={{ width: 160 }}
      value={value}
      disabled={disabled || locked}
      title={locked ? 'Admin roles are locked' : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      {roles.map((r) => (
        <option key={r.roleId} value={r.roleId}>
          {r.name}
        </option>
      ))}
    </select>
  )
}

/** One row of a role's permission matrix: inherit, allow or deny. */
function PermissionRow({
  label,
  hint,
  value,
  roleDefault,
  onChange
}: {
  label: string
  hint: string
  value: OverrideChoice
  roleDefault: boolean
  onChange: (value: OverrideChoice) => void
}) {
  return (
    <div className="perm-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{label}</div>
        <div className="small muted">{hint}</div>
      </div>
      <select className="select perm-select" value={value} onChange={(e) => onChange(e.target.value as OverrideChoice)}>
        <option value="inherit">Role default ({roleDefault ? 'allow' : 'deny'})</option>
        <option value="allow">Allow</option>
        <option value="deny">Deny</option>
      </select>
    </div>
  )
}

function UserModal({
  user,
  sites,
  roles,
  onClose,
  onSaved
}: {
  user?: UserRecord
  sites: SiteRecord[]
  roles: RoleRecord[]
  onClose: () => void
  onSaved: () => void
}) {
  const isEditing = Boolean(user)
  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<Role>(user?.role ?? 'viewer')
  const [password, setPassword] = useState('')
  const [siteIds, setSiteIds] = useState<string[]>(user?.siteIds ?? [])
  const [choices, setChoices] = useState<Record<PermissionKey, OverrideChoice>>({
    uploadFiles: toChoice(user?.permissions?.uploadFiles),
    viewBudget: toChoice(user?.permissions?.viewBudget),
    editDetails: toChoice(user?.permissions?.editDetails)
  })
  const [dailyUploads, setDailyUploads] = useState(user?.limits?.dailyUploads ? String(user.limits.dailyUploads) : '')
  const [maxFileMb, setMaxFileMb] = useState(user?.limits?.maxFileMb ? String(user.limits.maxFileMb) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rolePermissions: Permissions = roles.find((r) => r.roleId === role)?.permissions ?? {
    uploadFiles: false,
    viewBudget: false,
    editDetails: false
  }

  function toggle(id: string) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (!isEditing && !password.trim()) {
        throw new Error('Password is required for a new user')
      }

      const permissions: PermissionOverrides = {}
      for (const key of PERMISSION_KEYS) {
        const value = fromChoice(choices[key])
        if (value !== undefined) permissions[key] = value
      }
      const limits: Partial<UploadLimits> = {}
      if (dailyUploads.trim()) limits.dailyUploads = Number(dailyUploads)
      if (maxFileMb.trim()) limits.maxFileMb = Number(maxFileMb)

      const body: Record<string, unknown> = {
        name,
        email,
        role,
        siteIds: role === 'admin' ? [] : siteIds,
        permissions,
        limits
      }
      if (password.trim()) body.password = password

      if (isEditing) await api(`/admin/users/${user!.userId}`, { method: 'PATCH', body })
      else await api('/admin/users', { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${isEditing ? 'update' : 'create'} the user`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={isEditing ? `Edit user · ${user!.name}` : 'Add user'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            {isEditing ? 'Save changes' : 'Create user'}
          </Button>
        </>
      }
    >
      {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="grid grid-2">
        <Field label="Full name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Site Manager"
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@company.com"
          />
        </Field>
      </div>

      <Field
        label="Role"
        hint={user?.role === 'admin' ? 'Admin roles are locked and cannot be changed.' : 'Pick a starting bundle, then fine-tune below.'}
      >
        <select
          className="select"
          value={role}
          disabled={user?.role === 'admin'}
          onChange={(e) => setRole(e.target.value)}
        >
          {roles.map((item) => (
            <option key={item.roleId} value={item.roleId}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={isEditing ? 'Reset password' : 'Password'}
        hint={isEditing ? 'Leave blank to keep the current password.' : 'Minimum 8 characters.'}
      >
        <PasswordInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isEditing ? 'New password (optional)' : 'Create a password'}
        />
      </Field>

      <div className="section-title">Permissions</div>
      <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>
        Override what the {roleLabelSafe(role, roles)} role grants for this person only.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        {PERMISSION_KEYS.map((key) => (
          <PermissionRow
            key={key}
            label={PERMISSION_LABEL[key]}
            hint={PERMISSION_HINT[key]}
            value={choices[key]}
            roleDefault={rolePermissions[key] || role === 'admin'}
            onChange={(value) => setChoices((prev) => ({ ...prev, [key]: value }))}
          />
        ))}
      </div>

      <div className="section-title">Upload limits</div>
      <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>
        Leave blank to use the default guardrails ({DEFAULT_UPLOAD_LIMITS.dailyUploads} files/day,{' '}
        {DEFAULT_UPLOAD_LIMITS.maxFileMb} MB per file).
      </p>
      <div className="grid grid-2">
        <Field label="Files per day">
          <input
            className="input"
            type="number"
            min="1"
            value={dailyUploads}
            placeholder={String(DEFAULT_UPLOAD_LIMITS.dailyUploads)}
            onChange={(e) => setDailyUploads(e.target.value)}
          />
        </Field>
        <Field label="Max file size (MB)">
          <input
            className="input"
            type="number"
            min="1"
            value={maxFileMb}
            placeholder={String(DEFAULT_UPLOAD_LIMITS.maxFileMb)}
            onChange={(e) => setMaxFileMb(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Project access"
        hint={role === 'admin' ? 'Admins automatically have access to every project.' : 'Select the projects this user can access.'}
      >
        {role === 'admin' ? (
          <div className="alert alert-info">Admins can open every project.</div>
        ) : sites.length === 0 ? (
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
      </Field>
    </Modal>
  )
}

function roleLabelSafe(roleId: string, roles: RoleRecord[]): string {
  return roles.find((r) => r.roleId === roleId)?.name ?? roleId
}

function RoleModal({
  role,
  onClose,
  onSaved
}: {
  role?: RoleRecord
  onClose: () => void
  onSaved: () => void
}) {
  const isEditing = Boolean(role)
  const [name, setName] = useState(role?.name ?? '')
  const [permissions, setPermissions] = useState<Permissions>(
    role?.permissions ?? { uploadFiles: false, viewBudget: false, editDetails: false }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const body = { name, permissions }
      if (isEditing) await api(`/admin/roles/${role!.roleId}`, { method: 'PATCH', body })
      else await api('/admin/roles', { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${isEditing ? 'update' : 'create'} the role`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEditing ? `Edit role · ${role!.name}` : 'New role'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            {isEditing ? 'Save changes' : 'Create role'}
          </Button>
        </>
      }
    >
      {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <Field label="Role name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site Foreman" />
      </Field>

      <div className="section-title">Permissions</div>
      <div className="stack" style={{ gap: 8 }}>
        {PERMISSION_KEYS.map((key) => (
          <label key={key} className="perm-row" style={{ cursor: 'pointer' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{PERMISSION_LABEL[key]}</div>
              <div className="small muted">{PERMISSION_HINT[key]}</div>
            </div>
            <input
              type="checkbox"
              checked={permissions[key]}
              onChange={(e) => setPermissions((prev) => ({ ...prev, [key]: e.target.checked }))}
            />
          </label>
        ))}
      </div>
    </Modal>
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
          Admins can open every project. This list only matters for manager, viewer and custom roles.
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
