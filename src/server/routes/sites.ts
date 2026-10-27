import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { T, deleteItem, getItem, putItem, queryAll, updateFields } from '../db'
import { HttpError, asyncHandler, oneOf, optStr, str } from '../lib/http'
import { requireAdmin } from '../auth'
import {
  accessibleSites,
  canWrite,
  computeProgress,
  listMilestones,
  listStages,
  requireSiteAccess
} from '../services'
import { buildObjectKey, deleteObject, presignDownload, presignUpload } from '../s3'
import type {
  AssetCategory,
  AssetFolderRecord,
  AssetRecord,
  AssetType,
  MilestoneRecord,
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

const nowIso = () => new Date().toISOString()

function listFolders(siteId: string): Promise<AssetFolderRecord[]> {
  return queryAll<AssetFolderRecord>(T.folders, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': siteId }
  })
}

function sitePatchFrom(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  if (body?.name !== undefined) patch.name = str(body.name, 'name', 160)
  if (body?.code !== undefined) patch.code = optStr(body.code, 40)
  if (body?.description !== undefined) patch.description = optStr(body.description, 4000)
  if (body?.location !== undefined) patch.location = optStr(body.location, 240)
  if (body?.status !== undefined) patch.status = oneOf(body.status, SITE_STATUS, 'status')
  if (body?.startDate !== undefined) patch.startDate = optStr(body.startDate, 30)
  if (body?.targetDate !== undefined) patch.targetDate = optStr(body.targetDate, 30)
  if (body?.budget !== undefined) patch.budget = Number(body.budget)
  return patch
}

/* ------------------------------- sites ------------------------------- */

siteRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ sites: await accessibleSites(req.user!) })
}))

siteRouter.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const ts = nowIso()
  const body = (req.body ?? {}) as Record<string, unknown>
  const site: SiteRecord = {
    siteId: randomUUID(),
    name: str(body.name, 'name', 160),
    code: optStr(body.code, 40),
    description: optStr(body.description, 4000),
    location: optStr(body.location, 240),
    status: body.status ? oneOf(body.status, SITE_STATUS, 'status') : 'planning',
    startDate: optStr(body.startDate, 30),
    targetDate: optStr(body.targetDate, 30),
    budget: body.budget !== undefined ? Number(body.budget) : undefined,
    createdBy: req.user!.userId,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.sites, site)
  res.json({ site })
}))

siteRouter.get('/:siteId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const [stages, milestones] = await Promise.all([listStages(site.siteId), listMilestones(site.siteId)])
  res.json({ site, stages, milestones, progress: computeProgress(stages, milestones) })
}))

siteRouter.patch('/:siteId', requireAdmin, asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  await updateFields(T.sites, { siteId: site.siteId }, sitePatchFrom((req.body ?? {}) as Record<string, unknown>))
  res.json({ ok: true })
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
    [T.remarks, 'remarkId']
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

/* ------------------------------ stages ------------------------------- */

siteRouter.get('/:siteId/stages', asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user!, req.params.siteId)
  res.json({ stages: await listStages(req.params.siteId) })
}))

siteRouter.post('/:siteId/stages', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.patch('/:siteId/stages/:stageId', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.delete('/:siteId/stages/:stageId', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.post('/:siteId/milestones', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.patch('/:siteId/milestones/:milestoneId', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.delete('/:siteId/milestones/:milestoneId', requireAdmin, asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const milestone = await getItem<MilestoneRecord>(T.milestones, {
    siteId: site.siteId,
    milestoneId: req.params.milestoneId
  })
  if (!milestone) throw new HttpError(404, 'Milestone not found')
  await deleteItem(T.milestones, { siteId: site.siteId, milestoneId: milestone.milestoneId })
  res.json({ ok: true })
}))

/* ------------------------------ folders ------------------------------ */

siteRouter.get('/:siteId/folders', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const folders = await listFolders(site.siteId)
  res.json({ folders: folders.sort((a, b) => a.name.localeCompare(b.name)) })
}))

siteRouter.post('/:siteId/folders', requireAdmin, asyncHandler(async (req, res) => {
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

siteRouter.patch('/:siteId/folders/:folderId', requireAdmin, asyncHandler(async (req, res) => {
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
siteRouter.delete('/:siteId/folders/:folderId', requireAdmin, asyncHandler(async (req, res) => {
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

  const key = buildObjectKey(site.siteId, type, fileName)
  res.json({ key, uploadUrl: await presignUpload(key, contentType) })
}))

/** Step 2 of an upload: register the object that the browser just PUT to S3. */
siteRouter.post('/:siteId/assets', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to upload files')
  const body = (req.body ?? {}) as Record<string, unknown>

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
  res.json({ url: await presignDownload(asset.s3Key), name: asset.name, contentType: asset.contentType })
}))

siteRouter.delete('/:siteId/assets/:assetId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const asset = await getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId: req.params.assetId })
  if (!asset) throw new HttpError(404, 'File not found')
  if (asset.uploadedBy !== req.user!.userId && req.user!.role !== 'admin') {
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
  if (remark.authorId !== req.user!.userId && req.user!.role !== 'admin') {
    throw new HttpError(403, 'You can only delete your own remarks')
  }
  await deleteItem(T.remarks, { siteId: site.siteId, remarkId: remark.remarkId })
  res.json({ ok: true })
}))
