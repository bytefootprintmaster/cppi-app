import { T, scanAll } from './db'
import { HttpError } from './lib/http'
import type { AssetRecord, SessionUser } from './types'

/**
 * Baseline security limits every account carries, whatever its role.
 *
 * Two ceilings apply, both configurable per user by an administrator:
 *  - a maximum size for a single file, enforced before the browser is handed
 *    an upload URL and again when the upload is registered;
 *  - a ceiling on how many files one account may add in a calendar day.
 */
const BYTES_PER_MB = 1024 * 1024

/** Midnight today, in the server's timezone, as an ISO string. */
function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** How many files this user has registered since midnight. */
export async function uploadsToday(userId: string): Promise<number> {
  const since = startOfToday()
  const rows = await scanAll<AssetRecord>(T.assets)
  return rows.filter((asset) => asset.uploadedBy === userId && asset.uploadedAt >= since).length
}

/**
 * Enforce both ceilings for one upload attempt. `sizeBytes` is the size the
 * browser reported; when it is unknown the size check is skipped (the register
 * step re-checks with the authoritative value).
 */
export async function assertUploadAllowed(user: SessionUser, sizeBytes?: number): Promise<void> {
  if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)) {
    const maxBytes = user.limits.maxFileMb * BYTES_PER_MB
    if (sizeBytes > maxBytes) {
      throw new HttpError(413, `Files must be ${user.limits.maxFileMb} MB or smaller`)
    }
  }
  const used = await uploadsToday(user.userId)
  if (used >= user.limits.dailyUploads) {
    throw new HttpError(
      429,
      `Daily limit reached: you can upload ${user.limits.dailyUploads} files a day. Try again tomorrow.`
    )
  }
}
