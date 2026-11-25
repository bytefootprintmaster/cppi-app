import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { humanBytes, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Card, Empty, ErrorNote, Loading, Modal } from '../components/ui'
import {
  IconDownload,
  IconExternal,
  IconFile,
  IconScale,
  IconSearch
} from '../components/icons'
import type { RegulationKind, RegulationRecord } from '../../server/types'

/* ------------------------------- api shapes ------------------------------ */

interface PlaceSummary {
  place: string
  placeName: string
  placeType?: string
  parentRegion?: string
  sourceSite?: string
  seedUrls: string[]
  pageCount: number
  documentCount: number
  kinds: Partial<Record<RegulationKind, number>>
  ingestedAt?: string
}

/** A regulation as it arrives in the browse list: without the indexed text. */
type RegulationSummary = Omit<RegulationRecord, 'text' | 'terms'>

interface Listing extends PlaceSummary {
  documents: RegulationSummary[]
}

/** Local is the town's own by-law; regional is the upper-tier region above it. */
type RegulationTier = 'local' | 'regional'

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

interface SearchTarget {
  place: string
  placeName: string
  tier: RegulationTier
}

interface SearchResponse {
  place: string
  placeName: string
  /** Every jurisdiction searched — the town, then the region above it, if any. */
  places?: SearchTarget[]
  query: string
  count: number
  results: SearchHit[]
  note?: string
}

interface ReaderResponse {
  document: RegulationRecord
  chunks: Array<{ chunkId: string; text: string; offset: number }>
}

interface PlaceMatch {
  place: string
  placeName: string
  matchedOn: 'override' | 'city' | 'region'
}

interface SiteMatch {
  siteId: string
  siteName: string
  match: PlaceMatch | null
  /** The upper-tier region the matched town sits inside, if one has a corpus. */
  region: PlaceMatch | null
}

/* --------------------------------- kinds --------------------------------- */

/**
 * The order the shelves read in, and the colour each category carries. A builder
 * looking for "the sign by-law" and one looking for "the PLD-080 form" scan by
 * category long before they read a title, so the category is the loudest signal.
 */
const KIND_META = [
  { key: 'bylaw', label: 'By-laws', tone: 'green' },
  { key: 'form', label: 'Forms & applications', tone: 'amber' },
  { key: 'fee', label: 'Fees & charges', tone: 'blue' },
  { key: 'standard', label: 'Standards & details', tone: 'gray' },
  { key: 'plan', label: 'Plans & zoning', tone: 'blue' },
  { key: 'policy', label: 'Policies & guides', tone: 'gray' },
  { key: 'page', label: 'Guidance pages', tone: 'gray' }
] as const

type Tone = (typeof KIND_META)[number]['tone']

const KIND_BY_KEY = new Map<string, { label: string; tone: Tone }>(
  KIND_META.map((entry) => [entry.key, { label: entry.label, tone: entry.tone }])
)

function kindLabel(kind: string): string {
  return KIND_BY_KEY.get(kind)?.label ?? kind
}

function kindTone(kind: string): Tone {
  return KIND_BY_KEY.get(kind)?.tone ?? 'gray'
}

/* ----------------------------- markdown reader ---------------------------- */

/**
 * The crawler stores ordinary markdown, but the PDF extractor emits hard-wrapped
 * lines and peels tables out of the pages. Rendering that as raw text buries the
 * answer, so it is parsed into blocks — headings, lists, tables, quotes — and the
 * consecutive lines of a paragraph are re-joined, which matters most for the PDF
 * text whose sentences are broken every 90 characters.
 */
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }
  | { type: 'table'; head: string[]; rows: string[][] }

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]|[□■▪•●])\s+(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
// A by-law's own sections survive PDF extraction as numbered, all-caps lines —
// "1. DEFINITIONS", "13. DEVELOPMENT CHARGE SCHEDULE INDEXING" — not as markdown.
// Without them the longest documents, the by-laws a builder most needs to
// navigate, are the only ones with no outline at all. Requiring the rest of the
// line to be uppercase keeps ordinary numbered prose out.
const SECTION = /^\d{1,2}\.\s+[A-Z][A-Z0-9 ,'"&()/.-]{2,70}$/
const SCHEDULE = /^SCHEDULE\s+["']?[A-Z\d]{1,3}["']?$/

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function parseMarkdown(markdown: string): Block[] {
  const lines = (markdown ?? '').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) {
      i += 1
      continue
    }

    const heading = HEADING.exec(trimmed)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i += 1
      continue
    }

    if (SECTION.test(trimmed) || SCHEDULE.test(trimmed)) {
      blocks.push({ type: 'heading', level: 2, text: trimmed })
      i += 1
      continue
    }

    if (RULE.test(trimmed)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (trimmed.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim())
        i += 1
      }
      const rows = tableLines.map(splitRow)
      const separator = rows.findIndex((row) => row.every((cell) => /^:?-{2,}:?$/.test(cell)))
      blocks.push({
        type: 'table',
        head: separator > 0 ? rows[0] : [],
        rows: separator >= 0 ? rows.slice(separator + 1) : rows
      })
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: quoted.join(' ') })
      continue
    }

    if (LIST_ITEM.test(trimmed)) {
      const items: string[] = []
      const ordered = /^\d/.test(trimmed)
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i].trim())
        if (!item) break
        items.push(item[1].trim())
        i += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // A paragraph runs to the next blank line or the next block opener.
    const buffer: string[] = []
    while (i < lines.length) {
      const line = lines[i].trim()
      if (
        !line ||
        HEADING.test(line) ||
        SECTION.test(line) ||
        SCHEDULE.test(line) ||
        RULE.test(line) ||
        line.startsWith('|') ||
        line.startsWith('>') ||
        LIST_ITEM.test(line)
      ) {
        break
      }
      buffer.push(line)
      i += 1
    }
    if (buffer.length) blocks.push({ type: 'paragraph', text: buffer.join(' ') })
  }

  return blocks
}

/** Links, bold and inline code — the only markup the crawler emits in a line. */
function inline(text: string, key: string): ReactNode[] {
  const pattern = /\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|`([^`]+)`/g
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let n = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const id = `${key}-i${n++}`
    if (match[1] !== undefined) {
      nodes.push(
        <a key={id} href={match[2]} target="_blank" rel="noreferrer noopener">
          {match[1].trim().replace(/\s+/g, ' ')}
        </a>
      )
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={id}>{match[3]}</strong>)
    } else {
      nodes.push(<code key={id}>{match[4]}</code>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** One entry in a document's outline, keyed to the heading it scrolls to. */
interface OutlineEntry {
  id: string
  level: number
  text: string
}

/** The id a heading block carries in the reader, so the outline can jump to it. */
function headingId(index: number): string {
  return `reg-heading-${index}`
}

function Markdown({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) {
    return <p className="reg-reader-empty">This document has no readable text.</p>
  }
  return (
    <div className="reg-reader">
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.type) {
          case 'heading': {
            const Level = (block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5'
            return (
              <Level key={key} id={headingId(index)}>
                {inline(block.text, key)}
              </Level>
            )
          }
          case 'list':
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            )
          case 'quote':
            return <blockquote key={key}>{inline(block.text, key)}</blockquote>
          case 'rule':
            return <hr key={key} />
          case 'table':
            return (
              <div className="reg-table-wrap" key={key}>
                <table className="table">
                  {block.head.length ? (
                    <thead>
                      <tr>
                        {block.head.map((cell, cellIndex) => (
                          <th key={`${key}-h${cellIndex}`}>{inline(cell, `${key}-h${cellIndex}`)}</th>
                        ))}
                      </tr>
                    </thead>
                  ) : null}
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r${rowIndex}c${cellIndex}`}>
                            {inline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={key}>{inline(block.text, key)}</p>
        }
      })}
    </div>
  )
}

/* ------------------------------ reader helpers ---------------------------- */

/**
 * The text a document should actually show.
 *
 * `document.text` is capped at 8,000 characters by the indexer, which leaves the
 * bulk of a long by-law unreadable — the development-charge by-law runs to 55,000
 * characters, so the reader used to show about a seventh of it. The chunks in the
 * same response are that document cut into contiguous, non-overlapping windows, so
 * joining them in order restores the whole text. They are re-joined with a newline:
 * the markdown parser folds consecutive lines back into one paragraph, so a join at
 * a genuine line break stays a line break and a join mid-paragraph costs nothing.
 */
function readerText(data: ReaderResponse): string {
  const excerpt = data.document.text ?? ''
  const chunks = [...(data.chunks ?? [])].sort((a, b) => a.chunkId.localeCompare(b.chunkId))
  if (chunks.length === 0) return excerpt
  const joined = chunks
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join('\n')
  return joined.length > excerpt.length ? joined : excerpt
}

/** How much of the original document the joined chunks reach, in characters. */
function readerCoverage(data: ReaderResponse): number {
  const chunks = data.chunks ?? []
  if (chunks.length === 0) return (data.document.text ?? '').length
  const last = [...chunks].sort((a, b) => a.chunkId.localeCompare(b.chunkId))[chunks.length - 1]
  return (last.offset ?? 0) + last.text.length
}

function outlineOf(blocks: Block[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'heading') entries.push({ id: headingId(index), level: block.level, text: block.text })
  })
  // One heading is not an outline, it is a title.
  return entries.length > 1 ? entries : []
}

/**
 * The matched words inside a result excerpt, marked. The trailing `\w*` lets a
 * query word light up the longer town wording it stood in for — searching "deck"
 * highlights "Decks", which is how the by-law is actually titled.
 */
function highlight(text: string, terms: string[]): ReactNode {
  const patterns = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean)
  if (patterns.length === 0) return text
  const re = new RegExp(`\\b(${patterns.join('|')})\\w*`, 'gi')
  const nodes: ReactNode[] = []
  let last = 0
  let n = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    nodes.push(
      <mark key={`m${n++}`} className="reg-hit">
        {match[0]}
      </mark>
    )
    last = match.index + match[0].length
    if (match.index === re.lastIndex) re.lastIndex += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/* ---------------------------------- page --------------------------------- */

export function RegulationsPage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('place') ?? ''
  const siteId = params.get('siteId') ?? ''
  // The open document lives on the URL: a by-law can then be linked to a
  // contractor, survives a reload, and closes on the browser's Back button.
  const openDoc = params.get('doc')

  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<RegulationKind | ''>('')
  const [busyDoc, setBusyDoc] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const setDoc = useCallback(
    (docId: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (docId) next.set('doc', docId)
          else next.delete('doc')
          return next
        },
        // Opening pushes a history entry so Back closes the reader; closing
        // replaces, so Back leaves the page rather than reopening the document.
        docId ? undefined : { replace: true }
      )
    },
    [setParams]
  )

  useEffect(() => {
    document.title = 'Regulations · CPPI'
  }, [])

  const places = useApi<{ places: PlaceSummary[] }>('/regulations')
  const siteMatch = useApi<SiteMatch>(siteId ? `/regulations/for-site/${siteId}` : null)
  const listing = useApi<Listing>(selected ? `/regulations/${encodeURIComponent(selected)}` : null)
  const search = useApi<SearchResponse>(
    selected && query ? `/regulations/${encodeURIComponent(selected)}/search?q=${encodeURIComponent(query)}` : null
  )
  const reader = useApi<ReaderResponse>(
    selected && openDoc ? `/regulations/${encodeURIComponent(selected)}/documents/${encodeURIComponent(openDoc)}` : null
  )

  // Arriving from a project, the jurisdiction is whichever that project resolves
  // to; otherwise the first one loaded. Kept in the URL so the view is shareable.
  useEffect(() => {
    if (selected || !places.data) return
    if (siteId && !siteMatch.data) return
    const fallback = siteMatch.data?.match?.place ?? places.data.places[0]?.place
    if (!fallback) return
    // Keep whatever else is on the URL, so a project link survives the redirect.
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('place', fallback)
        return next
      },
      { replace: true }
    )
  }, [selected, siteId, places.data, siteMatch.data, setParams])

  // A different jurisdiction is a different corpus: drop the last one's filters
  // and any document it had open. Guarded against the first render so a shared
  // link like ?place=ajax&doc=… keeps the document it points at.
  const lastPlace = useRef(selected)
  useEffect(() => {
    if (lastPlace.current === selected) return
    lastPlace.current = selected
    setKind('')
    setQuery('')
    setInput('')
    setDoc(null)
  }, [selected, setDoc])

  const current = places.data?.places.find((place) => place.place === selected)
  // The upper-tier region this jurisdiction sits inside, when one has a corpus.
  // Ontario is two-tier, so Ajax's rules and Durham Region's both apply.
  const region = current?.parentRegion
    ? places.data?.places.find((place) => place.place === current.parentRegion)
    : undefined
  const twoTier = Boolean(region)
  const counts = listing.data?.kinds ?? current?.kinds ?? {}
  const shelves = KIND_META.filter((entry) => (counts[entry.key] ?? 0) > 0)
  const totalDocuments = (listing.data?.pageCount ?? 0) + (listing.data?.documentCount ?? 0)

  const documents = useMemo(() => {
    const rows = listing.data?.documents ?? []
    return kind ? rows.filter((row) => row.kind === kind) : rows
  }, [listing.data, kind])

  const results = useMemo(() => {
    const rows = search.data?.results ?? []
    return kind ? rows.filter((row) => row.kind === kind) : rows
  }, [search.data, kind])

  // The scope a search actually covered: the town alone, or the town and its
  // region. With two, each hit is badged with the jurisdiction it came from.
  const searchScope = search.data?.places ?? []
  const scopeLabel =
    searchScope.length > 1
      ? searchScope.map((entry) => entry.placeName).join(' and ')
      : search.data?.placeName ?? ''

  // The reader's body and outline, derived once per open document.
  const openDocument = reader.data?.document ?? null
  const readText = useMemo(() => (reader.data ? readerText(reader.data) : ''), [reader.data])
  const readBlocks = useMemo(() => parseMarkdown(readText), [readText])
  const outline = useMemo(() => outlineOf(readBlocks), [readBlocks])
  // `textChars` is the length of the whole extracted document, so comparing it
  // with what the chunks reach tells the reader whether anything is missing.
  const fullChars = openDocument?.textChars ?? 0
  const coveredChars = reader.data ? readerCoverage(reader.data) : 0

  function jumpTo(id: string) {
    const target = document.getElementById(id)
    if (!target) return
    // Honour a reader who has asked their system for less motion.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }

  function openExternal(url: string) {
    window.open(url, '_blank', 'noopener')
  }

  /** The stored copy of a document lives in S3 behind a short-lived signed link. */
  async function download(documentId: string, title: string) {
    const target = window.open('about:blank', '_blank')
    if (!target) {
      setActionError('Your browser blocked the download window. Allow pop-ups for this site and try again.')
      return
    }
    target.opener = null
    setBusyDoc(documentId)
    setActionError(null)
    try {
      const response = await api<{ url: string }>(
        `/regulations/${encodeURIComponent(selected)}/documents/${encodeURIComponent(documentId)}/url?download=true`
      )
      target.location.href = response.url
    } catch (err) {
      target.close()
      setActionError(err instanceof Error ? err.message : `Could not download “${title}”`)
    } finally {
      setBusyDoc(null)
    }
  }

  const subtitle = current
    ? `By-laws, forms, fees and standards published by ${current.placeName}.`
    : 'By-laws, forms, fees and standards a town publishes for builders.'

  return (
    <>
      <PageHeader
        title="Regulations"
        subtitle={subtitle}
        actions={
          current?.sourceSite ? (
            <Button variant="ghost" size="sm" onClick={() => openExternal(`https://${current.sourceSite}`)}>
              <IconExternal size={15} />
              {current.sourceSite}
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        <ErrorNote message={actionError ?? places.error ?? listing.error ?? search.error} />

        {siteId && siteMatch.data && !siteMatch.data.match ? (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            No regulations are loaded for {siteMatch.data.siteName} yet — showing the library instead. Add a city
            to the project, or pick its jurisdiction, to link it directly.
          </div>
        ) : null}

        {/* Ontario is two-tier. Say so, so a regional rule in the results never
            surprises — and so the local/regional badges below have a meaning. */}
        {twoTier && region && current ? (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            {current.placeName} sits inside {region.placeName}. Searches here cover both: {current.placeName}’s
            by-laws, permits and forms are labelled <strong>local</strong>, and {region.placeName}’s official
            plan, development charges and servicing rules are labelled <strong>regional</strong>.
          </div>
        ) : null}

        {/* Jurisdictions. One town needs no picker; several read as a shelf of them. */}
        {(places.data?.places.length ?? 0) > 1 ? (
          <div className="tag-bar reg-jurisdictions">
            {places.data!.places.map((place) => (
              <button
                key={place.place}
                type="button"
                className={`chip${place.place === selected ? ' on' : ''}`}
                aria-pressed={place.place === selected}
                onClick={() => setParams({ place: place.place })}
              >
                {place.placeName}
                <span className="reg-jurisdiction-count">{place.pageCount + place.documentCount}</span>
              </button>
            ))}
          </div>
        ) : null}

        {places.loading && !places.data ? <Loading label="Loading the regulations library…" /> : null}

        {places.data && places.data.places.length === 0 ? (
          <Card>
            <Empty title="No regulations have been loaded yet">
              Regulations are crawled from a town’s own website and indexed by{' '}
              <code>scripts/ingest_regulations.py</code>. Once a town is ingested it appears here.
            </Empty>
          </Card>
        ) : null}

        {selected ? (
          <>
            <Card>
              <div className="card-body">
                <form
                  className="search-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    setQuery(input.trim())
                  }}
                >
                  <div className="search-form-field">
                    <IconSearch size={18} className="search-form-icon" />
                    <input
                      className="input search-form-input"
                      placeholder="e.g. sign permit, development charge, driveway"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      aria-label="Search this jurisdiction’s regulations"
                    />
                  </div>
                  <Button type="submit" disabled={!input.trim()}>
                    Search
                  </Button>
                  {query ? (
                    <Button variant="ghost" type="button" onClick={() => setQuery('')}>
                      Clear
                    </Button>
                  ) : null}
                </form>
              </div>

              {shelves.length > 0 ? (
                <div className="card-body reg-shelves">
                  <div className="tag-bar">
                    <button
                      type="button"
                      className={`chip${kind === '' ? ' on' : ''}`}
                      aria-pressed={kind === ''}
                      onClick={() => setKind('')}
                    >
                      All<span className="reg-jurisdiction-count">{totalDocuments}</span>
                    </button>
                    {shelves.map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        className={`chip${kind === entry.key ? ' on' : ''}`}
                        aria-pressed={kind === entry.key}
                        onClick={() => setKind(kind === entry.key ? '' : entry.key)}
                      >
                        {entry.label}
                        <span className="reg-jurisdiction-count">{counts[entry.key]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>

            {/* Search wins over browsing: a deliberate query should never be buried. */}
            {query ? (
              search.loading ? (
                <Loading label={`Searching ${current?.placeName ?? 'the regulations'}…`} />
              ) : !search.data || search.data.results.length === 0 ? (
                <Card>
                  <Empty title={`Nothing matches “${query}”`}>
                    {search.data?.note ?? 'Try a broader word — “fence”, “driveway”, “permit”.'}
                  </Empty>
                </Card>
              ) : (
                <Card>
                  <div className="card-header">
                    <div>
                      <div className="card-title">
                        {results.length} result{results.length === 1 ? '' : 's'} in {scopeLabel}
                      </div>
                      <div className="card-sub">
                        Matching “{search.data.query}”
                        {searchScope.length > 1 ? ' · local and regional rules' : ''}
                      </div>
                    </div>
                  </div>
                  {results.length === 0 ? (
                    <div className="card-body">
                      <Empty title="None in this category">Clear the category filter to widen the search.</Empty>
                    </div>
                  ) : (
                    <div className="reg-docs">
                      {results.map((hit) => (
                        <div key={hit.docId} className="reg-doc">
                          <div className="reg-doc-main">
                            <div className="reg-doc-head">
                              <Badge tone={kindTone(hit.kind)}>{kindLabel(hit.kind)}</Badge>
                              {searchScope.length > 1 ? (
                                <Badge tone={hit.tier === 'regional' ? 'blue' : 'gray'}>{hit.placeName}</Badge>
                              ) : null}
                              <button type="button" className="reg-doc-title" onClick={() => setDoc(hit.docId)}>
                                {hit.title}
                              </button>
                            </div>
                            {hit.snippet ? (
                              <p className="reg-doc-excerpt">{highlight(hit.snippet, hit.matched)}</p>
                            ) : null}
                            <div className="reg-doc-terms">
                              {hit.matched.map((term) => (
                                <Badge key={term} tone="gray">
                                  {term}
                                </Badge>
                              ))}
                            </div>
                          </div>
                          <div className="reg-doc-actions">
                            <Button variant="ghost" size="sm" onClick={() => setDoc(hit.docId)}>
                              Read
                            </Button>
                            {hit.sourceType === 'document' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={busyDoc === hit.docId}
                                onClick={() => void download(hit.docId, hit.title)}
                              >
                                <IconDownload size={15} />
                                PDF
                              </Button>
                            ) : null}
                            <Button variant="ghost" size="sm" onClick={() => openExternal(hit.sourceUrl)}>
                              <IconExternal size={15} />
                              Source
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )
            ) : listing.loading && !listing.data ? (
              <Loading label="Opening the library…" />
            ) : documents.length === 0 ? (
              <Card>
                <Empty title={kind ? 'Nothing in this category' : 'This library is empty'}>
                  {kind ? 'Pick another category to see what is available.' : 'The last crawl found no documents.'}
                </Empty>
              </Card>
            ) : (
              <Card>
                <div className="card-header">
                  <div>
                    <div className="card-title">
                      {kind ? kindLabel(kind) : 'Everything published'}
                    </div>
                    <div className="card-sub">
                      {documents.length} item{documents.length === 1 ? '' : 's'}
                      {listing.data?.ingestedAt ? ` · crawled ${relativeTime(listing.data.ingestedAt)}` : ''}
                    </div>
                  </div>
                </div>
                <div className="reg-docs">
                  {documents.map((doc) => (
                    <div key={doc.docId} className="reg-doc">
                      <div className="reg-doc-icon">
                        <IconFile size={18} />
                      </div>
                      <div className="reg-doc-main">
                        <div className="reg-doc-head">
                          <button type="button" className="reg-doc-title" onClick={() => setDoc(doc.docId)}>
                            {doc.title}
                          </button>
                          <Badge tone={kindTone(doc.kind)}>{kindLabel(doc.kind)}</Badge>
                        </div>
                        <div className="reg-doc-meta">
                          <span>{doc.sourceType === 'document' ? 'PDF' : 'Web page'}</span>
                          {doc.sourceType === 'document' ? (
                            <>
                              <span>·</span>
                              <span>{humanBytes(doc.bytes)}</span>
                            </>
                          ) : null}
                          {doc.words ? (
                            <>
                              <span>·</span>
                              <span>{doc.words.toLocaleString()} words</span>
                            </>
                          ) : null}
                        </div>
                        {doc.excerpt ? <p className="reg-doc-excerpt">{doc.excerpt}</p> : null}
                      </div>
                      <div className="reg-doc-actions">
                        <Button variant="ghost" size="sm" onClick={() => setDoc(doc.docId)}>
                          Read
                        </Button>
                        {doc.sourceType === 'document' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busyDoc === doc.docId}
                            onClick={() => void download(doc.docId, doc.title)}
                          >
                            <IconDownload size={15} />
                            PDF
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => openExternal(doc.sourceUrl)}>
                          <IconExternal size={15} />
                          Source
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        ) : null}
      </PageBody>

      {openDoc ? (
        <Modal
          wide
          title={openDocument?.title ?? 'Reading…'}
          onClose={() => setDoc(null)}
          footer={
            openDocument ? (
              <div className="reg-reader-foot">
                <span className="small muted">
                  {fullChars > 0 ? `${fullChars.toLocaleString()} characters` : 'Indexed reference copy'}
                  {fullChars > 0 && coveredChars < fullChars
                    ? ` · ${coveredChars.toLocaleString()} indexed`
                    : ''}
                </span>
                <div className="reg-reader-foot-actions">
                  {openDocument.sourceType === 'document' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyDoc === openDocument.docId}
                      onClick={() => openDocument && void download(openDocument.docId, openDocument.title)}
                    >
                      <IconDownload size={15} />
                      Download PDF
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => openExternal(openDocument.sourceUrl)}>
                    <IconExternal size={15} />
                    Open at source
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          {reader.loading && !reader.data ? (
            <Loading label="Opening the document…" />
          ) : !reader.data ? (
            <ErrorNote message={reader.error ?? 'That document could not be opened.'} />
          ) : (
            <div className="reg-document">
              <div className="reg-document-meta">
                <Badge tone={kindTone(reader.data.document.kind)}>{kindLabel(reader.data.document.kind)}</Badge>
                <span className="small muted">
                  {reader.data.document.placeName}
                  {reader.data.document.retrievedAt
                    ? ` · retrieved ${relativeTime(reader.data.document.retrievedAt)}`
                    : ''}
                </span>
              </div>

              {outline.length > 1 ? (
                <details className="reg-outline">
                  <summary>
                    In this document
                    <span className="reg-outline-count">{outline.length}</span>
                  </summary>
                  <ol>
                    {outline.map((entry) => (
                      <li key={entry.id} data-level={entry.level}>
                        <button type="button" onClick={() => jumpTo(entry.id)}>
                          {entry.text}
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}

              <Markdown blocks={readBlocks} />

              {fullChars > 0 && coveredChars < fullChars ? (
                <p className="reg-document-truncated">
                  This shows {coveredChars.toLocaleString()} of about {fullChars.toLocaleString()} characters —
                  as much as was indexed. Open the official document for the rest.
                </p>
              ) : null}

              <div className="reg-cite">
                <IconScale size={16} />
                <div>
                  <div className="reg-cite-label">Official source</div>
                  <a href={reader.data.document.sourceUrl} target="_blank" rel="noreferrer noopener">
                    {reader.data.document.sourceUrl}
                  </a>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    A reference copy of a public document. Always confirm against the official version — this is
                    not legal advice.
                  </p>
                </div>
              </div>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
