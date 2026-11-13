import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { T, deleteItem, getItem, putItem, queryAll, updateFields } from '../db'
import { HttpError, asyncHandler, oneOf, optStr, str } from '../lib/http'
import { requireAdmin, requirePermission } from '../auth'
import {
  accessibleSites,
  canDo,
  canWrite,
  computeBudget,
  computeProgress,
  isAdmin,
  listBudget,
  listBudgetCategories,
  listMilestones,
  listStages,
  requireSiteAccess
} from '../services'
import { applyStandardFramework } from '../framework'
import { geocodeAddress } from '../geocode'
import { assertUploadAllowed } from '../limits'
import { buildObjectKey, deleteObject, presignDownload, presignUpload } from '../s3'
import type {
  AssetCategory,
  AssetFolderRecord,
  AssetRecord,
  AssetType,
  BudgetCategoryRecord,
  BudgetGroup,
  BudgetLineRecord,
  DocumentIntelligenceRecord,
  EvidenceClass,
  FindingRecord,
  FindingStatus,
  MilestoneRecord,
  RelationshipRecord,
  RemarkRecord,
  SiteRecord,
  StageRecord
} from '../types'

export const siteRouter = Router()

const SITE_STATUS = ['planning', 'in_progress', 'on_hold', 'completed'] as const
const STAGE_STATUS = ['not_started', 'in_progress', 'completed', 'blocked'] as const
const MILESTONE_STATUS = ['pending', 'in_progress', 'completed'] as const
const ASSET_TYPES = ['image', 'document'] as const
const ASSET_CATEGORIES = ['progress', 'plan', 'permit', 'invoice', 'other'] as const
const BUDGET_GROUPS = ['land', 'soft', 'hard'] as const

const nowIso = () => new Date().toISOString()

/** Budget amounts are money: two decimals, never negative. */
function money(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, `"${field}" must be a number of 0 or more`)
  }
  return Math.round(n * 100) / 100
}

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 40

/**
 * Clean a caller-supplied tag list: trim, collapse inner whitespace, drop blanks
 * and case-insensitive duplicates, and refuse anything oversized. Returning the
 * same set for "Survey" and "survey" keeps the filter list free of near-dupes.
 */
function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, '"tags" must be a list of strings')
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new HttpError(400, 'Each tag must be text')
    const tag = raw.trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH) {
      throw new HttpError(400, `Tags must be ${MAX_TAG_LENGTH} characters or fewer`)
    }
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  if (tags.length > MAX_TAGS) throw new HttpError(400, `A file can have at most ${MAX_TAGS} tags`)
  return tags
}

function listFolders(siteId: string): Promise<AssetFolderRecord[]> {
  return queryAll<AssetFolderRecord>(T.folders, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': siteId }
  })
}

/**
 * The structured address parts, in the order they read in a one-line label.
 * A project's `location` is derived from these so every list and the map pin
 * agree, with the city acting as the fallback when no street address is known.
 */
const ADDRESS_FIELDS = ['address', 'city', 'region', 'postalCode', 'country'] as const
type AddressField = (typeof ADDRESS_FIELDS)[number]
const ADDRESS_LIMIT: Record<AddressField, number> = {
  address: 240,
  city: 120,
  region: 120,
  postalCode: 24,
  country: 120
}

/** An address part. Unlike `optStr`, an empty value is kept so a field can be cleared. */
function optText(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new HttpError(400, 'Expected a string')
  const v = value.trim()
  if (v.length > max) throw new HttpError(400, 'Value is too long')
  return v
}

/** Latitude/longitude are optional; when supplied they must be in range. */
function coord(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `"${field}" must be a number between ${min} and ${max}`)
  }
  return n
}

type AddressLike = Pick<SiteRecord, AddressField | 'location'>

/** The one-line place shown in lists and popups, built from the address parts. */
function addressLabel(site: AddressLike): string | undefined {
  const parts = ADDRESS_FIELDS.map((field) => (site[field] ?? '').trim()).filter((v) => v !== '')
  if (parts.length) return parts.join(', ')
  return site.location?.trim() || undefined
}

/**
 * What to hand the geocoder. A full street address is preferred; when only a
 * city is known the lookup narrows to it (plus region/country) so a GIS pin can
 * still be placed — the city is the fallback, never the primary.
 */
function geocodeQuery(site: AddressLike): string | undefined {
  const street = (site.address ?? '').trim()
  if (street) {
    return [street, site.city, site.region, site.postalCode, site.country]
      .map((v) => (v ?? '').trim())
      .filter((v) => v !== '')
      .join(', ')
  }
  const city = (site.city ?? '').trim()
  if (city) {
    return [city, site.region, site.country]
      .map((v) => (v ?? '').trim())
      .filter((v) => v !== '')
      .join(', ')
  }
  return site.location?.trim() || undefined
}

function sitePatchFrom(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body?.name !== undefined) patch.name = str(body.name, 'name', 160)
  if (body?.code !== undefined) patch.code = optStr(body.code, 40)
  if (body?.description !== undefined) patch.description = optStr(body.description, 4000)
  if (body?.status !== undefined) patch.status = oneOf(body.status, SITE_STATUS, 'status')
  if (body?.startDate !== undefined) patch.startDate = optStr(body.startDate, 30)
  if (body?.targetDate !== undefined) patch.targetDate = optStr(body.targetDate, 30)
  for (const field of ADDRESS_FIELDS) {
    if (body?.[field] !== undefined) patch[field] = optText(body[field], ADDRESS_LIMIT[field])
  }
  return patch
}

/**
 * Resolve a site's address to coordinates and persist the result. The query is
 * the full street address when known and the city otherwise. Best-effort by
 * design: an address the geocoder cannot find clears the pin (so a stale one
 * from a previous address never lingers) rather than failing the save.
 */
async function locateSite(site: SiteRecord): Promise<SiteRecord> {
  const query = geocodeQuery(site)
  const geocodedAt = nowIso()
  const hit = query ? await geocodeAddress(query) : null
  await updateFields(T.sites, { siteId: site.siteId }, {
    lat: hit?.lat ?? null,
    lng: hit?.lng ?? null,
    geocodeLabel: hit?.label ?? null,
    geoSource: 'geocode',
    geocodedAt
  })
  return {
    ...site,
    lat: hit?.lat,
    lng: hit?.lng,
    geocodeLabel: hit?.label,
    geoSource: 'geocode',
    geocodedAt
  }
}

/* ------------------------------- sites ------------------------------- */

siteRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ sites: await accessibleSites(req.user!) })
}))

siteRouter.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const ts = nowIso()
  const body = (req.body ?? {}) as Record<string, unknown>
  const lat = coord(body.lat, 'lat', -90, 90)
  const lng = coord(body.lng, 'lng', -180, 180)
  const site: SiteRecord = {
    siteId: randomUUID(),
    name: str(body.name, 'name', 160),
    code: optStr(body.code, 40),
    description: optStr(body.description, 4000),
    address: optStr(body.address, 240),
    city: optStr(body.city, 120),
    region: optStr(body.region, 120),
    postalCode: optStr(body.postalCode, 24),
    country: optStr(body.country, 120),
    location: optStr(body.location, 240),
    status: body.status ? oneOf(body.status, SITE_STATUS, 'status') : 'planning',
    startDate: optStr(body.startDate, 30),
    targetDate: optStr(body.targetDate, 30),
    createdBy: req.user!.userId,
    createdAt: ts,
    updatedAt: ts
  }
  // The one-line label always mirrors the structured address.
  site.location = addressLabel(site)
  // A hand-entered coordinate is authoritative and skips the geocoder.
  const manual = typeof lat === 'number' && typeof lng === 'number'
  if (manual) {
    site.lat = lat
    site.lng = lng
    site.geoSource = 'manual'
    site.geocodedAt = ts
  }
  await putItem(T.sites, site)
  // Every project starts on the standard development framework; admins can edit
  // the seeded stages and milestones afterwards.
  await applyStandardFramework(site.siteId)
  const located = manual ? site : await locateSite(site)
  res.json({ site: located })
}))

/** Admin: locate every project that has no coordinates yet (one request/second). */
siteRouter.post('/geocode-missing', requireAdmin, asyncHandler(async (req, res) => {
  const sites = await accessibleSites(req.user!)
  const missing = sites.filter(
    (s) => geocodeQuery(s) && (typeof s.lat !== 'number' || typeof s.lng !== 'number')
  )

  let located = 0
  let failed = 0
  for (const site of missing) {
    const updated = await locateSite(site)
    if (typeof updated.lat === 'number' && typeof updated.lng === 'number') located += 1
    else failed += 1
  }
  res.json({ located, failed, considered: missing.length })
}))

siteRouter.get('/:siteId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const [stages, milestones] = await Promise.all([listStages(site.siteId), listMilestones(site.siteId)])
  // The budget only travels to users who may see it; everyone else gets the
  // project details without any cost figures attached.
  if (!canDo(req.user!, 'viewBudget')) {
    res.json({ site, stages, milestones, progress: computeProgress(stages, milestones) })
    return
  }
  const [budgetLines, budgetCategories] = await Promise.all([
    listBudget(site.siteId),
    listBudgetCategories(site.siteId)
  ])
  res.json({
    site,
    stages,
    milestones,
    progress: computeProgress(stages, milestones),
    budgetLines,
    budgetCategories,
    budget: computeBudget(budgetLines)
  })
}))

siteRouter.patch('/:siteId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const patch = sitePatchFrom(body)
  const lat = coord(body.lat, 'lat', -90, 90)
  const lng = coord(body.lng, 'lng', -180, 180)
  const manual = typeof lat === 'number' && typeof lng === 'number'

  if (manual) {
    patch.lat = lat
    patch.lng = lng
    patch.geoSource = 'manual'
    patch.geocodedAt = nowIso()
  }
  // Keep the one-line label in step with the structured address.
  const merged = { ...site, ...patch } as SiteRecord
  merged.location = addressLabel(merged)
  patch.location = merged.location

  await updateFields(T.sites, { siteId: site.siteId }, patch)

  // A hand-entered coordinate stands; otherwise a changed address re-resolves
  // the pin so the map follows the record.
  let updated: SiteRecord = merged
  const addressChanged =
    ADDRESS_FIELDS.some((field) => body[field] !== undefined) || body.location !== undefined
  if (!manual && addressChanged) {
    updated = await locateSite(updated)
  }
  res.json({ ok: true, site: updated })
}))

/** Admin: re-resolve one project's address (e.g. after fixing a typo). */
siteRouter.post('/:siteId/geocode', requireAdmin, asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const query = geocodeQuery(site)
  if (!query) throw new HttpError(400, 'This project has no address to look up')

  const located = await locateSite(site)
  if (typeof located.lat !== 'number' || typeof located.lng !== 'number') {
    throw new HttpError(422, `Could not find "${query}" on the map`)
  }
  res.json({ site: located })
}))

siteRouter.delete('/:siteId', requireAdmin, asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)

  const assets = await queryAll<AssetRecord>(T.assets, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': site.siteId }
  })
  await Promise.all(
    assets.map((a) => deleteObject(a.s3Key).catch(() => undefined))
  )

  const children: Array<[string, string]> = [
    [T.stages, 'stageId'],
    [T.milestones, 'milestoneId'],
    [T.folders, 'folderId'],
    [T.assets, 'assetId'],
    [T.remarks, 'remarkId'],
    [T.budget, 'lineId'],
    [T.budgetCategories, 'categoryId']
  ]
  for (const [table, sortKey] of children) {
    const rows = await queryAll<Record<string, unknown>>(table, {
      KeyConditionExpression: 'siteId = :s',
      ExpressionAttributeValues: { ':s': site.siteId }
    })
    await Promise.all(rows.map((row) => deleteItem(table, { siteId: site.siteId, [sortKey]: row[sortKey] })))
  }

  await deleteItem(T.sites, { siteId: site.siteId })
  res.json({ ok: true })
}))

/* ------------------------------ framework ---------------------------- */

/**
 * Re-apply the standard development framework, adding only the stages the
 * project does not already have. Never touches existing stages or milestones.
 */
siteRouter.post('/:siteId/framework', requireAdmin, asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const result = await applyStandardFramework(site.siteId)
  const [stages, milestones] = await Promise.all([listStages(site.siteId), listMilestones(site.siteId)])
  res.json({ ...result, stages, milestones })
}))

/* ------------------------------ stages ------------------------------- */

siteRouter.get('/:siteId/stages', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  res.json({ stages: await listStages(req.params.siteId) })
}))

siteRouter.post('/:siteId/stages', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const existing = await listStages(site.siteId)
  const ts = nowIso()
  const stage: StageRecord = {
    siteId: site.siteId,
    stageId: randomUUID(),
    name: str(body.name, 'name', 160),
    description: optStr(body.description, 2000),
    order: body.order !== undefined ? Number(body.order) : existing.length,
    status: body.status ? oneOf(body.status, STAGE_STATUS, 'status') : 'not_started',
    startDate: optStr(body.startDate, 30),
    endDate: optStr(body.endDate, 30),
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.stages, stage)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: ts })
  res.json({ stage })
}))

siteRouter.patch('/:siteId/stages/:stageId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const stage = await getItem<StageRecord>(T.stages, { siteId: site.siteId, stageId: req.params.stageId })
  if (!stage) throw new HttpError(404, 'Stage not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body.name !== undefined) patch.name = str(body.name, 'name', 160)
  if (body.description !== undefined) patch.description = optStr(body.description, 2000)
  if (body.order !== undefined) patch.order = Number(body.order)
  if (body.status !== undefined) patch.status = oneOf(body.status, STAGE_STATUS, 'status')
  if (body.startDate !== undefined) patch.startDate = optStr(body.startDate, 30)
  if (body.endDate !== undefined) patch.endDate = optStr(body.endDate, 30)

  await updateFields(T.stages, { siteId: site.siteId, stageId: stage.stageId }, patch)
  res.json({ ok: true })
}))

siteRouter.delete('/:siteId/stages/:stageId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const stage = await getItem<StageRecord>(T.stages, { siteId: site.siteId, stageId: req.params.stageId })
  if (!stage) throw new HttpError(404, 'Stage not found')

  const milestones = await listMilestones(site.siteId)
  await Promise.all(
    milestones
      .filter((m) => m.stageId === stage.stageId)
      .map((m) => deleteItem(T.milestones, { siteId: site.siteId, milestoneId: m.milestoneId }))
  )
  await deleteItem(T.stages, { siteId: site.siteId, stageId: stage.stageId })
  res.json({ ok: true })
}))

/* ----------------------------- milestones ---------------------------- */

siteRouter.get('/:siteId/milestones', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  res.json({ milestones: await listMilestones(req.params.siteId) })
}))

siteRouter.post('/:siteId/milestones', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const existing = await listMilestones(site.siteId)
  const ts = nowIso()
  const milestone: MilestoneRecord = {
    siteId: site.siteId,
    milestoneId: randomUUID(),
    stageId: str(body.stageId, 'stageId', 60),
    name: str(body.name, 'name', 160),
    description: optStr(body.description, 2000),
    dueDate: optStr(body.dueDate, 30),
    status: body.status ? oneOf(body.status, MILESTONE_STATUS, 'status') : 'pending',
    order: body.order !== undefined ? Number(body.order) : existing.length,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.milestones, milestone)
  res.json({ milestone })
}))

siteRouter.patch('/:siteId/milestones/:milestoneId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const milestone = await getItem<MilestoneRecord>(T.milestones, {
    siteId: site.siteId,
    milestoneId: req.params.milestoneId
  })
  if (!milestone) throw new HttpError(404, 'Milestone not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body.name !== undefined) patch.name = str(body.name, 'name', 160)
  if (body.description !== undefined) patch.description = optStr(body.description, 2000)
  if (body.dueDate !== undefined) patch.dueDate = optStr(body.dueDate, 30)
  if (body.stageId !== undefined) patch.stageId = str(body.stageId, 'stageId', 60)
  if (body.order !== undefined) patch.order = Number(body.order)
  if (body.status !== undefined) {
    const status = oneOf(body.status, MILESTONE_STATUS, 'status')
    patch.status = status
    patch.completedAt = status === 'completed' ? nowIso() : undefined
  }

  await updateFields(T.milestones, { siteId: site.siteId, milestoneId: milestone.milestoneId }, patch)
  res.json({ ok: true })
}))

siteRouter.delete('/:siteId/milestones/:milestoneId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const milestone = await getItem<MilestoneRecord>(T.milestones, {
    siteId: site.siteId,
    milestoneId: req.params.milestoneId
  })
  if (!milestone) throw new HttpError(404, 'Milestone not found')
  await deleteItem(T.milestones, { siteId: site.siteId, milestoneId: milestone.milestoneId })
  res.json({ ok: true })
}))

/* ------------------------------- budget ------------------------------- */

/**
 * A line may only point at a category in its own project *and* cost group, so
 * every write resolves the id here rather than trusting what the client sent.
 * An empty id means "leave it uncategorised".
 */
async function requireCategory(siteId: string, group: BudgetGroup, raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new HttpError(400, '"categoryId" must be a string')
  const category = await getItem<BudgetCategoryRecord>(T.budgetCategories, { siteId, categoryId: raw })
  if (!category) throw new HttpError(400, 'That budget category no longer exists')
  if (category.group !== group) throw new HttpError(400, 'The category belongs to a different cost group')
  return category.categoryId
}

function orderValue(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Amounts are optional in a body and default to zero. */
function amount(value: unknown, field: string): number {
  return value === undefined || value === null || value === '' ? 0 : money(value, field)
}

siteRouter.get('/:siteId/budget', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const [lines, categories] = await Promise.all([
    listBudget(site.siteId),
    listBudgetCategories(site.siteId)
  ])
  res.json({ lines, categories, summary: computeBudget(lines) })
}))

/* -------------------------- budget categories -------------------------- */

siteRouter.post('/:siteId/budget/categories', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const group = oneOf<BudgetGroup>(body.group, BUDGET_GROUPS, 'group')
  const name = str(body.name, 'name', 120)
  const existing = await listBudgetCategories(site.siteId)
  if (existing.some((c) => c.group === group && c.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `A ${group} category called "${name}" already exists`)
  }

  const ts = nowIso()
  const category: BudgetCategoryRecord = {
    siteId: site.siteId,
    categoryId: randomUUID(),
    group,
    name,
    description: optStr(body.description, 500),
    order:
      body.order !== undefined
        ? orderValue(body.order, existing.filter((c) => c.group === group).length)
        : existing.filter((c) => c.group === group).length,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.budgetCategories, category)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: ts })
  res.json({ category })
}))

siteRouter.post('/:siteId/budget/categories/reorder', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const items = Array.isArray(body.items) ? (body.items as unknown[]) : []
  const owned = new Set((await listBudgetCategories(site.siteId)).map((c) => c.categoryId))
  const ts = nowIso()
  for (const item of items) {
    const row = (item ?? {}) as Record<string, unknown>
    if (typeof row.categoryId !== 'string' || !owned.has(row.categoryId)) continue
    await updateFields(
      T.budgetCategories,
      { siteId: site.siteId, categoryId: row.categoryId },
      { order: orderValue(row.order, 0), updatedAt: ts }
    )
  }
  res.json({ ok: true })
}))

siteRouter.patch('/:siteId/budget/categories/:categoryId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const category = await getItem<BudgetCategoryRecord>(T.budgetCategories, {
    siteId: site.siteId,
    categoryId: req.params.categoryId
  })
  if (!category) throw new HttpError(404, 'Budget category not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body.name !== undefined) patch.name = str(body.name, 'name', 120)
  if (body.description !== undefined) patch.description = optStr(body.description, 500)
  if (body.order !== undefined) patch.order = orderValue(body.order, category.order)

  if (body.group !== undefined) {
    const group = oneOf<BudgetGroup>(body.group, BUDGET_GROUPS, 'group')
    // Moving a category means moving its lines too, or the tree would show a
    // hard-cost line sitting inside the land group.
    if (group !== category.group) {
      patch.group = group
      const lines = (await listBudget(site.siteId)).filter((l) => l.categoryId === category.categoryId)
      for (const line of lines) {
        await updateFields(T.budget, { siteId: site.siteId, lineId: line.lineId }, { group, updatedAt: patch.updatedAt })
      }
    }
  }

  await updateFields(T.budgetCategories, { siteId: site.siteId, categoryId: category.categoryId }, patch)
  res.json({ ok: true })
}))

siteRouter.delete('/:siteId/budget/categories/:categoryId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const category = await getItem<BudgetCategoryRecord>(T.budgetCategories, {
    siteId: site.siteId,
    categoryId: req.params.categoryId
  })
  if (!category) throw new HttpError(404, 'Budget category not found')

  const lines = (await listBudget(site.siteId)).filter((l) => l.categoryId === category.categoryId)
  if (lines.length > 0 && req.query.reassign !== 'none') {
    throw new HttpError(
      409,
      `${lines.length} cost line${lines.length === 1 ? '' : 's'} still sit under "${category.name}". Move them out first.`
    )
  }
  const ts = nowIso()
  for (const line of lines) {
    await updateFields(T.budget, { siteId: site.siteId, lineId: line.lineId }, { categoryId: '', updatedAt: ts })
  }
  await deleteItem(T.budgetCategories, { siteId: site.siteId, categoryId: category.categoryId })
  res.json({ ok: true })
}))

/* ----------------------------- budget lines ---------------------------- */

/** Bulk reorder / re-bucket from drag-and-drop. One round trip, not one per row. */
siteRouter.post('/:siteId/budget/reorder', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const items = Array.isArray(body.items) ? (body.items as unknown[]) : []
  const byId = new Map((await listBudget(site.siteId)).map((l) => [l.lineId, l]))
  const categories = new Map((await listBudgetCategories(site.siteId)).map((c) => [c.categoryId, c]))
  const ts = nowIso()

  for (const item of items) {
    const row = (item ?? {}) as Record<string, unknown>
    const line = typeof row.lineId === 'string' ? byId.get(row.lineId) : undefined
    if (!line) continue
    const patch: Record<string, unknown> = { order: orderValue(row.order, line.order), updatedAt: ts }
    if (row.categoryId !== undefined) {
      const next = typeof row.categoryId === 'string' ? row.categoryId : ''
      if (next === '') {
        patch.categoryId = ''
      } else {
        const category = categories.get(next)
        if (!category) throw new HttpError(400, 'That budget category no longer exists')
        // Dropping onto a category in another group moves the line with it.
        patch.group = category.group
        patch.categoryId = next
      }
    }
    await updateFields(T.budget, { siteId: site.siteId, lineId: line.lineId }, patch)
  }
  res.json({ ok: true })
}))

/**
 * Bulk import from a spreadsheet. The whole sheet is validated before a single
 * write, so one bad row can never leave the budget half-loaded.
 */
siteRouter.post('/:siteId/budget/import', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const rawRows = Array.isArray(body.rows) ? (body.rows as unknown[]) : []
  if (rawRows.length === 0) throw new HttpError(400, 'Nothing to import')
  if (rawRows.length > 1000) throw new HttpError(400, 'Import at most 1000 rows at a time')
  const mode = body.mode === 'replace' ? 'replace' : 'append'

  type Prepared = {
    group: BudgetGroup
    category?: string
    code?: string
    name: string
    budget: number
    spent: number
    hst: number
  }

  const prepared: Prepared[] = rawRows.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const label = `Row ${index + 1}`
    try {
      return {
        group: oneOf<BudgetGroup>(row.group, BUDGET_GROUPS, `${label}: group`),
        category: optStr(row.category, 120),
        code: optStr(row.code, 40),
        name: str(row.name, `${label}: item`, 240),
        budget: amount(row.budget, `${label}: budget`),
        spent: amount(row.spent, `${label}: spent`),
        hst: amount(row.hst, `${label}: hst`)
      }
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : `${label} is invalid`)
    }
  })

  const ts = nowIso()
  if (mode === 'replace') {
    const [oldLines, oldCategories] = await Promise.all([
      listBudget(site.siteId),
      listBudgetCategories(site.siteId)
    ])
    await Promise.all([
      ...oldLines.map((l) => deleteItem(T.budget, { siteId: site.siteId, lineId: l.lineId })),
      ...oldCategories.map((c) => deleteItem(T.budgetCategories, { siteId: site.siteId, categoryId: c.categoryId }))
    ])
  }

  const categories = mode === 'replace' ? [] : await listBudgetCategories(site.siteId)
  const perGroup: Record<BudgetGroup, number> = { land: 0, soft: 0, hard: 0 }
  let categoriesCreated = 0
  let linesCreated = 0

  for (const row of prepared) {
    let categoryId: string | undefined
    if (row.category) {
      let category = categories.find(
        (c) => c.group === row.group && c.name.toLowerCase() === row.category!.toLowerCase()
      )
      if (!category) {
        category = {
          siteId: site.siteId,
          categoryId: randomUUID(),
          group: row.group,
          name: row.category,
          order: categories.filter((c) => c.group === row.group).length,
          createdAt: ts,
          updatedAt: ts
        }
        await putItem(T.budgetCategories, category)
        categories.push(category)
        categoriesCreated += 1
      }
      categoryId = category.categoryId
    }

    const line: BudgetLineRecord = {
      siteId: site.siteId,
      lineId: randomUUID(),
      group: row.group,
      categoryId,
      code: row.code,
      name: row.name,
      budget: row.budget,
      spent: row.spent,
      hst: row.hst,
      order: perGroup[row.group]++,
      createdAt: ts,
      updatedAt: ts
    }
    await putItem(T.budget, line)
    linesCreated += 1
  }

  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: ts })
  res.json({ ok: true, mode, linesCreated, categoriesCreated, summary: computeBudget(await listBudget(site.siteId)) })
}))

siteRouter.post('/:siteId/budget', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const group = oneOf<BudgetGroup>(body.group, BUDGET_GROUPS, 'group')
  const existing = await listBudget(site.siteId)
  const ts = nowIso()
  const line: BudgetLineRecord = {
    siteId: site.siteId,
    lineId: randomUUID(),
    group,
    categoryId: await requireCategory(site.siteId, group, body.categoryId),
    code: optStr(body.code, 40),
    name: str(body.name, 'name', 240),
    budget: amount(body.budget, 'budget'),
    spent: amount(body.spent, 'spent'),
    hst: amount(body.hst, 'hst'),
    order: body.order !== undefined ? orderValue(body.order, existing.length) : existing.filter((l) => l.group === group).length,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.budget, line)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: ts })
  res.json({ line })
}))

siteRouter.patch('/:siteId/budget/:lineId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const line = await getItem<BudgetLineRecord>(T.budget, { siteId: site.siteId, lineId: req.params.lineId })
  if (!line) throw new HttpError(404, 'Budget line not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const group = body.group !== undefined ? oneOf<BudgetGroup>(body.group, BUDGET_GROUPS, 'group') : line.group
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body.group !== undefined) patch.group = group
  if (body.categoryId !== undefined) {
    patch.categoryId = (await requireCategory(site.siteId, group, body.categoryId)) ?? ''
  } else if (body.group !== undefined && group !== line.group && line.categoryId) {
    // Moved to another group without naming a category — drop the stale one.
    patch.categoryId = ''
  }
  if (body.code !== undefined) patch.code = optStr(body.code, 40)
  if (body.name !== undefined) patch.name = str(body.name, 'name', 240)
  if (body.budget !== undefined) patch.budget = money(body.budget, 'budget')
  if (body.spent !== undefined) patch.spent = money(body.spent, 'spent')
  if (body.hst !== undefined) patch.hst = money(body.hst, 'hst')
  if (body.order !== undefined) patch.order = orderValue(body.order, line.order)

  await updateFields(T.budget, { siteId: site.siteId, lineId: line.lineId }, patch)
  res.json({ ok: true })
}))

siteRouter.delete('/:siteId/budget/:lineId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const line = await getItem<BudgetLineRecord>(T.budget, { siteId: site.siteId, lineId: req.params.lineId })
  if (!line) throw new HttpError(404, 'Budget line not found')
  await deleteItem(T.budget, { siteId: site.siteId, lineId: line.lineId })
  res.json({ ok: true })
}))

/* ------------------------------ folders ------------------------------ */

siteRouter.get('/:siteId/folders', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const folders = await listFolders(site.siteId)
  res.json({ folders: folders.sort((a, b) => a.name.localeCompare(b.name)) })
}))

siteRouter.post('/:siteId/folders', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const existing = await listFolders(site.siteId)
  const name = str(body.name, 'name', 120)
  if (existing.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, 'A folder with this name already exists')
  }

  const ts = nowIso()
  const folder: AssetFolderRecord = {
    siteId: site.siteId,
    folderId: randomUUID(),
    name,
    description: optStr(body.description, 500),
    createdBy: req.user!.userId,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.folders, folder)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: ts })
  res.json({ folder })
}))

siteRouter.patch('/:siteId/folders/:folderId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const folder = await getItem<AssetFolderRecord>(T.folders, {
    siteId: site.siteId,
    folderId: req.params.folderId
  })
  if (!folder) throw new HttpError(404, 'Folder not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body.name !== undefined) patch.name = str(body.name, 'name', 120)
  if (body.description !== undefined) patch.description = optStr(body.description, 500)

  await updateFields(T.folders, { siteId: site.siteId, folderId: folder.folderId }, patch)
  res.json({ ok: true })
}))

/** Deleting a folder keeps its files: they simply move back to the project root. */
siteRouter.delete('/:siteId/folders/:folderId', requirePermission('editDetails'), asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const folder = await getItem<AssetFolderRecord>(T.folders, {
    siteId: site.siteId,
    folderId: req.params.folderId
  })
  if (!folder) throw new HttpError(404, 'Folder not found')

  const assets = await queryAll<AssetRecord>(T.assets, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': site.siteId }
  })
  await Promise.all(
    assets
      .filter((a) => a.folderId === folder.folderId)
      .map((a) => {
        const moved: AssetRecord = { ...a }
        delete moved.folderId
        return putItem(T.assets, moved)
      })
  )

  await deleteItem(T.folders, { siteId: site.siteId, folderId: folder.folderId })
  res.json({ ok: true })
}))

/* ------------------------------ assets ------------------------------- */

siteRouter.get('/:siteId/assets', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  const rows = await queryAll<AssetRecord>(T.assets, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': req.params.siteId }
  })
  res.json({ assets: rows.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)) })
}))

/** Step 1 of an upload: hand the browser a short-lived presigned PUT URL. */
siteRouter.post('/:siteId/assets/presign', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to upload files')
  const body = (req.body ?? {}) as Record<string, unknown>
  const fileName = str(body.fileName, 'fileName', 240)
  const contentType = str(body.contentType, 'contentType', 160)
  const type = oneOf<AssetType>(body.type, ASSET_TYPES, 'type')
  const size = body.size === undefined ? undefined : Number(body.size)
  // Refuse oversized files and runaway daily volume before any bytes move.
  await assertUploadAllowed(req.user!, size)

  const key = buildObjectKey(site.siteId, type, fileName)
  res.json({ key, uploadUrl: await presignUpload(key, contentType) })
}))

/** Step 2 of an upload: register the object that the browser just PUT to S3. */
siteRouter.post('/:siteId/assets', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to upload files')
  const body = (req.body ?? {}) as Record<string, unknown>
  const size = body.size !== undefined ? Number(body.size) : undefined
  await assertUploadAllowed(req.user!, size)
  const folderId = optStr(body.folderId, 60)
  if (folderId) {
    const folder = await getItem<AssetFolderRecord>(T.folders, { siteId: site.siteId, folderId })
    if (!folder) throw new HttpError(404, 'Folder not found')
  }

  const asset: AssetRecord = {
    siteId: site.siteId,
    assetId: randomUUID(),
    name: str(body.name, 'name', 240),
    type: oneOf<AssetType>(body.type, ASSET_TYPES, 'type'),
    category: body.category ? oneOf<AssetCategory>(body.category, ASSET_CATEGORIES, 'category') : 'other',
    s3Key: str(body.key, 'key', 500),
    contentType: optStr(body.contentType, 160),
    size: body.size !== undefined ? Number(body.size) : undefined,
    stageId: optStr(body.stageId, 60),
    folderId,
    tags: body.tags === undefined ? undefined : readTags(body.tags),
    uploadedBy: req.user!.userId,
    uploadedByName: req.user!.name,
    uploadedAt: nowIso()
  }
  await putItem(T.assets, asset)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: asset.uploadedAt })
  res.json({ asset })
}))

siteRouter.get('/:siteId/assets/:assetId/url', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const asset = await getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId: req.params.assetId })
  if (!asset) throw new HttpError(404, 'File not found')
  const download = req.query.download === 'true'
  if (download && !canDo(req.user!, 'downloadFiles')) {
    throw new HttpError(403, 'You do not have permission to download files')
  }
  res.json({
    url: await presignDownload(asset.s3Key, 900, download ? asset.name : undefined),
    name: asset.name,
    contentType: asset.contentType
  })
}))

/** Tagging is a curation step, so it follows the same rule as deleting a file. */
siteRouter.patch('/:siteId/assets/:assetId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const asset = await getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId: req.params.assetId })
  if (!asset) throw new HttpError(404, 'File not found')
  if (asset.uploadedBy !== req.user!.userId && !isAdmin(req.user!)) {
    throw new HttpError(403, 'You can only tag files you uploaded')
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  if (body.tags === undefined) throw new HttpError(400, '"tags" is required')
  const tags = readTags(body.tags)

  await updateFields(T.assets, { siteId: site.siteId, assetId: asset.assetId }, { tags })
  res.json({ assetId: asset.assetId, tags })
}))

siteRouter.delete('/:siteId/assets/:assetId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const asset = await getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId: req.params.assetId })
  if (!asset) throw new HttpError(404, 'File not found')
  if (asset.uploadedBy !== req.user!.userId && !isAdmin(req.user!)) {
    throw new HttpError(403, 'You can only delete files you uploaded')
  }
  await deleteItem(T.assets, { siteId: site.siteId, assetId: asset.assetId })
  await deleteObject(asset.s3Key).catch(() => undefined)
  res.json({ ok: true })
}))

/* ------------------------------ remarks ------------------------------ */

siteRouter.get('/:siteId/remarks', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  const rows = await queryAll<RemarkRecord>(T.remarks, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': req.params.siteId }
  })
  res.json({ remarks: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
}))

siteRouter.post('/:siteId/remarks', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to comment')
  const body = (req.body ?? {}) as Record<string, unknown>

  const remark: RemarkRecord = {
    siteId: site.siteId,
    remarkId: randomUUID(),
    text: str(body.text, 'text', 4000),
    stageId: optStr(body.stageId, 60),
    authorId: req.user!.userId,
    authorName: req.user!.name,
    authorRole: req.user!.role,
    createdAt: nowIso()
  }
  await putItem(T.remarks, remark)
  res.json({ remark })
}))

siteRouter.delete('/:siteId/remarks/:remarkId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const remark = await getItem<RemarkRecord>(T.remarks, { siteId: site.siteId, remarkId: req.params.remarkId })
  if (!remark) throw new HttpError(404, 'Remark not found')
  if (remark.authorId !== req.user!.userId && !isAdmin(req.user!)) {
    throw new HttpError(403, 'You can only delete your own remarks')
  }
  await deleteItem(T.remarks, { siteId: site.siteId, remarkId: remark.remarkId })
  res.json({ ok: true })
}))

/* ---------------------- document intelligence ----------------------- */

/** Canonical order of the twelve evidence classes (spec section 2). */
const EVIDENCE_CLASS_ORDER: EvidenceClass[] = [
  'land_survey',
  'design',
  'engineering',
  'permit_approval',
  'contractor_compliance',
  'procurement_quote',
  'executed_contract',
  'commencement',
  'construction_progress',
  'inspection_verification',
  'financial_payment',
  'completion_occupancy'
]

/** What the agent has understood about each file, plus which evidence is still missing. */
siteRouter.get('/:siteId/intelligence', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  const rows = await queryAll<DocumentIntelligenceRecord>(T.documentIntelligence, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': req.params.siteId }
  })
  rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  const covered = new Set<EvidenceClass>()
  for (const row of rows) for (const cls of row.evidenceClasses ?? []) covered.add(cls)

  res.json({
    documents: rows,
    evidenceCovered: EVIDENCE_CLASS_ORDER.filter((cls) => covered.has(cls)),
    evidenceMissing: EVIDENCE_CLASS_ORDER.filter((cls) => !covered.has(cls))
  })
}))

/** Gaps the agent's review has raised (missing documents, expiring certificates, ...). */
siteRouter.get('/:siteId/findings', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  const rows = await queryAll<FindingRecord>(T.findings, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': req.params.siteId }
  })
  res.json({ findings: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
}))

/** A human acknowledges or dismisses a finding. Resolving is admin-only. */
siteRouter.patch('/:siteId/findings/:findingId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  if (!isAdmin(req.user!)) throw new HttpError(403, 'Only admins can update findings')
  const finding = await getItem<FindingRecord>(T.findings, {
    siteId: site.siteId,
    findingId: req.params.findingId
  })
  if (!finding) throw new HttpError(404, 'Finding not found')

  const body = (req.body ?? {}) as Record<string, unknown>
  const status = oneOf<FindingStatus>(body.status, ['open', 'resolved'], 'status')
  await updateFields(
    T.findings,
    { siteId: site.siteId, findingId: finding.findingId },
    { status, updatedAt: nowIso() }
  )
  res.json({ findingId: finding.findingId, status })
}))

/** Property → project → contractor → contract → work package → document → payment. */
siteRouter.get('/:siteId/relationships', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  const rows = await queryAll<RelationshipRecord>(T.relationships, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': req.params.siteId }
  })
  res.json({ relationships: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
}))
