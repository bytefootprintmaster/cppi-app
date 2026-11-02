import { T, getItem, queryAll, scanAll } from './db'
import { HttpError } from './lib/http'
import type {
  BudgetGroup,
  BudgetLineRecord,
  MilestoneRecord,
  SessionUser,
  SiteRecord,
  StageRecord
} from './types'

export function isAdmin(user: SessionUser): boolean {
  return user.role === 'admin'
}

export function canWrite(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'contractor'
}

export async function loadSite(siteId: string): Promise<SiteRecord> {
  const site = await getItem<SiteRecord>(T.sites, { siteId })
  if (!site) throw new HttpError(404, 'Site not found')
  return site
}

/** Throws unless the user may see this site. Returns the site record. */
export async function requireSiteAccess(user: SessionUser, siteId: string): Promise<SiteRecord> {
  const site = await loadSite(siteId)
  if (isAdmin(user)) return site
  if (!(user.siteIds ?? []).includes(site.siteId)) {
    throw new HttpError(403, 'You do not have access to this project')
  }
  return site
}

export async function accessibleSites(user: SessionUser): Promise<SiteRecord[]> {
  const all = await scanAll<SiteRecord>(T.sites)
  const list = isAdmin(user) ? all : all.filter((s) => (user.siteIds ?? []).includes(s.siteId))
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

export function listStages(siteId: string): Promise<StageRecord[]> {
  return queryAll<StageRecord>(T.stages, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': siteId }
  }).then((rows) => rows.sort((a, b) => a.order - b.order))
}

export function listMilestones(siteId: string): Promise<MilestoneRecord[]> {
  return queryAll<MilestoneRecord>(T.milestones, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': siteId }
  }).then((rows) => rows.sort((a, b) => a.order - b.order))
}

/* ------------------------------- budget -------------------------------- */

/** Land first, then soft costs, then hard costs. */
const GROUP_ORDER: Record<BudgetGroup, number> = { land: 0, soft: 1, hard: 2 }

function compareBudgetLines(a: BudgetLineRecord, b: BudgetLineRecord): number {
  if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group]
  if (a.order !== b.order) return a.order - b.order
  return a.name.localeCompare(b.name)
}

export function listBudget(siteId: string): Promise<BudgetLineRecord[]> {
  return queryAll<BudgetLineRecord>(T.budget, {
    KeyConditionExpression: 'siteId = :s',
    ExpressionAttributeValues: { ':s': siteId }
  }).then((rows) => rows.sort(compareBudgetLines))
}

export interface BudgetGroupTotal {
  group: BudgetGroup
  lines: number
  budget: number
  spent: number
  hst: number
}

export interface BudgetSummary {
  groups: BudgetGroupTotal[]
  lines: number
  /** Approved cost, excluding HST. */
  budgeted: number
  /** Paid so far, excluding HST. */
  spent: number
  /** HST paid on top of `spent`. */
  hst: number
  /** `spent` + `hst` — what has actually left the bank. */
  paid: number
  /** `budgeted` − `spent`; negative once a budget is exceeded. */
  remaining: number
  /** 0..100+, `spent` as a share of `budgeted`. */
  percentUsed: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Roll the individual cost lines up into the totals a developer watches. The
 * budget and spend figures are both HST-exclusive so they compare directly;
 * HST is reported alongside them as cash flow.
 */
export function computeBudget(lines: BudgetLineRecord[]): BudgetSummary {
  const groups = (['land', 'soft', 'hard'] as BudgetGroup[]).map((group) => {
    const rows = lines.filter((line) => line.group === group)
    return {
      group,
      lines: rows.length,
      budget: round2(rows.reduce((sum, line) => sum + line.budget, 0)),
      spent: round2(rows.reduce((sum, line) => sum + line.spent, 0)),
      hst: round2(rows.reduce((sum, line) => sum + line.hst, 0))
    }
  })

  const budgeted = round2(groups.reduce((sum, g) => sum + g.budget, 0))
  const spent = round2(groups.reduce((sum, g) => sum + g.spent, 0))
  const hst = round2(groups.reduce((sum, g) => sum + g.hst, 0))

  return {
    groups,
    lines: lines.length,
    budgeted,
    spent,
    hst,
    paid: round2(spent + hst),
    remaining: round2(budgeted - spent),
    percentUsed: budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0
  }
}

export interface Progress {
  stages: number
  stagesCompleted: number
  milestones: number
  milestonesCompleted: number
  /** 0..100 */
  percent: number
}

/**
 * Project completion. Milestones drive the number when present, otherwise
 * completed stages are used as the fallback signal.
 */
export function computeProgress(stages: StageRecord[], milestones: MilestoneRecord[]): Progress {
  const stagesCompleted = stages.filter((s) => s.status === 'completed').length
  const milestonesCompleted = milestones.filter((m) => m.status === 'completed').length
  let percent = 0
  if (milestones.length > 0) percent = Math.round((milestonesCompleted / milestones.length) * 100)
  else if (stages.length > 0) percent = Math.round((stagesCompleted / stages.length) * 100)
  return {
    stages: stages.length,
    stagesCompleted,
    milestones: milestones.length,
    milestonesCompleted,
    percent
  }
}
