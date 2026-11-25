import { randomUUID } from 'node:crypto'
import { env } from './env'
import { T, getItem, putItem, queryAll, scanAll, updateFields } from './db'
import { HttpError } from './lib/http'
import { findUserByEmail } from './auth'
import { SUPER_ADMIN_ROLE } from './roles'
import { DEFAULT_ORG_ID } from './types'
import type { InviteRecord, OrgCounters, OrgLimits, OrgRecord, UserRecord } from './types'

/**
 * Workspaces — the tenant boundary.
 *
 * A workspace is one row in `cppi_orgs`. Every account and project carries its
 * `orgId`, and the org is always taken from the signed-in session, never from
 * the request, so one customer can never reach another's data. Everything that
 * hangs off a project (stages, files, remarks, budget…) inherits isolation
 * through the project itself.
 */

/** The starting product limits every new workspace gets. */
export function defaultOrgLimits(): OrgLimits {
  return {
    docs: env.DEFAULT_ORG_LIMITS_DOCS,
    images: env.DEFAULT_ORG_LIMITS_IMAGES,
    assistantAsks: env.DEFAULT_ORG_LIMITS_ASSISTANT_ASKS,
    period: env.DEFAULT_ORG_LIMITS_PERIOD
  }
}

/** Fresh counters, starting the current limit window. */
export function newOrgCounters(now = new Date().toISOString()): OrgCounters {
  return { docs: 0, images: 0, assistantAsks: 0, periodStartedAt: now }
}

/** A URL-safe slug for a workspace name. */
export function orgSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  )
}

/**
 * Every row in `table` that belongs to `orgId`.
 *
 * Prefers the `orgId-index` GSI. Until `setup-infra` has added that index and
 * `backfill-orgs` has stamped the older rows, the query would fail or return
 * nothing — so it falls back to a scan and treats a missing `orgId` as the
 * default workspace, which keeps single-tenant behaviour unchanged.
 */
export async function queryByOrg<Item>(table: string, orgId: string): Promise<Item[]> {
  try {
    return await queryAll<Item>(table, {
      IndexName: 'orgId-index',
      KeyConditionExpression: 'orgId = :o',
      ExpressionAttributeValues: { ':o': orgId }
    })
  } catch {
    const rows = await scanAll<Item & { orgId?: string }>(table)
    return rows.filter((row) => (row.orgId ?? DEFAULT_ORG_ID) === orgId)
  }
}

export function getOrg(orgId: string): Promise<OrgRecord | undefined> {
  return getItem<OrgRecord>(T.orgs, { orgId })
}

export async function putOrg(org: OrgRecord): Promise<void> {
  await putItem(T.orgs, org)
}

/** Every workspace. A super admin's list; never exposed to an org admin. */
export async function listOrgs(): Promise<OrgRecord[]> {
  const orgs = await scanAll<OrgRecord>(T.orgs)
  return orgs.sort((a, b) => a.name.localeCompare(b.name))
}

/** Create a workspace owned by `ownerUserId`, with the starting limits. */
export async function createOrg(params: {
  name: string
  ownerUserId: string
  orgId?: string
  limits?: OrgLimits
}): Promise<OrgRecord> {
  const now = new Date().toISOString()
  const org: OrgRecord = {
    orgId: params.orgId ?? `org_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    name: params.name,
    slug: orgSlug(params.name),
    ownerUserId: params.ownerUserId,
    status: 'active',
    limits: params.limits ?? defaultOrgLimits(),
    counters: newOrgCounters(now),
    createdAt: now,
    updatedAt: now
  }
  await putOrg(org)
  return org
}

/**
 * Bring a `workspace` invitation's workspace into being and make the invitee its
 * admin. This runs at the moment the invite is accepted — that is the point a
 * workspace starts to exist — and the invitee owns it from the first sign-in.
 */
export function createWorkspaceForInvite(invite: InviteRecord, ownerUserId: string): Promise<OrgRecord> {
  const name = (invite.orgName ?? '').trim() || 'New workspace'
  return createOrg({ name, ownerUserId })
}

/** Make sure the workspace that owns today's data exists. Idempotent. */
export async function ensureBootstrapOrg(): Promise<OrgRecord> {
  const existing = await getOrg(DEFAULT_ORG_ID)
  if (existing) return existing

  const name = env.BOOTSTRAP_ORG_NAME || 'CPPI'
  const now = new Date().toISOString()
  const org: OrgRecord = {
    orgId: DEFAULT_ORG_ID,
    name,
    slug: orgSlug(name),
    // Filled in by ensureSuperAdmins below, from the first super admin found.
    ownerUserId: '',
    status: 'active',
    limits: defaultOrgLimits(),
    counters: newOrgCounters(now),
    createdAt: now,
    updatedAt: now
  }
  await putOrg(org)
  return org
}

/**
 * Create — or promote — the platform super admins named in `SUPER_ADMIN_EMAILS`,
 * and put them in the default workspace so signing in as either one lands in the
 * workspace that holds today's data. Idempotent.
 */
export async function ensureSuperAdmins(): Promise<void> {
  if (env.SUPER_ADMIN_EMAILS.length === 0) return

  const org = await ensureBootstrapOrg()
  const now = new Date().toISOString()
  let owner = org.ownerUserId

  for (const email of env.SUPER_ADMIN_EMAILS) {
    const existing = await findUserByEmail(email)

    if (!existing) {
      const user: UserRecord = {
        userId: randomUUID(),
        orgId: org.orgId,
        email,
        name: email.split('@')[0],
        role: SUPER_ADMIN_ROLE,
        status: 'active',
        siteIds: [],
        createdAt: now
      }
      await putItem(T.users, user)
      if (!owner) owner = user.userId
      continue
    }

    const patch: Partial<UserRecord> = {}
    if (existing.role !== SUPER_ADMIN_ROLE) patch.role = SUPER_ADMIN_ROLE
    if (existing.status !== 'active') patch.status = 'active'
    if ((existing.orgId ?? DEFAULT_ORG_ID) !== org.orgId) patch.orgId = org.orgId
    if (Object.keys(patch).length > 0) {
      await updateFields(T.users, { userId: existing.userId }, patch)
    }
    if (!owner) owner = existing.userId
  }

  if (owner && owner !== org.ownerUserId) {
    await updateFields(T.orgs, { orgId: org.orgId }, { ownerUserId: owner, updatedAt: now })
  }
}

/* ---------------------------- product limits ---------------------------- */

/** The three metered things a workspace uses. */
export type LimitKind = 'docs' | 'images' | 'assistantAsks'

const LIMIT_LABEL: Record<LimitKind, string> = {
  docs: 'document',
  images: 'image',
  assistantAsks: 'Assistant question'
}

/**
 * Counters belong to a window. When the window has rolled over, the counts are
 * zeroed and the window restarts, so a monthly cap refills on the first use of
 * the new month rather than at a fixed midnight nobody watches.
 */
export async function refreshOrgPeriod(org: OrgRecord, now = new Date()): Promise<OrgRecord> {
  if (org.limits.period !== 'monthly') return org
  const started = new Date(org.counters?.periodStartedAt ?? 0)
  const sameMonth =
    started.getUTCFullYear() === now.getUTCFullYear() && started.getUTCMonth() === now.getUTCMonth()
  if (sameMonth) return org
  const counters = newOrgCounters(now.toISOString())
  await updateFields(T.orgs, { orgId: org.orgId }, { counters, updatedAt: now.toISOString() })
  return { ...org, counters }
}

/**
 * Guard one metered action. Returns the workspace so the caller can proceed, or
 * throws a clear, user-facing error when the cap is reached. A workspace with no
 * row yet (a fresh install before bootstrap) is treated as unlimited rather than
 * blocked.
 */
export async function assertWithinLimit(orgId: string, kind: LimitKind, amount = 1): Promise<OrgRecord | undefined> {
  const org = await getOrg(orgId)
  if (!org) return undefined
  const fresh = await refreshOrgPeriod(org)
  const cap = fresh.limits?.[kind] ?? Number.POSITIVE_INFINITY
  const used = fresh.counters?.[kind] ?? 0
  if (used + amount > cap) {
    const window = fresh.limits.period === 'monthly' ? 'each month' : 'in total'
    const unit = amount === 1 ? LIMIT_LABEL[kind] : `${LIMIT_LABEL[kind]}s`
    throw new HttpError(
      429,
      `Your workspace has reached its limit of ${cap} ${unit} ${window}. Contact your provider to raise it.`
    )
  }
  return fresh
}

/** Record usage after the guarded action has succeeded. */
export async function bumpOrgCounter(orgId: string, kind: LimitKind, delta = 1): Promise<void> {
  const org = await getOrg(orgId)
  if (!org) return
  const fresh = await refreshOrgPeriod(org)
  const counters = { ...fresh.counters, [kind]: Math.max(0, (fresh.counters?.[kind] ?? 0) + delta) }
  await updateFields(T.orgs, { orgId }, { counters })
}
