import { Router } from 'express'
import { T, getItem, putItem, queryAll } from '../db'
import { asyncHandler, HttpError } from '../lib/http'
import { accessibleSites, computeProgress, listMilestones, listStages } from '../services'
import type { AssetRecord, KpiConfig, RemarkRecord, SiteRecord } from '../types'

export const dashboardRouter = Router()

/** KPIs an admin can toggle on the dashboard. */
export const KPI_IDS = [
  'projects',
  'active',
  'completed',
  'avg_progress',
  'milestones_done',
  'photos',
  'files',
  'remarks',
  'attention'
] as const

export type KpiId = (typeof KPI_IDS)[number]

const DEFAULT_KPIS: KpiId[] = ['projects', 'active', 'avg_progress', 'milestones_done', 'photos', 'attention']

export interface SiteSummary {
  site: SiteRecord
  progress: ReturnType<typeof computeProgress>
  files: number
  photos: number
  remarks: number
  nextMilestone?: { name: string; dueDate?: string }
  lastActivity?: string
}

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const user = req.user!
  const sites = await accessibleSites(user)

  const rows: SiteSummary[] = await Promise.all(
    sites.map(async (site) => {
      const [stages, milestones, assets, remarks] = await Promise.all([
        listStages(site.siteId),
        listMilestones(site.siteId),
        queryAll<AssetRecord>(T.assets, {
          KeyConditionExpression: 'siteId = :s',
          ExpressionAttributeValues: { ':s': site.siteId }
        }),
        queryAll<RemarkRecord>(T.remarks, {
          KeyConditionExpression: 'siteId = :s',
          ExpressionAttributeValues: { ':s': site.siteId }
        })
      ])

      const upcoming = milestones
        .filter((m) => m.status !== 'completed' && m.dueDate)
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))

      const lastRemark = remarks.reduce<string | undefined>(
        (acc, r) => (!acc || r.createdAt > acc ? r.createdAt : acc),
        undefined
      )
      const lastAsset = assets.reduce<string | undefined>(
        (acc, a) => (!acc || a.uploadedAt > acc ? a.uploadedAt : acc),
        undefined
      )
      const lastActivity = [lastRemark, lastAsset, site.updatedAt].filter(Boolean).sort().pop()

      return {
        site,
        progress: computeProgress(stages, milestones),
        files: assets.filter((a) => a.type === 'document').length,
        photos: assets.filter((a) => a.type === 'image').length,
        remarks: remarks.length,
        nextMilestone: upcoming[0] ? { name: upcoming[0].name, dueDate: upcoming[0].dueDate } : undefined,
        lastActivity
      }
    })
  )

  rows.sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')))

  const totals = {
    projects: rows.length,
    active: rows.filter((r) => r.site.status === 'in_progress').length,
    completed: rows.filter((r) => r.site.status === 'completed').length,
    avgProgress: rows.length
      ? Math.round(rows.reduce((sum, r) => sum + r.progress.percent, 0) / rows.length)
      : 0,
    milestonesDone: rows.reduce((sum, r) => sum + r.progress.milestonesCompleted, 0),
    milestonesTotal: rows.reduce((sum, r) => sum + r.progress.milestones, 0),
    photos: rows.reduce((sum, r) => sum + r.photos, 0),
    files: rows.reduce((sum, r) => sum + r.files, 0),
    remarks: rows.reduce((sum, r) => sum + r.remarks, 0),
    attention: rows.filter((r) => r.site.status === 'on_hold' || r.progress.percent < 100 && r.site.status !== 'completed').length
  }

  const config = await getItem<KpiConfig>(T.kpis, { userId: user.userId })

  res.json({
    rows,
    totals,
    kpis: config?.kpis ?? DEFAULT_KPIS,
    availableKpis: KPI_IDS
  })
}))

dashboardRouter.get('/kpis', asyncHandler(async (req, res) => {
  const config = await getItem<KpiConfig>(T.kpis, { userId: req.user!.userId })
  res.json({ kpis: config?.kpis ?? DEFAULT_KPIS, availableKpis: KPI_IDS })
}))

dashboardRouter.put('/kpis', asyncHandler(async (req, res) => {
  const requested = req.body?.kpis
  if (!Array.isArray(requested)) throw new HttpError(400, '"kpis" must be an array')
  const kpis = requested.filter((k: unknown): k is KpiId => KPI_IDS.includes(k as KpiId))
  if (kpis.length === 0) throw new HttpError(400, 'Select at least one KPI')

  await putItem(T.kpis, {
    userId: req.user!.userId,
    kpis,
    updatedAt: new Date().toISOString()
  })
  res.json({ ok: true, kpis })
}))
