import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, putItem, scanAll, updateFields } from '../db'
import { HttpError, asyncHandler, str } from '../lib/http'
import {
  applyPendingInvites,
  ensureBootstrapAdmin,
  findPasswordCredential,
  findUserByEmail,
  requireAuth,
  signSession,
  toSession,
  verifyPassword,
  verifyGoogleCredential
} from '../auth'
import type { UserRecord } from '../types'

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
 * Exchange a Google ID token for a CPPI session token.
 * First ever user (or any email listed in ADMIN_EMAILS) becomes an admin.
 */
authRouter.post('/auth/google', asyncHandler(async (req, res) => {
  const credential = str(req.body?.credential, 'credential', 8000)
  const profile = await verifyGoogleCredential(credential)
  const now = new Date().toISOString()

  let user = await findUserByEmail(profile.email)

  if (!user) {
    const existing = await scanAll<UserRecord>(T.users)
    const isFirstUser = existing.length === 0
    const isAdminEmail = env.ADMIN_EMAILS.includes(profile.email)
    user = {
      userId: randomUUID(),
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      role: isFirstUser || isAdminEmail ? 'admin' : 'viewer',
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

  res.json({ token: signSession(user), user: toSession(user) })
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

  res.json({ token: signSession(user), user: toSession(user) })
}))

authRouter.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: req.user })
}))
