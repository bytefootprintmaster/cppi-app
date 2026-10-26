import { useRef, useState } from 'react'
import { api } from '../lib/api'
import { Button } from './ui'

interface UploaderProps {
  siteId: string
  onUploaded: () => void
}

interface PresignResponse {
  key: string
  uploadUrl: string
}

const EXT_IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

function guessType(file: File): 'image' | 'document' {
  if (file.type.startsWith('image/') || EXT_IMAGE.test(file.name)) return 'image'
  return 'document'
}

export function Uploader({ siteId, onUploaded }: UploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    setBusy(true)
    setError(null)

    try {
      let done = 0
      for (const file of list) {
        setStatus(`Uploading ${file.name} (${done + 1}/${list.length})…`)
        const type = guessType(file)

        const presign = await api<PresignResponse>(`/sites/${siteId}/assets/presign`, {
          method: 'POST',
          body: { fileName: file.name, contentType: file.type || 'application/octet-stream', type }
        })

        const put = await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        })
        if (!put.ok) throw new Error(`S3 upload failed for ${file.name} (${put.status})`)

        await api(`/sites/${siteId}/assets`, {
          method: 'POST',
          body: {
            key: presign.key,
            name: file.name,
            type,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
            category: type === 'image' ? 'progress' : 'other'
          }
        })
        done += 1
      }
      setStatus(`Uploaded ${done} file${done === 1 ? '' : 's'}.`)
      onUploaded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (e.dataTransfer.files) void uploadFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
      >
        <div style={{ fontWeight: 700, color: 'var(--ink-soft)' }}>
          {busy ? 'Uploading…' : 'Drop photos or documents here'}
        </div>
        <div className="small" style={{ marginTop: 4 }}>
          Images and documents are stored privately in S3 and delivered via signed links.
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {status ? (
        <div className="row" style={{ marginTop: 10 }}>
          {busy ? <span className="spinner" /> : null}
          <span className="small muted">{status}</span>
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-error" style={{ marginTop: 10 }}>
          {error}
        </div>
      ) : null}
      {!busy && !status && !error ? null : null}
      {busy ? null : (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
        </div>
      )}
    </div>
  )
}
