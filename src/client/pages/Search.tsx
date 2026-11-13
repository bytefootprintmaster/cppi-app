import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { humanBytes, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Card, Empty, ErrorNote, Loading } from '../components/ui'
import { IconDownload, IconExternal, IconFile, IconImage, IconSearch } from '../components/icons'
import type { SiteRecord } from '../../server/types'

/** Shape returned by `GET /api/search`, mirroring `routes/search.ts`. */
interface SearchResult {
  siteId: string
  siteName?: string
  assetId?: string
  name: string
  s3Key: string
  kind: string
  contentType?: string
  size?: number
  uploadedAt?: string
  indexedAt?: string
  matched: string[]
  snippet: string
  tags?: string[]
}

type ResultSort = 'relevance' | 'newest' | 'oldest' | 'name' | 'size'

interface SearchResponse {
  query: string
  count: number
  results: SearchResult[]
  note?: string
}

/** Wrap each matched word in `<mark>` so the reason a file matched is obvious. */
function highlight(text: string, terms: string[]) {
  if (!text || terms.length === 0) return text
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const wanted = new Set(terms)
  return text.split(pattern).map((part, index) =>
    wanted.has(part.toLowerCase()) ? <mark key={index}>{part}</mark> : part
  )
}

export function SearchPage() {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [siteId, setSiteId] = useState('')
  const [sort, setSort] = useState<ResultSort>('relevance')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { user } = useAuth()
  const sites = useApi<{ sites: SiteRecord[] }>('/sites')
  const canDownload = user?.role === 'admin' || user?.permissions?.downloadFiles !== false

  useEffect(() => {
    document.title = 'Search · CPPI'
  }, [])

  // `useApi` refetches whenever the path changes, so submitting is just setting
  // `query`; changing the project filter re-runs the current search.
  const path = query
    ? `/search?q=${encodeURIComponent(query)}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`
    : null
  const { data, error, loading } = useApi<SearchResponse>(path)

  // A fresh search replaces the result set, so any tag picked from the last one
  // would silently filter everything out.
  useEffect(() => {
    setTagFilter(null)
  }, [query, siteId])

  // Every tag present in the current results, so the filter only offers tags
  // that can actually narrow the list.
  const availableTags = useMemo(() => {
    const set = new Set<string>()
    for (const result of data?.results ?? []) for (const tag of result.tags ?? []) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [data])

  const results = useMemo(() => {
    const all = data?.results ?? []
    const filtered = tagFilter
      ? all.filter((result) =>
          (result.tags ?? []).some((tag) => tag.toLowerCase() === tagFilter.toLowerCase())
        )
      : all
    if (sort === 'relevance') return filtered
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return (a.uploadedAt ?? a.indexedAt ?? '').localeCompare(b.uploadedAt ?? b.indexedAt ?? '')
        case 'name':
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        case 'size':
          return (b.size ?? 0) - (a.size ?? 0)
        default:
          return (b.uploadedAt ?? b.indexedAt ?? '').localeCompare(a.uploadedAt ?? a.indexedAt ?? '')
      }
    })
  }, [data, sort, tagFilter])

  async function openResult(result: SearchResult, download = false) {
    if (!result.assetId) return
    const target = window.open('about:blank', '_blank')
    if (!target) {
      setActionError('Your browser blocked the file window. Allow pop-ups for this site and try again.')
      return
    }
    target.opener = null
    setBusyAssetId(result.assetId)
    setActionError(null)
    try {
      const suffix = download ? '?download=true' : ''
      const response = await api<{ url: string }>(
        `/sites/${result.siteId}/assets/${result.assetId}/url${suffix}`
      )
      target.location.href = response.url
    } catch (err) {
      target.close()
      setActionError(err instanceof Error ? err.message : `Could not ${download ? 'download' : 'open'} the file`)
    } finally {
      setBusyAssetId(null)
    }
  }

  return (
    <>
      <PageHeader title="Search" subtitle="Find a file by any word it contains across your projects." />

      <PageBody>
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
                  placeholder="e.g. survey, invoice, geotech report"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  aria-label="Search files"
                />
              </div>
              <select
                className="input search-form-select"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {(sites.data?.sites ?? []).map((site) => (
                  <option key={site.siteId} value={site.siteId}>
                    {site.name}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={!input.trim()}>
                Search
              </Button>
            </form>
          </div>
        </Card>

        <ErrorNote message={error ?? actionError} />

        {loading ? (
          <Loading label="Searching the index…" />
        ) : !query ? (
          <Card>
            <Empty title="Search inside your files">
              Type a word that appears in a document — a report title, a supplier name, a drawing
              number — and every saved file containing it will be listed.
            </Empty>
          </Card>
        ) : !data || data.results.length === 0 ? (
          <Card>
            <Empty title={`No files match “${query}”`}>
              {data?.note ?? 'Try a different word, or search across all projects.'}
            </Empty>
          </Card>
        ) : (
          <Card>
            <div className="card-header">
              <div>
                <div className="card-title">
                  {results.length} file{results.length === 1 ? '' : 's'} found
                  {tagFilter ? ` of ${data.count}` : ''}
                </div>
                <div className="card-sub">Matching “{data.query}”</div>
              </div>
              <select
                className="input file-sort"
                value={sort}
                onChange={(event) => setSort(event.target.value as ResultSort)}
                aria-label="Sort results"
              >
                <option value="relevance">Best match</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name A–Z</option>
                <option value="size">Largest first</option>
              </select>
            </div>

            {availableTags.length > 0 ? (
              <div className="card-body" style={{ paddingTop: 14, paddingBottom: 0 }}>
                <div className="tag-bar" style={{ marginBottom: 12 }}>
                  <button
                    className={`chip${tagFilter === null ? ' on' : ''}`}
                    onClick={() => setTagFilter(null)}
                  >
                    All tags
                  </button>
                  {availableTags.map((tag) => (
                    <button
                      key={tag}
                      className={`chip${tagFilter === tag ? ' on' : ''}`}
                      onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {results.length === 0 ? (
              <div className="card-body">
                <Empty title={`No files tagged “${tagFilter}”`}>
                  Clear the tag filter to see every result for this search.
                </Empty>
              </div>
            ) : (
              <div className="search-results">
                {results.map((result) => (
                  <div key={result.s3Key} className="search-result">
                    <Link
                      className="search-result-link"
                      to={`/sites/${result.siteId}?tab=files${result.assetId ? `&assetId=${encodeURIComponent(result.assetId)}` : ''}`}
                    >
                      <div className="search-result-icon">
                        {result.kind === 'image' ? <IconImage size={18} /> : <IconFile size={18} />}
                      </div>
                      <div className="search-result-main">
                        <div className="row-between" style={{ gap: 10, alignItems: 'flex-start' }}>
                          <div className="search-result-name">{result.name}</div>
                          {result.siteName ? <Badge tone="green">{result.siteName}</Badge> : null}
                        </div>
                        <div className="search-result-meta small muted">
                          <span>{result.kind === 'image' ? 'Image' : 'Document'}</span>
                          <span>·</span>
                          <span>{humanBytes(result.size)}</span>
                          <span>·</span>
                          <span>{relativeTime(result.uploadedAt ?? result.indexedAt)}</span>
                        </div>
                        {result.tags?.length ? (
                          <div className="file-tags">
                            {result.tags.map((tag) => (
                              <span
                                key={tag}
                                role="button"
                                tabIndex={0}
                                className={`chip${tagFilter === tag ? ' on' : ''}`}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  setTagFilter(tagFilter === tag ? null : tag)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    setTagFilter(tagFilter === tag ? null : tag)
                                  }
                                }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {result.snippet ? (
                          <p className="search-result-snippet">
                            {highlight(result.snippet, result.matched)}
                          </p>
                        ) : null}
                        {result.matched.length > 0 ? (
                          <div className="search-result-terms">
                            {result.matched.map((term) => (
                              <Badge key={term} tone="gray">
                                {term}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </Link>
                    {result.assetId ? (
                      <div className="search-result-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busyAssetId === result.assetId}
                          onClick={() => void openResult(result)}
                        >
                          <IconExternal size={15} />
                          Open
                        </Button>
                        {canDownload ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busyAssetId === result.assetId}
                            onClick={() => void openResult(result, true)}
                          >
                            <IconDownload size={15} />
                            Download
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
