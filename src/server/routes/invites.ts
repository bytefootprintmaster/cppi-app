import { Router } from 'express'
import { T, getItem, updateFields } from '../db'
import { HttpError, asyncHandler } from '../lib/http'
import { requireAuth } from '../auth'
import type { InviteRecord, Role, UserRecord } from '../types'

export const inviteRouter = Router()

/** Public: show what an invite is for, so the join page can render before sign-in. */
inviteRouter.get('/:token', asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid')
  res.json({
    invite: {
      role: invite.role,
      email: invite.email,
      siteIds: invite.siteIds,
      note: invite.note,
      status: invite.status,
      expired: invite.expiresAt <= new Date().toISOString()
    }
  })
}))

/** Authenticated: accept an invite and merge its role + site access into the account. */
inviteRouter.post('/:token/accept', requireAuth, asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid')
  if (invite.status !== 'pending') throw new HttpError(400, 'This invitation has already been used or revoked')
  if (invite.expiresAt <= new Date().toISOString()) throw new HttpError(400, 'This invitation has expired')
  if (invite.email && invite.email !== req.user!.email) {
    throw new HttpError(403, 'This invitation was issued for a different email address')
  }

  const user = await getItem<UserRecord>(T.users, { userId: req.user!.userId })
  if (!user) throw new HttpError(404, 'User not found')

  const siteIds = new Set(user.siteIds ?? [])
  for (const id of invite.siteIds ?? []) siteIds.add(id)

  let role: Role = user.role
  if (invite.role === 'admin') role = 'admin'
  else if (invite.role === 'contractor' && user.role !== 'admin') role = 'contractor'

  await updateFields(T.users, { userId: user.userId }, { role, siteIds: [...siteIds] })
  await updateFields(T.invites, { token: invite.token }, {
    status: 'accepted',
    acceptedBy: user.userId,
    acceptedAt: new Date().toISOString()
  })

  res.json({ ok: true, role, siteIds: [...siteIds] })
}))
