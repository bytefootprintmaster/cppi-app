import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useVoiceInput } from '../lib/useVoiceInput'
import { PageBody, PageHeader } from '../components/Layout'
import { Badge, Button, Empty, ErrorNote, Loading, Modal } from '../components/ui'
import {
  IconChat,
  IconCheck,
  IconCopy,
  IconDownload,
  IconFile,
  IconImage,
  IconMic,
  IconPlus,
  IconSearch,
  IconSend,
  IconTag,
  IconTrash,
  IconUpload,
  IconX
} from '../components/icons'
import type {
  AssetRecord,
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

/** Everything a turn can be searched on: its words, file names, cards, reports. */
function turnText(message: ChatMessageRecord): string {
  const parts: string[] = [message.text]
  for (const attachment of message.attachments ?? []) parts.push(attachment.name)
  for (const action of message.pending ?? []) parts.push(action.preview, TOOL_LABEL[action.tool] ?? action.tool)
  for (const artifact of message.artifacts ?? []) parts.push(artifact.title ?? artifact.name, artifact.name)
  return parts.join(' ')
}

/** Wrap every occurrence of the query in a <mark> so hits are easy to spot. */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const pattern = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    nodes.push(
      <mark className="chat-mark" key={`${match.index}-${nodes.length}`}>
        {match[0]}
      </mark>
    )
    cursor = match.index + match[0].length
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

/** Render common Markdown safely as React nodes, including GFM-style tables. */
function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0

  function inline(text: string): ReactNode[] {
    const tokenPattern =
      /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g
    const tokens = text.split(tokenPattern).filter(Boolean)
    return tokens.map((token, tokenIndex) => {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
      if (link) {
        return (
          <a key={tokenIndex} href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        )
      }
      if (token.startsWith('**') || token.startsWith('__')) {
        return <strong key={tokenIndex}>{token.slice(2, -2)}</strong>
      }
      if (token.startsWith('~~')) return <del key={tokenIndex}>{token.slice(2, -2)}</del>
      if (token.startsWith('`')) return <code key={tokenIndex}>{token.slice(1, -1)}</code>
      if (token.startsWith('*') || token.startsWith('_')) {
        return <em key={tokenIndex}>{token.slice(1, -1)}</em>
      }
      return <Fragment key={tokenIndex}>{token}</Fragment>
    })
  }

  function cells(line: string): string[] {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split('|').map((cell) => cell.trim())
  }

  function isTableDivider(line: string): boolean {
    const columns = cells(line)
    return columns.length > 0 && columns.every((cell) => /^:?-{3,}:?$/.test(cell))
  }

  function isBlockStart(line: string, nextLine: string): boolean {
    return (
      /^```/.test(line) ||
      /^#{1,6}\s/.test(line) ||
      /^>\s?/.test(line) ||
      /^\s*([-*_]\s*){3,}$/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      (line.includes('|') && isTableDivider(nextLine))
    )
  }

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim()
      index += 1
      const code: string[] = []
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index += 1
      blocks.push(
        <pre key={`code-${blocks.length}`} data-language={language || undefined}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length, 4)
      const content = inline(heading[2])
      const key = `heading-${blocks.length}`
      blocks.push(
        level === 1 ? <h1 key={key}>{content}</h1> :
          level === 2 ? <h2 key={key}>{content}</h2> :
            level === 3 ? <h3 key={key}>{content}</h3> :
              <h4 key={key}>{content}</h4>
      )
      index += 1
      continue
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headers = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(cells(lines[index++]))
      }
      blocks.push(
        <div className="chat-table-wrap" key={`table-${blocks.length}`}>
          <table className="chat-markdown-table">
            <thead>
              <tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{inline(header)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{inline(row[cellIndex] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={`hr-${blocks.length}`} />)
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index++].replace(/^>\s?/, ''))
      }
      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          {quote.map((part, partIndex) => (
            <Fragment key={partIndex}>
              {partIndex ? <br /> : null}
              {inline(part)}
            </Fragment>
          ))}
        </blockquote>
      )
      continue
    }

    const listMarker = line.match(/^\s*([-*+])\s+|^\s*(\d+)[.)]\s+/)
    if (listMarker) {
      const ordered = Boolean(listMarker[2])
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*+])\s+(.+)$|^\s*\d+[.)]\s+(.+)$/)
        if (!item || Boolean(item[3]) !== ordered) break
        items.push(item[2] ?? item[3])
        index += 1
      }
      const content = items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)
      blocks.push(
        ordered
          ? <ol key={`list-${blocks.length}`}>{content}</ol>
          : <ul key={`list-${blocks.length}`}>{content}</ul>
      )
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && isBlockStart(lines[index], lines[index + 1] ?? '')) break
      paragraph.push(lines[index++])
    }
    blocks.push(
      <p key={`paragraph-${blocks.length}`}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex ? <br /> : null}
            {inline(part)}
          </Fragment>
        ))}
      </p>
    )
  }

  return <div className="chat-markdown">{blocks}</div>
}

/** Optimistic turns shown while the agent is working, before the server reply lands. */
interface OverlayTurn {
  role: 'user' | 'assistant'
  text: string
  thinking?: boolean
  attachments?: ChatAttachment[]
}

type ChatAttachment = Pick<AssetRecord, 'siteId' | 'assetId' | 'name' | 'type' | 'contentType' | 'size' | 'tags'>

interface ChatServiceStatus {
  configured: boolean
  reachable: boolean
  storageReady: boolean
  storageError?: string
  reason?: 'storage_unavailable' | 'missing_agent_token' | 'agent_unreachable' | 'ready'
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

function ChatAttachmentList({
  attachments,
  onOpen
}: {
  attachments: ChatAttachment[]
  onOpen: (attachment: ChatAttachment) => void
}) {
  if (!attachments.length) return null
  return (
    <div className="chat-attachment-list">
      {attachments.map((attachment) => (
        <div className="chat-attachment" key={attachment.assetId}>
          <button type="button" className="chat-attachment-open" onClick={() => onOpen(attachment)}>
            {attachment.type === 'image' ? <IconImage size={17} /> : <IconFile size={17} />}
            <span className="chat-attachment-name" title={attachment.name}>{attachment.name}</span>
            {attachment.size ? (
              <span className="small muted">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
            ) : null}
          </button>
          {attachment.tags?.length ? (
            <div className="chat-attachment-tags">
              {attachment.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------- page --------------------------------- */

export function ChatPage() {
  const [params] = useSearchParams()
  const paramSiteId = params.get('siteId') ?? ''

  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // One continuous conversation per user, in the WhatsApp sense — no threads.
  const [thread, setThread] = useState<ChatThreadRecord | null>(null)
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [loadingThread, setLoadingThread] = useState(true)

  // The project is chosen per turn, because one conversation can span projects.
  const [siteId, setSiteId] = useState(paramSiteId)
  const [draft, setDraft] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [sending, setSending] = useState(false)
  const [overlay, setOverlay] = useState<OverlayTurn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const copyResetRef = useRef<number | null>(null)

  const sites = useApi<{ sites: SiteRecord[] }>('/sites')
  const status = useApi<ChatServiceStatus>('/chat/status')
  const assistantReady = Boolean(
    status.data?.configured && status.data.reachable && status.data.storageReady
  )

  const serviceMessage = status.error
    ? `Could not check assistant availability: ${status.error}`
    : status.data?.storageError
      ? `Could not verify chat storage: ${status.data.storageError}`
      : status.data && !status.data.storageReady
        ? 'Assistant chat storage is not ready. Ask an administrator to run the portal infrastructure setup.'
        : status.data && !status.data.configured
          ? 'The portal is missing AGENT_API_TOKEN. Configure it to match HTTP_API_TOKEN in the agent environment.'
          : status.data && !status.data.reachable
            ? 'The agent service is not reachable. Confirm HTTP_API_ENABLED=true and restart the agent service.'
            : null

  // Dictated phrases land in the draft, separated from what is already typed.
  const appendTranscript = useCallback((phrase: string) => {
    setDraft((current) => {
      if (!current) return phrase
      return /\s$/.test(current) ? `${current}${phrase}` : `${current} ${phrase}`
    })
  }, [])
  const voice = useVoiceInput(appendTranscript)

  useEffect(() => {
    document.title = 'Assistant · CPPI'
  }, [])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  // A project page can deep-link here with `?siteId=`, pre-selecting its context.
  useEffect(() => {
    if (paramSiteId) setSiteId(paramSiteId)
  }, [paramSiteId])

  const loadThread = useCallback(async () => {
    setLoadingThread(true)
    try {
      const data = await api<{ thread: ChatThreadRecord | null; messages: ChatMessageRecord[] }>(
        '/chat/thread'
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

  useEffect(() => {
    void loadThread()
  }, [loadThread])

  // Keep the newest turn in view — unless a search is pinning results.
  useEffect(() => {
    if (query.trim()) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, overlay.length, sending, query])

  function chooseFiles(files: FileList | null) {
    if (!files?.length) return
    const existingKeys = new Set(selectedFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`))
    const additions = Array.from(files).filter(
      (file) => !existingKeys.has(`${file.name}:${file.size}:${file.lastModified}`)
    )
    if (chatAttachments.length + selectedFiles.length + additions.length > 5) {
      setError('A chat turn can include at most 5 files.')
      return
    }
    const currentBytes = chatAttachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0)
    const selectedBytes = [...selectedFiles, ...additions].reduce((total, file) => total + file.size, 0)
    if (currentBytes + selectedBytes > 40_000_000) {
      setError('Chat attachments cannot exceed 40 MB in total.')
      return
    }
    setSelectedFiles((current) => [...current, ...additions])
    setError(null)
  }

  async function uploadFiles() {
    if (!siteId || !selectedFiles.length || uploadingFiles) return
    const tags = [...new Set(tagDraft.split(/[,\n]/).map((tag) => tag.trim().replace(/\s+/g, ' ')).filter(Boolean))]
    if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
      setError('Use at most 20 tags, with no more than 40 characters per tag.')
      return
    }
    setUploadingFiles(true)
    setError(null)
    try {
      for (const file of selectedFiles) {
        const type = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name)
          ? 'image'
          : 'document'
        const contentType = file.type || 'application/octet-stream'
        const { key, uploadUrl } = await api<{ key: string; uploadUrl: string }>(
          `/sites/${siteId}/assets/presign`,
          { method: 'POST', body: { fileName: file.name, contentType, type } }
        )
        const uploaded = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: file
        })
        if (!uploaded.ok) throw new Error(`S3 upload failed (${uploaded.status})`)

        const { asset } = await api<{ asset: AssetRecord }>(`/sites/${siteId}/assets`, {
          method: 'POST',
          body: {
            key,
            name: file.name,
            type,
            contentType,
            size: file.size,
            category: type === 'image' ? 'progress' : 'other',
            tags
          }
        })
        setChatAttachments((current) => [
          ...current,
          {
            siteId: asset.siteId,
            assetId: asset.assetId,
            name: asset.name,
            type: asset.type,
            contentType: asset.contentType,
            size: asset.size,
            tags: asset.tags
          }
        ])
        setSelectedFiles((current) => current.filter((candidate) => candidate !== file))
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the selected file')
    } finally {
      setUploadingFiles(false)
    }
  }

  async function send() {
    const text = draft.trim()
    if ((!text && !chatAttachments.length) || sending || uploadingFiles) return
    if (!assistantReady) {
      setError(serviceMessage ?? 'The assistant is not ready yet.')
      return
    }
    if (chatAttachments.some((attachment) => attachment.siteId !== siteId)) {
      setError('Choose the project these attachments belong to before sending.')
      return
    }
    const messageText = text || 'Please review the attached project files.'
    const turnAttachments = chatAttachments
    setSending(true)
    setError(null)
    setDraft('')
    setQuery('')
    setOverlay([
      { role: 'user', text: messageText, attachments: turnAttachments },
      { role: 'assistant', text: '', thinking: true }
    ])
    try {
      await api('/chat/messages', {
        method: 'POST',
        body: {
          message: messageText,
          siteId: siteId || undefined,
          attachments: turnAttachments.map((attachment) => attachment.assetId)
        }
      })
      setChatAttachments([])
      await loadThread()
      setOverlay([])
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Something went wrong'
      setError(detail)
      // Keep the user's words on screen and explain the failure in a reply bubble.
      setOverlay([
        { role: 'user', text: messageText, attachments: turnAttachments },
        { role: 'assistant', text: detail }
      ])
    } finally {
      setSending(false)
    }
  }

  async function decide(actionId: string, decision: 'approve' | 'reject') {
    setBusyAction(actionId)
    setError(null)
    try {
      await api(`/chat/actions/${actionId}/${decision}`, { method: 'POST' })
      await loadThread()
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

  async function downloadAttachment(attachment: ChatAttachment) {
    setError(null)
    try {
      const { url } = await api<{ url: string }>(
        `/sites/${attachment.siteId}/assets/${attachment.assetId}/url`
      )
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the project file')
    }
  }

  async function copyMessage(messageId: string, text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const input = document.createElement('textarea')
        input.value = text
        input.setAttribute('readonly', '')
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand('copy')
        input.remove()
        if (!copied) throw new Error('Clipboard access is unavailable')
      }
      setCopiedMessageId(messageId)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => {
        setCopiedMessageId((current) => current === messageId ? null : current)
      }, 1800)
    } catch {
      setError('Could not copy this response. Check your browser clipboard permissions and try again.')
    }
  }

  async function clearThread() {
    setClearing(true)
    setError(null)
    try {
      await api('/chat/thread', { method: 'DELETE' })
      setConfirmClear(false)
      setOverlay([])
      setQuery('')
      await loadThread()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the conversation')
    } finally {
      setClearing(false)
    }
  }

  const needle = query.trim()
  const searching = needle.length > 0
  const visibleMessages = searching
    ? messages.filter((message) => turnText(message).toLowerCase().includes(needle.toLowerCase()))
    : messages
  const conversationStarted = messages.length > 0 || overlay.length > 0

  function renderTurn(message: ChatMessageRecord) {
    return (
      <div key={message.messageId} className={`chat-turn chat-turn-${message.role}`}>
        <div
          className={`chat-bubble${
            message.role === 'user'
              ? ' chat-bubble-user'
              : message.status === 'error'
                ? ' chat-bubble-error'
                : ' chat-bubble-bot'
          }`}
        >
          {message.role === 'assistant' && !query.trim()
            ? renderMarkdown(message.text)
            : highlight(message.text, query)}
        </div>
        {message.attachments?.length ? (
          <ChatAttachmentList attachments={message.attachments} onOpen={downloadAttachment} />
        ) : null}
        {message.pending?.length ? (
          <div className="chat-extras">
            {message.pending.map((action) => (
              <PendingCard
                key={action.actionId}
                action={action}
                busy={busyAction === action.actionId}
                onDecide={decide}
              />
            ))}
          </div>
        ) : null}
        {message.artifacts?.length ? (
          <div className="chat-extras">
            {message.artifacts.map((artifact) => (
              <ArtifactCard key={artifact.s3Key ?? artifact.name} artifact={artifact} onDownload={download} />
            ))}
          </div>
        ) : null}
        <div className="chat-meta">
          <span>
            {message.role === 'assistant' && message.agent ? `${message.agent} · ` : ''}
            {clockTime(message.createdAt)}
          </span>
          {message.role === 'assistant' && message.text.trim() ? (
            <button
              type="button"
              className="chat-copy"
              aria-label={copiedMessageId === message.messageId ? 'Response copied' : 'Copy response'}
              title={copiedMessageId === message.messageId ? 'Copied' : 'Copy response'}
              onClick={() => void copyMessage(message.messageId, message.text)}
            >
              {copiedMessageId === message.messageId ? <IconCheck size={14} /> : <IconCopy size={14} />}
              <span>{copiedMessageId === message.messageId ? 'Copied' : 'Copy'}</span>
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="Assistant"
        subtitle="One continuous conversation. Scroll back through everything, or search it."
        actions={
          conversationStarted ? (
            <Button variant="ghost" onClick={() => setConfirmClear(true)}>
              <IconTrash size={16} />
              Clear chat
            </Button>
          ) : null
        }
      />
      <PageBody>
        <ErrorNote message={error} />

        {serviceMessage ? (
          <div className="alert alert-info chat-service-notice" role="status" style={{ marginBottom: 14 }}>
            <strong>Assistant unavailable.</strong> {serviceMessage}
          </div>
        ) : null}

        <section className="chat-main">
          {conversationStarted ? (
            <div className="chat-toolbar">
              <label className="chat-search">
                <IconSearch size={16} />
                <input
                  className="input"
                  type="search"
                  value={query}
                  placeholder="Search this conversation…"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {searching ? (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
                    <IconX size={14} />
                  </button>
                ) : null}
              </label>
              {searching ? (
                <span className="small muted chat-search-count">
                  {visibleMessages.length} {visibleMessages.length === 1 ? 'message' : 'messages'}
                </span>
              ) : null}
            </div>
          ) : null}

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
            ) : searching && visibleMessages.length === 0 ? (
              <Empty title="No matching messages">
                Nothing in this conversation matches “{needle}”.
              </Empty>
            ) : (
              <>
                {visibleMessages.map(renderTurn)}

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
                      {turn.thinking
                        ? <Thinking />
                        : turn.role === 'assistant'
                          ? renderMarkdown(turn.text)
                          : turn.text}
                    </div>
                    {turn.role === 'assistant' && !turn.thinking && turn.text.trim() ? (
                      <div className="chat-meta">
                        <span />
                        <button
                          type="button"
                          className="chat-copy"
                          aria-label={copiedMessageId === `overlay-${index}` ? 'Response copied' : 'Copy response'}
                          title={copiedMessageId === `overlay-${index}` ? 'Copied' : 'Copy response'}
                          onClick={() => void copyMessage(`overlay-${index}`, turn.text)}
                        >
                          {copiedMessageId === `overlay-${index}`
                            ? <IconCheck size={14} />
                            : <IconCopy size={14} />}
                          <span>{copiedMessageId === `overlay-${index}` ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    ) : null}
                    {turn.attachments?.length ? (
                      <ChatAttachmentList attachments={turn.attachments} onOpen={downloadAttachment} />
                    ) : null}
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
            <label className="chat-context">
              <span className="small muted">Project context</span>
              <select
                className="select"
                value={siteId}
                onChange={(event) => {
                  setSiteId(event.target.value)
                  setSelectedFiles([])
                  setChatAttachments([])
                }}
              >
                <option value="">General (no specific project)</option>
                {(sites.data?.sites ?? []).map((site) => (
                  <option key={site.siteId} value={site.siteId}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="chat-upload-tools">
              <input
                ref={fileInputRef}
                className="chat-file-input"
                type="file"
                multiple
                accept="image/*,.pdf,.docx,.xlsx,.csv,.txt,.md,.json"
                onChange={(event) => chooseFiles(event.target.files)}
                disabled={uploadingFiles || sending}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!siteId || uploadingFiles || sending || chatAttachments.length + selectedFiles.length >= 5}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconPlus size={15} />
                Add files
              </Button>
              <label className="chat-tag-field">
                <IconTag size={15} />
                <input
                  className="input"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  placeholder="Tags for selected files (comma separated)"
                  disabled={uploadingFiles || sending}
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!siteId || !selectedFiles.length || uploadingFiles || sending}
                loading={uploadingFiles}
                onClick={() => void uploadFiles()}
              >
                <IconUpload size={15} />
                Upload
              </Button>
            </div>
            {!siteId ? (
              <div className="small muted chat-hint">Choose a project to upload project files.</div>
            ) : null}
            {selectedFiles.length ? (
              <div className="chat-selected-files">
                {selectedFiles.map((file) => (
                  <span className="chat-file-chip" key={`${file.name}:${file.size}:${file.lastModified}`}>
                    <IconFile size={14} />
                    <span title={file.name}>{file.name}</span>
                    {!uploadingFiles ? (
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => setSelectedFiles((current) => current.filter((item) => item !== file))}
                      >
                        <IconX size={13} />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
            {chatAttachments.length ? (
              <div className="chat-selected-files">
                {chatAttachments.map((attachment) => (
                  <span className="chat-file-chip uploaded" key={attachment.assetId}>
                    {attachment.type === 'image' ? <IconImage size={14} /> : <IconFile size={14} />}
                    <span title={attachment.name}>{attachment.name}</span>
                    {attachment.tags?.length ? <small>{attachment.tags.join(', ')}</small> : null}
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name} from this message`}
                      onClick={() => setChatAttachments((current) => current.filter((item) => item.assetId !== attachment.assetId))}
                    >
                      <IconX size={13} />
                    </button>
                  </span>
                ))}
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
              <Button
                type="button"
                variant={voice.listening ? 'danger' : 'ghost'}
                className={`chat-mic${voice.listening ? ' chat-mic-recording' : ''}`}
                loading={voice.loading}
                disabled={sending || !voice.supported}
                aria-pressed={voice.listening}
                aria-label={
                  voice.listening
                    ? 'Stop voice dictation'
                    : voice.supported
                      ? 'Dictate message with your microphone'
                      : 'Voice dictation is unavailable'
                }
                onClick={voice.toggle}
                title={
                  voice.supported
                    ? voice.listening
                      ? 'Stop dictating'
                      : 'Dictate a message (processed on this device)'
                    : 'Voice input requires HTTPS and browser microphone support'
                }
              >
                <IconMic size={16} />
                {voice.loading ? 'Loading…' : voice.listening ? 'Stop' : 'Dictate'}
              </Button>
              <Button
                type="submit"
                loading={sending || status.loading}
                disabled={(!draft.trim() && !chatAttachments.length) || !assistantReady || uploadingFiles}
                className="chat-send"
              >
                <IconSend size={16} />
                Send
              </Button>
            </div>
            {voice.listening ? (
              <div className="chat-voice-status" role="status">
                Listening on this device — speak, then pause to add the words to your message.
              </div>
            ) : null}
            {voice.error ? <div className="small chat-voice-error">{voice.error}</div> : null}
            <div className="small muted chat-hint">
              Enter to send · Shift + Enter for a new line
              {thread?.messageCount ? ` · ${thread.messageCount} messages in this conversation` : ''}
            </div>
            {!voice.supported ? (
              <div className="small muted chat-hint">
                Voice dictation requires HTTPS and browser microphone support.
              </div>
            ) : null}
          </form>
        </section>
      </PageBody>

      {confirmClear ? (
        <Modal
          title="Clear this conversation?"
          onClose={() => (clearing ? undefined : setConfirmClear(false))}
          footer={
            <>
              <Button variant="ghost" disabled={clearing} onClick={() => setConfirmClear(false)}>
                <IconX size={15} />
                Cancel
              </Button>
              <Button variant="danger" loading={clearing} onClick={() => void clearThread()}>
                <IconTrash size={15} />
                Clear chat
              </Button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            This deletes every message in your conversation with the assistant. Project files and reports it
            created are not affected.
          </p>
        </Modal>
      ) : null}
    </>
  )
}
