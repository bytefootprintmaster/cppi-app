import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { humanBytes } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Modal,
  useConfirm,
  useToast
} from '../components/ui'
import { IconCheck, IconFile, IconImage, IconRefresh, IconSearch } from '../components/icons'
import type { SiteRecord } from '../../server/types'

interface GoogleStatus {
  google: { connected: boolean; email?: string; scopes?: string[]; connectedAt?: string }
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: number
  modifiedTime?: string
}

/** Start the server-side Google grant: fetch the URL, then hand the browser to it. */
async function startGoogleConnect(): Promise<void> {
  const { url } = await api<{ url: string }>('/integrations/google/connect')
  window.location.assign(url)
}

const isImageMime = (mimeType: string) => mimeType.startsWith('image/')

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useApi<GoogleStatus>('/integrations/status')
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Google returns the browser here with the outcome in the query string; report
  // it once, then tidy the URL so a refresh does not repeat the message.
  useEffect(() => {
    if (params.get('integration') !== 'google') return
    if (params.get('connected')) toast.success('Google account connected.')
    const failure = params.get('error')
    if (failure) setProblem(failure)
    const next = new URLSearchParams(params)
    next.delete('integration')
    next.delete('connected')
    next.delete('error')
    setParams(next, { replace: true })
  }, [params, setParams, toast])

  const connected = Boolean(data?.google?.connected)

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect Google?',
      message: 'The Assistant will stop reading this mailbox and you will not be able to import Drive files until you reconnect.',
      confirmLabel: 'Disconnect',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await api('/integrations/google', { method: 'DELETE' })
      toast.success('Google account disconnected.')
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Connect the outside services this workspace can use." />
      <PageBody>
        <ErrorNote message={problem} />
        <h2 className="section-heading">Integrate</h2>
        <p className="muted" style={{ marginTop: -6, marginBottom: 16 }}>
          Connect your Google account once. CPPI reads only — it never sends mail or changes your Drive.
        </p>

        {loading ? (
          <Loading label="Checking your connections…" />
        ) : (
          <ErrorNote message={error} />
        )}

        <Card>
          <CardHeader
            title="Gmail"
            sub="Let the Assistant answer from this mailbox."
            action={
              connected ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>
            }
          />
          <div className="row wrap" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="small muted">
              {connected ? (
                <span>
                  Reading <strong>{data?.google?.email}</strong>
                </span>
              ) : (
                <span>Connect a Google account to give the Assistant access to your email.</span>
              )}
            </div>
            {connected ? (
              <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  startGoogleConnect().catch((err) =>
                    toast.error(err instanceof Error ? err.message : 'Could not start the connection')
                  )
                }
              >
                Connect Google
              </Button>
            )}
          </div>
        </Card>

        <Card style={{ marginTop: 16 }}>
          <CardHeader
            title="Google Drive"
            sub="Copy files from your Drive into a project."
            action={connected ? <Badge tone="green">Ready</Badge> : <Badge tone="gray">Connect Gmail first</Badge>}
          />
          <div className="row wrap" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="small muted">
              Imported files are copied into the project's storage and analysed like any other upload.
            </div>
            <Button size="sm" onClick={() => setImportOpen(true)} disabled={!connected}>
              Import from Drive
            </Button>
          </div>
        </Card>
      </PageBody>

      {importOpen ? (
        <DriveImportModal
          onClose={() => setImportOpen(false)}
          onImported={(count) => {
            setImportOpen(false)
            toast.success(`Imported ${count} file${count === 1 ? '' : 's'} from Drive.`)
          }}
        />
      ) : null}
    </>
  )
}

/** Browse the connected Drive and copy the chosen files into one project. */
function DriveImportModal({ onClose, onImported }: { onClose: () => void; onImported: (count: number) => void }) {
  const { data: siteData } = useApi<{ sites: SiteRecord[] }>('/sites')
  const [siteId, setSiteId] = useState('')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<DriveFile[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [listing, setListing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const sites = siteData?.sites ?? []
  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(sites[0].siteId)
  }, [sites, siteId])

  async function load() {
    setListing(true)
    setProblem(null)
    try {
      const res = await api<{ files: DriveFile[] }>(
        `/integrations/drive/files${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''}`
      )
      setFiles(res.files)
      setChosen(new Set())
      setLoaded(true)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not read your Drive')
    } finally {
      setListing(false)
    }
  }

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit() {
    if (!siteId) {
      setProblem('Choose a project first.')
      return
    }
    if (chosen.size === 0) {
      setProblem('Choose at least one file.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const res = await api<{ count: number }>('/integrations/drive/import', {
        method: 'POST',
        body: { siteId, fileIds: [...chosen] }
      })
      onImported(res.count)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Import from Google Drive"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={chosen.size === 0}>
            Import {chosen.size > 0 ? `(${chosen.size})` : ''}
          </Button>
        </>
      }
    >
      <Field label="Project" hint="Files are copied into this project.">
        <select className="input" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
          {sites.length === 0 ? <option value="">No projects yet</option> : null}
          {sites.map((site) => (
            <option key={site.siteId} value={site.siteId}>
              {site.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Search your Drive">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            placeholder="File name contains…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load()
            }}
          />
          <Button variant="ghost" onClick={() => void load()} loading={listing}>
            <IconSearch size={16} />
            Search
          </Button>
        </div>
      </Field>

      <ErrorNote message={problem} />

      {!loaded ? (
        <Empty title="Search your Drive">
          Enter a name and press Search to list files.
        </Empty>
      ) : files.length === 0 ? (
        <Empty title="Nothing matched">Try a different name.</Empty>
      ) : (
        <div className="drive-list">
          {files.map((file) => (
            <label key={file.id} className="drive-row">
              <input type="checkbox" checked={chosen.has(file.id)} onChange={() => toggle(file.id)} />
              <span className="drive-icon">
                {isImageMime(file.mimeType) ? <IconImage size={16} /> : <IconFile size={16} />}
              </span>
              <span className="drive-name">{file.name}</span>
              <span className="muted small">{file.size ? humanBytes(Number(file.size)) : ''}</span>
            </label>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Button variant="ghost" size="sm" onClick={() => void load()} loading={listing}>
          <IconRefresh size={15} />
          Refresh
        </Button>
        {chosen.size > 0 ? (
          <span className="small muted">
            <IconCheck size={14} /> {chosen.size} selected
          </span>
        ) : null}
      </div>
    </Modal>
  )
}
