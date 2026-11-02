import { useEffect, useState, type FormEvent } from 'react'
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
  IconEdit,
  IconFile,
  IconFolder,
  IconImage,
  IconPlus,
  IconTrash
} from '../components/icons'
import type { BudgetSummary } from '../../server/services'
import type {
  AssetFolderRecord,
  AssetRecord,
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

  const { site, stages, milestones, budgetLines, budget, progress } = data

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

function BudgetTab({
  siteId,
  lines,
  summary,
  isAdmin,
  onChanged
}: {
  siteId: string
  lines: BudgetLineRecord[]
  summary: BudgetSummary
  isAdmin: boolean
  onChanged: () => void
}) {
  const [modal, setModal] = useState<{ line: BudgetLineRecord | null; group: BudgetGroup } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function remove(line: BudgetLineRecord) {
    if (!window.confirm(`Delete the budget line "${line.name}"?`)) return
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

  const columns = isAdmin ? 6 : 5

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

      {lines.length === 0 ? (
        <Card>
          <Empty title="No budget yet">
            {isAdmin
              ? 'Add land, soft cost and hard cost lines to start tracking spend against this project.'
              : 'The administrator has not set a budget for this project yet.'}
          </Empty>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Cost breakdown"
            sub={`${formatMoney(summary.budgeted)} budgeted · ${formatMoney(summary.paid)} paid`}
            action={
              isAdmin ? (
                <Button variant="ghost" size="sm" onClick={() => setModal({ line: null, group: 'hard' })}>
                  <IconPlus size={14} />
                  Add line
                </Button>
              ) : undefined
            }
          />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Budget</th>
                  <th className="num">Spent</th>
                  <th className="num">HST</th>
                  <th className="num">Remaining</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              {BUDGET_GROUP_ORDER.map((group) => {
                const rows = lines.filter((line) => line.group === group)
                if (rows.length === 0) return null
                const subtotal = summary.groups.find((g) => g.group === group)
                return (
                  <tbody key={group}>
                    <tr className="group-row">
                      <td colSpan={columns}>{BUDGET_GROUP_LABEL[group]}</td>
                    </tr>
                    {rows.map((line) => {
                      const remaining = Math.round((line.budget - line.spent) * 100) / 100
                      return (
                        <tr key={line.lineId}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{line.name}</div>
                            {line.code ? <div className="small muted mono">{line.code}</div> : null}
                          </td>
                          <td className="num">{formatMoney(line.budget)}</td>
                          <td className="num">{formatMoney(line.spent)}</td>
                          <td className="num">{formatMoney(line.hst)}</td>
                          <td className={`num${remaining < 0 ? ' money-over' : ''}`}>{formatMoney(remaining)}</td>
                          {isAdmin ? (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <Button variant="ghost" size="sm" onClick={() => setModal({ line, group })}>
                                Edit
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
                    <tr className="subtotal">
                      <td>Subtotal — {BUDGET_GROUP_LABEL[group]}</td>
                      <td className="num">{formatMoney(subtotal?.budget ?? 0)}</td>
                      <td className="num">{formatMoney(subtotal?.spent ?? 0)}</td>
                      <td className="num">{formatMoney(subtotal?.hst ?? 0)}</td>
                      <td className="num">{formatMoney((subtotal?.budget ?? 0) - (subtotal?.spent ?? 0))}</td>
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
                  <td className="num">{formatMoney(summary.remaining)}</td>
                  {isAdmin ? <td /> : null}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {isAdmin ? (
        <div>
          <Button variant="ghost" onClick={() => setModal({ line: null, group: 'hard' })}>
            <IconPlus size={16} />
            Add cost line
          </Button>
        </div>
      ) : null}

      {modal ? (
        <BudgetLineFormModal
          siteId={siteId}
          line={modal.line}
          defaultGroup={modal.group}
          nextOrder={lines.length}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

function BudgetLineFormModal({
  siteId,
  line,
  defaultGroup,
  nextOrder,
  onClose,
  onSaved
}: {
  siteId: string
  line: BudgetLineRecord | null
  defaultGroup: BudgetGroup
  nextOrder: number
  onClose: () => void
  onSaved: () => void
}) {
  const [group, setGroup] = useState<BudgetGroup>(line?.group ?? defaultGroup)
  const [code, setCode] = useState(line?.code ?? '')
  const [name, setName] = useState(line?.name ?? '')
  const [budget, setBudget] = useState(line ? String(line.budget) : '')
  const [spent, setSpent] = useState(line ? String(line.spent) : '')
  const [hst, setHst] = useState(line ? String(line.hst) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the cost line a name')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      group,
      code: code.trim() || undefined,
      name: name.trim(),
      budget: budget === '' ? 0 : Number(budget),
      spent: spent === '' ? 0 : Number(spent),
      hst: hst === '' ? 0 : Number(hst),
      order: line?.order ?? nextOrder
    }
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
          <Field label="Group">
            <select className="select" value={group} onChange={(e) => setGroup(e.target.value as BudgetGroup)}>
              {BUDGET_GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cost code" hint="Optional, e.g. H.06 10 00">
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
        <Field label="Item">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Framing"
            autoFocus
          />
        </Field>
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
