import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, formatDateTime, formatMoney, humanBytes, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { SiteFormModal } from '../components/SiteForm'
import { Uploader } from '../components/Uploader'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  Loading,
  MilestoneStatusBadge,
  Modal,
  Progress,
  SiteStatusBadge,
  StageStatusBadge
} from '../components/ui'
import {
  IconBuilding,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconGrip,
  IconImage,
  IconLayers,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX
} from '../components/icons'
import type { BudgetSummary } from '../../server/services'
import type {
  AssetFolderRecord,
  AssetRecord,
  BudgetCategoryRecord,
  BudgetGroup,
  BudgetLineRecord,
  MilestoneRecord,
  MilestoneStatus,
  RemarkRecord,
  SiteRecord,
  StageRecord,
  StageStatus
} from '../../server/types'

interface SiteDetailResponse {
  site: SiteRecord
  stages: StageRecord[]
  milestones: MilestoneRecord[]
  budgetLines: BudgetLineRecord[]
  budgetCategories: BudgetCategoryRecord[]
  budget: BudgetSummary
  progress: {
    stages: number
    stagesCompleted: number
    milestones: number
    milestonesCompleted: number
    percent: number
  }
}

const STAGE_STATUS_OPTIONS: StageStatus[] = ['not_started', 'in_progress', 'completed', 'blocked']
const MILESTONE_STATUS_OPTIONS: MilestoneStatus[] = ['pending', 'in_progress', 'completed']

const BUDGET_GROUPS: Array<{ value: BudgetGroup; label: string }> = [
  { value: 'land', label: 'Land' },
  { value: 'soft', label: 'Soft costs' },
  { value: 'hard', label: 'Hard costs' }
]

const BUDGET_GROUP_LABEL: Record<BudgetGroup, string> = { land: 'Land', soft: 'Soft costs', hard: 'Hard costs' }

type Tab = 'overview' | 'framework' | 'budget' | 'files' | 'remarks'

export function SiteDetailPage() {
  const { siteId = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState(false)
  const { data, error, loading, reload } = useApi<SiteDetailResponse>(`/sites/${siteId}`)

  const isAdmin = user?.role === 'admin'
  const canWrite = isAdmin || user?.role === 'contractor'

  useEffect(() => {
    if (data?.site.name) document.title = `${data.site.name} · CPPI`
  }, [data?.site.name])

  async function removeSite() {
    if (!data) return
    if (!window.confirm(`Delete "${data.site.name}" and all of its files? This cannot be undone.`)) return
    try {
      await api(`/sites/${data.site.siteId}`, { method: 'DELETE' })
      navigate('/sites')
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not delete the project')
    }
  }

  if (loading && !data) return <Loading />
  if (error && !data) {
    return (
      <PageBody>
        <ErrorNote message={error} />
        <Link className="btn btn-ghost" to="/sites">
          Back to projects
        </Link>
      </PageBody>
    )
  }
  if (!data) return null

  const { site, stages, milestones, budgetLines, budgetCategories, budget, progress } = data

  return (
    <>
      <PageHeader
        title={site.name}
        subtitle={[site.code, site.location].filter(Boolean).join(' · ') || 'No code or location set'}
        actions={
          <>
            <Link className="btn btn-ghost" to="/sites">
              <IconBuilding size={16} />
              All projects
            </Link>
            {isAdmin ? (
              <>
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  Edit details
                </Button>
                <Button variant="danger" onClick={removeSite}>
                  <IconTrash size={16} />
                  Delete
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <PageBody>
        <div className="row wrap" style={{ marginBottom: 18, gap: 12 }}>
          <SiteStatusBadge status={site.status} />
          <Badge tone="gray">
            {progress.milestonesCompleted}/{progress.milestones} milestones
          </Badge>
          <Badge tone="gray">
            {progress.stagesCompleted}/{progress.stages} stages
          </Badge>
          {budget.lines > 0 ? (
            <Badge tone="blue">Budget {formatMoney(budget.budgeted, { compact: true })}</Badge>
          ) : null}
        </div>

        <div className="tabs" style={{ marginBottom: 20 }}>
          {(
            [
              ['overview', 'Overview'],
              ['framework', 'Framework'],
              ['budget', 'Budget'],
              ['files', 'Files'],
              ['remarks', 'Remarks']
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' ? <OverviewTab site={site} progress={progress} budget={budget} /> : null}
        {tab === 'framework' ? (
          <FrameworkTab siteId={site.siteId} stages={stages} milestones={milestones} isAdmin={isAdmin} onChanged={reload} />
        ) : null}
        {tab === 'budget' ? (
          <BudgetTab
            siteId={site.siteId}
            lines={budgetLines}
            categories={budgetCategories}
            summary={budget}
            isAdmin={isAdmin}
            onChanged={reload}
          />
        ) : null}
        {tab === 'files' ? <FilesTab siteId={site.siteId} canWrite={canWrite} isAdmin={isAdmin} /> : null}
        {tab === 'remarks' ? <RemarksTab siteId={site.siteId} stages={stages} canWrite={canWrite} /> : null}
      </PageBody>

      {editing ? (
        <SiteFormModal
          site={site}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            void reload()
          }}
        />
      ) : null}
    </>
  )
}

/* ------------------------------- overview -------------------------------- */

function OverviewTab({
  site,
  progress,
  budget
}: {
  site: SiteRecord
  progress: SiteDetailResponse['progress']
  budget: BudgetSummary
}) {
  const facts: Array<[string, string]> = [
    ['Location', site.location || '—'],
    ['Start date', formatDate(site.startDate)],
    ['Target completion', formatDate(site.targetDate)],
    ['Total budget', budget.lines > 0 ? formatMoney(budget.budgeted) : '—'],
    ['Spent to date', budget.lines > 0 ? formatMoney(budget.spent) : '—'],
    ['Created', formatDate(site.createdAt)],
    ['Last updated', formatDateTime(site.updatedAt)]
  ]

  return (
    <div className="grid grid-2">
      <Card>
        <CardHeader title="Progress" sub="Milestones drive completion; stages are the fallback" />
        <div className="card-body">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="small muted">Overall completion</span>
            <strong>{progress.percent}%</strong>
          </div>
          <Progress percent={progress.percent} />
          <div className="grid grid-2" style={{ marginTop: 18 }}>
            <div>
              <div className="kpi-label">Milestones</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--green-900)' }}>
                {progress.milestonesCompleted}
                <span className="muted" style={{ fontSize: 15 }}>
                  /{progress.milestones}
                </span>
              </div>
            </div>
            <div>
              <div className="kpi-label">Stages</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--green-900)' }}>
                {progress.stagesCompleted}
                <span className="muted" style={{ fontSize: 15 }}>
                  /{progress.stages}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Project details" />
        <div className="card-body">
          <div className="grid grid-2">
            {facts.map(([label, value]) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <div className="kpi-label">{label}</div>
                <div style={{ fontWeight: 600, marginTop: 3 }}>{value}</div>
              </div>
            ))}
          </div>
          {site.description ? (
            <div style={{ marginTop: 4 }}>
              <div className="kpi-label">Description</div>
              <p className="muted" style={{ marginTop: 6 }}>
                {site.description}
              </p>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------- framework -------------------------------- */

function FrameworkTab({
  siteId,
  stages,
  milestones,
  isAdmin,
  onChanged
}: {
  siteId: string
  stages: StageRecord[]
  milestones: MilestoneRecord[]
  isAdmin: boolean
  onChanged: () => void
}) {
  const [stageModal, setStageModal] = useState<{ stage: StageRecord | null } | null>(null)
  const [milestoneModal, setMilestoneModal] = useState<{ milestone: MilestoneRecord | null; stageId?: string } | null>(
    null
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>, id: string) {
    setBusyId(id)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="stack">
      <ErrorNote message={error} />

      <div className="row-between">
        <div>
          <h2>Development framework</h2>
          <p className="small muted">Stages group the work; milestones mark what must be delivered.</p>
        </div>
        {isAdmin ? (
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant={stages.length === 0 ? 'primary' : 'ghost'}
              loading={busyId === 'framework'}
              onClick={() =>
                void run(
                  () => api(`/sites/${siteId}/framework`, { method: 'POST' }),
                  'framework'
                )
              }
            >
              {stages.length === 0 ? 'Apply standard framework' : 'Add missing stages'}
            </Button>
            <Button variant="ghost" onClick={() => setStageModal({ stage: null })}>
              <IconPlus size={16} />
              Add stage
            </Button>
          </div>
        ) : null}
      </div>

      {stages.length === 0 ? (
        <Card>
          <Empty title="No stages defined">
            {isAdmin
              ? 'Apply the standard framework to get every stage and milestone for a build, then tailor it to this project.'
              : 'The administrator has not defined the development framework yet.'}
          </Empty>
        </Card>
      ) : (
        stages.map((stage) => {
          const stageMilestones = milestones.filter((m) => m.stageId === stage.stageId)
          return (
            <Card key={stage.stageId}>
              <CardHeader
                title={stage.name}
                sub={[stage.description, `${stageMilestones.length} milestone(s)`].filter(Boolean).join(' · ')}
                action={
                  <div className="row">
                    <StageStatusBadge status={stage.status} />
                    {isAdmin ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setMilestoneModal({ milestone: null, stageId: stage.stageId })}
                        >
                          <IconPlus size={14} />
                          Milestone
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setStageModal({ stage })}>
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          loading={busyId === stage.stageId}
                          onClick={() => {
                            if (!window.confirm(`Delete stage "${stage.name}" and its milestones?`)) return
                            void run(
                              () => api(`/sites/${siteId}/stages/${stage.stageId}`, { method: 'DELETE' }),
                              stage.stageId
                            )
                          }}
                        >
                          <IconTrash size={14} />
                        </Button>
                      </>
                    ) : null}
                  </div>
                }
              />

              {stageMilestones.length === 0 ? (
                <div className="card-body small muted">No milestones yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Milestone</th>
                        <th>Due</th>
                        <th>Status</th>
                        {isAdmin ? <th /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {stageMilestones.map((m) => (
                        <tr key={m.milestoneId}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{m.name}</div>
                            {m.description ? <div className="small muted">{m.description}</div> : null}
                          </td>
                          <td className="small">{formatDate(m.dueDate)}</td>
                          <td>
                            {isAdmin ? (
                              <select
                                className="select status-select"
                                value={m.status}
                                disabled={busyId === m.milestoneId}
                                onChange={(e) =>
                                  void run(
                                    () =>
                                      api(`/sites/${siteId}/milestones/${m.milestoneId}`, {
                                        method: 'PATCH',
                                        body: { status: e.target.value }
                                      }),
                                    m.milestoneId
                                  )
                                }
                              >
                                {MILESTONE_STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>
                                    {s.replace('_', ' ')}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <MilestoneStatusBadge status={m.status} />
                            )}
                          </td>
                        {isAdmin ? (
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setMilestoneModal({ milestone: m, stageId: stage.stageId })}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              style={{ marginLeft: 6 }}
                              loading={busyId === m.milestoneId}
                              onClick={() => {
                                if (!window.confirm(`Delete milestone "${m.name}"?`)) return
                                void run(
                                  () => api(`/sites/${siteId}/milestones/${m.milestoneId}`, { method: 'DELETE' }),
                                  m.milestoneId
                                )
                              }}
                            >
                              <IconTrash size={14} />
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Card>
          )
        })
      )}

      {stageModal ? (
        <StageFormModal
          siteId={siteId}
          stage={stageModal.stage}
          nextOrder={stages.length}
          onClose={() => setStageModal(null)}
          onSaved={() => {
            setStageModal(null)
            onChanged()
          }}
        />
      ) : null}

      {milestoneModal ? (
        <MilestoneFormModal
          siteId={siteId}
          stages={stages}
          milestone={milestoneModal.milestone}
          defaultStageId={milestoneModal.stageId}
          nextOrder={milestones.length}
          onClose={() => setMilestoneModal(null)}
          onSaved={() => {
            setMilestoneModal(null)
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

function StageFormModal({
  siteId,
  stage,
  nextOrder,
  onClose,
  onSaved
}: {
  siteId: string
  stage: StageRecord | null
  nextOrder: number
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(stage?.name ?? '')
  const [description, setDescription] = useState(stage?.description ?? '')
  const [status, setStatus] = useState<StageStatus>(stage?.status ?? 'not_started')
  const [startDate, setStartDate] = useState(stage?.startDate ?? '')
  const [endDate, setEndDate] = useState(stage?.endDate ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Stage name is required')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      description: description.trim() || undefined,
      status,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      order: stage?.order ?? nextOrder
    }
    try {
      if (stage) await api(`/sites/${siteId}/stages/${stage.stageId}`, { method: 'PATCH', body })
      else await api(`/sites/${siteId}/stages`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the stage')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={stage ? 'Edit stage' : 'New stage'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="stage-form" type="submit" loading={busy}>
            Save stage
          </Button>
        </>
      }
    >
      <form id="stage-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}
        <Field label="Stage name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Foundation" />
        </Field>
        <Field label="Description">
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Scope of works for this stage"
          />
        </Field>
        <div className="grid grid-2">
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as StageStatus)}>
              {STAGE_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <div />
        </div>
        <div className="grid grid-2">
          <Field label="Start date">
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End date">
            <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

function MilestoneFormModal({
  siteId,
  stages,
  milestone,
  defaultStageId,
  nextOrder,
  onClose,
  onSaved
}: {
  siteId: string
  stages: StageRecord[]
  milestone: MilestoneRecord | null
  defaultStageId?: string
  nextOrder: number
  onClose: () => void
  onSaved: () => void
}) {
  const [stageId, setStageId] = useState(milestone?.stageId ?? defaultStageId ?? stages[0]?.stageId ?? '')
  const [name, setName] = useState(milestone?.name ?? '')
  const [description, setDescription] = useState(milestone?.description ?? '')
  const [dueDate, setDueDate] = useState(milestone?.dueDate ?? '')
  const [status, setStatus] = useState<MilestoneStatus>(milestone?.status ?? 'pending')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!stageId) {
      setError('Create a stage before adding milestones')
      return
    }
    if (!name.trim()) {
      setError('Milestone name is required')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      stageId,
      name: name.trim(),
      description: description.trim() || undefined,
      dueDate: dueDate || undefined,
      status,
      order: milestone?.order ?? nextOrder
    }
    try {
      if (milestone) await api(`/sites/${siteId}/milestones/${milestone.milestoneId}`, { method: 'PATCH', body })
      else await api(`/sites/${siteId}/milestones`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the milestone')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={milestone ? 'Edit milestone' : 'New milestone'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="milestone-form" type="submit" loading={busy}>
            Save milestone
          </Button>
        </>
      }
    >
      <form id="milestone-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}
        <Field label="Stage">
          <select className="select" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.map((s) => (
              <option key={s.stageId} value={s.stageId}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Milestone name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Slab poured" />
        </Field>
        <Field label="Description">
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-2">
          <Field label="Due date">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as MilestoneStatus)}>
              {MILESTONE_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  )
}

/* --------------------------------- budget --------------------------------- */

const BUDGET_GROUP_ORDER: BudgetGroup[] = ['land', 'soft', 'hard']

const GROUP_INDEX: Record<BudgetGroup, number> = { land: 0, soft: 1, hard: 2 }

type BudgetFilter = 'all' | 'over' | 'uncategorised'

const BUDGET_FILTERS: Array<{ value: BudgetFilter; label: string }> = [
  { value: 'all', label: 'All items' },
  { value: 'over', label: 'Over budget' },
  { value: 'uncategorised', label: 'Uncategorised' }
]

/** Spreadsheet columns the importer reads and the exporter writes. */
const IMPORT_COLUMNS = ['group', 'category', 'code', 'name', 'budget', 'spent', 'hst']

const GROUP_ALIASES: Record<string, BudgetGroup> = {
  land: 'land',
  soft: 'soft',
  'soft cost': 'soft',
  'soft costs': 'soft',
  hard: 'hard',
  'hard cost': 'hard',
  'hard costs': 'hard'
}

interface ImportRow {
  group: BudgetGroup
  category?: string
  code?: string
  name: string
  budget: number
  spent: number
  hst: number
}

/** One node of the tree: a category and the cost lines filed under it. */
interface BudgetBucket {
  /** null is the group's uncategorised bucket. */
  categoryId: string | null
  name: string
  description?: string
  group: BudgetGroup
  lines: BudgetLineRecord[]
  budget: number
  spent: number
  hst: number
}

const bucketKey = (bucket: BudgetBucket) => bucket.categoryId ?? `${bucket.group}:__none`

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

function sumLines(rows: BudgetLineRecord[], pick: (line: BudgetLineRecord) => number): number {
  return round2(rows.reduce((total, line) => total + pick(line), 0))
}

function compareLines(a: BudgetLineRecord, b: BudgetLineRecord): number {
  if (a.group !== b.group) return GROUP_INDEX[a.group] - GROUP_INDEX[b.group]
  if (a.order !== b.order) return a.order - b.order
  return a.name.localeCompare(b.name)
}

function normalizeGroup(raw: string): BudgetGroup | null {
  return GROUP_ALIASES[raw.trim().toLowerCase()] ?? null
}

/** Split one CSV/TSV line, honouring "quoted, fields" and "" escapes. */
function parseCsvLine(raw: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quoted) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',' || char === '\t') {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)
  return cells
}

function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Fold the flat cost lines into the tree the tab renders. A line whose category
 * has been deleted falls back to its group's uncategorised bucket, so a cost can
 * never silently vanish from the budget.
 */
function buildBuckets(
  group: BudgetGroup,
  lines: BudgetLineRecord[],
  categories: BudgetCategoryRecord[]
): BudgetBucket[] {
  const groupCategories = categories.filter((category) => category.group === group)
  const known = new Set(groupCategories.map((category) => category.categoryId))
  const buckets: BudgetBucket[] = groupCategories.map((category) => ({
    categoryId: category.categoryId,
    name: category.name,
    description: category.description,
    group,
    lines: [],
    budget: 0,
    spent: 0,
    hst: 0
  }))

  const loose: BudgetLineRecord[] = []
  for (const line of lines) {
    if (line.group !== group) continue
    const bucket = line.categoryId && known.has(line.categoryId)
      ? buckets.find((candidate) => candidate.categoryId === line.categoryId)
      : undefined
    if (bucket) bucket.lines.push(line)
    else loose.push(line)
  }

  const withTotals = (bucket: BudgetBucket): BudgetBucket => ({
    ...bucket,
    budget: sumLines(bucket.lines, (line) => line.budget),
    spent: sumLines(bucket.lines, (line) => line.spent),
    hst: sumLines(bucket.lines, (line) => line.hst)
  })

  const result = buckets.map(withTotals)
  if (loose.length > 0) {
    result.push(
      withTotals({ categoryId: null, name: 'Uncategorised', group, lines: loose, budget: 0, spent: 0, hst: 0 })
    )
  }
  return result
}

function parseImport(text: string): { rows: ImportRow[]; error?: string } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return { rows: [], error: 'Nothing to import yet.' }

  const first = parseCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const hasHeader = first.includes('name')
  const columns = hasHeader ? first : IMPORT_COLUMNS
  const body = hasHeader ? lines.slice(1) : lines

  const rows: ImportRow[] = []
  const problems: string[] = []

  body.forEach((raw, index) => {
    const cells = parseCsvLine(raw)
    const label = `Row ${index + (hasHeader ? 2 : 1)}`
    const pick = (column: string) => {
      const at = columns.indexOf(column)
      return at >= 0 ? (cells[at] ?? '').trim() : ''
    }
    const numeric = (column: string) => {
      const value = pick(column)
      return value === '' ? 0 : Number(value.replace(/[$,\s]/g, ''))
    }

    const group = normalizeGroup(pick('group'))
    const name = pick('name')
    const budget = numeric('budget')
    const spent = numeric('spent')
    const hst = numeric('hst')

    if (!group) {
      problems.push(`${label}: group must be land, soft or hard`)
      return
    }
    if (!name) {
      problems.push(`${label}: item name is required`)
      return
    }
    if ([budget, spent, hst].some((value) => !Number.isFinite(value) || value < 0)) {
      problems.push(`${label}: budget, spent and hst must be numbers of 0 or more`)
      return
    }
    rows.push({
      group,
      category: pick('category') || undefined,
      code: pick('code') || undefined,
      name,
      budget,
      spent,
      hst
    })
  })

  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join(' · ')
    const extra = problems.length > 5 ? ` (+${problems.length - 5} more)` : ''
    return { rows: [], error: `${shown}${extra}` }
  }
  return { rows }
}

function budgetToCsv(lines: BudgetLineRecord[], categories: BudgetCategoryRecord[]): string {
  const nameOf = new Map(categories.map((category) => [category.categoryId, category.name]))
  const rows = lines
    .slice()
    .sort(compareLines)
    .map((line) =>
      [
        BUDGET_GROUP_LABEL[line.group],
        line.categoryId ? nameOf.get(line.categoryId) ?? '' : '',
        line.code ?? '',
        line.name,
        line.budget,
        line.spent,
        line.hst
      ]
        .map(csvEscape)
        .join(',')
    )
  return [IMPORT_COLUMNS.join(','), ...rows].join('\r\n')
}

function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** An amount that becomes an input in place, so figures can be tuned without a modal. */
function InlineAmount({
  value,
  canEdit,
  onSave,
  onError
}: {
  value: number
  canEdit: boolean
  onSave: (next: number) => Promise<void>
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)

  async function commit() {
    if (saving.current) return
    const next = draft.trim() === '' ? 0 : Number(draft)
    if (!Number.isFinite(next) || next < 0) {
      onError('Amounts must be numbers of 0 or more')
      setEditing(false)
      return
    }
    if (next === value) {
      setEditing(false)
      return
    }
    saving.current = true
    setBusy(true)
    try {
      await onSave(next)
      setEditing(false)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the amount')
      setEditing(false)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  if (!canEdit) return <span className="num">{formatMoney(value)}</span>
  if (busy) return <span className="num"><span className="spinner inline-spinner" /></span>

  if (!editing) {
    return (
      <button
        type="button"
        className="num inline-amount"
        title="Click to edit"
        onClick={() => {
          setDraft(value === 0 ? '' : String(value))
          setEditing(true)
        }}
      >
        {formatMoney(value)}
      </button>
    )
  }

  return (
    <input
      className="num inline-amount-input"
      type="number"
      min="0"
      step="0.01"
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setEditing(false)
        }
      }}
    />
  )
}

function BudgetTab({
  siteId,
  lines,
  categories,
  summary,
  isAdmin,
  onChanged
}: {
  siteId: string
  lines: BudgetLineRecord[]
  categories: BudgetCategoryRecord[]
  summary: BudgetSummary
  isAdmin: boolean
  onChanged: () => void
}) {
  const [modal, setModal] = useState<{ line: BudgetLineRecord | null; group: BudgetGroup; categoryId?: string } | null>(null)
  const [managing, setManaging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BudgetFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<{ kind: 'line' | 'category'; id: string } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  const needle = query.trim().toLowerCase()
  const filtering = needle !== '' || filter !== 'all'

  const visibleLineIds = useMemo(() => {
    const byId = new Map(categories.map((category) => [category.categoryId, category]))
    const ids = new Set<string>()
    for (const line of lines) {
      if (filter === 'over' && !(line.spent > line.budget)) continue
      if (filter === 'uncategorised' && line.categoryId && byId.has(line.categoryId)) continue
      if (needle) {
        const haystack = [
          line.name,
          line.code ?? '',
          line.categoryId ? byId.get(line.categoryId)?.name ?? '' : ''
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      ids.add(line.lineId)
    }
    return ids
  }, [lines, categories, needle, filter])

  const dragLine = drag?.kind === 'line' ? lines.find((line) => line.lineId === drag.id) ?? null : null

  async function remove(line: BudgetLineRecord) {
    if (!window.confirm(`Delete the cost line "${line.name}"?`)) return
    setBusyId(line.lineId)
    setError(null)
    try {
      await api(`/sites/${siteId}/budget/${line.lineId}`, { method: 'DELETE' })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the cost line')
    } finally {
      setBusyId(null)
    }
  }

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusyId(id)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  async function saveAmount(line: BudgetLineRecord, field: 'budget' | 'spent' | 'hst', next: number) {
    await api(`/sites/${siteId}/budget/${line.lineId}`, { method: 'PATCH', body: { [field]: next } })
    onChanged()
  }

  /** Re-file a cost line and renumber its group in a single round trip. */
  async function moveLine(lineId: string, group: BudgetGroup, targetCategoryId: string | null, beforeLineId: string | null) {
    const moved = lines.find((line) => line.lineId === lineId)
    if (!moved) return
    // A category id already carries its group, so dropping onto a category in
    // another group travels on its own. Dropping into another group's
    // uncategorised bucket is the one case the reorder call cannot express.
    if (!targetCategoryId && moved.group !== group) {
      await api(`/sites/${siteId}/budget/${lineId}`, { method: 'PATCH', body: { group, categoryId: '' } })
    }
    const buckets = buildBuckets(group, lines.filter((line) => line.lineId !== lineId), categories)
    let bucket = buckets.find((candidate) => candidate.categoryId === targetCategoryId)
    if (!bucket) {
      if (targetCategoryId !== null) return
      bucket = { categoryId: null, name: 'Uncategorised', group, lines: [], budget: 0, spent: 0, hst: 0 }
      buckets.push(bucket)
    }
    const at = beforeLineId ? bucket.lines.findIndex((line) => line.lineId === beforeLineId) : -1
    if (at >= 0) bucket.lines.splice(at, 0, moved)
    else bucket.lines.push(moved)

    const items = buckets.flatMap((node) =>
      node.lines.map((line, index) => ({ lineId: line.lineId, order: index, categoryId: node.categoryId ?? '' }))
    )
    await api(`/sites/${siteId}/budget/reorder`, { method: 'POST', body: { items } })
  }

  async function moveCategory(categoryId: string, group: BudgetGroup, beforeId: string | null) {
    const moved = categories.find((category) => category.categoryId === categoryId)
    if (!moved) return
    // Changing group drags the category's cost lines along with it.
    if (moved.group !== group) {
      await api(`/sites/${siteId}/budget/categories/${categoryId}`, { method: 'PATCH', body: { group } })
    }
    const siblings = categories.filter(
      (category) => category.group === group && category.categoryId !== categoryId
    )
    const at = beforeId ? siblings.findIndex((category) => category.categoryId === beforeId) : -1
    if (at >= 0) siblings.splice(at, 0, moved)
    else siblings.push(moved)

    const items = siblings.map((category, index) => ({ categoryId: category.categoryId, order: index }))
    await api(`/sites/${siteId}/budget/categories/reorder`, { method: 'POST', body: { items } })
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function setAllCollapsed(shouldCollapse: boolean) {
    if (!shouldCollapse) {
      setCollapsed(new Set())
      return
    }
    const keys: string[] = []
    for (const group of BUDGET_GROUP_ORDER) {
      keys.push(`group:${group}`)
      for (const bucket of buildBuckets(group, lines, categories)) keys.push(`cat:${bucketKey(bucket)}`)
    }
    setCollapsed(new Set(keys))
  }

  function resetDrag() {
    setDrag(null)
    setDropKey(null)
  }

  function dropOnLine(target: BudgetLineRecord) {
    const moved = dragLine
    resetDrag()
    if (!moved || moved.lineId === target.lineId) return
    const targetCategoryId =
      target.categoryId && categories.some((category) => category.categoryId === target.categoryId)
        ? target.categoryId
        : null
    void run(`move:${moved.lineId}`, () => moveLine(moved.lineId, target.group, targetCategoryId, target.lineId))
  }

  function dropOnBucket(bucket: BudgetBucket) {
    const moved = dragLine
    const categoryId = drag?.kind === 'category' ? drag.id : null
    resetDrag()
    if (moved) {
      void run(`move:${moved.lineId}`, () => moveLine(moved.lineId, bucket.group, bucket.categoryId, null))
      return
    }
    if (categoryId && bucket.categoryId) {
      void run(`movecat:${categoryId}`, () => moveCategory(categoryId, bucket.group, bucket.categoryId))
    }
  }

  function dropOnGroup(group: BudgetGroup) {
    const moved = dragLine
    const categoryId = drag?.kind === 'category' ? drag.id : null
    resetDrag()
    if (moved) {
      void run(`move:${moved.lineId}`, () => moveLine(moved.lineId, group, null, null))
      return
    }
    if (categoryId) {
      void run(`movecat:${categoryId}`, () => moveCategory(categoryId, group, null))
    }
  }

  const exportCsv = () =>
    downloadCsv(`budget-${new Date().toISOString().slice(0, 10)}.csv`, budgetToCsv(lines, categories))

  const columns = isAdmin ? 6 : 5

  /** Everything folded into the tree, then narrowed to whatever the filter kept. */
  const shownLines = filtering ? lines.filter((line) => visibleLineIds.has(line.lineId)) : lines

  const allCollapsed = useMemo(() => {
    const keys: string[] = []
    for (const group of BUDGET_GROUP_ORDER) {
      keys.push(`group:${group}`)
      for (const bucket of buildBuckets(group, lines, categories)) keys.push(`cat:${bucketKey(bucket)}`)
    }
    return keys.length > 0 && keys.every((key) => collapsed.has(key))
  }, [lines, categories, collapsed])

  return (
    <div className="stack">
      <ErrorNote message={error} />

      <div className="grid grid-4">
        <div className="kpi">
          <div className="kpi-label">Total budget</div>
          <div className="kpi-value">{formatMoney(summary.budgeted, { compact: true })}</div>
          <div className="kpi-foot">
            {summary.lines} cost line{summary.lines === 1 ? '' : 's'} · excl. HST
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Spent</div>
          <div className="kpi-value">{formatMoney(summary.spent, { compact: true })}</div>
          <Progress percent={summary.percentUsed} />
          <div className="kpi-foot">{summary.percentUsed}% of budget</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">HST paid</div>
          <div className="kpi-value">{formatMoney(summary.hst, { compact: true })}</div>
          <div className="kpi-foot">{formatMoney(summary.paid, { compact: true })} paid in total</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Remaining</div>
          <div className="kpi-value" style={summary.remaining < 0 ? { color: 'var(--red)' } : undefined}>
            {formatMoney(summary.remaining, { compact: true })}
          </div>
          <div className="kpi-foot">
            {summary.remaining < 0 ? 'Over budget' : 'Budget still to be spent'}
          </div>
        </div>
      </div>

      {lines.length === 0 && categories.length === 0 ? (
        <Card>
          <Empty title="No budget yet">
            {isAdmin
              ? 'Add land, soft cost and hard cost lines — or import a spreadsheet — to start tracking spend against this project.'
              : 'The administrator has not set a budget for this project yet.'}
          </Empty>
          {isAdmin ? (
            <div className="row" style={{ justifyContent: 'center', paddingBottom: 20, gap: 10 }}>
              <Button variant="ghost" onClick={() => setModal({ line: null, group: 'hard' })}>
                <IconPlus size={16} />
                Add cost line
              </Button>
              <Button variant="ghost" onClick={() => setImporting(true)}>
                <IconUpload size={16} />
                Import CSV
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <Card>
          <div className="budget-toolbar">
            <label className="budget-search">
              <IconSearch size={16} />
              <input
                value={query}
                placeholder="Search items, codes or categories"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="budget-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <IconX size={14} />
                </button>
              ) : null}
            </label>

            <div className="budget-chips">
              {BUDGET_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`chip${filter === option.value ? ' on' : ''}`}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="budget-actions">
              <Button variant="ghost" size="sm" onClick={() => setAllCollapsed(!allCollapsed)}>
                <IconChevronDown size={14} />
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </Button>
              <Button variant="ghost" size="sm" onClick={exportCsv}>
                <IconDownload size={14} />
                Export
              </Button>
              {isAdmin ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
                    <IconUpload size={14} />
                    Import
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>
                    <IconLayers size={14} />
                    Categories
                  </Button>
                  <Button size="sm" onClick={() => setModal({ line: null, group: 'hard' })}>
                    <IconPlus size={14} />
                    Add cost line
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {filtering ? (
            <div className="budget-note small muted">
              Showing {shownLines.length} of {lines.length} cost line{lines.length === 1 ? '' : 's'}
              {filter === 'over' ? ' over budget' : ''}
              {filter === 'uncategorised' ? ' with no category' : ''}
            </div>
          ) : null}

          <div className="table-wrap">
            <table className="table budget-table">
              <thead>
                <tr>
                  <th>Category / item</th>
                  <th className="num">Budget</th>
                  <th className="num">Spent</th>
                  <th className="num">HST</th>
                  <th className="num">Remaining</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>

              {BUDGET_GROUP_ORDER.map((group) => {
                const buckets = buildBuckets(group, shownLines, categories).filter(
                  (bucket) => !filtering || bucket.lines.length > 0
                )
                if (buckets.length === 0) return null

                const groupBudget = round2(buckets.reduce((total, bucket) => total + bucket.budget, 0))
                const groupSpent = round2(buckets.reduce((total, bucket) => total + bucket.spent, 0))
                const groupHst = round2(buckets.reduce((total, bucket) => total + bucket.hst, 0))
                const groupRemaining = round2(groupBudget - groupSpent)
                const groupKey = `group:${group}`
                const groupCollapsed = collapsed.has(groupKey)

                return (
                  <tbody
                    key={group}
                    onDragOver={
                      isAdmin
                        ? (event) => {
                            event.preventDefault()
                            if (dropKey !== groupKey) setDropKey(groupKey)
                          }
                        : undefined
                    }
                    onDrop={
                      isAdmin
                        ? (event) => {
                            event.preventDefault()
                            dropOnGroup(group)
                          }
                        : undefined
                    }
                  >
                    <tr className={`group-row${dropKey === groupKey ? ' drop-target' : ''}`}>
                      <td colSpan={columns}>
                        <span className="tree-row">
                          <button
                            type="button"
                            className="tree-toggle"
                            aria-expanded={!groupCollapsed}
                            aria-label={groupCollapsed ? 'Expand group' : 'Collapse group'}
                            onClick={() => toggle(groupKey)}
                          >
                            {groupCollapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
                          </button>
                          <span className="group-name">{BUDGET_GROUP_LABEL[group]}</span>
                          <span className="group-meta">
                            {buckets.length} categor{buckets.length === 1 ? 'y' : 'ies'} ·{' '}
                            {buckets.reduce((total, bucket) => total + bucket.lines.length, 0)} items
                          </span>
                        </span>
                      </td>
                    </tr>

                    {groupCollapsed
                      ? null
                      : buckets.map((bucket) => {
                          const key = bucketKey(bucket)
                          const catKey = `cat:${key}`
                          const catCollapsed = collapsed.has(catKey)
                          const remaining = round2(bucket.budget - bucket.spent)
                          return (
                            <Fragment key={key}>
                              <tr
                                className={`category-row${dropKey === catKey ? ' drop-target' : ''}`}
                                onDragOver={
                                  isAdmin
                                    ? (event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        if (dropKey !== catKey) setDropKey(catKey)
                                      }
                                    : undefined
                                }
                                onDrop={
                                  isAdmin
                                    ? (event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        dropOnBucket(bucket)
                                      }
                                    : undefined
                                }
                              >
                                <td>
                                  <span className="tree-row indent-1">
                                    {isAdmin && bucket.categoryId ? (
                                      <span
                                        className="drag-handle"
                                        draggable
                                        title="Drag to reorder, or onto another group to move it"
                                        onDragStart={() => setDrag({ kind: 'category', id: bucket.categoryId! })}
                                        onDragEnd={resetDrag}
                                      >
                                        <IconGrip size={14} />
                                      </span>
                                    ) : (
                                      <span className="drag-spacer" />
                                    )}
                                    <button
                                      type="button"
                                      className="tree-toggle"
                                      aria-expanded={!catCollapsed}
                                      aria-label={catCollapsed ? 'Expand category' : 'Collapse category'}
                                      onClick={() => toggle(catKey)}
                                    >
                                      {catCollapsed ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
                                    </button>
                                    <span className="category-name">{bucket.name}</span>
                                    <span className="small muted">
                                      {bucket.lines.length} item{bucket.lines.length === 1 ? '' : 's'}
                                    </span>
                                    {bucket.description ? (
                                      <span className="small muted">· {bucket.description}</span>
                                    ) : null}
                                    {busyId === `movecat:${bucket.categoryId}` ? (
                                      <span className="spinner inline-spinner" />
                                    ) : null}
                                  </span>
                                </td>
                                <td className="num">{formatMoney(bucket.budget)}</td>
                                <td className="num">{formatMoney(bucket.spent)}</td>
                                <td className="num">{formatMoney(bucket.hst)}</td>
                                <td className={`num${remaining < 0 ? ' money-over' : ''}`}>
                                  {formatMoney(remaining)}
                                </td>
                                {isAdmin ? (
                                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Add a cost line to this category"
                                      onClick={() =>
                                        setModal({ line: null, group, categoryId: bucket.categoryId ?? undefined })
                                      }
                                    >
                                      <IconPlus size={14} />
                                    </Button>
                                  </td>
                                ) : null}
                              </tr>

                              {catCollapsed
                                ? null
                                : bucket.lines.map((line) => {
                                    const lineRemaining = round2(line.budget - line.spent)
                                    const lineKey = `line:${line.lineId}`
                                    return (
                                      <tr
                                        key={line.lineId}
                                        className={`line-row${dropKey === lineKey ? ' drop-target' : ''}`}
                                        onDragOver={
                                          isAdmin
                                            ? (event) => {
                                                event.preventDefault()
                                                event.stopPropagation()
                                                if (dropKey !== lineKey) setDropKey(lineKey)
                                              }
                                            : undefined
                                        }
                                        onDrop={
                                          isAdmin
                                            ? (event) => {
                                                event.preventDefault()
                                                event.stopPropagation()
                                                dropOnLine(line)
                                              }
                                            : undefined
                                        }
                                      >
                                        <td>
                                          <span className="tree-row indent-2">
                                            {isAdmin ? (
                                              <span
                                                className="drag-handle"
                                                draggable
                                                title="Drag to reorder, or onto a category to re-file it"
                                                onDragStart={() => setDrag({ kind: 'line', id: line.lineId })}
                                                onDragEnd={resetDrag}
                                              >
                                                <IconGrip size={14} />
                                              </span>
                                            ) : (
                                              <span className="drag-spacer" />
                                            )}
                                            <span className="line-name">{line.name}</span>
                                            {line.code ? <span className="small muted mono">{line.code}</span> : null}
                                            {busyId === `move:${line.lineId}` ? (
                                              <span className="spinner inline-spinner" />
                                            ) : null}
                                          </span>
                                        </td>
                                        <td className="num">
                                          <InlineAmount
                                            value={line.budget}
                                            canEdit={isAdmin}
                                            onSave={(next) => saveAmount(line, 'budget', next)}
                                            onError={setError}
                                          />
                                        </td>
                                        <td className="num">
                                          <InlineAmount
                                            value={line.spent}
                                            canEdit={isAdmin}
                                            onSave={(next) => saveAmount(line, 'spent', next)}
                                            onError={setError}
                                          />
                                        </td>
                                        <td className="num">
                                          <InlineAmount
                                            value={line.hst}
                                            canEdit={isAdmin}
                                            onSave={(next) => saveAmount(line, 'hst', next)}
                                            onError={setError}
                                          />
                                        </td>
                                        <td className={`num${lineRemaining < 0 ? ' money-over' : ''}`}>
                                          {formatMoney(lineRemaining)}
                                        </td>
                                        {isAdmin ? (
                                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() => setModal({ line, group, categoryId: line.categoryId })}
                                            >
                                              <IconEdit size={14} />
                                            </Button>
                                            <Button
                                              variant="danger"
                                              size="sm"
                                              style={{ marginLeft: 6 }}
                                              loading={busyId === line.lineId}
                                              onClick={() => void remove(line)}
                                            >
                                              <IconTrash size={14} />
                                            </Button>
                                          </td>
                                        ) : null}
                                      </tr>
                                    )
                                  })}
                            </Fragment>
                          )
                        })}

                    <tr className="subtotal">
                      <td>
                        Subtotal — {BUDGET_GROUP_LABEL[group]}
                        {filtering ? ' (filtered)' : ''}
                      </td>
                      <td className="num">{formatMoney(groupBudget)}</td>
                      <td className="num">{formatMoney(groupSpent)}</td>
                      <td className="num">{formatMoney(groupHst)}</td>
                      <td className={`num${groupRemaining < 0 ? ' money-over' : ''}`}>
                        {formatMoney(groupRemaining)}
                      </td>
                      {isAdmin ? <td /> : null}
                    </tr>
                  </tbody>
                )
              })}

              <tfoot>
                <tr className="grand-total">
                  <td>Total</td>
                  <td className="num">{formatMoney(summary.budgeted)}</td>
                  <td className="num">{formatMoney(summary.spent)}</td>
                  <td className="num">{formatMoney(summary.hst)}</td>
                  <td className={`num${summary.remaining < 0 ? ' money-over' : ''}`}>
                    {formatMoney(summary.remaining)}
                  </td>
                  {isAdmin ? <td /> : null}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {modal ? (
        <BudgetLineFormModal
          siteId={siteId}
          line={modal.line}
          defaultGroup={modal.group}
          defaultCategoryId={modal.categoryId}
          categories={categories}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            onChanged()
          }}
        />
      ) : null}

      {managing ? (
        <BudgetCategoryModal
          siteId={siteId}
          categories={categories}
          lines={lines}
          onClose={() => setManaging(false)}
          onChanged={onChanged}
        />
      ) : null}

      {importing ? (
        <BudgetImportModal
          siteId={siteId}
          onClose={() => setImporting(false)}
          onImported={onChanged}
        />
      ) : null}
    </div>
  )
}

function BudgetLineFormModal({
  siteId,
  line,
  defaultGroup,
  defaultCategoryId,
  categories,
  onClose,
  onSaved
}: {
  siteId: string
  line: BudgetLineRecord | null
  defaultGroup: BudgetGroup
  defaultCategoryId?: string
  categories: BudgetCategoryRecord[]
  onClose: () => void
  onSaved: () => void
}) {
  const [group, setGroup] = useState<BudgetGroup>(line?.group ?? defaultGroup)
  const [categoryId, setCategoryId] = useState(line?.categoryId ?? defaultCategoryId ?? '')
  const [code, setCode] = useState(line?.code ?? '')
  const [name, setName] = useState(line?.name ?? '')
  const [budget, setBudget] = useState(line ? String(line.budget) : '')
  const [spent, setSpent] = useState(line ? String(line.spent) : '')
  const [hst, setHst] = useState(line ? String(line.hst) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = categories.filter((category) => category.group === group)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the cost line a name')
      return
    }
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = {
      group,
      categoryId: options.some((category) => category.categoryId === categoryId) ? categoryId : '',
      code: code.trim() || undefined,
      name: name.trim(),
      budget: budget === '' ? 0 : Number(budget),
      spent: spent === '' ? 0 : Number(spent),
      hst: hst === '' ? 0 : Number(hst)
    }
    // An edit keeps its place; a new line is appended inside its group.
    if (line) body.order = line.order
    try {
      if (line) await api(`/sites/${siteId}/budget/${line.lineId}`, { method: 'PATCH', body })
      else await api(`/sites/${siteId}/budget`, { method: 'POST', body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the cost line')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={line ? 'Edit cost line' : 'New cost line'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="budget-form" type="submit" loading={busy}>
            Save line
          </Button>
        </>
      }
    >
      <form id="budget-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}
        <div className="grid grid-2">
          <Field label="Cost group">
            <select
              className="select"
              value={group}
              onChange={(e) => {
                const next = e.target.value as BudgetGroup
                setGroup(next)
                if (!categories.some((c) => c.group === next && c.categoryId === categoryId)) setCategoryId('')
              }}
            >
              {BUDGET_GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" hint={options.length === 0 ? 'Add categories under "Categories"' : 'Optional'}>
            <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorised</option>
              {options.map((category) => (
                <option key={category.categoryId} value={category.categoryId}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Item">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Framing"
              autoFocus
            />
          </Field>
          <Field label="Cost code" hint="Optional, e.g. H.06 10 00">
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-3">
          <Field label="Budget" hint="Excl. HST">
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </Field>
          <Field label="Spent" hint="Excl. HST">
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={spent}
              onChange={(e) => setSpent(e.target.value)}
            />
          </Field>
          <Field label="HST paid">
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={hst}
              onChange={(e) => setHst(e.target.value)}
            />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

/** Per-project category list: create, rename, describe and delete. */
function BudgetCategoryModal({
  siteId,
  categories,
  lines,
  onClose,
  onChanged
}: {
  siteId: string
  categories: BudgetCategoryRecord[]
  lines: BudgetLineRecord[]
  onClose: () => void
  onChanged: () => void
}) {
  const [group, setGroup] = useState<BudgetGroup>('hard')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [editing, setEditing] = useState<{ categoryId: string; name: string; description: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const line of lines) {
      if (line.categoryId) map.set(line.categoryId, (map.get(line.categoryId) ?? 0) + 1)
    }
    return map
  }, [lines])

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the category a name')
      return
    }
    setBusy('new')
    setError(null)
    try {
      await api(`/sites/${siteId}/budget/categories`, {
        method: 'POST',
        body: { group, name: name.trim(), description: description.trim() || undefined }
      })
      setName('')
      setDescription('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the category')
    } finally {
      setBusy(null)
    }
  }

  async function save(categoryId: string) {
    if (!editing) return
    if (!editing.name.trim()) {
      setError('Give the category a name')
      return
    }
    setBusy(categoryId)
    setError(null)
    try {
      await api(`/sites/${siteId}/budget/categories/${categoryId}`, {
        method: 'PATCH',
        body: { name: editing.name.trim(), description: editing.description.trim() }
      })
      setEditing(null)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the category')
    } finally {
      setBusy(null)
    }
  }

  async function remove(category: BudgetCategoryRecord) {
    const used = counts.get(category.categoryId) ?? 0
    const question =
      used > 0
        ? `"${category.name}" still holds ${used} cost line${used === 1 ? '' : 's'}. Delete the category and leave those lines uncategorised?`
        : `Delete the category "${category.name}"?`
    if (!window.confirm(question)) return
    setBusy(category.categoryId)
    setError(null)
    try {
      const suffix = used > 0 ? '?reassign=none' : ''
      await api(`/sites/${siteId}/budget/categories/${category.categoryId}${suffix}`, { method: 'DELETE' })
      if (editing?.categoryId === category.categoryId) setEditing(null)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the category')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title="Budget categories"
      wide
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ErrorNote message={error} />

      <p className="small muted" style={{ marginBottom: 16 }}>
        Categories sit between a cost group and its cost lines, and belong to this project only.
      </p>

      <form className="category-create" onSubmit={create}>
        <div className="grid grid-3">
          <Field label="Cost group">
            <select className="select" value={group} onChange={(e) => setGroup(e.target.value as BudgetGroup)}>
              {BUDGET_GROUPS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Permits & fees"
            />
          </Field>
          <Field label="Description" hint="Optional">
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 20 }}>
          <Button type="submit" loading={busy === 'new'}>
            <IconPlus size={15} />
            Add category
          </Button>
        </div>
      </form>

      <div className="category-list">
        {categories.length === 0 ? (
          <Empty title="No categories yet">Add one above to start grouping cost lines.</Empty>
        ) : (
          BUDGET_GROUP_ORDER.map((groupName) => {
            const rows = categories.filter((category) => category.group === groupName)
            if (rows.length === 0) return null
            return (
              <div key={groupName} className="category-group">
                <div className="category-group-title">{BUDGET_GROUP_LABEL[groupName]}</div>
                {rows.map((category) => {
                  const used = counts.get(category.categoryId) ?? 0
                  const draft = editing?.categoryId === category.categoryId ? editing : null
                  return (
                    <div key={category.categoryId} className="category-item">
                      {draft ? (
                        <>
                          <input
                            className="input"
                            value={draft.name}
                            autoFocus
                            onChange={(e) => setEditing({ ...draft, name: e.target.value })}
                          />
                          <input
                            className="input"
                            value={draft.description}
                            placeholder="Description (optional)"
                            onChange={(e) => setEditing({ ...draft, description: e.target.value })}
                          />
                          <div className="row">
                            <Button
                              size="sm"
                              type="button"
                              loading={busy === category.categoryId}
                              onClick={() => void save(category.categoryId)}
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="category-item-text">
                            <div className="category-item-name">{category.name}</div>
                            <div className="small muted">
                              {used} cost line{used === 1 ? '' : 's'}
                              {category.description ? ` · ${category.description}` : ''}
                            </div>
                          </div>
                          <div className="row">
                            <Button
                              size="sm"
                              variant="ghost"
                              type="button"
                              onClick={() =>
                                setEditing({
                                  categoryId: category.categoryId,
                                  name: category.name,
                                  description: category.description ?? ''
                                })
                              }
                            >
                              <IconEdit size={14} />
                              Rename
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              type="button"
                              loading={busy === category.categoryId}
                              onClick={() => void remove(category)}
                            >
                              <IconTrash size={14} />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}

/** Paste or upload a spreadsheet, then let the server validate the whole sheet. */
function BudgetImportModal({
  siteId,
  onClose,
  onImported
}: {
  siteId: string
  onClose: () => void
  onImported: () => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const parsed = useMemo(() => parseImport(text), [text])

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setText(await file.text())
    setError(null)
    setDone(null)
  }

  function downloadTemplate() {
    const sample = [
      IMPORT_COLUMNS.join(','),
      'Hard costs,Structure,,Framing,120000,0,0',
      'Soft costs,Permits & fees,A.01,Building permit,9500,4200,546'
    ].join('\r\n')
    downloadCsv('budget-template.csv', sample)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const { rows, error: parseError } = parseImport(text)
    if (parseError) {
      setError(parseError)
      return
    }
    if (rows.length === 0) {
      setError('Paste or upload some rows first')
      return
    }
    if (
      mode === 'replace' &&
      !window.confirm('Replace mode deletes every existing cost line and category on this project first. Continue?')
    ) {
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await api<{ linesCreated: number; categoriesCreated: number }>(
        `/sites/${siteId}/budget/import`,
        { method: 'POST', body: { rows, mode } }
      )
      setDone(
        `Imported ${res.linesCreated} cost line${res.linesCreated === 1 ? '' : 's'} and created ${res.categoriesCreated} categor${res.categoriesCreated === 1 ? 'y' : 'ies'}.`
      )
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the budget')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Import budget"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={downloadTemplate} disabled={busy}>
            <IconDownload size={15} />
            Template
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="budget-import-form" type="submit" loading={busy} disabled={parsed.rows.length === 0}>
            Import {parsed.rows.length > 0 ? `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <form id="budget-import-form" onSubmit={submit}>
        <ErrorNote message={error} />
        {done ? <div className="alert alert-info" style={{ marginBottom: 14 }}>{done}</div> : null}

        <p className="small muted" style={{ marginBottom: 14 }}>
          Columns: <span className="mono">group, category, code, name, budget, spent, hst</span>. Group is
          <em> Land</em>, <em>Soft costs</em> or <em>Hard costs</em>. Categories are created automatically when
          they do not exist yet.
        </p>

        <Field label="Spreadsheet file" hint="CSV or tab separated. The header row is optional.">
          <input className="input" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={pickFile} />
        </Field>

        <Field label="Or paste rows">
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
              setDone(null)
            }}
            placeholder={'Hard costs,Structure,,Framing,120000,0,0'}
          />
        </Field>

        {text.trim() ? (
          <div className={`budget-import-preview${parsed.error ? ' is-error' : ''}`}>
            {parsed.error
              ? parsed.error
              : `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} parsed and ready to import.`}
          </div>
        ) : null}

        <div className="mode-row">
          <label className={`mode-option${mode === 'append' ? ' on' : ''}`}>
            <input type="radio" name="budget-import-mode" checked={mode === 'append'} onChange={() => setMode('append')} />
            <span>
              <strong>Append</strong>
              <span className="small muted">Keep what is already there and add the new rows.</span>
            </span>
          </label>
          <label className={`mode-option${mode === 'replace' ? ' on' : ''}`}>
            <input type="radio" name="budget-import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span>
              <strong>Replace</strong>
              <span className="small muted">Clear every cost line and category first.</span>
            </span>
          </label>
        </div>
      </form>
    </Modal>
  )
}

/* --------------------------------- files --------------------------------- */

/** Signed thumbnail URLs are fetched in small batches to avoid flooding the API. */
const THUMB_CONCURRENCY = 4

/** Sentinel for the "show everything" filter. */
const ALL_FILES = 'all'

function FolderFormModal({
  siteId,
  folder,
  onClose,
  onSaved
}: {
  siteId: string
  folder?: AssetFolderRecord
  onClose: () => void
  onSaved: (folder: AssetFolderRecord) => void
}) {
  const [name, setName] = useState(folder?.name ?? '')
  const [description, setDescription] = useState(folder?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the folder a name')
      return
    }
    setBusy(true)
    setError(null)
    const body = { name: name.trim(), description: description.trim() || undefined }
    try {
      if (folder) {
        await api(`/sites/${siteId}/folders/${folder.folderId}`, { method: 'PATCH', body })
        onSaved({ ...folder, name: body.name, description: body.description, updatedAt: new Date().toISOString() })
      } else {
        const res = await api<{ folder: AssetFolderRecord }>(`/sites/${siteId}/folders`, { method: 'POST', body })
        onSaved(res.folder)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the folder')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={folder ? 'Edit folder' : 'New folder'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="folder-form" type="submit" loading={busy}>
            {folder ? 'Save folder' : 'Create folder'}
          </Button>
        </>
      }
    >
      <form id="folder-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}
        <Field label="Folder name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Construction, Materials, Finance"
            autoFocus
          />
        </Field>
        <Field label="Description" hint="Optional. Helps the team know what belongs here.">
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Daily site photos and progress reports"
          />
        </Field>
      </form>
    </Modal>
  )
}

function FilesTab({
  siteId,
  canWrite,
  isAdmin
}: {
  siteId: string
  canWrite: boolean
  isAdmin: boolean
}) {
  const { data, error, loading, reload } = useApi<{ assets: AssetRecord[] }>(`/sites/${siteId}/assets`)
  const { data: folderData, reload: reloadFolders } = useApi<{ folders: AssetFolderRecord[] }>(
    `/sites/${siteId}/folders`
  )
  const { user } = useAuth()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string>(ALL_FILES)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [editingFolder, setEditingFolder] = useState<AssetFolderRecord | null>(null)

  // Thumbnails need a signed URL each. Requesting them all at once saturates the
  // browser's connection pool and stalls every other call, so they are fetched by
  // a small worker pool and merged in as they arrive.
  useEffect(() => {
    if (!data) return
    let cancelled = false
    const queue = data.assets.filter((a) => a.type === 'image').map((a) => a.assetId)

    void (async () => {
      const workers = Array.from({ length: THUMB_CONCURRENCY }, async () => {
        while (queue.length) {
          const assetId = queue.shift()
          if (!assetId || cancelled) return
          try {
            const res = await api<{ url: string }>(`/sites/${siteId}/assets/${assetId}/url`)
            if (cancelled) return
            setUrls((prev) => ({ ...prev, [assetId]: res.url }))
          } catch {
            /* a thumbnail that can't be signed is simply not shown */
          }
        }
      })
      await Promise.all(workers)
    })()

    return () => {
      cancelled = true
    }
  }, [data, siteId])

  async function openAsset(asset: AssetRecord) {
    setBusyId(asset.assetId)
    setActionError(null)
    try {
      const res = await api<{ url: string }>(`/sites/${siteId}/assets/${asset.assetId}/url`)
      window.open(res.url, '_blank', 'noopener')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open the file')
    } finally {
      setBusyId(null)
    }
  }

  async function removeAsset(asset: AssetRecord) {
    if (!window.confirm(`Delete "${asset.name}"?`)) return
    setBusyId(asset.assetId)
    setActionError(null)
    try {
      await api(`/sites/${siteId}/assets/${asset.assetId}`, { method: 'DELETE' })
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the file')
    } finally {
      setBusyId(null)
    }
  }

  async function removeFolder(folder: AssetFolderRecord) {
    if (
      !window.confirm(
        `Delete the folder "${folder.name}"? Files inside it move to the project root — no files are deleted.`
      )
    ) {
      return
    }
    setBusyId(folder.folderId)
    setActionError(null)
    try {
      await api(`/sites/${siteId}/folders/${folder.folderId}`, { method: 'DELETE' })
      setSelected(ALL_FILES)
      await Promise.all([reload(), reloadFolders()])
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the folder')
    } finally {
      setBusyId(null)
    }
  }

  const assets = data?.assets ?? []
  const folders = folderData?.folders ?? []
  const countIn = (folderId: string) => assets.filter((a) => a.folderId === folderId).length
  // A folder that vanished (deleted elsewhere) silently falls back to the full list.
  const activeFolder = folders.find((f) => f.folderId === selected) ?? null
  const visible = activeFolder ? assets.filter((a) => a.folderId === activeFolder.folderId) : assets
  const folderName = (folderId?: string) =>
    folderId ? folders.find((f) => f.folderId === folderId)?.name : undefined

  return (
    <div className="stack">
      <ErrorNote message={error ?? actionError} />

      <div className="folder-bar">
        <button
          className={`folder-chip${activeFolder ? '' : ' active'}`}
          onClick={() => setSelected(ALL_FILES)}
        >
          <IconFolder size={15} />
          All files
          <span className="folder-count">{assets.length}</span>
        </button>
        {folders.map((folder) => (
          <button
            key={folder.folderId}
            className={`folder-chip${activeFolder?.folderId === folder.folderId ? ' active' : ''}`}
            onClick={() => setSelected(folder.folderId)}
            title={folder.description || folder.name}
          >
            <IconFolder size={15} />
            {folder.name}
            <span className="folder-count">{countIn(folder.folderId)}</span>
          </button>
        ))}
        {isAdmin ? (
          <button className="folder-chip folder-chip-add" onClick={() => setCreatingFolder(true)}>
            <IconPlus size={15} />
            New folder
          </button>
        ) : null}
      </div>

      {canWrite ? (
        <Card>
          <CardHeader
            title={activeFolder ? `Upload to ${activeFolder.name}` : 'Upload files'}
            sub={
              activeFolder
                ? activeFolder.description || 'Photos and documents added here stay in this folder'
                : 'Files without a folder land in the project root'
            }
          />
          <div className="card-body">
            <Uploader
              siteId={siteId}
              folderId={activeFolder?.folderId}
              onUploaded={() => void reload()}
            />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title={activeFolder ? activeFolder.name : 'Project files'}
          sub={
            `${visible.length} item${visible.length === 1 ? '' : 's'}` +
            (activeFolder ? ` · ${assets.length} in project` : '')
          }
          action={
            activeFolder && isAdmin ? (
              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === activeFolder.folderId}
                  onClick={() => setEditingFolder(activeFolder)}
                >
                  <IconEdit size={14} />
                  Edit folder
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busyId === activeFolder.folderId}
                  onClick={() => void removeFolder(activeFolder)}
                >
                  <IconTrash size={14} />
                  Delete folder
                </Button>
              </div>
            ) : undefined
          }
        />
        <div className="card-body">
          {loading && !data ? (
            <Loading />
          ) : visible.length === 0 ? (
            <Empty title={activeFolder ? 'This folder is empty' : 'No files yet'}>
              {canWrite
                ? activeFolder
                  ? 'Drop photos or documents above to add them here.'
                  : 'Drop site photos or documents above to get started.'
                : 'Nothing has been uploaded yet.'}
            </Empty>
          ) : (
            <div className="file-grid">
              {visible.map((asset) => (
                <div className="file-card" key={asset.assetId}>
                  <div className="file-thumb">
                    {asset.type === 'image' && urls[asset.assetId] ? (
                      <img src={urls[asset.assetId]} alt={asset.name} />
                    ) : asset.type === 'image' ? (
                      <IconImage size={26} />
                    ) : (
                      <IconFile size={26} />
                    )}
                  </div>
                  <div className="file-meta">
                    <div className="file-name" title={asset.name}>
                      {asset.name}
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {humanBytes(asset.size)} · {relativeTime(asset.uploadedAt)}
                    </div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      {asset.uploadedByName}
                    </div>
                    {!activeFolder && folderName(asset.folderId) ? (
                      <div className="file-folder">
                        <IconFolder size={12} />
                        {folderName(asset.folderId)}
                      </div>
                    ) : null}
                    <div className="row" style={{ marginTop: 8, gap: 6 }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === asset.assetId}
                        onClick={() => void openAsset(asset)}
                      >
                        Open
                      </Button>
                      {user?.role === 'admin' || asset.uploadedBy === user?.userId ? (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busyId === asset.assetId}
                          onClick={() => void removeAsset(asset)}
                        >
                          <IconTrash size={14} />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {creatingFolder ? (
        <FolderFormModal
          siteId={siteId}
          onClose={() => setCreatingFolder(false)}
          onSaved={(folder) => {
            setCreatingFolder(false)
            setSelected(folder.folderId)
            void reloadFolders()
          }}
        />
      ) : null}

      {editingFolder ? (
        <FolderFormModal
          siteId={siteId}
          folder={editingFolder}
          onClose={() => setEditingFolder(null)}
          onSaved={() => {
            setEditingFolder(null)
            void reloadFolders()
          }}
        />
      ) : null}
    </div>
  )
}

/* -------------------------------- remarks -------------------------------- */

function RemarksTab({
  siteId,
  stages,
  canWrite
}: {
  siteId: string
  stages: StageRecord[]
  canWrite: boolean
}) {
  const { data, error, loading, reload } = useApi<{ remarks: RemarkRecord[] }>(`/sites/${siteId}/remarks`)
  const { user } = useAuth()
  const [text, setText] = useState('')
  const [stageId, setStageId] = useState('')
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  async function post(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setPostError(null)
    try {
      await api(`/sites/${siteId}/remarks`, {
        method: 'POST',
        body: { text: text.trim(), stageId: stageId || undefined }
      })
      setText('')
      await reload()
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Could not post the remark')
    } finally {
      setBusy(false)
    }
  }

  async function remove(remark: RemarkRecord) {
    if (!window.confirm('Delete this remark?')) return
    try {
      await api(`/sites/${siteId}/remarks/${remark.remarkId}`, { method: 'DELETE' })
      await reload()
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Could not delete the remark')
    }
  }

  const remarks = data?.remarks ?? []

  return (
    <div className="stack">
      <ErrorNote message={error ?? postError} />

      {canWrite ? (
        <Card>
          <CardHeader title="Add a remark" sub="Notes are visible to everyone with access to this project" />
          <form className="card-body" onSubmit={post}>
            <Field label="Remark">
              <textarea
                className="textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Progress update, issue, inspection note…"
              />
            </Field>
            {stages.length > 0 ? (
              <Field label="Related stage (optional)">
                <select className="select" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  <option value="">General</option>
                  {stages.map((s) => (
                    <option key={s.stageId} value={s.stageId}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Button type="submit" loading={busy}>
              Post remark
            </Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Activity" sub={`${remarks.length} remark${remarks.length === 1 ? '' : 's'}`} />
        <div className="card-body">
          {loading && !data ? (
            <Loading />
          ) : remarks.length === 0 ? (
            <Empty title="No remarks yet">
              {canWrite ? 'Post the first update for this project.' : 'Nothing has been noted yet.'}
            </Empty>
          ) : (
            <div className="timeline">
              {remarks.map((remark) => {
                const stage = stages.find((s) => s.stageId === remark.stageId)
                return (
                  <div className="timeline-item" key={remark.remarkId}>
                    <span className="timeline-dot" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row-between">
                        <div className="row" style={{ gap: 8 }}>
                          <Avatar name={remark.authorName} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{remark.authorName}</div>
                            <div className="small muted">
                              {relativeTime(remark.createdAt)} · {remark.authorRole}
                              {stage ? ` · ${stage.name}` : ''}
                            </div>
                          </div>
                        </div>
                        {user?.role === 'admin' || remark.authorId === user?.userId ? (
                          <Button variant="ghost" size="sm" onClick={() => void remove(remark)}>
                            <IconTrash size={14} />
                          </Button>
                        ) : null}
                      </div>
                      <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{remark.text}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
