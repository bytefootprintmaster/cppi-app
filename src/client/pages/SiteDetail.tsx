import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { formatDate, formatDateTime, humanBytes, relativeTime } from '../lib/format'
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
  IconFile,
  IconImage,
  IconPlus,
  IconTrash
} from '../components/icons'
import type {
  AssetRecord,
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

type Tab = 'overview' | 'framework' | 'files' | 'remarks'

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

  const { site, stages, milestones, progress } = data

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
          {site.budget != null ? <Badge tone="blue">Budget {site.budget.toLocaleString()}</Badge> : null}
        </div>

        <div className="tabs" style={{ marginBottom: 20 }}>
          {(
            [
              ['overview', 'Overview'],
              ['framework', 'Framework'],
              ['files', 'Files'],
              ['remarks', 'Remarks']
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' ? <OverviewTab site={site} progress={progress} /> : null}
        {tab === 'framework' ? (
          <FrameworkTab siteId={site.siteId} stages={stages} milestones={milestones} isAdmin={isAdmin} onChanged={reload} />
        ) : null}
        {tab === 'files' ? <FilesTab siteId={site.siteId} canWrite={canWrite} /> : null}
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
  progress
}: {
  site: SiteRecord
  progress: SiteDetailResponse['progress']
}) {
  const facts: Array<[string, string]> = [
    ['Location', site.location || '—'],
    ['Start date', formatDate(site.startDate)],
    ['Target completion', formatDate(site.targetDate)],
    ['Budget', site.budget != null ? site.budget.toLocaleString() : '—'],
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
          <Button onClick={() => setStageModal({ stage: null })}>
            <IconPlus size={16} />
            Add stage
          </Button>
        ) : null}
      </div>

      {stages.length === 0 ? (
        <Card>
          <Empty title="No stages defined">
            {isAdmin
              ? 'Add your first stage — for example “Site preparation”, “Foundation”, “Structure”, “Finishes”.'
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

/* --------------------------------- files --------------------------------- */

function FilesTab({ siteId, canWrite }: { siteId: string; canWrite: boolean }) {
  const { data, error, loading, reload } = useApi<{ assets: AssetRecord[] }>(`/sites/${siteId}/assets`)
  const { user } = useAuth()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    let cancelled = false
    const images = data.assets.filter((a) => a.type === 'image')
    void (async () => {
      const pairs = await Promise.all(
        images.map(async (asset) => {
          try {
            const res = await api<{ url: string }>(`/sites/${siteId}/assets/${asset.assetId}/url`)
            return [asset.assetId, res.url] as [string, string]
          } catch {
            return null
          }
        })
      )
      if (cancelled) return
      setUrls(Object.fromEntries(pairs.filter((p): p is [string, string] => p !== null)))
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

  const assets = data?.assets ?? []

  return (
    <div className="stack">
      <ErrorNote message={error ?? actionError} />

      {canWrite ? (
        <Card>
          <CardHeader title="Upload files" sub="Photos and documents are stored privately in object storage" />
          <div className="card-body">
            <Uploader siteId={siteId} onUploaded={() => void reload()} />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Project files" sub={`${assets.length} item${assets.length === 1 ? '' : 's'}`} />
        <div className="card-body">
          {loading && !data ? (
            <Loading />
          ) : assets.length === 0 ? (
            <Empty title="No files yet">
              {canWrite ? 'Drop site photos or documents above to get started.' : 'Nothing has been uploaded yet.'}
            </Empty>
          ) : (
            <div className="file-grid">
              {assets.map((asset) => (
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
