import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { T, getItem, putItem, scanAll, updateFields } from '../db'
import { HttpError, asyncHandler, optStr, str } from '../lib/http'
import { requireAuth } from '../auth'
import { accessibleSites, canWrite, requireSiteAccess } from '../services'
import { buildObjectKey, getObjectBytes, presignDownload, putObject } from '../s3'
import { formatBytes, renderSiteReportPdf } from '../pdf'
import type { AssetRecord, SiteRecord, SiteReportView } from '../types'

/**
 * The field capture surface, as seen from the server.
 *
 * A site worker stands in front of a project with a phone, taps four big
 * buttons, and this router turns that into an ordinary project file: the
 * generated *site report* PDF. There is no report table — the PDF is the record,
 * its tags say `site report`, and its name carries the date and time it was
 * sent, so the manager simply finds it in the project's files.
 */
export const inspectionRouter = Router()

inspectionRouter.use(requireAuth)

/** Tags every report PDF carries, so the list and the file filter agree. */
const REPORT_TAG = 'site report'

const nowIso = () => new Date().toISOString()

/** Coordinates are optional but, when sent, must be real numbers on Earth. */
function coordinate(value: unknown, field: string, limit: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || Math.abs(n) > limit) {
    throw new HttpError(400, `"${field}" must be a number between -${limit} and ${limit}`)
  }
  return n
}

/** Great-circle distance in metres, good enough to tell one driveway from the next. */
function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))))
}

/** A distance a person would say out loud, e.g. "about 40 m from this project". */
function describeDistance(metres: number): string {
  if (metres < 30) return 'at this project'
  if (metres < 1000) return `about ${Math.round(metres / 10) * 10} m from this project`
  return `about ${(metres / 1000).toFixed(1)} km from this project`
}

/** `Site report - Riverside - 2026-11-23 14-32.pdf` — label first, time last. */
function reportFileName(site: SiteRecord, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`
  const label = (site.code || site.name || 'Site').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40)
  return `Site report - ${label} - ${stamp}.pdf`
}

function hasTag(asset: AssetRecord, tag: string): boolean {
  return (asset.tags ?? []).some((t) => t.toLowerCase() === tag)
}

/** Full street address, falling back to city/region, for the report letterhead. */
function sitePlace(site: SiteRecord): string | undefined {
  const parts = [site.city, site.region].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/* ---------------------------- resolve the site ---------------------------- */

/**
 * Public to signed-in field workers: given where the phone is, say which of the
 * worker's projects they are standing at. Coordinates come straight from the
 * browser's geolocation API, so they can be missing or wrong — the reply carries
 * the whole shortlist and the UI asks the worker to confirm.
 */
inspectionRouter.post('/resolve-site', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const lat = coordinate(body.latitude, 'latitude', 90)
  const lng = coordinate(body.longitude, 'longitude', 180)

  const sites = await accessibleSites(req.user!)
  const located = sites.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')

  const ranked = sites
    .map((site) => ({
      siteId: site.siteId,
      name: site.name,
      code: site.code,
      location: site.location,
      address: site.address,
      distanceM:
        lat !== undefined && lng !== undefined && typeof site.lat === 'number' && typeof site.lng === 'number'
          ? distanceMeters(lat, lng, site.lat, site.lng)
          : null
    }))
    .sort((a, b) => {
      if (a.distanceM === null && b.distanceM === null) return a.name.localeCompare(b.name)
      if (a.distanceM === null) return 1
      if (b.distanceM === null) return -1
      return a.distanceM - b.distanceM
    })

  const best = ranked[0] ?? null
  // Within a couple of hundred metres we are confident; further away the worker
  // is likely between projects and should pick from the list themselves.
  const match = best && best.distanceM !== null
    ? {
        ...best,
        distanceM: best.distanceM,
        confident: best.distanceM <= 250
      }
    : null

  res.json({
    match,
    sites: ranked,
    /** True when the worker has at least one project with a pin to match against. */
    canGeolocate: located.length > 0
  })
}))

/* ------------------------------ send a report ------------------------------ */

/** Read a list of asset ids off the request body, deduped and bounded. */
function assetIds(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HttpError(400, `"${field}" must be a list of file ids`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') throw new HttpError(400, `"${field}" must be file ids`)
    const id = raw.trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > 60) throw new HttpError(400, `A report can hold at most 60 files in "${field}"`)
  return out
}

/**
 * Execute. The photos and documents have already been uploaded and registered as
 * ordinary project files; this bundles them, with the dictated remarks, into the
 * site-report PDF and files that PDF on the project too.
 */
inspectionRouter.post('/reports', asyncHandler(async (req, res) => {
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to send reports')

  const body = (req.body ?? {}) as Record<string, unknown>
  const site = await requireSiteAccess(req.user!, str(body.siteId, 'siteId', 60))
  const remarks = optStr(body.remarks, 8000)
  const lat = coordinate(body.latitude, 'latitude', 90)
  const lng = coordinate(body.longitude, 'longitude', 180)
  const photoIds = assetIds(body.photoAssetIds, 'photoAssetIds')
  const documentIds = assetIds(body.documentAssetIds, 'documentAssetIds')

  if (!remarks && photoIds.length === 0 && documentIds.length === 0) {
    throw new HttpError(400, 'Add a remark, a photo or a file before sending the report')
  }

  const load = (assetId: string) => getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId })

  // Photos are embedded in the PDF; documents are listed by name. Both were
  // registered against this project when they were captured.
  const photos: { name: string; data: Uint8Array }[] = []
  for (const assetId of photoIds) {
    const asset = await load(assetId)
    if (!asset || asset.type !== 'image') continue
    let data: Uint8Array = new Uint8Array()
    try {
      data = await getObjectBytes(asset.s3Key)
    } catch {
      // The object vanished between capture and send: keep the caption, drop the picture.
    }
    photos.push({ name: asset.name, data })
  }

  const documents: { name: string; detail?: string }[] = []
  for (const assetId of documentIds) {
    const asset = await load(assetId)
    if (!asset) continue
    documents.push({
      name: asset.name,
      detail: [asset.contentType, formatBytes(asset.size)].filter(Boolean).join(' · ') || undefined
    })
  }

  const sentAt = new Date()
  const locationNote =
    lat !== undefined && lng !== undefined && typeof site.lat === 'number' && typeof site.lng === 'number'
      ? describeDistance(distanceMeters(lat, lng, site.lat, site.lng))
      : undefined

  const bytes = await renderSiteReportPdf({
    siteName: site.name,
    siteCode: site.code,
    siteAddress: site.address,
    sitePlace: sitePlace(site),
    sentByName: req.user!.name,
    sentByEmail: req.user!.email,
    sentAt,
    locationNote,
    coordinates: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
    remarks,
    photos,
    documents
  })

  const name = reportFileName(site, sentAt)
  const s3Key = buildObjectKey(site.siteId, 'document', name)
  await putObject(s3Key, bytes, 'application/pdf')

  const asset: AssetRecord = {
    siteId: site.siteId,
    assetId: randomUUID(),
    name,
    type: 'document',
    category: 'other',
    s3Key,
    contentType: 'application/pdf',
    size: bytes.length,
    tags: [REPORT_TAG],
    uploadedBy: req.user!.userId,
    uploadedByName: req.user!.name,
    uploadedAt: sentAt.toISOString()
  }
  await putItem(T.assets, asset)
  await updateFields(T.sites, { siteId: site.siteId }, { updatedAt: asset.uploadedAt })

  const view: SiteReportView = {
    assetId: asset.assetId,
    siteId: site.siteId,
    siteName: site.name,
    name: asset.name,
    size: asset.size,
    sentAt: asset.uploadedAt,
    sentByName: asset.uploadedByName
  }
  res.json({
    report: view,
    /** Counts echoed back so the field screen can confirm what went in. */
    included: { remarks: remarks ? 1 : 0, photos: photos.length, documents: documents.length }
  })
}))

/* ------------------------------ my reports ------------------------------ */

/** The reports this worker has sent, newest first, for the "My reports" list. */
inspectionRouter.get('/reports', asyncHandler(async (req, res) => {
  const sites = await accessibleSites(req.user!)
  const names = new Map(sites.map((site) => [site.siteId, site.name]))

  // One scan, then keep only this worker's own site-report PDFs on projects they
  // can still reach. The volume of a project's file list makes a scan cheap here.
  const rows = await scanAll<AssetRecord>(T.assets)
  const reports: SiteReportView[] = rows
    .filter(
      (asset) =>
        asset.uploadedBy === req.user!.userId &&
        names.has(asset.siteId) &&
        asset.type === 'document' &&
        hasTag(asset, REPORT_TAG)
    )
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .map((asset) => ({
      assetId: asset.assetId,
      siteId: asset.siteId,
      siteName: names.get(asset.siteId) ?? 'Project',
      name: asset.name,
      size: asset.size,
      sentAt: asset.uploadedAt,
      sentByName: asset.uploadedByName
    }))

  res.json({ reports })
}))

/** Open one of the worker's own reports, or any report on a project they reach. */
inspectionRouter.get('/reports/:siteId/:assetId/url', asyncHandler(async (req, res) => {
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to open reports')
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const asset = await getItem<AssetRecord>(T.assets, { siteId: site.siteId, assetId: req.params.assetId })
  if (!asset) throw new HttpError(404, 'Report not found')
  res.json({
    url: await presignDownload(asset.s3Key, 900, asset.name),
    name: asset.name,
    contentType: asset.contentType
  })
}))
