import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, deleteItem, getItem, putItem, scanAll, updateFields } from '../db'
import { HttpError, asyncHandler, oneOf, optStr } from '../lib/http'
import { requireAdmin } from '../auth'
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

adminRouter.patch('/users/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params
  const target = await getItem<UserRecord>(T.users, { userId })
  if (!target) throw new HttpError(404, 'User not found')

  const patch: Record<string, unknown> = {}
  if (req.body?.role !== undefined) patch.role = oneOf<Role>(req.body.role, ROLES, 'role')
  if (req.body?.status !== undefined) patch.status = oneOf(req.body.status, STATUSES, 'status')
  if (req.body?.siteIds !== undefined) {
    if (!Array.isArray(req.body.siteIds)) throw new HttpError(400, '"siteIds" must be an array')
    patch.siteIds = req.body.siteIds.filter((s: unknown): s is string => typeof s === 'string')
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update')

  await updateFields(T.users, { userId }, patch)
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
