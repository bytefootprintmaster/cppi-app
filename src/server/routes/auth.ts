import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, getItem, putItem, updateFields } from '../db'
import { HttpError, asyncHandler, optStr, str } from '../lib/http'
import {
  applyPendingInvites,
  ensureBootstrapAdmin,
  findPendingInvites,
  findPasswordCredential,
  findUserByEmail,
  requireAuth,
  signSession,
  toSession,
  verifyPassword,
  verifyGoogleCredential
} from '../auth'
import type { InviteRecord, UserRecord } from '../types'

export const authRouter = Router()

/** Public runtime config for the browser (never expose secrets here). */
authRouter.get('/config', (_req, res) => {
  res.json({
    appName: 'CPPI',
    googleClientId: env.GOOGLE_CLIENT_ID,
    appUrl: env.APP_URL,
    passwordLoginEnabled: true
  })
})

/**
 * Exchange a Google ID token for a CPPI session token. New accounts must be
 * explicitly configured as admins or backed by a pending administrator invite.
 */
authRouter.post('/auth/google', asyncHandler(async (req, res) => {
  const credential = str(req.body?.credential, 'credential', 8000)
  const profile = await verifyGoogleCredential(credential)
  const inviteToken = optStr(req.body?.inviteToken, 200)
  const now = new Date().toISOString()

  await ensureBootstrapAdmin()
  let user = await findUserByEmail(profile.email)

  if (!user) {
    let tokenInvite: InviteRecord | undefined
    if (inviteToken) {
      tokenInvite = await getItem<InviteRecord>(T.invites, { token: inviteToken })
      if (
        !tokenInvite ||
        tokenInvite.status !== 'pending' ||
        tokenInvite.expiresAt <= now
      ) {
        throw new HttpError(403, 'This invitation is not valid for account creation')
      }
      if (tokenInvite.email && tokenInvite.email.toLowerCase() !== profile.email) {
        throw new HttpError(403, 'This invitation was issued for a different email address')
      }
    }
    const isAdminEmail =
      env.ADMIN_EMAILS.includes(profile.email) ||
      env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === profile.email
    const invites = await findPendingInvites(profile.email)
    if (!isAdminEmail && invites.length === 0 && !tokenInvite) {
      throw new HttpError(403, 'Your account has not been provisioned. Ask a CPPI administrator for an invitation.')
    }
    user = {
      userId: randomUUID(),
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      role: isAdminEmail ? 'admin' : 'viewer',
      status: 'active',
      siteIds: [],
      createdAt: now
    }
    await putItem(T.users, user)
  } else {
    if (user.status === 'disabled') throw new HttpError(403, 'Your account has been disabled by an administrator')
    await updateFields(T.users, { userId: user.userId }, { name: profile.name, picture: profile.picture })
    user = { ...user, name: profile.name, picture: profile.picture }
  }

  user = await applyPendingInvites(user)
  await updateFields(T.users, { userId: user.userId }, { lastLoginAt: now })

  res.json({ token: signSession(user), user: await toSession(user) })
}))

authRouter.post('/auth/password', asyncHandler(async (req, res) => {
  const email = str(req.body?.email, 'email', 320).toLowerCase()
  const password = str(req.body?.password, 'password', 200)

  await ensureBootstrapAdmin()

  let user = await findUserByEmail(email)
  const credential = await findPasswordCredential(email)
  if (!user || !credential || credential.userId !== user.userId) {
    throw new HttpError(401, 'Invalid email or password')
  }
  if (user.status === 'disabled') {
    throw new HttpError(403, 'Your account has been disabled by an administrator')
  }
  if (!(await verifyPassword(password, credential.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password')
  }

  user = await applyPendingInvites(user)
  const now = new Date().toISOString()
  await updateFields(T.users, { userId: user.userId }, { lastLoginAt: now })

  res.json({ token: signSession(user), user: await toSession(user) })
}))

authRouter.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: req.user })
}))
