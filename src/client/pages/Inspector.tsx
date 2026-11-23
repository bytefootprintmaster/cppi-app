import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useApi } from '../lib/useApi'
import { uploadSiteFile } from '../lib/upload'
import { useVoiceInput } from '../lib/useVoiceInput'
import { humanBytes, relativeTime, formatDateTime } from '../lib/format'
import { Button, Empty, ErrorNote, Loading, Modal, useToast } from '../components/ui'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconFile,
  IconLogOut,
  IconMapPin,
  IconMic,
  IconRefresh,
  IconSend,
  IconUpload,
  IconX
} from '../components/icons'
import type { SiteReportView } from '../../server/types'

/* -------------------------------- helpers -------------------------------- */

interface SiteOption {
  siteId: string
  name: string
  code?: string
  location?: string
  address?: string
  distanceM: number | null
}

interface ResolveResponse {
  match: (SiteOption & { confident: boolean }) | null
  sites: SiteOption[]
  canGeolocate: boolean
}

type ItemStatus = 'ready' | 'uploading' | 'done' | 'error'

interface FieldItem {
  id: string
  file: File
  kind: 'photo' | 'document'
  status: ItemStatus
  assetId?: string
  error?: string
  /** Object URL for a photo thumbnail; revoked when the item goes away. */
  previewUrl?: string
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** The distance a person would say out loud, mirroring the server's wording. */
function describeDistance(metres: number | null): string | null {
  if (metres === null) return null
  if (metres < 30) return 'You are on site'
  if (metres < 1000) return `About ${Math.round(metres / 10) * 10} m away`
  return `About ${(metres / 1000).toFixed(1)} km away`
}

/** Run `worker` over `list` with at most `limit` in flight — kind to phone data. */
async function runWithLimit<T>(list: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next
      next += 1
      await worker(list[index])
    }
  })
  await Promise.all(runners)
}

/* --------------------------------- shell --------------------------------- */

function FieldShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth()
  // This is the whole app for a site inspector, so there is nothing to go back
  // to. An office user opening it from the admin area does need a way out, and
  // their own name is the least useful thing to spend the header on.
  const previewing = user?.surface !== 'inspector'
  return (
    <div className="field-shell">
      <header className="field-top">
        <img className="field-logo" src="/cppi-logo.svg" alt="CPPI" />
        {previewing ? (
          <Link className="field-office-back" to="/">
            <IconChevronRight size={18} style={{ transform: 'rotate(180deg)' }} />
            <span>Back to office</span>
          </Link>
        ) : (
          <div className="field-top-name">{user?.name?.split(' ')[0] ?? 'Site'}</div>
        )}
        <button type="button" className="field-signout" onClick={signOut}>
          <IconLogOut size={18} />
          <span>Sign out</span>
        </button>
      </header>
      <main className="field-main">{children}</main>
    </div>
  )
}

/* ------------------------------ caption tile ------------------------------ */

function FieldTile({
  icon,
  label,
  hint,
  tone,
  count,
  badge,
  onClick,
  disabled
}: {
  icon: ReactNode
  label: string
  hint: string
  tone: 'amber' | 'green' | 'blue' | 'send'
  count?: number
  badge?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`field-tile field-tile-${tone}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="field-tile-icon">{icon}</span>
      <span className="field-tile-label">{label}</span>
      <span className="field-tile-hint">{badge ?? hint}</span>
      {count && count > 0 ? <span className="field-tile-count">{count}</span> : null}
    </button>
  )
}

/* ------------------------------ camera sheet ------------------------------ */

function CameraSheet({
  count,
  onCapture,
  onClose
}: {
  count: number
  onCapture: (file: File) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<'starting' | 'live' | 'review' | 'unavailable'>('starting')
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This device does not expose a camera to the browser.')
        setMode('unavailable')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
          audio: false
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
        setMode('live')
      } catch (err) {
        if (cancelled) return
        setError(
          err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
            ? 'Camera access was blocked. Allow the camera for this site, or add a photo from this device.'
            : 'The camera could not start on this device. Add a photo from this device instead.'
        )
        setMode('unavailable')
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  // Lock the page behind the sheet and let Escape close it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  // A pending review is dropped without leaking its object URL.
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url)
  }, [shot])

  function shoot() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const at = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const name = `Site photo ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.jpg`
        const file = new File([blob], name, { type: 'image/jpeg' })
        setShot({ file, url: URL.createObjectURL(blob) })
        setMode('review')
      },
      'image/jpeg',
      0.85
    )
  }

  function approve() {
    if (shot) {
      onCapture(shot.file)
      URL.revokeObjectURL(shot.url)
    }
    setShot(null)
    setMode('live')
  }

  function retake() {
    if (shot) URL.revokeObjectURL(shot.url)
    setShot(null)
    setMode('live')
  }

  return (
    <div className="cam-sheet" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="cam-top">
        <button type="button" className="cam-btn" onClick={onClose} aria-label="Close the camera">
          <IconX size={24} />
        </button>
        <span className="cam-count">
          {count} photo{count === 1 ? '' : 's'} taken
        </span>
        <button type="button" className="cam-btn cam-done" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="cam-stage">
        {mode === 'review' && shot ? (
          <img className="cam-media" src={shot.url} alt="Photo you just took" />
        ) : mode === 'unavailable' ? (
          <div className="cam-message">
            <IconAlert size={28} />
            <p>{error}</p>
            <label className="btn btn-ghost">
              Add a photo from this device
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    onCapture(file)
                    setMode('live')
                  }
                  event.target.value = ''
                }}
              />
            </label>
          </div>
        ) : (
          <>
            <video ref={videoRef} className="cam-media" playsInline muted autoPlay />
            {mode === 'starting' ? <div className="cam-note">Starting the camera…</div> : null}
            {mode === 'live' ? <div className="cam-note">Line up the shot, then tap the button.</div> : null}
          </>
        )}
      </div>

      {mode === 'review' ? (
        <div className="cam-controls">
          <button type="button" className="cam-side" onClick={retake}>
            <IconRefresh size={22} />
            <span>Retake</span>
          </button>
          <button type="button" className="cam-shutter cam-approve" onClick={approve} aria-label="Approve photo">
            <IconCheck size={34} />
          </button>
          <span className="cam-side" aria-hidden="true" />
        </div>
      ) : mode === 'live' ? (
        <div className="cam-controls">
          <span className="cam-side" aria-hidden="true" />
          <button type="button" className="cam-shutter" onClick={shoot} aria-label="Take a photo">
            <span className="cam-shutter-ring" />
          </button>
          <span className="cam-side" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}

/* ----------------------------- dictation sheet ----------------------------- */

function DictateSheet({
  value,
  onChange,
  onClose
}: {
  value: string
  onChange: (next: string) => void
  onClose: () => void
}) {
  const valueRef = useRef(value)
  const apply = useCallback(
    (next: string) => {
      valueRef.current = next
      onChange(next)
    },
    [onChange]
  )

  const voice = useVoiceInput((phrase) => {
    const current = valueRef.current.replace(/\s+$/, '')
    apply(current ? `${current}\n${phrase}` : phrase)
  })

  const status = voice.loading
    ? 'Getting ready…'
    : voice.listening
      ? 'Listening — speak now'
      : voice.error
        ? voice.error
        : voice.supported
          ? 'Tap the microphone and speak your notes'
          : 'Voice input is not available here — you can still type.'

  return (
    <Modal
      title="Remarks"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="dictate">
        <button
          type="button"
          className={`dictate-mic${voice.listening ? ' live' : ''}`}
          onClick={voice.toggle}
          disabled={!voice.supported || voice.loading}
          aria-pressed={voice.listening}
        >
          <IconMic size={30} />
          <span>{voice.listening ? 'Stop' : 'Speak'}</span>
        </button>
        <p className={`dictate-status${voice.error ? ' error' : ''}`} role="status">
          {status}
        </p>
        <label className="label" htmlFor="field-remarks">
          Your remarks
        </label>
        <textarea
          id="field-remarks"
          className="textarea field-textarea"
          rows={7}
          value={value}
          onChange={(event) => apply(event.target.value)}
          placeholder="What you said appears here. You can also type or correct it."
        />
        <p className="hint">Everything you say lands here — edit or add anything before you send.</p>
      </div>
    </Modal>
  )
}

/* ------------------------------ site picker ------------------------------ */

function SitePicker({
  sites,
  current,
  onPick,
  onClose
}: {
  sites: SiteOption[]
  current: SiteOption | null
  onPick: (site: SiteOption) => void
  onClose: () => void
}) {
  return (
    <Modal title="Which project are you at?" onClose={onClose}>
      {sites.length === 0 ? (
        <Empty title="No projects yet">
          Ask your office to add you to a project before you send a report.
        </Empty>
      ) : (
        <ul className="site-picker">
          {sites.map((site) => (
            <li key={site.siteId}>
              <button
                type="button"
                className={`site-option${current?.siteId === site.siteId ? ' selected' : ''}`}
                onClick={() => onPick(site)}
              >
                <span className="site-option-icon">
                  <IconMapPin size={20} />
                </span>
                <span className="site-option-text">
                  <strong>{site.name}</strong>
                  <span className="small muted">
                    {[site.code, site.location || site.address, describeDistance(site.distanceM)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {current?.siteId === site.siteId ? <IconCheck size={18} /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/* ------------------------------ capture page ------------------------------ */

export function InspectorCapturePage() {
  const toast = useToast()
  const navigate = useNavigate()

  const [items, setItems] = useState<FieldItem[]>([])
  const [remarks, setRemarks] = useState('')
  const [site, setSite] = useState<SiteOption | null>(null)
  const [sites, setSites] = useState<SiteOption[]>([])
  const [locating, setLocating] = useState(true)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [dictateOpen, setDictateOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const urlsRef = useRef(new Set<string>())

  useEffect(() => {
    document.title = 'Site capture · CPPI'
  }, [])

  // Ask the device where it is, then let the server name the nearest project.
  // Geolocation may be unavailable or refused; the picker covers both.
  useEffect(() => {
    let cancelled = false

    async function resolve(latitude?: number, longitude?: number) {
      try {
        const res = await api<ResolveResponse>('/inspections/resolve-site', {
          method: 'POST',
          body: { latitude, longitude }
        })
        if (cancelled) return
        setSites(res.sites)
        if (res.match) setSite(res.match)
        else if (res.sites.length === 1) setSite(res.sites[0])
      } catch (err) {
        if (!cancelled) setLocationError(err instanceof Error ? err.message : 'Could not load your projects')
      } finally {
        if (!cancelled) setLocating(false)
      }
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      void resolve()
    } else {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (cancelled) return
          setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude })
          void resolve(position.coords.latitude, position.coords.longitude)
        },
        () => void resolve(),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 }
      )
    }

    return () => {
      cancelled = true
    }
  }, [])

  // Photo thumbnails are object URLs; release them when the screen goes away.
  useEffect(
    () => () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      urlsRef.current.clear()
    },
    []
  )

  const patch = useCallback((id: string, changes: Partial<FieldItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...changes } : item)))
  }, [])

  const addFiles = useCallback((files: File[], kind: 'photo' | 'document') => {
    const added: FieldItem[] = files.map((file) => {
      let previewUrl: string | undefined
      if (kind === 'photo') {
        previewUrl = URL.createObjectURL(file)
        urlsRef.current.add(previewUrl)
      }
      return { id: newId(), file, kind, status: 'ready', previewUrl }
    })
    setItems((prev) => [...prev, ...added])
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        urlsRef.current.delete(target.previewUrl)
      }
      return prev.filter((item) => item.id !== id)
    })
  }, [])

  const photoCount = items.filter((item) => item.kind === 'photo').length
  const documentCount = items.filter((item) => item.kind === 'document').length
  const hasContent = items.length > 0 || remarks.trim() !== ''
  const executeLabel = progress ? `Uploading ${progress.done} of ${progress.total}…` : 'Sending…'

  async function execute() {
    if (sending) return
    if (!site) {
      toast.info('Choose the project you are standing at first.')
      setPickerOpen(true)
      return
    }
    if (!hasContent) {
      toast.info('Add a photo, a file or a remark first.')
      return
    }

    setSending(true)
    const pending = items.filter((item) => !item.assetId)
    setProgress(pending.length > 0 ? { done: 0, total: pending.length } : null)

    // Anything already registered keeps its id, so a retry never re-uploads it.
    const assetIds = new Map<string, string>()
    for (const item of items) if (item.assetId) assetIds.set(item.id, item.assetId)

    let failed = 0
    let done = 0
    try {
      await runWithLimit(pending, 3, async (item) => {
        try {
          const uploaded = await uploadSiteFile(site.siteId, item.file, {
            category: item.kind === 'photo' ? 'progress' : 'other'
          })
          assetIds.set(item.id, uploaded.assetId)
          patch(item.id, { status: 'done', assetId: uploaded.assetId, error: undefined })
        } catch (err) {
          failed += 1
          patch(item.id, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Upload failed'
          })
        } finally {
          done += 1
          setProgress({ done, total: pending.length })
        }
      })

      if (failed > 0) {
        toast.error(
          `${failed} file${failed === 1 ? '' : 's'} did not upload. Check your signal and tap Execute again.`
        )
        return
      }

      const photoAssetIds = items
        .filter((item) => item.kind === 'photo')
        .map((item) => assetIds.get(item.id))
        .filter((id): id is string => Boolean(id))
      const documentAssetIds = items
        .filter((item) => item.kind === 'document')
        .map((item) => assetIds.get(item.id))
        .filter((id): id is string => Boolean(id))

      await api('/inspections/reports', {
        method: 'POST',
        body: {
          siteId: site.siteId,
          remarks: remarks.trim() || undefined,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          photoAssetIds,
          documentAssetIds
        }
      })

      items.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl)
          urlsRef.current.delete(item.previewUrl)
        }
      })
      setItems([])
      setRemarks('')
      toast.success(`Report sent to ${site.name}.`)
      navigate('/inspector/reports')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The report could not be sent.')
    } finally {
      setSending(false)
      setProgress(null)
    }
  }

  const siteNote = useMemo(() => {
    if (locationError) return 'Tap to choose your project'
    if (!site) return locating ? 'Finding where you are…' : 'Tap to choose your project'
    return describeDistance(site.distanceM) ?? 'Position saved with your report'
  }, [locationError, locating, site])

  return (
    <FieldShell>
      <h1 className="sr-only">Site capture — photos, files and remarks for your project</h1>
      <button type="button" className="field-site" onClick={() => setPickerOpen(true)}>
        <span className="field-site-pin">
          <IconMapPin size={22} />
        </span>
        <span className="field-site-text">
          <span className="field-site-name">{site ? site.name : locating ? 'Finding your project…' : 'Choose your project'}</span>
          <span className="field-site-note">{siteNote}</span>
        </span>
        <IconChevronRight size={20} />
      </button>

      {sites.length === 0 && !locating ? (
        <div className="field-warning">
          <IconAlert size={18} />
          <span>You are not on any project yet. Ask your office to add you, then come back.</span>
        </div>
      ) : null}

      <div className="field-grid">
        <FieldTile
          tone="amber"
          icon={<IconMic size={42} />}
          label="Dictate"
          hint="Say your notes"
          badge={remarks.trim() ? 'Remarks added' : undefined}
          onClick={() => setDictateOpen(true)}
        />
        <FieldTile
          tone="green"
          icon={<IconCamera size={42} />}
          label="Camera"
          hint="Take photos"
          count={photoCount}
          onClick={() => setCameraOpen(true)}
        />
        <FieldTile
          tone="blue"
          icon={<IconUpload size={42} />}
          label="Files"
          hint="Add documents"
          count={documentCount}
          onClick={() => fileInputRef.current?.click()}
        />
        <FieldTile
          tone="send"
          icon={<IconSend size={42} />}
          label="Execute"
          hint={sending ? executeLabel : 'Send the report'}
          count={items.length}
          onClick={() => void execute()}
          disabled={sending}
        />
      </div>

      {items.length > 0 ? (
        <section className="field-captured" aria-label="Captured so far">
          <div className="field-captured-head">
            <span>
              {photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''}
              {photoCount > 0 && documentCount > 0 ? ' · ' : ''}
              {documentCount > 0 ? `${documentCount} file${documentCount === 1 ? '' : 's'}` : ''}
            </span>
            <span className="small muted">Tap ✕ to remove</span>
          </div>
          <ul className="field-thumbs">
            {items.map((item) => (
              <li key={item.id} className={`field-thumb ${item.status}`}>
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt={item.file.name} />
                ) : (
                  <span className="field-thumb-file">
                    <IconFile size={26} />
                  </span>
                )}
                {item.status === 'error' ? (
                  <span className="field-thumb-flag error" title={item.error}>
                    <IconAlert size={14} />
                  </span>
                ) : item.status === 'done' ? (
                  <span className="field-thumb-flag ok">
                    <IconCheck size={14} />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="field-thumb-remove"
                  onClick={() => removeItem(item.id)}
                  disabled={sending}
                  aria-label={`Remove ${item.file.name}`}
                >
                  <IconX size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Link className="field-reports-link" to="/inspector/reports">
        <IconClock size={18} />
        <span>My previous reports</span>
        <IconChevronRight size={18} />
      </Link>

      {sending && progress ? (
        <div className="field-sending" role="status">
          <span className="spinner" />
          <span>{executeLabel} Keep this screen open.</span>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) addFiles(Array.from(event.target.files), 'document')
          event.target.value = ''
        }}
      />

      {cameraOpen ? (
        <CameraSheet
          count={photoCount}
          onCapture={(file) => addFiles([file], 'photo')}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}

      {dictateOpen ? (
        <DictateSheet value={remarks} onChange={setRemarks} onClose={() => setDictateOpen(false)} />
      ) : null}

      {pickerOpen ? (
        <SitePicker
          sites={sites}
          current={site}
          onPick={(picked) => {
            setSite(picked)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </FieldShell>
  )
}

/* ------------------------------ reports page ------------------------------ */

export function InspectorReportsPage() {
  const { data, error, loading, reload } = useApi<{ reports: SiteReportView[] }>('/inspections/reports')
  const toast = useToast()
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'My reports · CPPI'
  }, [])

  const reports = data?.reports ?? []

  async function open(report: SiteReportView) {
    setOpening(report.assetId)
    try {
      const res = await api<{ url: string }>(
        `/inspections/reports/${report.siteId}/${report.assetId}/url`
      )
      window.open(res.url, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The report could not be opened.')
    } finally {
      setOpening(null)
    }
  }

  return (
    <FieldShell>
      <div className="field-page-head">
        <Link className="field-back" to="/inspector">
          <IconChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
          <span>Capture</span>
        </Link>
        <h1 className="field-h1">My reports</h1>
        <p className="muted small">Every site report you have sent, newest first.</p>
      </div>

      <ErrorNote message={error} />

      {loading && !data ? (
        <Loading label="Loading your reports…" />
      ) : reports.length === 0 ? (
        <Empty title="No reports yet">
          Take photos, add files or dictate your notes, then tap Execute to send your first report.
        </Empty>
      ) : (
        <ul className="report-list">
          {reports.map((report) => (
            <li key={report.assetId} className="report-card">
              <div className="report-icon">
                <IconFile size={22} />
              </div>
              <div className="report-body">
                <div className="report-name">{report.name}</div>
                <div className="report-meta">
                  <strong>{report.siteName}</strong>
                  <span>· {formatDateTime(report.sentAt)}</span>
                  <span>· {relativeTime(report.sentAt)}</span>
                  {report.size ? <span>· {humanBytes(report.size)}</span> : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={opening === report.assetId}
                onClick={() => void open(report)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="field-page-foot">
        <Button variant="ghost" size="sm" onClick={() => void reload()}>
          <IconRefresh size={16} />
          Refresh
        </Button>
      </div>
    </FieldShell>
  )
}
