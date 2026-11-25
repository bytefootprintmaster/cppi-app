import { Router } from 'express'
import { T, getItem, queryAll, scanAll } from '../db'
import { HttpError, asyncHandler, oneOf, optStr } from '../lib/http'
import { presignDownload } from '../s3'
import { env } from '../env'
import { requireSiteAccess } from '../services'
import type {
  RegulationChunkRecord,
  RegulationKind,
  RegulationRecord,
  RegulationTermRecord,
  RegulationsMetaRecord,
  SiteRecord
} from '../types'

/**
 * Municipal regulations: the by-laws, forms, fee schedules and design standards a
 * town publishes for builders, crawled from its own website and written to these
 * tables by the agent's `scripts/ingest_regulations.py`.
 *
 * Everything is keyed by `place` — a town slug such as `ajax` — never by project,
 * because a by-law belongs to a jurisdiction. A project reaches its regulations
 * through {@link resolvePlace}, which reads the project's city/region or an
 * explicit `regulationsPlace` override, so "show me the rules for this job" needs
 * no extra bookkeeping on the project itself.
 */
export const regulationsRouter = Router()

const KINDS = ['bylaw', 'form', 'fee', 'standard', 'plan', 'policy', 'page'] as const
const MAX_QUERY_TERMS = 12
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const SNIPPET_CHARS = 220
/** Cap on index rows read per search, so one common word can't fan out forever. */
const MAX_SEARCH_ROWS = 300

/**
 * Mirrors `tokenize()` in the agent's `app/indexing.py` and `routes/search.ts`.
 * It must stay byte-for-byte identical, otherwise the words looked up here are
 * not the words `ingest_regulations.py` wrote into `regulation_terms`.
 * The singular/plural fallback below (`variants()`) is mirrored in the agent's
 * `app/tools/regulations.py` for the same reason.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
}

/** Every index row for one word, this jurisdiction only. */
function termsFor(term: string, place: string): Promise<RegulationTermRecord[]> {
  return queryAll<RegulationTermRecord>(T.regulationTerms, {
    KeyConditionExpression: '#term = :t',
    FilterExpression: '#place = :p',
    ExpressionAttributeNames: { '#term': 'term', '#place': 'place' },
    ExpressionAttributeValues: { ':t': term, ':p': place }
  })
}

/** Singular/plural forms of one query word, tried only when the word itself found nothing. */
function variants(term: string): string[] {
  const out: string[] = []
  if (term.endsWith('ies') && term.length > 4) out.push(`${term.slice(0, -3)}y`)
  else if (term.endsWith('es') && term.length > 3) out.push(term.slice(0, -2))
  else if (term.endsWith('s') && term.length > 2) out.push(term.slice(0, -1))
  else if (term.endsWith('y') && term.length > 2) out.push(`${term.slice(0, -1)}ies`)
  else {
    out.push(`${term}s`)
    out.push(`${term}es`)
  }
  return out.filter((variant) => variant !== term && variant.length >= 2)
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
  if (position < 0) return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat
  const start = Math.max(0, position - Math.floor(SNIPPET_CHARS / 3))
  const end = Math.min(flat.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

function normalize(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** The meaningful words of a place name, used to compare against a project's city. */
function tokens(value?: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length >= 2)
}

/** Does this jurisdiction's own name or website contain every word of the needle? */
function placeMatches(meta: RegulationsMetaRecord, needle: string[]): boolean {
  if (needle.length === 0) return false
  const identity = new Set([
    ...tokens(meta.placeName),
    ...tokens(meta.sourceSite),
    meta.place.toLowerCase()
  ])
  return needle.every((token) => identity.has(token))
}

export interface PlaceMatch {
  place: string
  placeName: string
  matchedOn: 'override' | 'city' | 'region'
}

/**
 * Which jurisdiction a project belongs to. An explicit `regulationsPlace` wins
 * outright; otherwise the project's city, then its region, are matched against
 * the jurisdictions that have actually been ingested. Returns null when nothing
 * matches — a town with no corpus simply has no regulations to show.
 */
export function resolvePlace(site: SiteRecord, metas: RegulationsMetaRecord[]): PlaceMatch | null {
  const override = (site.regulationsPlace ?? '').trim()
  if (override) {
    const meta = metas.find((m) => m.place === override)
    return { place: override, placeName: meta?.placeName ?? override, matchedOn: 'override' }
  }
  const candidates: Array<[string | undefined, 'city' | 'region']> = [
    [site.city, 'city'],
    [site.region, 'region']
  ]
  for (const [value, matchedOn] of candidates) {
    const needle = tokens(value)
    if (needle.length === 0) continue
    const meta = metas.find((m) => placeMatches(m, needle))
    if (meta) return { place: meta.place, placeName: meta.placeName ?? meta.place, matchedOn }
  }
  return null
}

/**
 * The upper-tier region or county a jurisdiction sits inside, if it has one and
 * that region has a corpus. Ontario is two-tier: a town writes the zoning by-laws
 * and most permits, while the region carries the official plan, the development
 * charges and the water/sewer servicing that also bind the project. The link is the
 * `parentRegion` the ingest writes onto the jurisdiction's meta row.
 */
export function regionForPlace(place: string, metas: RegulationsMetaRecord[]): PlaceMatch | null {
  const parent = (metas.find((m) => m.place === place)?.parentRegion ?? '').trim()
  if (!parent) return null
  const meta = metas.find((m) => m.place === parent)
  if (!meta) return null
  return { place: meta.place, placeName: meta.placeName ?? meta.place, matchedOn: 'region' }
}

function knownPlaces(): Promise<RegulationsMetaRecord[]> {
  return scanAll<RegulationsMetaRecord>(T.regulationsMeta)
}

/** For callers that only hold a project — the chat proxy, chiefly. */
export async function placeForSite(site: SiteRecord): Promise<PlaceMatch | null> {
  return resolvePlace(site, await knownPlaces())
}

async function requirePlace(place: string): Promise<RegulationsMetaRecord> {
  const meta = await getItem<RegulationsMetaRecord>(T.regulationsMeta, { place })
  if (!meta) throw new HttpError(404, 'That jurisdiction has no regulations loaded')
  return meta
}

/**
 * The attributes the browse list needs. The document's full `text` and its
 * `terms` array are deliberately left behind: a jurisdiction can hold hundreds of
 * documents and shipping every body to draw a list would be wasteful.
 */
const DOC_PROJECTION = [
  '#docId',
  '#kind',
  '#title',
  '#sourceUrl',
  '#sourceType',
  '#contentType',
  '#bytes',
  '#words',
  '#retrievedAt',
  '#excerpt',
  '#textChars',
  '#truncated',
  '#chunkCount',
  '#indexedAt'
].join(', ')

// Every attribute is aliased: a projection cannot use a reserved word bare, and
// aliasing all of them means adding a field later cannot silently break the list.
const DOC_NAMES: Record<string, string> = {
  '#docId': 'docId',
  '#kind': 'kind',
  '#title': 'title',
  '#sourceUrl': 'sourceUrl',
  '#sourceType': 'sourceType',
  '#contentType': 'contentType',
  '#bytes': 'bytes',
  '#words': 'words',
  '#retrievedAt': 'retrievedAt',
  '#excerpt': 'excerpt',
  '#textChars': 'textChars',
  '#truncated': 'truncated',
  '#chunkCount': 'chunkCount',
  '#indexedAt': 'indexedAt'
}

/** Everything the caller may render, without the index-only `terms` or `text`. */
export type RegulationSummary = Omit<RegulationRecord, 'text' | 'terms'>

/* -------------------------------- places -------------------------------- */

/** The jurisdictions that have a corpus, for the picker on the Regulations page. */
regulationsRouter.get('/', asyncHandler(async (_req, res) => {
  const metas = await knownPlaces()
  metas.sort((a, b) => (a.placeName ?? a.place).localeCompare(b.placeName ?? b.place))
  res.json({
    places: metas.map((meta) => ({
      place: meta.place,
      placeName: meta.placeName ?? meta.place,
      placeType: meta.placeType,
      parentRegion: meta.parentRegion,
      sourceSite: meta.sourceSite,
      seedUrls: meta.seedUrls ?? [],
      pageCount: meta.pageCount ?? 0,
      documentCount: meta.documentCount ?? 0,
      kinds: meta.kinds ?? {},
      ingestedAt: meta.ingestedAt ?? meta.updatedAt
    }))
  })
}))

/** The regulations that apply to one project, resolved from its address. */
regulationsRouter.get('/for-site/:siteId', asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user!, req.params.siteId)
  const metas = await knownPlaces()
  const match = resolvePlace(site, metas)
  // The town's own jurisdiction, plus the upper-tier region that also binds it.
  const region = match ? regionForPlace(match.place, metas) : null
  res.json({ siteId: site.siteId, siteName: site.name, match, region })
}))

/* ------------------------------- documents ------------------------------- */

/** Every document in a jurisdiction, newest first within its kind. */
regulationsRouter.get('/:place', asyncHandler(async (req, res) => {
  const meta = await requirePlace(req.params.place)
  const kind =
    req.query.kind === undefined ? undefined : oneOf<RegulationKind>(req.query.kind, KINDS, 'kind')

  const rows = await queryAll<RegulationSummary>(T.regulations, {
    KeyConditionExpression: '#place = :p',
    FilterExpression: kind ? '#kind = :k' : undefined,
    ProjectionExpression: DOC_PROJECTION,
    ExpressionAttributeNames: { ...DOC_NAMES, '#place': 'place' },
    ExpressionAttributeValues: kind ? { ':p': meta.place, ':k': kind } : { ':p': meta.place }
  })

  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
  res.json({
    place: meta.place,
    placeName: meta.placeName ?? meta.place,
    placeType: meta.placeType,
    sourceSite: meta.sourceSite,
    seedUrls: meta.seedUrls ?? [],
    pageCount: meta.pageCount ?? 0,
    documentCount: meta.documentCount ?? 0,
    kinds: meta.kinds ?? {},
    ingestedAt: meta.ingestedAt ?? meta.updatedAt,
    documents: rows
  })
}))

/** One hit as the agent's `lookup_regulations` returns it. */
interface AgentRegulationHit {
  docId?: string
  title?: string
  kind?: string
  sourceUrl?: string
  sourceType?: string
  place?: string
  placeName?: string
  tier?: string
  matched?: string[]
  snippet?: string
  score?: number
}

/** Whether a hit comes from the project's own town or the region above it. */
export type RegulationTier = 'local' | 'regional'

/** One jurisdiction to search, with the tier its hits carry. */
interface SearchTarget {
  place: string
  placeName: string
  tier: RegulationTier
}

/** A search result, tagged with the jurisdiction it came from and its tier. */
interface SearchHit {
  docId: string
  title: string
  kind: RegulationKind
  sourceUrl: string
  sourceType: 'page' | 'document'
  place: string
  placeName: string
  tier: RegulationTier
  matched: string[]
  snippet: string
  score: number
}

/**
 * Semantic search is computed in the agent's Python process, where the embeddings
 * model (`EMBEDDINGS_PROVIDER=local`) lives. This asks it over HTTP and returns
 * null whenever it is not configured, not reachable, or answers with something
 * unusable — the caller then falls back to the keyword index below, so the route
 * always answers. It is the same reader the assistant uses, so the portal and the
 * assistant never disagree about a jurisdiction. `includeRegion` lets the agent add
 * the town's upper-tier region and label each hit `local` or `regional`.
 */
async function agentSearch(
  place: string,
  query: string,
  limit: number
): Promise<{ mode?: string; note?: string; results: AgentRegulationHit[] } | null> {
  if (!env.AGENT_API_TOKEN) return null
  try {
    const res = await fetch(`${env.AGENT_API_URL}/regulations/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_API_TOKEN}` },
      body: JSON.stringify({ query, place, mode: 'hybrid', limit, includeRegion: true }),
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { mode?: string; note?: string; results?: AgentRegulationHit[] }
    if (!Array.isArray(data.results)) return null
    return { mode: data.mode, note: data.note, results: data.results }
  } catch {
    // The agent is down or has no embeddings provider: keyword search stands in.
    return null
  }
}

/** Keyword search inside one jurisdiction's corpus, scored like the file search. */
async function keywordSearch(
  target: SearchTarget,
  terms: string[],
  kind: RegulationKind | undefined,
  limit: number
): Promise<SearchHit[]> {
  const postings = new Map<string, { docId: string; terms: string[]; score: number }>()
  await Promise.all(
    terms.map(async (term) => {
      let rows = await termsFor(term, target.place)
      if (rows.length === 0) {
        // The corpus is written in the town's own words, which are often plural
        // ("Decks and Accessory Structures"), so a singular query word would
        // otherwise find nothing at all.
        for (const variant of variants(term)) {
          rows = await termsFor(variant, target.place)
          if (rows.length > 0) break
        }
      }
      for (const row of rows) {
        const hit = postings.get(row.docId) ?? { docId: row.docId, terms: [], score: 0 }
        if (!hit.terms.includes(term)) hit.terms.push(term)
        // A word in the title is worth more than one buried on page 40.
        hit.score += 1 + Math.min(Number(row.tf) || 0, 10) * 0.15
        if (row.ntf) hit.score += 1.5
        postings.set(row.docId, hit)
      }
    })
  )

  const ranked = [...postings.values()]
    .sort((a, b) => b.terms.length - a.terms.length || b.score - a.score)
    .slice(0, MAX_SEARCH_ROWS)
  const docs = await Promise.all(
    ranked.map((hit) => getItem<RegulationRecord>(T.regulations, { place: target.place, docId: hit.docId }))
  )

  return ranked
    .map((hit, index) => {
      const doc = docs[index]
      if (!doc) return null
      return {
        docId: doc.docId,
        title: doc.title,
        kind: doc.kind,
        sourceUrl: doc.sourceUrl,
        sourceType: doc.sourceType,
        place: target.place,
        placeName: target.placeName,
        tier: target.tier,
        matched: hit.terms,
        snippet: snippet(doc.text ?? doc.excerpt ?? '', hit.terms),
        score: Math.round(hit.score * 100) / 100
      }
    })
    .filter((result): result is SearchHit => result !== null)
    .filter((result) => !kind || result.kind === kind)
    .slice(0, limit)
}

/**
 * Search one jurisdiction and, when it has one, the upper-tier region above it.
 * Ontario is two-tier, so a project in Ajax is bound by Ajax's by-laws *and*
 * Durham Region's plan, development charges and servicing rules; both are searched
 * and every hit is labelled `local` or `regional`.
 */
regulationsRouter.get('/:place/search', asyncHandler(async (req, res) => {
  const meta = await requirePlace(req.params.place)
  const region = regionForPlace(meta.place, await knownPlaces())
  const targets: SearchTarget[] = [
    { place: meta.place, placeName: meta.placeName ?? meta.place, tier: 'local' },
    ...(region ? [{ place: region.place, placeName: region.placeName, tier: 'regional' as const }] : [])
  ]
  const query = optStr(req.query.q, 200)
  const empty = {
    place: meta.place,
    placeName: meta.placeName ?? meta.place,
    places: targets,
    query: query ?? '',
    count: 0,
    results: [] as SearchHit[]
  }
  if (!query) {
    res.json({ ...empty, note: 'Type a word or two to search this jurisdiction’s regulations.' })
    return
  }

  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  const kind = req.query.kind === undefined ? undefined : oneOf<RegulationKind>(req.query.kind, KINDS, 'kind')

  // Hybrid search through the agent answers with vectors as well as words, so a
  // query phrased the builder's way ("backyard shed") can find a by-law written
  // the town's way ("accessory structure"). The agent also merges the town's parent
  // region. Falls through to the keyword index when the agent is not up.
  const semantic = await agentSearch(meta.place, query, limit)
  if (semantic) {
    const results: SearchHit[] = semantic.results
      .filter((hit) => !kind || hit.kind === kind)
      .slice(0, limit)
      .map((hit) => {
        const place = hit.place ?? meta.place
        const target = targets.find((entry) => entry.place === place)
        return {
          docId: hit.docId ?? '',
          title: hit.title ?? '',
          kind: (hit.kind ?? 'page') as RegulationKind,
          sourceUrl: hit.sourceUrl ?? '',
          sourceType: (hit.sourceType === 'document' ? 'document' : 'page') as 'page' | 'document',
          place,
          placeName: hit.placeName ?? target?.placeName ?? '',
          tier: hit.tier === 'regional' ? 'regional' : 'local',
          matched: hit.matched ?? [],
          snippet: hit.snippet ?? '',
          score: hit.score ?? 0
        }
      })
    res.json({ ...empty, count: results.length, results, note: semantic.note || undefined })
    return
  }

  const terms = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) {
    res.json({ ...empty, note: 'That search had no searchable words.' })
    return
  }

  // The keyword fallback runs over every target — town and region — so the page
  // reads the same whether or not the agent is up. Best score first across both.
  const merged = (await Promise.all(targets.map((target) => keywordSearch(target, terms, kind, limit)))).flat()
  merged.sort((a, b) => b.score - a.score || a.place.localeCompare(b.place))
  const results = merged.slice(0, limit)

  res.json({ ...empty, count: results.length, results })
}))

/** One document, with its chunks, for the in-app reader. */
regulationsRouter.get('/:place/documents/:docId', asyncHandler(async (req, res) => {
  const meta = await requirePlace(req.params.place)
  const doc = await getItem<RegulationRecord>(T.regulations, { place: meta.place, docId: req.params.docId })
  if (!doc) throw new HttpError(404, 'Document not found')

  const chunks = await queryAll<RegulationChunkRecord>(T.regulationChunks, {
    KeyConditionExpression: 'docRef = :r',
    ExpressionAttributeValues: { ':r': doc.ref }
  })
  chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId))

  res.json({
    document: doc,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, text: chunk.text, offset: chunk.offset }))
  })
}))

/**
 * A short-lived link to the stored copy of a document, for download. Web pages
 * have no file of their own — the reader links to the live page instead — so
 * this only answers for ingested documents.
 */
regulationsRouter.get('/:place/documents/:docId/url', asyncHandler(async (req, res) => {
  const meta = await requirePlace(req.params.place)
  const doc = await getItem<RegulationRecord>(T.regulations, { place: meta.place, docId: req.params.docId })
  if (!doc) throw new HttpError(404, 'Document not found')
  if (!doc.fileKey || doc.sourceType !== 'document') {
    throw new HttpError(404, 'This entry is a web page; open it at its source instead')
  }
  const name = doc.fileKey.split('/').pop() || `${doc.title}.pdf`
  const download = req.query.download === 'true'
  res.json({
    url: await presignDownload(doc.fileKey, 900, download ? name : undefined),
    name,
    contentType: doc.contentType
  })
}))
