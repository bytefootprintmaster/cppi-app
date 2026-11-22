import { useMemo, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { SiteRecord, SiteStatus } from '../../server/types'
import { Button, Field, Modal, useDiscardGuard } from './ui'

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

/** Which field a validation failure belongs to, so it can be marked inline. */
type InvalidField = 'name' | 'coords' | 'location'

/** The form's starting values — also the baseline the unsaved-changes check compares against. */
function blankForm(site?: SiteRecord | null) {
  return {
    name: site?.name ?? '',
    code: site?.code ?? '',
    status: (site?.status ?? 'planning') as SiteStatus,
    description: site?.description ?? '',
    startDate: site?.startDate ?? '',
    targetDate: site?.targetDate ?? '',
    // Structured address — what GIS maps geolocate against.
    address: site?.address ?? '',
    city: site?.city ?? '',
    region: site?.region ?? '',
    postalCode: site?.postalCode ?? '',
    country: site?.country ?? '',
    // Pins which town's by-laws and forms this project follows. Blank = derive
    // the jurisdiction from the city on save.
    regulationsPlace: site?.regulationsPlace ?? '',
    // Coordinates may be typed by hand to place the pin exactly.
    lat: site?.lat !== undefined ? String(site.lat) : '',
    lng: site?.lng !== undefined ? String(site.lng) : ''
  }
}

export function SiteFormModal({ site, onClose, onSaved }: Props) {
  const editing = Boolean(site)
  const initial = useMemo(() => blankForm(site), [site])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalidField, setInvalidField] = useState<InvalidField | null>(null)
  const [form, setForm] = useState(initial)

  // Closing a half-filled form is the easiest way to lose work in the whole app,
  // so every exit route — Escape, backdrop, X and Cancel — goes through here.
  const dirty = useMemo(
    () => (Object.keys(initial) as Array<keyof typeof initial>).some((key) => form[key] !== initial[key]),
    [form, initial]
  )
  const guardClose = useDiscardGuard(dirty, onClose)

  function requestClose() {
    if (busy) return
    void guardClose()
  }

  // The jurisdictions that have a corpus, for the picker below.
  const places = useApi<{ places: Array<{ place: string; placeName: string }> }>('/regulations')
  const placeOptions = useMemo(() => {
    const list = places.data?.places ?? []
    // A pinned jurisdiction that is no longer in the list must still show, or
    // editing an unrelated field would silently drop the override.
    if (form.regulationsPlace && !list.some((p) => p.place === form.regulationsPlace)) {
      return [...list, { place: form.regulationsPlace, placeName: form.regulationsPlace }]
    }
    return list
  }, [places.data, form.regulationsPlace])

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    // Clear a stale validation message as soon as the user starts fixing it.
    if (error) {
      setError(null)
      setInvalidField(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) {
      setError('Project name is required')
      setInvalidField('name')
      return
    }
    if (Boolean(form.lat.trim()) !== Boolean(form.lng.trim())) {
      setError('Enter both latitude and longitude, or leave both blank')
      setInvalidField('coords')
      return
    }
    if (!form.address.trim() && !form.city.trim()) {
      setError('Enter a street address, or at least a city so the map can place the pin')
      setInvalidField('location')
      return
    }
    setBusy(true)
    setError(null)
    setInvalidField(null)

    const body = {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      status: form.status,
      description: form.description.trim() || undefined,
      startDate: form.startDate || undefined,
      targetDate: form.targetDate || undefined,
      address: form.address.trim(),
      city: form.city.trim(),
      region: form.region.trim(),
      postalCode: form.postalCode.trim(),
      country: form.country.trim(),
      regulationsPlace: form.regulationsPlace,
      lat: form.lat.trim() ? Number(form.lat) : undefined,
      lng: form.lng.trim() ? Number(form.lng) : undefined
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
      onClose={requestClose}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button form="site-form" type="submit" loading={busy}>
            {editing ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="site-form" onSubmit={submit}>
        {error ? (
          <div id="site-form-error" className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        ) : null}

        <Field label="Project name">
          <input
            className="input"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Riverside Apartments — Phase 2"
            aria-required="true"
            aria-invalid={invalidField === 'name' || undefined}
            aria-describedby={invalidField === 'name' ? 'site-form-error' : undefined}
          />
        </Field>

        <div className="grid grid-2">
          <Field label="Project code" hint="Optional internal reference">
            <input className="input" value={form.code} onChange={(e) => set('code', e.target.value)} />
          </Field>
          <Field label="Status">
            <select className="select" value={form.status} onChange={(e) => set('status', e.target.value as SiteStatus)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="section-title">Address</div>
        <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>
          The full address is what the GIS map places the pin from. City alone is only a fallback.
        </p>

        <Field label="Full street address">
          <input
            className="input"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="e.g. 27 Mandrake Street"
            aria-invalid={invalidField === 'location' || undefined}
            aria-describedby={invalidField === 'location' ? 'site-form-error' : undefined}
          />
        </Field>

        <div className="grid grid-2">
          <Field label="City">
            <input
              className="input"
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              placeholder="e.g. Toronto"
              aria-invalid={invalidField === 'location' || undefined}
              aria-describedby={invalidField === 'location' ? 'site-form-error' : undefined}
            />
          </Field>
          <Field label="Province / State">
            <input className="input" value={form.region} onChange={(e) => set('region', e.target.value)} placeholder="e.g. ON" />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Postal code">
            <input
              className="input"
              value={form.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
              placeholder="e.g. M5V 2T6"
            />
          </Field>
          <Field label="Country">
            <input className="input" value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="e.g. Canada" />
          </Field>
        </div>

        <Field
          label="Regulations jurisdiction"
          hint={
            places.data && places.data.places.length === 0
              ? 'No jurisdictions have been ingested yet.'
              : 'Matched from the city automatically. Pick one to pin the by-laws, forms and fees this project must follow.'
          }
        >
          <select
            className="select"
            value={form.regulationsPlace}
            onChange={(e) => set('regulationsPlace', e.target.value)}
          >
            <option value="">Match automatically from the city</option>
            {placeOptions.map((place) => (
              <option key={place.place} value={place.place}>
                {place.placeName}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-2">
          <Field label="Latitude" hint="Optional — leave blank to geocode from the address">
            <input
              className="input"
              type="number"
              step="any"
              value={form.lat}
              onChange={(e) => set('lat', e.target.value)}
              placeholder="e.g. 43.6426"
              aria-invalid={invalidField === 'coords' || undefined}
              aria-describedby={invalidField === 'coords' ? 'site-form-error' : undefined}
            />
          </Field>
          <Field label="Longitude" hint="Optional — paired with latitude">
            <input
              className="input"
              type="number"
              step="any"
              value={form.lng}
              onChange={(e) => set('lng', e.target.value)}
              placeholder="e.g. -79.3871"
              aria-invalid={invalidField === 'coords' || undefined}
              aria-describedby={invalidField === 'coords' ? 'site-form-error' : undefined}
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
