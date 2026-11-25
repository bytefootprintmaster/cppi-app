import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import { T, getItem, putItem, updateFields } from '../db'
import { HttpError, asyncHandler, optStr, str } from '../lib/http'
import { requireAuth } from '../auth'
import { canWrite, orgIdOf, requireSiteAccess } from '../services'
import { assertWithinLimit, bumpOrgCounter } from '../orgs'
import { buildObjectKey, putObject } from '../s3'
import type { AssetRecord, AssetType } from '../types'
import {
  buildAuthUrl,
  downloadDriveFile,
  exchangeCode,
  fetchDriveFile,
  fetchEmail,
  listDriveFiles,
  revokeToken,
  signState,
  verifyState
} from '../integrations/google'
import { decryptSecret } from '../integrations/crypto'
import { accessTokenFor, getConnection, removeConnection, saveConnection } from '../integrations/store'

/**
 * Settings → Integrate. A user connects their Google account once; from then on
 * CPPI can read their mail (so the Assistant can work from it) and pull files
 * out of their Drive into the project's own storage. Everything here is
 * read-only, and the tokens stay server-side.
 */
export const integrationsRouter = Router()

/** Files a single Drive import may carry, so one request can't run away. */
const MAX_IMPORT = 25

const driveType = (mimeType: string): AssetType => (mimeType.startsWith('image/') ? 'image' : 'document')

integrationsRouter.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const record = await getConnection(req.user!.userId)
  res.json({
    google: record
      ? {
          connected: true,
          email: record.email,
          scopes: record.scopes,
          connectedAt: record.connectedAt
        }
      : { connected: false }
  })
}))

/** The URL to send the browser to in order to grant the read-only scopes. */
integrationsRouter.get('/google/connect', requireAuth, asyncHandler(async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(500, 'Google is not configured on the server')
  }
  res.json({ url: buildAuthUrl(signState(req.user!.userId)) })
}))

/** Where Google returns the browser once the user has decided. */
integrationsRouter.get('/google/callback', asyncHandler(async (req, res) => {
  const settings = `${env.APP_URL.replace(/\/$/, '')}/settings`
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  try {
    if (!code) throw new HttpError(400, 'Google did not return an authorization code')
    const userId = verifyState(state)
    const tokens = await exchangeCode(code)
    if (!tokens.refreshToken) {
      throw new HttpError(400, 'Google did not return a refresh token — try connecting again')
    }
    const email = await fetchEmail(tokens.accessToken)
    const user = await getItem<{ userId: string; orgId?: string }>(T.users, { userId })
    if (!user) throw new HttpError(404, 'Account not found')
    await saveConnection({
      userId,
      orgId: user.orgId ?? 'org_default',
      email,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      refreshToken: tokens.refreshToken
    })
    res.redirect(`${settings}?integration=google&connected=1`)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not connect Google'
    res.redirect(`${settings}?integration=google&error=${encodeURIComponent(message)}`)
  }
}))

integrationsRouter.delete('/google', requireAuth, asyncHandler(async (req, res) => {
  const record = await getConnection(req.user!.userId)
  if (record) {
    // Sever the grant at Google too, not just our copy of it.
    await revokeToken(decryptSecret(record.refreshToken))
    await removeConnection(req.user!.userId)
  }
  res.json({ ok: true })
}))

/** A page of the user's Drive, filtered by an optional name contains-query. */
integrationsRouter.get('/drive/files', requireAuth, asyncHandler(async (req, res) => {
  const { accessToken } = await accessTokenFor(req.user!.userId)
  const query = optStr(req.query.query, 200)
  const clauses = ['trashed = false']
  if (query) clauses.push(`name contains '${query.replace(/'/g, "\\'")}'`)
  const files = await listDriveFiles(accessToken, clauses.join(' and '))
  res.json({ files })
}))

/** Copy the chosen Drive files into a project: Drive → S3 → asset row. */
integrationsRouter.post('/drive/import', requireAuth, asyncHandler(async (req, res) => {
  const orgId = orgIdOf(req.user!)
  const siteId = str(req.body?.siteId, 'siteId', 60)
  const site = await requireSiteAccess(req.user!, siteId)
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to upload files')

  const rawIds: unknown[] = Array.isArray(req.body?.fileIds) ? req.body.fileIds : []
  const fileIds = rawIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_IMPORT)
  if (fileIds.length === 0) throw new HttpError(400, 'Choose at least one file to import')

  const { accessToken } = await accessTokenFor(req.user!.userId)

  // Read each file's real metadata, then classify before moving any bytes.
  const wanted = await Promise.all(fileIds.map((id) => fetchDriveFile(accessToken, id)))
  const images = wanted.filter((file) => driveType(file.mimeType) === 'image').length
  const documents = wanted.length - images
  if (documents > 0) await assertWithinLimit(orgId, 'docs', documents)
  if (images > 0) await assertWithinLimit(orgId, 'images', images)

  const imported: AssetRecord[] = []
  for (const file of wanted) {
    const { bytes, contentType, name } = await downloadDriveFile(accessToken, file)
    const type = driveType(contentType || file.mimeType)
    const key = buildObjectKey(site.siteId, type, name)
    await putObject(key, bytes, contentType)
    const asset: AssetRecord = {
      siteId: site.siteId,
      assetId: randomUUID(),
      name: name.slice(0, 240),
      type,
      category: 'other',
      s3Key: key,
      contentType,
      size: bytes.byteLength,
      tags: ['Google Drive'],
      uploadedBy: req.user!.userId,
      uploadedByName: req.user!.name,
      uploadedAt: new Date().toISOString()
    }
    await putItem(T.assets, asset)
    imported.push(asset)
  }

  if (documents > 0) await bumpOrgCounter(orgId, 'docs', documents)
  if (images > 0) await bumpOrgCounter(orgId, 'images', images)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: new Date().toISOString() })

  res.json({ imported, count: imported.length })
}))
