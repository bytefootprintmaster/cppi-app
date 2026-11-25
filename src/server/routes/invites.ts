import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { T, getItem, putItem, updateFields } from '../db'
import { HttpError, asyncHandler, optStr, str } from '../lib/http'
import {
  findUserByEmail,
  requireAuth,
  signSession,
  toSession,
  upsertPasswordCredential
} from '../auth'
import { ADMIN_ROLE } from '../roles'
import { createWorkspaceForInvite } from '../orgs'
import { DEFAULT_ORG_ID } from '../types'
import type { InviteRecord, Role, UserRecord } from '../types'

export const inviteRouter = Router()

/** How an existing account's role reacts to an invite. Admin wins outright. */
function mergeRole(current: Role, invited: Role): Role {
  if (invited === ADMIN_ROLE) return ADMIN_ROLE
  if (current === ADMIN_ROLE) return ADMIN_ROLE
  if (current === 'viewer' && invited !== 'viewer') return invited
  return current
}

/**
 * Work out what an invitation does to an account.
 *
 * A `workspace` invitation founds a new workspace — this is the moment it comes
 * into being — and makes the invitee its admin. A `member` invitation merges a
 * role and project access into the workspace it names. Returns only the fields
 * that change, so the caller can either build a new account around them or patch
 * an existing one.
 */
async function inviteEffect(
  invite: InviteRecord,
  user: UserRecord,
  name?: string
): Promise<Partial<UserRecord>> {
  if (invite.kind === 'workspace') {
    const org = await createWorkspaceForInvite(invite, user.userId)
    return { orgId: org.orgId, role: ADMIN_ROLE, name }
  }

  const siteIds = new Set(user.siteIds ?? [])
  for (const id of invite.siteIds ?? []) siteIds.add(id)
  return {
    // The invite names the workspace being joined, when it names one at all.
    ...(invite.orgId ? { orgId: invite.orgId } : {}),
    role: mergeRole(user.role, invite.role),
    siteIds: [...siteIds],
    name
  }
}

/** Public: show what an invite is for, so the join page can render before sign-in. */
inviteRouter.get('/:token', asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid')
  res.json({
    invite: {
      kind: invite.kind ?? 'member',
      orgName: invite.orgName,
      role: invite.role,
      email: invite.email,
      siteIds: invite.siteIds,
      note: invite.note,
      status: invite.status,
      expired: invite.expiresAt <= new Date().toISOString()
    }
  })
}))

/**
 * Public: claim an invitation by choosing a password.
 *
 * This is the only way into CPPI that does not need Google, and it is what the
 * "site inspector" flow depends on — the worker receives a link by email, picks
 * a name and a password, and is signed in straight away. The account is created
 * here with the invite's role and projects, so it is scoped correctly from its
 * very first request.
 */
inviteRouter.post('/:token/register', asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid')
  if (invite.status !== 'pending') {
    throw new HttpError(400, 'This invitation has already been used or revoked')
  }
  if (invite.expiresAt <= new Date().toISOString()) {
    throw new HttpError(400, 'This invitation has expired')
  }

  const email = str(req.body?.email, 'email', 320).toLowerCase()
  const name = str(req.body?.name, 'name', 200)
  const password = str(req.body?.password, 'password', 200)
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
  if (invite.email && invite.email.toLowerCase() !== email) {
    throw new HttpError(403, 'This invitation was issued for a different email address')
  }

  const now = new Date().toISOString()
  let user = await findUserByEmail(email)
  if (user && user.status === 'disabled') {
    throw new HttpError(403, 'This account has been disabled by an administrator')
  }

  if (!user) {
    user = {
      userId: randomUUID(),
      // Replaced below when the invite founds or names a workspace.
      orgId: DEFAULT_ORG_ID,
      email,
      name,
      role: invite.role,
      status: 'active',
      siteIds: [],
      createdAt: now
    }
    Object.assign(user, await inviteEffect(invite, user, name), { lastLoginAt: now })
    await putItem(T.users, user)
  } else {
    // The name typed on the claim form is what the project records show.
    const patch = { ...(await inviteEffect(invite, user, name)), lastLoginAt: now }
    await updateFields(T.users, { userId: user.userId }, patch)
    user = { ...user, ...patch }
  }

  await upsertPasswordCredential(email, user.userId, password)
  await updateFields(T.invites, { token: invite.token }, {
    status: 'accepted',
    acceptedBy: user.userId,
    acceptedAt: now
  })

  res.json({ token: signSession(user), user: await toSession(user) })
}))

/** Authenticated: accept an invite and merge its role + site access into the account. */
inviteRouter.post('/:token/accept', requireAuth, asyncHandler(async (req, res) => {
  const invite = await getItem<InviteRecord>(T.invites, { token: req.params.token })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid')
  // Google sign-in may already have applied a pending invite to this same user.
  if (invite.status === 'accepted' && invite.acceptedBy === req.user!.userId) {
    res.json({ ok: true, role: req.user!.role, siteIds: req.user!.siteIds })
    return
  }
  if (invite.status !== 'pending') throw new HttpError(400, 'This invitation has already been used or revoked')
  if (invite.expiresAt <= new Date().toISOString()) throw new HttpError(400, 'This invitation has expired')
  if (invite.email && invite.email !== req.user!.email) {
    throw new HttpError(403, 'This invitation was issued for a different email address')
  }

  const user = await getItem<UserRecord>(T.users, { userId: req.user!.userId })
  if (!user) throw new HttpError(404, 'User not found')

  const patch = await inviteEffect(invite, user)

  await updateFields(T.users, { userId: user.userId }, patch)
  await updateFields(T.invites, { token: invite.token }, {
    status: 'accepted',
    acceptedBy: user.userId,
    acceptedAt: new Date().toISOString()
  })

  const next = { ...user, ...patch }
  res.json({ ok: true, role: next.role, siteIds: next.siteIds })
}))
