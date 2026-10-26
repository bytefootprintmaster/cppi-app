import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { env } from './env'
import { T, getItem, putItem, queryAll, updateFields } from './db'
import { HttpError } from './lib/http'
import type { InviteRecord, Role, SessionUser, UserRecord } from './types'

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID)

interface PasswordCredentialRecord {
  email: string
  userId: string
  passwordHash: string
  createdAt: string
  updatedAt: string
}

export interface GoogleProfile {
  sub: string
  email: string
  name: string
  picture: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey as Buffer)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derived = await deriveKey(password, salt)
  return `scrypt$${salt}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [scheme, salt, expectedHex] = passwordHash.split('$')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = await deriveKey(password, salt)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Verify a Google ID token (from Google Identity Services) and return its profile. */
export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new HttpError(500, 'GOOGLE_CLIENT_ID is not configured on the server')
  }
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: env.GOOGLE_CLIENT_ID
  })
  const payload = ticket.getPayload()
  if (!payload?.email) throw new HttpError(401, 'Google account did not return an email address')
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || payload.email,
    picture: payload.picture || ''
  }
}

export function toSession(user: UserRecord): SessionUser {
  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    siteIds: user.siteIds ?? []
  }
}

export function signSession(user: UserRecord): string {
  return jwt.sign({ sub: user.userId, role: user.role }, env.JWT_SECRET, { expiresIn: '30d' })
}

export async function findUserByEmail(email: string): Promise<UserRecord | undefined> {
  const rows = await queryAll<UserRecord>(T.users, {
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': normalizeEmail(email) }
  })
  return rows[0]
}

export async function findPasswordCredential(email: string): Promise<PasswordCredentialRecord | undefined> {
  return getItem<PasswordCredentialRecord>(T.credentials, { email: normalizeEmail(email) })
}

export async function upsertPasswordCredential(email: string, userId: string, password: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email)
  const now = new Date().toISOString()
  const existing = await findPasswordCredential(normalizedEmail)
  await putItem(T.credentials, {
    email: normalizedEmail,
    userId,
    passwordHash: await hashPassword(password),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
}

export async function loadUser(userId: string): Promise<UserRecord | undefined> {
  return getItem<UserRecord>(T.users, { userId })
}

export async function ensureBootstrapAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL
  const password = env.BOOTSTRAP_ADMIN_PASSWORD
  if (!email || !password) return

  const now = new Date().toISOString()
  let user = await findUserByEmail(email)

  if (!user) {
    user = {
      userId: randomUUID(),
      email,
      name: env.BOOTSTRAP_ADMIN_NAME || email,
      role: 'admin',
      status: 'active',
      siteIds: [],
      createdAt: now
    }
    await putItem(T.users, user)
  } else {
    const patch: Partial<UserRecord> = {}
    if (user.role !== 'admin') patch.role = 'admin'
    if (user.status !== 'active') patch.status = 'active'
    if (!user.name && env.BOOTSTRAP_ADMIN_NAME) patch.name = env.BOOTSTRAP_ADMIN_NAME
    if (Object.keys(patch).length > 0) {
      await updateFields(T.users, { userId: user.userId }, patch)
      user = { ...user, ...patch }
    }
  }

  const credential = await findPasswordCredential(email)
  if (!credential || credential.userId !== user.userId || !(await verifyPassword(password, credential.passwordHash))) {
    await upsertPasswordCredential(email, user.userId, password)
  }
}

/** Pending, non-expired invites addressed to this email address. */
export async function findPendingInvites(email: string): Promise<InviteRecord[]> {
  const rows = await queryAll<InviteRecord>(T.invites, {
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email.toLowerCase() }
  })
  const now = new Date().toISOString()
  return rows.filter((i) => i.status === 'pending' && i.expiresAt > now)
}

/** Merge every pending invite for this address into the user record (role + site access). */
export async function applyPendingInvites(user: UserRecord): Promise<UserRecord> {
  const invites = await findPendingInvites(user.email)
  if (invites.length === 0) return user

  const siteIds = new Set(user.siteIds ?? [])
  let role: Role = user.role
  for (const invite of invites) {
    if (invite.role === 'admin') role = 'admin'
    else if (invite.role === 'contractor' && role !== 'admin') role = 'contractor'
    for (const id of invite.siteIds ?? []) siteIds.add(id)
  }

  const next: UserRecord = { ...user, role, siteIds: [...siteIds] }
  await updateFields(T.users, { userId: user.userId }, { role: next.role, siteIds: next.siteIds })

  const now = new Date().toISOString()
  for (const invite of invites) {
    await updateFields(T.invites, { token: invite.token }, {
      status: 'accepted',
      acceptedBy: user.userId,
      acceptedAt: now
    })
  }
  return next
}

/** Populates req.user when a valid Bearer token is present (never rejects). */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (token) {
      const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string }
      const user = await loadUser(payload.sub)
      if (user && user.status !== 'disabled') req.user = toSession(user)
    }
  } catch {
    /* invalid or expired token -> stay anonymous */
  }
  next()
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Authentication required')
  next()
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Authentication required')
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admin access required')
  next()
}
