import { Router } from 'express'
import { T, getItem, queryAll } from '../db'
import { HttpError, asyncHandler, optStr } from '../lib/http'
import { accessibleSites } from '../services'
import type { AssetRecord, FileIndexRecord, FileTermRecord } from '../types'

/**
 * Portal-side search.
 *
 * Two sources are merged so a file is findable even before the agent has had a
 * chance to index it:
 *
 *  1. The inverted index the agent writes (`file_terms`/`file_index`) — matches
 *     the words *inside* a document. One lookup per word rather than a scan.
 *  2. The portal's own `assets` table — matches the file's name and its tags.
 *     This is what makes a freshly uploaded "Survey Report.pdf" show up straight
 *     away, without waiting for processing.
 *
 * The tokeniser must stay byte-for-byte identical to `tokenize()` in the agent's
 * `app/indexing.py`, otherwise the words looked up here are not the words stored
 * there. Stopwords are not filtered out of the index lookup (the agent never
 * writes a posting for one, so finding nothing is correct), but they *are*
 * ignored when matching names and tags, where "the" would otherwise match every
 * file.
 */
export const searchRouter = Router()

const MAX_QUERY_TERMS = 12
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SNIPPET_CHARS = 220
/** Cap on index rows fetched per search, so one broad word can't fan out forever. */
const MAX_INDEX_ROWS = 300

// Mirrors `STOPWORDS` in the agent's `app/indexing.py`.
const STOPWORDS = new Set(
  `
  a about above after again against all am an and any are aren as at be because been
  before being below between both but by can cannot could couldn did didn do does
  doesn doing don down during each few for from further had hadn has hasn have haven
  having he her here hers herself him himself his how i if in into is isn it its
  itself let me more most mustn my myself no nor not of off on once only or other
  ought our ours ourselves out over own same shall shan she should shouldn so some
  such than that the their theirs them themselves then there these they this those
  through to too under until up very was wasn we were weren what when where which
  while who whom why will with won would wouldn you your yours yourself yourselves
  `.split(/\s+/)
)

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
}

/** A readable window around the first matching word. */
function snippet(text: string, terms: string[]): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const lowered = flat.toLowerCase()
  let position = -1
  for (const term of terms) {
    const found = lowered.indexOf(term)
    if (found >= 0 && (position < 0 || found < position)) position = found
  }
  if (position < 0) {
    return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat
  }
  const start = Math.max(0, position - Math.floor(SNIPPET_CHARS / 3))
  const end = Math.min(flat.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** One file, however it was matched. Keyed by `s3Key` when merging the two sources. */
interface Hit {
  siteId: string
  s3Key: string
  docId?: string
  assetId?: string
  name?: string
  kind?: string
  contentType?: string
  size?: number
  uploadedAt?: string
  indexedAt?: string
  text?: string
  tags?: string[]
  terms: Set<string>
  score: number
}

interface IndexPosting {
  siteId: string
  docId: string
  terms: string[]
  score: number
}

searchRouter.get('/', asyncHandler(async (req, res) => {
  const query = optStr(req.query.q, 200)
  if (!query) {
    res.json({ query: '', count: 0, results: [], note: 'Type a word or two to search inside the saved files.' })
    return
  }

  const sites = await accessibleSites(req.user!)
  const requested = optStr(req.query.siteId, 60)
  if (requested && !sites.some((s) => s.siteId === requested)) {
    throw new HttpError(403, 'You do not have access to this project')
  }
  const allowed = new Set(requested ? [requested] : sites.map((s) => s.siteId))
  const scoped = sites.filter((s) => allowed.has(s.siteId))
  const siteNames = new Map(sites.map((s) => [s.siteId, s.name as string | undefined]))

  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  const terms = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) {
    res.json({ query, count: 0, results: [], note: 'That search had no searchable words.' })
    return
  }
  // Words worth matching against a file name or tag (a stopword would match all).
  const contentTerms = terms.filter((term) => !STOPWORDS.has(term))
  const nameTerms = contentTerms.length > 0 ? contentTerms : terms

  const merged = new Map<string, Hit>()
  function hitFor(siteId: string, s3Key: string): Hit {
    const existing = merged.get(s3Key)
    if (existing) return existing
    const created: Hit = { siteId, s3Key, terms: new Set(), score: 0 }
    merged.set(s3Key, created)
    return created
  }

  // 1) Inverted index: words found inside a document. Wrapped so a missing or
  //    throttled index table degrades to name/tag search instead of failing the
  //    whole request.
  try {
    const postings = new Map<string, IndexPosting>()
    await Promise.all(
      terms.map(async (term) => {
        const rows = await queryAll<FileTermRecord>(T.fileTerms, {
          KeyConditionExpression: 'term = :t',
          ExpressionAttributeValues: { ':t': term }
        })
        for (const row of rows) {
          if (!allowed.has(row.siteId)) continue
          const hit =
            postings.get(row.ref) ?? { siteId: row.siteId, docId: row.docId, terms: [], score: 0 }
          if (!hit.terms.includes(term)) hit.terms.push(term)
          // A word in the file name is worth more than one buried on page 40.
          hit.score += 1 + Math.min(Number(row.tf) || 0, 10) * 0.15
          if (row.ntf) hit.score += 1.5
          postings.set(row.ref, hit)
        }
      })
    )

    const ranked = [...postings.values()].sort((a, b) => b.score - a.score).slice(0, MAX_INDEX_ROWS)
    const indexRows = await Promise.all(
      ranked.map((hit) => getItem<FileIndexRecord>(T.fileIndex, { siteId: hit.siteId, docId: hit.docId }))
    )
    ranked.forEach((hit, index) => {
      const row = indexRows[index]
      if (!row) return
      const mergedHit = hitFor(row.siteId, row.s3Key)
      for (const term of hit.terms) mergedHit.terms.add(term)
      mergedHit.score += hit.score
      mergedHit.docId = row.docId
      mergedHit.assetId ??= row.assetId
      mergedHit.name ??= row.name
      mergedHit.kind ??= row.kind
      mergedHit.contentType ??= row.contentType
      mergedHit.size ??= row.size
      mergedHit.uploadedAt ??= row.uploadedAt
      mergedHit.indexedAt ??= row.indexedAt
      mergedHit.text ??= row.text
    })
  } catch (err) {
    console.error('[search] file index unavailable, falling back to name/tag matches', err)
  }

  // 2) The portal's own asset rows: match the file name and its tags. Also the
  //    place every result gets its tags from, indexed or not.
  const assetRows = await Promise.all(
    scoped.map((site) =>
      queryAll<AssetRecord>(T.assets, {
        KeyConditionExpression: 'siteId = :s',
        ExpressionAttributeValues: { ':s': site.siteId }
      })
    )
  )
  const assetsByKey = new Map<string, AssetRecord>()
  for (const rows of assetRows) for (const asset of rows) assetsByKey.set(asset.s3Key, asset)

  for (const asset of assetsByKey.values()) {
    const haystack = `${asset.name} ${(asset.tags ?? []).join(' ')}`.toLowerCase()
    const matched = nameTerms.filter((term) => haystack.includes(term))
    if (matched.length === 0) continue
    const hit = hitFor(asset.siteId, asset.s3Key)
    for (const term of matched) hit.terms.add(term)
    // A name or tag match is a stronger signal than a body-only one.
    hit.score += 2.5 + matched.length
    hit.assetId = asset.assetId
    hit.name ??= asset.name
    hit.kind ??= asset.type === 'image' ? 'image' : 'document'
    hit.contentType ??= asset.contentType
    hit.size ??= asset.size
    hit.uploadedAt ??= asset.uploadedAt
  }

  // Tags live on the asset row, not the index, so this reflects a tag added a
  // moment ago without waiting for the agent to re-index the file.
  for (const hit of merged.values()) {
    const asset = assetsByKey.get(hit.s3Key)
    if (!asset) continue
    hit.tags = asset.tags ?? []
    hit.assetId ??= asset.assetId
  }

  // Answers that contain more of the query rank first, then the strongest matches.
  const results = [...merged.values()]
    .sort((a, b) => b.terms.size - a.terms.size || b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({
      siteId: hit.siteId,
      siteName: siteNames.get(hit.siteId),
      assetId: hit.assetId,
      name: hit.name ?? '',
      s3Key: hit.s3Key,
      kind: hit.kind ?? 'document',
      contentType: hit.contentType,
      size: hit.size,
      uploadedAt: hit.uploadedAt,
      indexedAt: hit.indexedAt,
      matched: [...hit.terms],
      snippet: snippet(hit.text ?? '', [...hit.terms]),
      tags: hit.tags ?? []
    }))

  res.json({ query, count: results.length, results })
}))
