import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { relativeTime } from '../lib/format'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Empty, ErrorNote, Loading, Modal } from '../components/ui'
import { IconChat, IconCheck, IconDownload, IconPlus, IconSend, IconTrash, IconX } from '../components/icons'
import type {
  ChatArtifact,
  ChatMessageRecord,
  ChatPendingAction,
  ChatThreadRecord,
  SiteRecord
} from '../../server/types'

/* ------------------------------ small helpers ---------------------------- */

const EXAMPLES = [
  'I am at 27 Mandrake St, the foundation is done — make me a Site inspection report',
  'What is the current progress on each project?',
  "Record that the framing passed inspection at the Ajax site"
]

/** A friendly name for the dashboard change the assistant parked for approval. */
const TOOL_LABEL: Record<string, string> = {
  propose_site_status: 'Change the project status',
  propose_stage_status: 'Change a stage status',
  propose_milestone_status: 'Change a milestone status'
}

function clockTime(value?: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Optimistic turns shown while the agent is working, before the server reply lands. */
interface OverlayTurn {
  role: 'user' | 'assistant'
  text: string
  thinking?: boolean
}

/* -------------------------------- bubbles -------------------------------- */

function Thinking() {
  return (
    <span className="chat-thinking" aria-label="The assistant is working">
      <span className="chat-dot" />
      <span className="chat-dot" />
      <span className="chat-dot" />
    </span>
  )
}

function PendingCard({
  action,
  busy,
  onDecide
}: {
  action: ChatPendingAction
  busy: boolean
  onDecide: (actionId: string, decision: 'approve' | 'reject') => void
}) {
  const decided = action.status !== 'pending'
  return (
    <div className="chat-pending">
      <div className="chat-pending-head">
        <IconCheck size={15} />
        <span>{TOOL_LABEL[action.tool] ?? action.tool}</span>
        {decided ? (
          <Badge tone={action.status === 'approved' ? 'green' : 'gray'}>
            {action.status === 'approved' ? 'Approved' : 'Rejected'}
          </Badge>
        ) : (
          <Badge tone="amber">Needs approval</Badge>
        )}
      </div>
      <div className="chat-pending-preview">{action.preview}</div>
      {decided ? (
        action.resolution ? <div className="small muted">{action.resolution}</div> : null
      ) : (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" loading={busy} onClick={() => onDecide(action.actionId, 'approve')}>
            Approve
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide(action.actionId, 'reject')}>
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

function ArtifactCard({ artifact, onDownload }: { artifact: ChatArtifact; onDownload: (a: ChatArtifact) => void }) {
  return (
    <button type="button" className="chat-artifact" onClick={() => onDownload(artifact)}>
      <IconDownload size={16} />
      <span className="chat-artifact-text">
        <span className="chat-artifact-title">{artifact.title ?? artifact.name}</span>
        <span className="small muted">
          {artifact.name}
          {artifact.size ? ` · ${Math.max(1, Math.round(artifact.size / 1024))} KB` : ''}
        </span>
      </span>
    </button>
  )
}

/* ------------------------------ thread sidebar --------------------------- */

function ThreadList({
  threads,
  activeId,
  onSelect,
  onDelete
}: {
  threads: ChatThreadRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  if (threads.length === 0) {
    return <div className="small muted" style={{ padding: '6px 4px' }}>No saved conversations yet.</div>
  }
  return (
    <div className="chat-thread-list">
      {threads.map((thread) => (
        <div key={thread.threadId} className={`chat-thread${thread.threadId === activeId ? ' on' : ''}`}>
          <button type="button" className="chat-thread-open" onClick={() => onSelect(thread.threadId)}>
            <span className="chat-thread-title">{thread.title}</span>
            <span className="chat-thread-sub">{relativeTime(thread.updatedAt)}</span>
          </button>
          <button
            type="button"
            className="chat-thread-del"
            aria-label="Delete conversation"
            title="Delete conversation"
            onClick={() => onDelete(thread.threadId)}
          >
            <IconTrash size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------- page --------------------------------- */

export function ChatPage() {
  const [params] = useSearchParams()
  const paramSiteId = params.get('siteId') ?? ''

  const [activeId, setActiveId] = useState<string | null>(null)
  const [siteId, setSiteId] = useState(paramSiteId)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [overlay, setOverlay] = useState<OverlayTurn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [thread, setThread] = useState<ChatThreadRecord | null>(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)

  const sites = useApi<{ sites: SiteRecord[] }>('/sites')
  const status = useApi<{ configured: boolean; reachable: boolean }>('/chat/status')
  const threads = useApi<{ threads: ChatThreadRecord[] }>('/chat/threads')

  useEffect(() => {
    document.title = 'Assistant · CPPI'
  }, [])

  // A project page can deep-link here with `?siteId=`, pre-selecting its context.
  useEffect(() => {
    if (paramSiteId) setSiteId(paramSiteId)
  }, [paramSiteId])

  const siteNameFor = useCallback(
    (id?: string) => (id ? sites.data?.sites.find((s) => s.siteId === id)?.name ?? id : undefined),
    [sites.data]
  )

  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true)
    try {
      const data = await api<{ thread: ChatThreadRecord; messages: ChatMessageRecord[] }>(
        `/chat/threads/${id}`
      )
      setThread(data.thread)
      setMessages(data.messages)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the conversation')
    } finally {
      setLoadingThread(false)
    }
  }, [])

  // Load the selected conversation. `activeId === null` is the "new chat" draft.
  useEffect(() => {
    if (!activeId) {
      setThread(null)
      setMessages([])
      return
    }
    void loadThread(activeId)
  }, [activeId, loadThread])

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, overlay.length, sending, activeId])

  /** Reuse the open thread, or create one (with the chosen project context). */
  async function ensureThread(): Promise<string> {
    if (activeId) return activeId
    const { thread: created } = await api<{ thread: ChatThreadRecord }>('/chat/threads', {
      method: 'POST',
      body: { siteId: siteId || undefined }
    })
    return created.threadId
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    setDraft('')
    setOverlay([{ role: 'user', text }, { role: 'assistant', text: '', thinking: true }])
    try {
      const tid = await ensureThread()
      await api(`/chat/threads/${tid}/messages`, { method: 'POST', body: { message: text } })
      setActiveId(tid)
      await loadThread(tid)
      setOverlay([])
      void threads.reload()
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Something went wrong'
      setError(detail)
      // Keep the user's words on screen and explain the failure in a reply bubble.
      setOverlay([{ role: 'user', text }, { role: 'assistant', text: detail }])
    } finally {
      setSending(false)
    }
  }

  async function decide(actionId: string, decision: 'approve' | 'reject') {
    if (!activeId) return
    setBusyAction(actionId)
    setError(null)
    try {
      await api(`/chat/threads/${activeId}/actions/${actionId}/${decision}`, { method: 'POST' })
      await loadThread(activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the approval')
    } finally {
      setBusyAction(null)
    }
  }

  async function download(artifact: ChatArtifact) {
    if (!artifact.assetId) return
    setError(null)
    try {
      const { url } = await api<{ url: string }>(`/sites/${artifact.siteId}/assets/${artifact.assetId}/url`)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the report')
    }
  }

  async function removeThread(id: string) {
    setError(null)
    try {
      await api(`/chat/threads/${id}`, { method: 'DELETE' })
      if (activeId === id) setActiveId(null)
      void threads.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the conversation')
    }
  }

  function startNew() {
    setActiveId(null)
    setMessages([])
    setThread(null)
    setOverlay([])
    setError(null)
    setDraft('')
    setListOpen(false)
  }

  const threadList = threads.data?.threads ?? []
  const conversationStarted = messages.length > 0 || overlay.length > 0
  const assistantOffline = status.data ? !status.data.configured || !status.data.reachable : false

  return (
    <>
      <PageHeader
        title="Assistant"
        subtitle="Ask about any project, record what you see, or generate a report."
        actions={
          <>
            <Button variant="ghost" className="chat-convos-btn" onClick={() => setListOpen(true)}>
              <IconChat size={16} />
              Conversations
              {threadList.length ? <span className="chat-count">{threadList.length}</span> : null}
            </Button>
            <Button onClick={startNew}>
              <IconPlus size={16} />
              New chat
            </Button>
          </>
        }
      />
      <PageBody>
        <ErrorNote message={error} />

        {assistantOffline ? (
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            The assistant service is not reachable right now. Your messages are still saved, but no reply
            will come until it is back online.
          </div>
        ) : null}

        <div className="chat-shell">
          <aside className="chat-side">
            <div className="chat-side-head">
              <span className="label">Conversations</span>
              <Button variant="ghost" size="sm" className="btn-icon" title="New chat" onClick={startNew}>
                <IconPlus size={15} />
              </Button>
            </div>
            {threads.loading ? (
              <div className="small muted" style={{ padding: '6px 4px' }}>Loading…</div>
            ) : (
              <ThreadList
                threads={threadList}
                activeId={activeId}
                onSelect={(id) => {
                  setActiveId(id)
                  setOverlay([])
                  setError(null)
                }}
                onDelete={removeThread}
              />
            )}
          </aside>

          <section className="chat-main">
            <div className="chat-scroll" ref={scrollRef}>
              {loadingThread && !conversationStarted ? (
                <Loading label="Loading the conversation…" />
              ) : !conversationStarted ? (
                <div className="chat-empty">
                  <div className="chat-empty-icon">
                    <IconChat size={26} />
                  </div>
                  <h2>How can I help?</h2>
                  <p className="muted">
                    Tell me what you are looking at and I will answer from the project files, or write it up.
                  </p>
                  <div className="chat-suggest">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="chip"
                        onClick={() => {
                          setDraft(example)
                          if (paramSiteId) setSiteId(paramSiteId)
                        }}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((m) => (
                    <div key={m.messageId} className={`chat-turn chat-turn-${m.role}`}>
                      <div
                        className={`chat-bubble${
                          m.role === 'user'
                            ? ' chat-bubble-user'
                            : m.status === 'error'
                              ? ' chat-bubble-error'
                              : ' chat-bubble-bot'
                        }`}
                      >
                        {m.text}
                      </div>
                      {m.pending?.length ? (
                        <div className="chat-extras">
                          {m.pending.map((action) => (
                            <PendingCard
                              key={action.actionId}
                              action={action}
                              busy={busyAction === action.actionId}
                              onDecide={decide}
                            />
                          ))}
                        </div>
                      ) : null}
                      {m.artifacts?.length ? (
                        <div className="chat-extras">
                          {m.artifacts.map((artifact) => (
                            <ArtifactCard key={artifact.s3Key ?? artifact.name} artifact={artifact} onDownload={download} />
                          ))}
                        </div>
                      ) : null}
                      <div className="chat-meta">
                        {m.role === 'assistant' && m.agent ? `${m.agent} · ` : ''}
                        {clockTime(m.createdAt)}
                      </div>
                    </div>
                  ))}

                  {overlay.map((turn, index) => (
                    <div key={`overlay-${index}`} className={`chat-turn chat-turn-${turn.role}`}>
                      <div
                        className={`chat-bubble${
                          turn.role === 'user'
                            ? ' chat-bubble-user'
                            : turn.thinking
                              ? ' chat-bubble-bot chat-bubble-thinking'
                              : ' chat-bubble-error'
                        }`}
                      >
                        {turn.thinking ? <Thinking /> : turn.text}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            <form
              className="chat-compose"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              {!activeId ? (
                <label className="chat-context">
                  <span className="small muted">Project context</span>
                  <select className="select" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
                    <option value="">General (no specific project)</option>
                    {(sites.data?.sites ?? []).map((site) => (
                      <option key={site.siteId} value={site.siteId}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : thread?.siteId ? (
                <div className="chat-context-static small">
                  <IconChat size={14} />
                  {siteNameFor(thread.siteId)}
                </div>
              ) : null}

              <div className="chat-compose-row">
                <textarea
                  className="textarea chat-input"
                  rows={2}
                  placeholder="Ask a question, describe what you see, or ask for a report…"
                  value={draft}
                  disabled={sending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                />
                <Button type="submit" loading={sending} disabled={!draft.trim()} className="chat-send">
                  <IconSend size={16} />
                  Send
                </Button>
              </div>
              <div className="small muted chat-hint">Enter to send · Shift + Enter for a new line</div>
            </form>
          </section>
        </div>
      </PageBody>

      {listOpen ? (
        <Modal
          title="Conversations"
          onClose={() => setListOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setListOpen(false)}>
                <IconX size={15} />
                Close
              </Button>
              <Button onClick={startNew}>
                <IconPlus size={15} />
                New chat
              </Button>
            </>
          }
        >
          {threadList.length === 0 ? (
            <Empty title="No saved conversations">Start a new chat to see it listed here.</Empty>
          ) : (
            <div className="chat-modal-list">
              <ThreadList
                threads={threadList}
                activeId={activeId}
                onSelect={(id) => {
                  setActiveId(id)
                  setOverlay([])
                  setError(null)
                  setListOpen(false)
                }}
                onDelete={removeThread}
              />
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
