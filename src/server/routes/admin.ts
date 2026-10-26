import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, deleteItem, getItem, putItem, scanAll, updateFields } from '../db'
import { HttpError, asyncHandler, oneOf, optStr, str } from '../lib/http'
import { findPasswordCredential, findUserByEmail, requireAdmin, upsertPasswordCredential } from '../auth'
import type { InviteRecord, Role, UserRecord } from '../types'

export const adminRouter = Router()

const ROLES = ['admin', 'contractor', 'viewer'] as const
const STATUSES = ['active', 'disabled'] as const

adminRouter.use(requireAdmin)

/* ------------------------------- users ------------------------------- */

adminRouter.get('/users', asyncHandler(async (_req, res) => {
  const users = await scanAll<UserRecord>(T.users)
  res.json({ users: users.sort((a, b) => a.name.localeCompare(b.name)) })
}))

adminRouter.post('/users', asyncHandler(async (req, res) => {
  const name = str(req.body?.name, 'name', 200)
  const email = str(req.body?.email, 'email', 320).toLowerCase()
  const role = oneOf<Role>(req.body?.role, ROLES, 'role')
  const password = str(req.body?.password, 'password', 200)
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')

  const existing = await findUserByEmail(email)
  if (existing) throw new HttpError(409, 'A user with this email already exists')

  const siteIds = Array.isArray(req.body?.siteIds)
    ? req.body.siteIds.filter((s: unknown): s is string => typeof s === 'string')
    : []

  const user: UserRecord = {
    userId: randomUUID(),
    email,
    name,
    role,
    status: 'active',
    siteIds: role === 'admin' ? [] : siteIds,
    createdAt: new Date().toISOString()
  }

  await putItem(T.users, user)
  await upsertPasswordCredential(email, user.userId, password)
  res.status(201).json({ user })
}))

adminRouter.patch('/users/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params
  const target = await getItem<UserRecord>(T.users, { userId })
  if (!target) throw new HttpError(404, 'User not found')

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
    const nextRole = oneOf<Role>(req.body.role, ROLES, 'role')
    if (target.role === 'admin' && nextRole !== 'admin') {
      throw new HttpError(400, 'Admin user roles cannot be changed')
    }
    patch.role = nextRole
  }
  if (req.body?.status !== undefined) patch.status = oneOf(req.body.status, STATUSES, 'status')
  if (req.body?.siteIds !== undefined) {
    if (!Array.isArray(req.body.siteIds)) throw new HttpError(400, '"siteIds" must be an array')
    patch.siteIds = req.body.siteIds.filter((s: unknown): s is string => typeof s === 'string')
  }
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
        updatedAt: new Date().toISOString()
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
  await deleteItem(T.users, { userId: req.params.userId })
  await deleteItem(T.credentials, { email: target.email }).catch(() => undefined)
  res.json({ ok: true })
}))

/* ------------------------------ invites ------------------------------ */

adminRouter.get('/invites', asyncHandler(async (_req, res) => {
  const invites = await scanAll<InviteRecord>(T.invites)
  const withUrls = invites
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((invite) => ({ ...invite, url: `${env.APP_URL.replace(/\/$/, '')}/invite/${invite.token}` }))
  res.json({ invites: withUrls })
}))

adminRouter.post('/invites', asyncHandler(async (req, res) => {
  const role = oneOf<Role>(req.body?.role, ROLES, 'role')
  const email = optStr(req.body?.email, 320)?.toLowerCase()
  const note = optStr(req.body?.note, 500)
  const siteIds = Array.isArray(req.body?.siteIds)
    ? req.body.siteIds.filter((s: unknown): s is string => typeof s === 'string')
    : []
  const days = Number(req.body?.expiresInDays ?? 14)

  const invite: InviteRecord = {
    token: randomUUID().replace(/-/g, ''),
    email,
    role,
    siteIds,
    note,
    status: 'pending',
    createdBy: req.user!.userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.min(Math.max(days, 1), 90) * 86_400_000).toISOString()
  }

  await putItem(T.invites, invite)
  res.json({ invite, url: `${env.APP_URL.replace(/\/$/, '')}/invite/${invite.token}` })
}))

adminRouter.delete('/invites/:token', asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'Invite not found')
  await updateFields(T.invites, { token: req.params.token }, { status: 'revoked' })
  res.json({ ok: true })
}))

/* ----------------------------- diagnostics ---------------------------- */

adminRouter.get('/overview', asyncHandler(async (_req, res) => {
  const [users, invites] = await Promise.all([
    scanAll<UserRecord>(T.users),
    scanAll<InviteRecord>(T.invites)
  ])
  res.json({
    users: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    contractors: users.filter((u) => u.role === 'contractor').length,
    pendingInvites: invites.filter((i) => i.status === 'pending').length,
    config: {
      region: env.AWS_REGION,
      bucket: env.S3_BUCKET,
      googleConfigured: Boolean(env.GOOGLE_CLIENT_ID)
    }
  })
}))
