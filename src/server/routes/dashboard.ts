import { Router } from 'express'
import { T, getItem, putItem, queryAll } from '../db'
import { asyncHandler, HttpError } from '../lib/http'
import {
  accessibleSites,
  canDo,
  computeBudget,
  computeProgress,
  listBudget,
  listMilestones,
  listStages
} from '../services'
import type { BudgetSummary } from '../services'
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
  'budget_total',
  'budget_spent',
  'budget_remaining',
  'attention'
] as const

export type KpiId = (typeof KPI_IDS)[number]

const DEFAULT_KPIS: KpiId[] = [
  'projects',
  'active',
  'budget_total',
  'budget_spent',
  'avg_progress',
  'milestones_done',
  'attention'
]

/**
 * The KPIs that expose cost figures. They are withheld from anyone without the
 * "see budget" permission, both from what the dashboard shows and from what the
 * customiser offers.
 */
const BUDGET_KPIS: readonly KpiId[] = ['budget_total', 'budget_spent', 'budget_remaining']

function isBudgetKpi(id: string): boolean {
  return (BUDGET_KPIS as readonly string[]).includes(id)
}

/** The KPI ids a user may pick from — no budget figures without the permission. */
function availableKpiIds(canSeeBudget: boolean): KpiId[] {
  return canSeeBudget ? [...KPI_IDS] : KPI_IDS.filter((id) => !isBudgetKpi(id))
}

/** Keep the KPIs a user may see: known ids, minus budget figures without access. */
function visibleKpis(kpis: readonly string[], canSeeBudget: boolean): KpiId[] {
  return kpis.filter(
    (id): id is KpiId =>
      (KPI_IDS as readonly string[]).includes(id) && (canSeeBudget || !isBudgetKpi(id))
  )
}

export interface SiteSummary {
  site: SiteRecord
  progress: ReturnType<typeof computeProgress>
  /** Absent when the user may not see budget figures. */
  budget?: BudgetSummary
  files: number
  photos: number
  remarks: number
  nextMilestone?: { name: string; dueDate?: string }
  lastActivity?: string
}

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const user = req.user!
  const sites = await accessibleSites(user)
  const canSeeBudget = canDo(user, 'viewBudget')

  const rows: SiteSummary[] = await Promise.all(
    sites.map(async (site) => {
      const [stages, milestones, budgetLines, assets, remarks] = await Promise.all([
        listStages(site.siteId),
        listMilestones(site.siteId),
        // Cost lines never leave the server for a user without budget access.
        canSeeBudget ? listBudget(site.siteId) : Promise.resolve([]),
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
        budget: canSeeBudget ? computeBudget(budgetLines) : undefined,
        files: assets.filter((a) => a.type === 'document').length,
        photos: assets.filter((a) => a.type === 'image').length,
        remarks: remarks.length,
        nextMilestone: upcoming[0] ? { name: upcoming[0].name, dueDate: upcoming[0].dueDate } : undefined,
        lastActivity
      }
    })
  )

  rows.sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')))

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const budgetTotals = rows.reduce(
    (acc, r) => ({
      budgeted: acc.budgeted + (r.budget?.budgeted ?? 0),
      spent: acc.spent + (r.budget?.spent ?? 0),
      paid: acc.paid + (r.budget?.paid ?? 0),
      remaining: acc.remaining + (r.budget?.remaining ?? 0)
    }),
    { budgeted: 0, spent: 0, paid: 0, remaining: 0 }
  )

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
    budgetTotal: round2(budgetTotals.budgeted),
    budgetSpent: round2(budgetTotals.spent),
    budgetPaid: round2(budgetTotals.paid),
    budgetRemaining: round2(budgetTotals.remaining),
    attention: rows.filter((r) => r.site.status === 'on_hold' || r.progress.percent < 100 && r.site.status !== 'completed').length
  }

  const config = await getItem<KpiConfig>(T.kpis, { userId: user.userId })

  res.json({
    rows,
    totals,
    kpis: visibleKpis(config?.kpis ?? DEFAULT_KPIS, canSeeBudget),
    availableKpis: availableKpiIds(canSeeBudget)
  })
}))

dashboardRouter.get('/kpis', asyncHandler(async (req, res) => {
  const canSeeBudget = canDo(req.user!, 'viewBudget')
  const config = await getItem<KpiConfig>(T.kpis, { userId: req.user!.userId })
  res.json({
    kpis: visibleKpis(config?.kpis ?? DEFAULT_KPIS, canSeeBudget),
    availableKpis: availableKpiIds(canSeeBudget)
  })
}))

dashboardRouter.put('/kpis', asyncHandler(async (req, res) => {
  const requested = req.body?.kpis
  if (!Array.isArray(requested)) throw new HttpError(400, '"kpis" must be an array')
  const allowed = availableKpiIds(canDo(req.user!, 'viewBudget'))
  const kpis = requested.filter((k: unknown): k is KpiId => allowed.includes(k as KpiId))
  if (kpis.length === 0) throw new HttpError(400, 'Select at least one KPI')

  await putItem(T.kpis, {
    userId: req.user!.userId,
    kpis,
    updatedAt: new Date().toISOString()
  })
  res.json({ ok: true, kpis })
}))
