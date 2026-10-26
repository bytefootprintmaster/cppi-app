import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import type { SiteRecord, SiteStatus } from '../../server/types'
import { Button, Field, Modal } from './ui'

const STATUS_OPTIONS: Array<{ value: SiteStatus; label: string }> = [
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'completed', label: 'Completed' }
]

interface Props {
  /** Pass a site to edit; omit to create. */
  site?: SiteRecord | null
  onClose: () => void
  onSaved: () => void
}

export function SiteFormModal({ site, onClose, onSaved }: Props) {
  const editing = Boolean(site)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: site?.name ?? '',
    code: site?.code ?? '',
    location: site?.location ?? '',
    status: (site?.status ?? 'planning') as SiteStatus,
    description: site?.description ?? '',
    startDate: site?.startDate ?? '',
    targetDate: site?.targetDate ?? '',
    budget: site?.budget != null ? String(site.budget) : ''
  })

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) {
      setError('Project name is required')
      return
    }
    setBusy(true)
    setError(null)

    const body = {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      location: form.location.trim() || undefined,
      status: form.status,
      description: form.description.trim() || undefined,
      startDate: form.startDate || undefined,
      targetDate: form.targetDate || undefined,
      budget: form.budget === '' ? undefined : Number(form.budget)
    }

    try {
      if (editing) {
        await api(`/sites/${site!.siteId}`, { method: 'PATCH', body })
      } else {
        await api('/sites', { method: 'POST', body })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Edit project' : 'New project'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="site-form" type="submit" loading={busy}>
            {editing ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="site-form" onSubmit={submit}>
        {error ? <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div> : null}

        <Field label="Project name">
          <input
            className="input"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Riverside Apartments — Phase 2"
          />
        </Field>

        <div className="grid grid-2">
          <Field label="Project code" hint="Optional internal reference">
            <input className="input" value={form.code} onChange={(e) => set('code', e.target.value)} />
          </Field>
          <Field label="Location">
            <input
              className="input"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="City / site address"
            />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Status">
            <select className="select" value={form.status} onChange={(e) => set('status', e.target.value as SiteStatus)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Budget" hint="Optional, in your local currency">
            <input
              className="input"
              type="number"
              min="0"
              value={form.budget}
              onChange={(e) => set('budget', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Start date">
            <input className="input" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label="Target completion">
            <input className="input" type="date" value={form.targetDate} onChange={(e) => set('targetDate', e.target.value)} />
          </Field>
        </div>

        <Field label="Description">
          <textarea
            className="textarea"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Scope, notes, key stakeholders…"
          />
        </Field>
      </form>
    </Modal>
  )
}
