/**
 * The standard development framework every CPPI project follows.
 *
 * Code owns the framework definition; the database only holds the per-project
 * copies of it. Creating a project seeds the framework, and a boot-time
 * reconcile backfills any project that has none.
 */
import { randomUUID } from 'node:crypto'
import { T, putItem, scanAll } from './db'
import { listMilestones, listStages } from './services'
import type { MilestoneRecord, SiteRecord, StageRecord } from './types'

export interface FrameworkMilestone {
  name: string
  description?: string
}

export interface FrameworkStage {
  name: string
  description: string
  milestones: FrameworkMilestone[]
}

/** Stages run in this order; milestone statuses start as pending. */
export const STANDARD_FRAMEWORK: readonly FrameworkStage[] = [
  {
    name: 'Feasibility & Due Diligence',
    description: 'Prove the site can be built on before design money is committed.',
    milestones: [
      { name: 'Site survey & boundary confirmed', description: 'Survey plan received and lot lines verified.' },
      { name: 'Zoning & by-law review completed', description: 'Permitted use, setbacks and coverage confirmed.' },
      { name: 'Feasibility budget approved' }
    ]
  },
  {
    name: 'Design & Permits',
    description: 'Design team retained and permits in hand.',
    milestones: [
      { name: 'Architectural drawings issued' },
      { name: 'Structural & MEP drawings complete', description: 'Coordinated structural, mechanical, electrical and plumbing.' },
      { name: 'Building permit issued', description: 'Permit number recorded on the project.' }
    ]
  },
  {
    name: 'Site Preparation & Excavation',
    description: 'Site cleared, serviced and excavated to design elevation.',
    milestones: [
      { name: 'Utilities & services located', description: 'Locates called before any ground disturbance.' },
      { name: 'Clearing & demolition complete' },
      { name: 'Excavation & shoring inspected' }
    ]
  },
  {
    name: 'Foundation',
    description: 'Footings, foundation walls and drainage.',
    milestones: [
      { name: 'Footings inspected' },
      { name: 'Foundation walls poured & waterproofed' },
      { name: 'Backfill & drainage complete', description: 'Weeping tile, gravel and grading against the foundation.' }
    ]
  },
  {
    name: 'Structural Framing',
    description: 'Structure erected and closed in from the top.',
    milestones: [
      { name: 'Floor structure complete' },
      { name: 'Framing erected' },
      { name: 'Framing inspection passed' },
      { name: 'Roof trusses & sheathing complete' }
    ]
  },
  {
    name: 'Building Envelope',
    description: 'Weathertight and insulated.',
    milestones: [
      { name: 'Roofing watertight' },
      { name: 'Windows & exterior doors installed' },
      { name: 'Cladding & insulation complete' }
    ]
  },
  {
    name: 'Rough-In Services',
    description: 'Mechanical, electrical and plumbing run inside the walls.',
    milestones: [
      { name: 'Electrical rough-in inspected' },
      { name: 'Plumbing rough-in inspected' },
      { name: 'HVAC rough-in complete' }
    ]
  },
  {
    name: 'Interior Finishes',
    description: 'Finished surfaces, fixtures and fittings.',
    milestones: [
      { name: 'Drywall & plaster complete' },
      { name: 'Cabinetry & millwork installed' },
      { name: 'Flooring & paint complete' }
    ]
  },
  {
    name: 'Landscaping & Exterior Works',
    description: 'Site works around the building.',
    milestones: [
      { name: 'Grading & drainage certified' },
      { name: 'Driveway & hardscaping complete' },
      { name: 'Landscaping planted' }
    ]
  },
  {
    name: 'Handover & Closeout',
    description: 'Delivered to the owner and closed out.',
    milestones: [
      { name: 'Occupancy permit issued' },
      { name: 'Pre-delivery inspection (PDI) complete' },
      { name: 'Final accounts & warranty documents issued' }
    ]
  }
] as const

export interface FrameworkSeedResult {
  /** Names of the stages this call actually created. */
  addedStages: string[]
  addedMilestones: number
}

const nowIso = () => new Date().toISOString()

/**
 * Give a project the standard framework, adding only the stages it does not
 * already have (matched on name, case-insensitive). Safe to call repeatedly.
 */
export async function applyStandardFramework(siteId: string): Promise<FrameworkSeedResult> {
  const [existingStages, existingMilestones] = await Promise.all([
    listStages(siteId),
    listMilestones(siteId)
  ])

  const known = new Set(existingStages.map((s) => s.name.trim().toLowerCase()))
  const missing = STANDARD_FRAMEWORK.filter((s) => !known.has(s.name.toLowerCase()))
  if (missing.length === 0) return { addedStages: [], addedMilestones: 0 }

  const ts = nowIso()
  let stageOrder = existingStages.reduce((max, s) => Math.max(max, s.order), -1) + 1
  let milestoneOrder = existingMilestones.length
  const addedStages: string[] = []

  for (const stage of missing) {
    const stageId = randomUUID()
    const stageRecord: StageRecord = {
      siteId,
      stageId,
      name: stage.name,
      description: stage.description,
      order: stageOrder,
      status: 'not_started',
      createdAt: ts,
      updatedAt: ts
    }
    await putItem(T.stages, stageRecord)
    addedStages.push(stage.name)

    for (const milestone of stage.milestones) {
      const milestoneRecord: MilestoneRecord = {
        siteId,
        milestoneId: randomUUID(),
        stageId,
        name: milestone.name,
        description: milestone.description,
        status: 'pending',
        order: milestoneOrder,
        createdAt: ts,
        updatedAt: ts
      }
      await putItem(T.milestones, milestoneRecord)
      milestoneOrder += 1
    }
    stageOrder += 1
  }

  return {
    addedStages,
    addedMilestones: missing.reduce((sum, s) => sum + s.milestones.length, 0)
  }
}

/**
 * Boot-time backfill: any project with no stages at all gets the standard
 * framework. Projects that already have stages are left untouched so an
 * admin's edits are never overwritten.
 */
export async function backfillMissingFrameworks(): Promise<void> {
  let sites: SiteRecord[]
  try {
    sites = await scanAll<SiteRecord>(T.sites)
  } catch (err) {
    console.warn('[cppi] framework backfill skipped:', err instanceof Error ? err.message : err)
    return
  }

  for (const site of sites) {
    try {
      const stages = await listStages(site.siteId)
      if (stages.length > 0) continue
      const result = await applyStandardFramework(site.siteId)
      if (result.addedStages.length > 0) {
        console.log(
          `[cppi] seeded standard framework on "${site.name}" (${result.addedStages.length} stages, ${result.addedMilestones} milestones)`
        )
      }
    } catch (err) {
      console.warn(
        `[cppi] framework backfill failed for "${site.name}":`,
        err instanceof Error ? err.message : err
      )
    }
  }
}
