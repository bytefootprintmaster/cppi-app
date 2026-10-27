import { memo, useCallback, useRef, useState } from 'react'
import { api, ApiError, type RequestOptions } from '../lib/api'
import { Button } from './ui'
import { IconAlert, IconCheck, IconUpload } from './icons'

interface UploaderProps {
  siteId: string
  onUploaded: () => void
}

interface PresignResponse {
  key: string
  uploadUrl: string
}

type ItemStatus = 'queued' | 'uploading' | 'done' | 'error'

interface UploadItem {
  id: string
  file: File
  progress: number
  status: ItemStatus
  /** Shown while an upload is being retried, or as the final failure reason. */
  error?: string
  /** 1 on the first try, up to MAX_ATTEMPTS while the queue self-heals. */
  attempt: number
}

const EXT_IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

/** How many files are pushed to S3 at the same time. */
const CONCURRENCY = 3
/** Presign / register API calls must answer within this window. */
const REQUEST_TIMEOUT_MS = 30_000
/** A stalled S3 PUT is aborted after this much total time. */
const UPLOAD_TIMEOUT_MS = 180_000
/** A PUT that reports no progress at all for this long is treated as dead. */
const STALL_TIMEOUT_MS = 45_000
/** Transient failures (dropped connections, 5xx) are retried this many times. */
const MAX_ATTEMPTS = 3

function guessType(file: File): 'image' | 'document' {
  if (file.type.startsWith('image/') || EXT_IMAGE.test(file.name)) return 'image'
  return 'document'
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** Only retry what can plausibly succeed: bad input / permissions never will. */
function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429 || err.status === 408
  return true
}

/** JSON API call guarded by a timeout so a hung request can never block the queue. */
async function apiWithTimeout<T>(path: string, options: RequestOptions, ms: number): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  try {
    return await api<T>(path, { ...options, signal: controller.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your connection and try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * PUT the file straight to S3 via XHR so we get real upload progress, a hard
 * timeout, and a stall watchdog: if the connection dies mid-upload without
 * erroring, the transfer is abandoned instead of hanging at its last percent.
 */
function putToS3(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    let lastActivity = Date.now()

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      window.clearInterval(watchdog)
      fn()
    }

    const watchdog = window.setInterval(() => {
      if (Date.now() - lastActivity > STALL_TIMEOUT_MS) xhr.abort()
    }, 5_000)

    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.upload.onprogress = (e) => {
      lastActivity = Date.now()
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish(resolve)
      else finish(() => reject(new Error(`S3 upload failed (${xhr.status})`)))
    }
    xhr.onerror = () => finish(() => reject(new Error('Network error while uploading')))
    xhr.ontimeout = () => finish(() => reject(new Error('Upload timed out')))
    xhr.onabort = () =>
      finish(() => reject(new Error('Upload stalled — the connection dropped, retrying')))
    xhr.send(file)
  })
}

/** One row is isolated from the rest so a progress tick can't re-render the list. */
const UploadRow = memo(function UploadRow({
  item,
  onRetry
}: {
  item: UploadItem
  onRetry: (id: string) => void
}) {
  const pct =
    item.status === 'done'
      ? 'Done'
      : item.status === 'queued'
        ? 'Queued'
        : item.error
          ? 'Retrying'
          : `${item.progress}%`

  return (
    <div className={`upload-item ${item.status}`}>
      <span className="upload-icon">
        {item.status === 'done' ? (
          <IconCheck size={16} />
        ) : item.status === 'error' ? (
          <IconAlert size={16} />
        ) : item.status === 'uploading' ? (
          <span className="spinner" />
        ) : (
          <IconUpload size={16} />
        )}
      </span>
      <div className="upload-body">
        <div className="upload-name" title={item.file.name}>
          {item.file.name}
        </div>
        {item.status === 'error' ? (
          <div className="upload-error">{item.error}</div>
        ) : item.error ? (
          <div className="small muted">{item.error}</div>
        ) : (
          <div className="progress upload-progress">
            <div
              className="progress-bar"
              style={{ width: `${item.status === 'done' ? 100 : item.progress}%` }}
            />
          </div>
        )}
      </div>
      {item.status === 'error' ? (
        <Button variant="ghost" size="sm" onClick={() => onRetry(item.id)}>
          Retry
        </Button>
      ) : (
        <span className="small muted upload-pct">{pct}</span>
      )}
    </div>
  )
})

export function Uploader({ siteId, onUploaded }: UploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<UploadItem[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)

  // Mutable upload queue: keeping it in refs lets concurrent batches share one
  // worker pool instead of stacking separate loops.
  const pendingRef = useRef<string[]>([])
  const runningRef = useRef(false)
  const filesRef = useRef(new Map<string, File>())

  /** Apply a change to a single row, leaving the array identity intact when nothing moved. */
  const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
    setItems((prev) => {
      const index = prev.findIndex((it) => it.id === id)
      if (index === -1) return prev
      const current = prev[index]
      // Progress events arrive far faster than the UI needs; skipping no-op
      // updates keeps React from re-rendering the whole list on every tick.
      const dirty = (Object.keys(changes) as (keyof UploadItem)[]).some(
        (key) => current[key] !== changes[key]
      )
      if (!dirty) return prev
      const next = prev.slice()
      next[index] = { ...current, ...changes }
      return next
    })
  }, [])

  async function uploadOne(id: string) {
    const file = filesRef.current.get(id)
    if (!file) {
      patch(id, { status: 'error', error: 'File is no longer available — please add it again.' })
      return
    }
    const type = guessType(file)
    const contentType = file.type || 'application/octet-stream'

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        patch(id, { status: 'uploading', progress: 0, error: undefined, attempt })

        const presign = await apiWithTimeout<PresignResponse>(
          `/sites/${siteId}/assets/presign`,
          { method: 'POST', body: { fileName: file.name, contentType, type } },
          REQUEST_TIMEOUT_MS
        )

        await putToS3(presign.uploadUrl, file, contentType, (percent) =>
          patch(id, { progress: percent })
        )

        await apiWithTimeout(
          `/sites/${siteId}/assets`,
          {
            method: 'POST',
            body: {
              key: presign.key,
              name: file.name,
              type,
              contentType,
              size: file.size,
              category: type === 'image' ? 'progress' : 'other'
            }
          },
          REQUEST_TIMEOUT_MS
        )

        // S3 has the bytes now, so the in-memory copy is dead weight.
        filesRef.current.delete(id)
        patch(id, { status: 'done', progress: 100, attempt })
        return
      } catch (err) {
        const message =
          err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed'
        if (attempt === MAX_ATTEMPTS || !isRetryable(err)) {
          patch(id, { status: 'error', error: message, attempt })
          return
        }
        patch(id, {
          status: 'uploading',
          progress: 0,
          attempt,
          error: `${message} — retrying (${attempt + 1}/${MAX_ATTEMPTS})`
        })
        await wait(600 * attempt)
      }
    }
  }

  /** Drain the shared queue with a fixed number of workers. */
  async function drain() {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    try {
      // Rebuild the pool until the queue is genuinely empty: files added while
      // the previous workers were winding down would otherwise stay queued.
      do {
        const workers = Array.from({ length: CONCURRENCY }, async () => {
          while (pendingRef.current.length) {
            const id = pendingRef.current.shift()
            if (!id) break
            await uploadOne(id)
          }
        })
        await Promise.all(workers)
      } while (pendingRef.current.length)
    } finally {
      runningRef.current = false
      setBusy(false)
      onUploaded()
    }
  }

  function enqueue(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return

    const added: UploadItem[] = list.map((file) => {
      const id = newId()
      filesRef.current.set(id, file)
      return { id, file, progress: 0, status: 'queued', attempt: 1 }
    })

    setItems((prev) => [...prev, ...added])
    pendingRef.current.push(...added.map((it) => it.id))
    void drain()
  }

  /** Stable identity so memoised rows don't re-render on every parent update. */
  const retry = useCallback((id: string) => {
    if (!filesRef.current.has(id)) return
    patch(id, { status: 'queued', progress: 0, error: undefined, attempt: 1 })
    pendingRef.current.push(id)
    void drain()
  }, [patch])

  function retryFailed() {
    const failed = items.filter((it) => it.status === 'error' && filesRef.current.has(it.id))
    if (failed.length === 0) return
    for (const it of failed) {
      patch(it.id, { status: 'queued', progress: 0, error: undefined, attempt: 1 })
    }
    pendingRef.current.push(...failed.map((it) => it.id))
    void drain()
  }

  function clearFinished() {
    const finished = items.filter((it) => it.status === 'done')
    for (const it of finished) filesRef.current.delete(it.id)
    setItems((prev) => prev.filter((it) => it.status !== 'done'))
  }

  const total = items.length
  const doneCount = items.filter((it) => it.status === 'done').length
  const failedCount = items.filter((it) => it.status === 'error').length

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
          if (e.dataTransfer.files) enqueue(e.dataTransfer.files)
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
          if (e.target.files) enqueue(e.target.files)
          e.target.value = ''
        }}
      />

      {total > 0 ? (
        <div className="upload-list">
          {items.map((it) => (
            <UploadRow key={it.id} item={it} onRetry={retry} />
          ))}
        </div>
      ) : null}

      <div className="row wrap" style={{ marginTop: 12 }}>
        <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        {failedCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={retryFailed}>
            Retry failed ({failedCount})
          </Button>
        ) : null}
        {doneCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearFinished}>
            Clear finished
          </Button>
        ) : null}
        {total > 0 ? (
          <span className="small muted">
            {doneCount}/{total} uploaded
            {failedCount > 0 ? ` · ${failedCount} failed` : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}
