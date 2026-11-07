import { Router } from 'express'
import { T, getItem, queryAll } from '../db'
import { HttpError, asyncHandler, optStr } from '../lib/http'
import { accessibleSites } from '../services'
import type { FileIndexRecord, FileTermRecord } from '../types'

/**
 * Portal-side search over the file index the agent writes.
 *
 * The index is an inverted index (`file_terms`: one row per word/file pair), so a
 * query costs one lookup per word rather than a scan of every document. The
 * tokeniser must stay byte-for-byte identical to `tokenize()` in the agent's
 * `app/indexing.py`, otherwise the words looked up here are not the words stored
 * there. Stopwords are not filtered: the agent never writes a posting for one, so
 * looking one up simply finds nothing.
 */
export const searchRouter = Router()

const MAX_QUERY_TERMS = 12
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SNIPPET_CHARS = 220

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

interface Hit {
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

  const hits = new Map<string, Hit>()
  await Promise.all(
    terms.map(async (term) => {
      const postings = await queryAll<FileTermRecord>(T.fileTerms, {
        KeyConditionExpression: 'term = :t',
        ExpressionAttributeValues: { ':t': term }
      })
      for (const posting of postings) {
        if (!allowed.has(posting.siteId)) continue
        const key = posting.ref
        const hit = hits.get(key) ?? { siteId: posting.siteId, docId: posting.docId, terms: [], score: 0 }
        if (!hit.terms.includes(term)) hit.terms.push(term)
        // A word in the file name is worth more than one buried on page 40.
        hit.score += 1 + Math.min(Number(posting.tf) || 0, 10) * 0.15
        if (posting.ntf) hit.score += 1.5
        hits.set(key, hit)
      }
    })
  )

  // Answers that contain more of the query rank first, then the strongest matches.
  const ranked = [...hits.values()]
    .sort((a, b) => b.terms.length - a.terms.length || b.score - a.score)
    .slice(0, limit)

  const rows = await Promise.all(
    ranked.map((hit) => getItem<FileIndexRecord>(T.fileIndex, { siteId: hit.siteId, docId: hit.docId }))
  )

  const results = rows
    .map((row, index) =>
      row
        ? {
            siteId: row.siteId,
            siteName: siteNames.get(row.siteId),
            assetId: row.assetId,
            name: row.name,
            s3Key: row.s3Key,
            kind: row.kind,
            contentType: row.contentType,
            size: row.size,
            uploadedAt: row.uploadedAt,
            indexedAt: row.indexedAt,
            matched: ranked[index].terms,
            snippet: snippet(row.text ?? '', ranked[index].terms)
          }
        : null
    )
    .filter((row): row is NonNullable<typeof row> => row !== null)

  res.json({ query, count: results.length, results })
}))
