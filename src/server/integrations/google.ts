import jwt from 'jsonwebtoken'
import { env } from '../env'
import { HttpError } from '../lib/http'

/**
 * The one Google grant CPPI asks a user for: read their mail, and read their
 * Drive so files can be pulled into S3. Both are read-only — we never send mail
 * or write back into Drive — and the browser never sees the tokens: the code
 * exchange and every refresh happen here, on the server.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
export const GOOGLE_SCOPES = [GMAIL_SCOPE, DRIVE_SCOPE]

/** Where Google returns the browser. Defaults to the canonical callback path. */
export function redirectUri(): string {
  return env.GOOGLE_OAUTH_REDIRECT_URL || `${env.APP_URL.replace(/\/$/, '')}/api/integrations/google/callback`
}

/** The signed, user-bound `state` guarding the round trip against CSRF. */
export function signState(userId: string): string {
  return jwt.sign({ sub: userId, purpose: 'google-connect' }, env.JWT_SECRET, { expiresIn: '15m' })
}

export function verifyState(state: string): string {
  let payload: { sub?: string; purpose?: string }
  try {
    payload = jwt.verify(state, env.JWT_SECRET) as { sub?: string; purpose?: string }
  } catch {
    throw new HttpError(400, 'This connection link has expired — start again from Settings')
  }
  if (payload.purpose !== 'google-connect' || !payload.sub) {
    throw new HttpError(400, 'Invalid connection state')
  }
  return payload.sub
}

/** The URL the browser is sent to so the user can grant the read-only scopes. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: ['openid', 'email', ...GOOGLE_SCOPES].join(' '),
    // `offline` + `consent` are what return a refresh token we can keep using.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export interface GoogleTokens {
  accessToken: string
  refreshToken?: string
  scope?: string
}

/** Trade the one-time code for tokens. Only happens on the callback. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  })
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    scope?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !data.access_token) {
    throw new HttpError(400, data.error_description || data.error || 'Google refused the connection')
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, scope: data.scope }
}

/** Mint a fresh short-lived access token from the stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })
  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!res.ok || !data.access_token) {
    throw new HttpError(502, 'Google access could not be renewed — reconnect in Settings → Integrate')
  }
  return data.access_token
}

/** The address behind an access token, so the card can show whose account it is. */
export async function fetchEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return ''
  const data = (await res.json()) as { email?: string }
  return (data.email ?? '').toLowerCase()
}

/** Best-effort revocation, so disconnecting really severs the grant at Google. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  }).catch(() => undefined)
}

/** Turn a Google `files.list` result into what our UI needs. */
export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: number
  modifiedTime?: string
}

export async function listDriveFiles(accessToken: string, query: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    pageSize: '60',
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    orderBy: 'modifiedTime desc',
    q: query
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new HttpError(502, 'Drive could not be reached — reconnect in Settings → Integrate')
  const data = (await res.json()) as { files?: DriveFile[] }
  return data.files ?? []
}

/** Metadata for one file, re-read from Drive rather than trusted from the client. */
export async function fetchDriveFile(accessToken: string, fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,size,modifiedTime' })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new HttpError(502, 'That Drive file could not be read')
  return (await res.json()) as DriveFile
}

/** Download a Drive file's bytes, exporting Google-native docs to PDF. */
export async function downloadDriveFile(
  accessToken: string,
  file: DriveFile
): Promise<{ bytes: Uint8Array; contentType: string; name: string }> {
  const isGoogleDoc = file.mimeType.startsWith('application/vnd.google-apps')
  const url = isGoogleDoc
    ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=application/pdf`
    : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new HttpError(502, `Could not read "${file.name}" from Drive`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const contentType = isGoogleDoc ? 'application/pdf' : res.headers.get('content-type') || file.mimeType
  const name = isGoogleDoc && !file.name.toLowerCase().endsWith('.pdf') ? `${file.name}.pdf` : file.name
  return { bytes, contentType, name }
}
