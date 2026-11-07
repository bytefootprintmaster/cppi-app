import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi'
import { humanBytes, relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Card, Empty, ErrorNote, Loading } from '../components/ui'
import { IconFile, IconImage, IconSearch } from '../components/icons'
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
}

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
  const sites = useApi<{ sites: SiteRecord[] }>('/sites')

  useEffect(() => {
    document.title = 'Search · CPPI'
  }, [])

  // `useApi` refetches whenever the path changes, so submitting is just setting
  // `query`; changing the project filter re-runs the current search.
  const path = query
    ? `/search?q=${encodeURIComponent(query)}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`
    : null
  const { data, error, loading } = useApi<SearchResponse>(path)

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

        <ErrorNote message={error} />

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
                  {data.count} file{data.count === 1 ? '' : 's'} found
                </div>
                <div className="card-sub">Matching “{data.query}”</div>
              </div>
            </div>
            <div className="search-results">
              {data.results.map((result) => (
                <Link key={result.s3Key} className="search-result" to={`/sites/${result.siteId}`}>
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
                    {result.snippet ? (
                      <p className="search-result-snippet">{highlight(result.snippet, result.matched)}</p>
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
              ))}
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
