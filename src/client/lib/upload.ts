import { api } from './api'

/**
 * Upload one file to a project from the field screen.
 *
 * The browser presigns, PUTs the bytes straight to S3, then registers the object
 * as a project file — the same two-step handshake the desktop Uploader uses, but
 * with a plain `fetch` instead of a progress-tracking XHR: a worker in gloves
 * wants one honest "Uploading…" state, not a percentage.
 */
const UPLOAD_TIMEOUT_MS = 180_000

export type AssetCategory = 'progress' | 'plan' | 'permit' | 'invoice' | 'other'

export interface UploadedAsset {
  assetId: string
  name: string
}

interface PresignResponse {
  key: string
  uploadUrl: string
}

const EXT_IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i

function guessType(file: File): 'image' | 'document' {
  if (file.type.startsWith('image/') || EXT_IMAGE.test(file.name)) return 'image'
  return 'document'
}

export async function uploadSiteFile(
  siteId: string,
  file: File,
  options: { category?: AssetCategory; tags?: string[] } = {}
): Promise<UploadedAsset> {
  const type = guessType(file)
  const contentType = file.type || 'application/octet-stream'

  const presign = await api<PresignResponse>(`/sites/${siteId}/assets/presign`, {
    method: 'POST',
    body: { fileName: file.name, contentType, type, size: file.size }
  })

  // A hung PUT would leave the Execute button waiting forever; abort it.
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(presign.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Upload timed out. Move somewhere with signal and try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  const created = await api<{ asset: { assetId: string; name: string } }>(`/sites/${siteId}/assets`, {
    method: 'POST',
    body: {
      key: presign.key,
      name: file.name,
      type,
      contentType,
      size: file.size,
      category: options.category ?? (type === 'image' ? 'progress' : 'other'),
      tags: options.tags
    }
  })

  return { assetId: created.asset.assetId, name: created.asset.name }
}
