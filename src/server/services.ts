import { T, getItem, queryAll, scanAll } from './db'
import { HttpError } from './lib/http'
import type { MilestoneRecord, SessionUser, SiteRecord, StageRecord } from './types'

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
