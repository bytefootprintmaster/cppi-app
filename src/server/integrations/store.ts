import { T, deleteItem, getItem, putItem } from '../db'
import { HttpError } from '../lib/http'
import type { GoogleConnectionRecord } from '../types'
import { decryptSecret, encryptSecret } from './crypto'
import { refreshAccessToken } from './google'

/**
 * Reading and writing the connected Google account. The refresh token is
 * encrypted on the way in and decrypted only for the instant it is needed to mint
 * an access token, so the plaintext token exists in memory and nowhere else.
 */

export function getConnection(userId: string): Promise<GoogleConnectionRecord | undefined> {
  return getItem<GoogleConnectionRecord>(T.googleConnections, { userId })
}

export async function saveConnection(params: {
  userId: string
  orgId: string
  email: string
  scopes: string[]
  refreshToken: string
}): Promise<GoogleConnectionRecord> {
  const existing = await getConnection(params.userId)
  const now = new Date().toISOString()
  const record: GoogleConnectionRecord = {
    userId: params.userId,
    orgId: params.orgId,
    email: params.email,
    scopes: params.scopes,
    refreshToken: encryptSecret(params.refreshToken),
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now
  }
  await putItem(T.googleConnections, record)
  return record
}

export async function removeConnection(userId: string): Promise<void> {
  await deleteItem(T.googleConnections, { userId })
}

/** Mint a short-lived access token for this user, or explain what to do first. */
export async function accessTokenFor(
  userId: string
): Promise<{ accessToken: string; record: GoogleConnectionRecord }> {
  const record = await getConnection(userId)
  if (!record) throw new HttpError(400, 'Connect your Google account first in Settings → Integrate')
  const accessToken = await refreshAccessToken(decryptSecret(record.refreshToken))
  return { accessToken, record }
}
