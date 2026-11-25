import { Router } from 'express'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, deleteItem, getItem, putItem, scanAll, updateFields } from '../db'
import { HttpError, asyncHandler, oneOf, optStr, str } from '../lib/http'
import { findPasswordCredential, findUserByEmail, requireAdmin, upsertPasswordCredential } from '../auth'
import { orgIdOf } from '../services'
import { queryByOrg } from '../orgs'
import { ADMIN_ROLE, SUPER_ADMIN_ROLE, isBuiltinRole, isSuperAdmin, listRoles } from '../roles'
import type {
  InviteRecord,
  PermissionOverrides,
  Permissions,
  RoleRecord,
  SiteRecord,
  UploadLimits,
  UserRecord
} from '../types'
import { DEFAULT_ORG_ID, PERMISSION_KEYS } from '../types'

export const adminRouter = Router()

const STATUSES = ['active', 'disabled'] as const

adminRouter.use(requireAdmin)

const nowIso = () => new Date().toISOString()

/**
 * A super admin's account is platform-level: an org admin may not see it in a
 * list they can edit, change its role, or delete it. Anything reaching one of
 * those routes is refused here.
 */
function assertNotSuperAdmin(target: UserRecord): void {
  if (target.role === SUPER_ADMIN_ROLE) {
    throw new HttpError(403, 'A super admin account cannot be changed from here')
  }
}

/** Throws unless `target` belongs to the caller's workspace. */
function assertSameOrg(targetOrgId: string | undefined, callerOrgId: string): void {
  if ((targetOrgId ?? DEFAULT_ORG_ID) !== callerOrgId) {
    throw new HttpError(404, 'Not found')
  }
}

/* ---------------------------- shared readers ---------------------------- */

async function requireRoleId(value: unknown): Promise<string> {
  const roleId = str(value, 'role', 60)
  const roles = await listRoles()
  if (!roles.some((role) => role.roleId === roleId)) throw new HttpError(400, `Unknown role: ${roleId}`)
  return roleId
}

/** Omitted grants deny access; downloads default to allowed for new roles. */
function readPermissionBundle(value: unknown): Permissions {
  const src = (value ?? {}) as Record<string, unknown>
  const out: Permissions = {
    uploadFiles: false,
    downloadFiles: true,
    viewBudget: false,
    editDetails: false
  }
  for (const key of PERMISSION_KEYS) {
    const raw = src[key]
    if (raw !== undefined && typeof raw !== 'boolean') {
      throw new HttpError(400, `"permissions.${key}" must be true or false`)
    }
    out[key] = raw === true
  }
  return out
}

/** Per-user overrides. Only keys the admin actually set are stored; the rest inherit. */
function readPermissionOverrides(value: unknown): PermissionOverrides {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') throw new HttpError(400, '"permissions" must be an object')
  const src = value as Record<string, unknown>
  const out: PermissionOverrides = {}
  for (const key of PERMISSION_KEYS) {
    const raw = src[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'boolean') throw new HttpError(400, `"permissions.${key}" must be true or false`)
    out[key] = raw
  }
  return out
}

function readLimits(value: unknown): Partial<UploadLimits> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') throw new HttpError(400, '"limits" must be an object')
  const src = value as Record<string, unknown>
  const out: Partial<UploadLimits> = {}
  for (const key of ['dailyUploads', 'maxFileMb'] as const) {
    const raw = src[key]
    if (raw === undefined || raw === null) continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `"${key}" must be 1 or more`)
    out[key] = Math.round(n)
  }
  return out
}

/**
 * The project grants an org admin may hand out. Only projects inside the
 * caller's own workspace count: handing someone a project from another
 * workspace would cross the tenancy boundary, so any such id is refused rather
 * than silently dropped.
 */
async function readOrgSiteIds(req: Request, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return []
  const requested = value.filter((s): s is string => typeof s === 'string')
  if (requested.length === 0) return []
  const orgSites = await queryByOrg<SiteRecord>(T.sites, orgIdOf(req.user!))
  const allowed = new Set(orgSites.map((site) => site.siteId))
  const foreign = requested.find((id) => !allowed.has(id))
  if (foreign) throw new HttpError(403, 'A project outside your workspace cannot be granted')
  return requested
}

/* ------------------------------- roles ------------------------------- */

adminRouter.get('/roles', asyncHandler(async (_req, res) => {
  res.json({ roles: await listRoles() })
}))

adminRouter.post('/roles', asyncHandler(async (req, res) => {
  const name = str(req.body?.name, 'name', 60)
  const permissions = readPermissionBundle(req.body?.permissions)

  const existing = await listRoles()
  if (existing.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `A role called "${name}" already exists`)
  }

  const ts = nowIso()
  const role: RoleRecord = {
    roleId: `role_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name,
    builtin: false,
    permissions,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.roles, role)
  res.status(201).json({ role })
}))

adminRouter.patch('/roles/:roleId', asyncHandler(async (req, res) => {
  const { roleId } = req.params
  if (isBuiltinRole(roleId)) {
    throw new HttpError(400, 'Built-in roles cannot be edited. Create a custom role instead.')
  }
  const role = await getItem<RoleRecord>(T.roles, { roleId })
  if (!role) throw new HttpError(404, 'Role not found')

  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, 'name', 60)
    const others = (await listRoles()).filter((r) => r.roleId !== roleId)
    if (others.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `A role called "${name}" already exists`)
    }
    patch.name = name
  }
  if (req.body?.permissions !== undefined) patch.permissions = readPermissionBundle(req.body.permissions)

  await updateFields(T.roles, { roleId }, patch)
  res.json({ ok: true, role: { ...role, ...patch } })
}))

adminRouter.delete('/roles/:roleId', asyncHandler(async (req, res) => {
  const { roleId } = req.params
  if (isBuiltinRole(roleId)) throw new HttpError(400, 'Built-in roles cannot be deleted')
  const role = await getItem<RoleRecord>(T.roles, { roleId })
  if (!role) throw new HttpError(404, 'Role not found')

  const users = await queryByOrg<UserRecord>(T.users, orgIdOf(req.user!))
  const inUse = users.filter((u) => u.role === roleId).length
  if (inUse > 0) {
    throw new HttpError(409, `${inUse} user${inUse === 1 ? '' : 's'} still use "${role.name}". Reassign them first.`)
  }

  await deleteItem(T.roles, { roleId })
  res.json({ ok: true })
}))

/* ------------------------------- users ------------------------------- */

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const users = await queryByOrg<UserRecord>(T.users, orgIdOf(req.user!))
  res.json({ users: users.sort((a, b) => a.name.localeCompare(b.name)) })
}))

adminRouter.post('/users', asyncHandler(async (req, res) => {
  const name = str(req.body?.name, 'name', 200)
  const email = str(req.body?.email, 'email', 320).toLowerCase()
  const role = await requireRoleId(req.body?.role)
  const password = str(req.body?.password, 'password', 200)
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')

  const existing = await findUserByEmail(email)
  if (existing) throw new HttpError(409, 'A user with this email already exists')

  const siteIds = await readOrgSiteIds(req, req.body?.siteIds)
  const permissions = readPermissionOverrides(req.body?.permissions)
  const limits = readLimits(req.body?.limits)

  const user: UserRecord = {
    userId: randomUUID(),
    // The new account joins the workspace of the admin who created it.
    orgId: orgIdOf(req.user!),
    email,
    name,
    role,
    status: 'active',
    siteIds: role === ADMIN_ROLE ? [] : siteIds,
    permissions: Object.keys(permissions).length ? permissions : undefined,
    limits: Object.keys(limits).length ? limits : undefined,
    createdAt: nowIso()
  }

  await putItem(T.users, user)
  await upsertPasswordCredential(email, user.userId, password)
  res.status(201).json({ user })
}))

adminRouter.patch('/users/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params
  const target = await getItem<UserRecord>(T.users, { userId })
  if (!target) throw new HttpError(404, 'User not found')
  assertSameOrg(target.orgId, orgIdOf(req.user!))
  assertNotSuperAdmin(target)

  const patch: Record<string, unknown> = {}
  const nextName = req.body?.name !== undefined ? str(req.body.name, 'name', 200) : undefined
  const nextEmail = req.body?.email !== undefined ? str(req.body.email, 'email', 320).toLowerCase() : undefined
  const nextPassword = req.body?.password !== undefined ? str(req.body.password, 'password', 200) : undefined

  if (nextName !== undefined) patch.name = nextName
  if (nextEmail !== undefined) {
    const existing = await findUserByEmail(nextEmail)
    if (existing && existing.userId !== target.userId) {
      throw new HttpError(409, 'A user with this email already exists')
    }
    patch.email = nextEmail
  }
  if (req.body?.role !== undefined) {
    const nextRole = await requireRoleId(req.body.role)
    if (target.role === ADMIN_ROLE && nextRole !== ADMIN_ROLE) {
      throw new HttpError(400, 'The administrator role cannot be changed')
    }
    patch.role = nextRole
  }
  if (req.body?.status !== undefined) patch.status = oneOf(req.body.status, STATUSES, 'status')
  if (req.body?.siteIds !== undefined) {
    if (!Array.isArray(req.body.siteIds)) throw new HttpError(400, '"siteIds" must be an array')
    patch.siteIds = await readOrgSiteIds(req, req.body.siteIds)
  }
  if (req.body?.permissions !== undefined) patch.permissions = readPermissionOverrides(req.body.permissions)
  if (req.body?.limits !== undefined) patch.limits = readLimits(req.body.limits)
  if (nextPassword !== undefined && nextPassword.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters')
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update')

  await updateFields(T.users, { userId }, patch)

  const currentEmail = target.email
  const updatedEmail = (patch.email as string | undefined) ?? currentEmail
  if (updatedEmail !== currentEmail) {
    const existingCredential = await findPasswordCredential(currentEmail)
    if (existingCredential) {
      await putItem(T.credentials, {
        ...existingCredential,
        email: updatedEmail,
        updatedAt: nowIso()
      })
      await deleteItem(T.credentials, { email: currentEmail }).catch(() => undefined)
    }
  }
  if (nextPassword !== undefined) {
    await upsertPasswordCredential(updatedEmail, target.userId, nextPassword)
  }

  res.json({ ok: true })
}))

adminRouter.delete('/users/:userId', asyncHandler(async (req, res) => {
  if (req.user!.userId === req.params.userId) {
    throw new HttpError(400, 'You cannot delete your own account')
  }
  const target = await getItem<UserRecord>(T.users, { userId: req.params.userId })
  if (!target) throw new HttpError(404, 'User not found')
  assertSameOrg(target.orgId, orgIdOf(req.user!))
  assertNotSuperAdmin(target)
  await deleteItem(T.users, { userId: req.params.userId })
  await deleteItem(T.credentials, { email: target.email }).catch(() => undefined)
  res.json({ ok: true })
}))

/* ------------------------------ invites ------------------------------ */

/** The link an invitee follows to join. */
function inviteUrl(token: string): string {
  return `${env.APP_URL.replace(/\/$/, '')}/invite/${token}`
}

/** An invitation's lifetime in days, clamped to 1–90; the default is two weeks. */
function inviteDays(value: unknown): number {
  const days = Number(value ?? 14)
  if (!Number.isFinite(days)) return 14
  return Math.min(Math.max(Math.round(days), 1), 90)
}

adminRouter.get('/invites', asyncHandler(async (req, res) => {
  const invites = await queryByOrg<InviteRecord>(T.invites, orgIdOf(req.user!))
  const withUrls = invites
    // Workspace invitations have their own list: they join nobody to this org.
    .filter((invite) => (invite.kind ?? 'member') !== 'workspace')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((invite) => ({ ...invite, url: inviteUrl(invite.token) }))
  res.json({ invites: withUrls })
}))

adminRouter.post('/invites', asyncHandler(async (req, res) => {
  const role = await requireRoleId(req.body?.role)
  const email = optStr(req.body?.email, 320)?.toLowerCase()
  const note = optStr(req.body?.note, 500)
  const siteIds = await readOrgSiteIds(req, req.body?.siteIds)

  const invite: InviteRecord = {
    token: randomUUID().replace(/-/g, ''),
    kind: 'member',
    email,
    // The invitee joins the workspace of the admin who issued it.
    orgId: orgIdOf(req.user!),
    role,
    siteIds,
    note,
    status: 'pending',
    createdBy: req.user!.userId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + inviteDays(req.body?.expiresInDays) * 86_400_000).toISOString()
  }

  await putItem(T.invites, invite)
  res.json({ invite, url: inviteUrl(invite.token) })
}))

/* ------------------------ workspace invitations ------------------------ */
//
// CPPI has no public sign-up: the only way a new customer comes in is a
// workspace invitation, and only a platform super admin may issue one.
// Accepting it creates the invitee's own workspace with them as its admin, so
// they start from nothing — no projects, no files — and build their own.

/** Refuse the request unless the caller is a platform super admin. */
function requireSuperAdmin(req: Request): void {
  if (!isSuperAdmin(req.user!)) {
    throw new HttpError(403, 'Only a platform super admin can invite a new workspace')
  }
}

adminRouter.get('/workspace-invites', asyncHandler(async (req, res) => {
  requireSuperAdmin(req)
  const invites = await scanAll<InviteRecord>(T.invites)
  const withUrls = invites
    .filter((invite) => invite.kind === 'workspace')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((invite) => ({ ...invite, url: inviteUrl(invite.token) }))
  res.json({ invites: withUrls })
}))

adminRouter.post('/workspace-invites', asyncHandler(async (req, res) => {
  requireSuperAdmin(req)
  const email = optStr(req.body?.email, 320)?.toLowerCase()
  const orgName = str(req.body?.orgName, 'orgName', 200)
  const note = optStr(req.body?.note, 500)

  const invite: InviteRecord = {
    token: randomUUID().replace(/-/g, ''),
    kind: 'workspace',
    email,
    // No workspace yet: it is created when the invite is accepted, and named here.
    orgName,
    // The invitee administers the workspace this invitation brings into being.
    role: ADMIN_ROLE,
    siteIds: [],
    note,
    status: 'pending',
    createdBy: req.user!.userId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + inviteDays(req.body?.expiresInDays) * 86_400_000).toISOString()
  }

  await putItem(T.invites, invite)
  res.json({ invite, url: inviteUrl(invite.token) })
}))

adminRouter.delete('/workspace-invites/:token', asyncHandler(async (req, res) => {
  requireSuperAdmin(req)
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite || invite.kind !== 'workspace') throw new HttpError(404, 'Invite not found')
  await updateFields(T.invites, { token: req.params.token }, { status: 'revoked' })
  res.json({ ok: true })
}))

adminRouter.delete('/invites/:token', asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite || invite.kind === 'workspace') throw new HttpError(404, 'Invite not found')
  assertSameOrg(invite.orgId, orgIdOf(req.user!))
  await updateFields(T.invites, { token: req.params.token }, { status: 'revoked' })
  res.json({ ok: true })
}))

/* ----------------------------- diagnostics ---------------------------- */

adminRouter.get('/overview', asyncHandler(async (req, res) => {
  const orgId = orgIdOf(req.user!)
  const [users, invites] = await Promise.all([
    queryByOrg<UserRecord>(T.users, orgId),
    queryByOrg<InviteRecord>(T.invites, orgId)
  ])
  res.json({
    users: users.length,
    admins: users.filter((u) => u.role === ADMIN_ROLE).length,
    managers: users.filter((u) => u.role === 'manager').length,
    pendingInvites: invites.filter((i) => i.status === 'pending').length,
    config: {
      region: env.AWS_REGION,
      bucket: env.S3_BUCKET,
      googleConfigured: Boolean(env.GOOGLE_CLIENT_ID)
    }
  })
}))
