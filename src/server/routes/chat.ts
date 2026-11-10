import { Router, type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { T, deleteItem, getItem, putItem, queryAll, tableIsActive, updateFields } from '../db'
import { env } from '../env'
import { HttpError, asyncHandler, optStr, str } from '../lib/http'
import { requireAuth } from '../auth'
import { canWrite, requireSiteAccess } from '../services'
import type {
  AssetRecord,
  ChatArtifact,
  ChatMessageRecord,
  ChatPendingAction,
  ChatThreadRecord
} from '../types'

/**
 * The Assistant chat.
 *
 * The portal owns the conversation (threads + messages in DynamoDB) and proxies
 * each turn to the Python agent's `POST /chat`, which answers from the dashboard
 * and may park a dashboard change for approval. Keeping the transcript here means
 * history, titles and threads survive independently of the agent's own session
 * store, and a thread is scoped to the user who started it.
 *
 * The agent URL/token never leave the server: the browser only ever talks to
 * `/api/chat`.
 */
export const chatRouter = Router()

const MAX_MESSAGE_CHARS = 8000
const MAX_CHAT_ATTACHMENTS = 5
const DEFAULT_TITLE = 'New conversation'
/** A turn can run many tool steps, so this is generous; the agent caps itself too. */
const AGENT_TIMEOUT_MS = 240_000

const now = () => new Date().toISOString()

/** Only the user who owns a thread may read or write it. */
async function loadThread(userId: string, threadId: string): Promise<ChatThreadRecord> {
  const thread = await getItem<ChatThreadRecord>(T.chatThreads, { threadId }, true)
  if (!thread || thread.userId !== userId) throw new HttpError(404, 'Conversation not found')
  return thread
}

function listMessages(threadId: string): Promise<ChatMessageRecord[]> {
  return queryAll<ChatMessageRecord>(T.chatMessages, {
    KeyConditionExpression: 'threadId = :t',
    ExpressionAttributeValues: { ':t': threadId },
    ConsistentRead: true
  }).then((rows) => rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
}

/* ------------------------------ agent proxy ------------------------------ */

interface AgentReply {
  ok: boolean
  agent?: string
  text: string
  pending: ChatPendingAction[]
  artifacts: ChatArtifact[]
  costUsd?: number
}

function replyText(data: Record<string, unknown>): string {
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (text) return text
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (summary) return summary
  if (typeof data.hit_cap === 'string' && data.hit_cap) return `The assistant stopped early: ${data.hit_cap}`
  return 'Done.'
}

function toPending(raw: unknown): ChatPendingAction[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      actionId: String(item.action_id ?? ''),
      tool: String(item.tool ?? ''),
      preview: String(item.preview ?? ''),
      status: 'pending' as const
    }))
    .filter((item) => item.actionId)
}

function toArtifacts(raw: unknown): ChatArtifact[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      kind: 'report' as const,
      siteId: String(item.siteId ?? ''),
      assetId: item.assetId ? String(item.assetId) : undefined,
      s3Key: item.s3Key ? String(item.s3Key) : undefined,
      name: String(item.name ?? 'Report.pdf'),
      title: item.title ? String(item.title) : undefined,
      reportType: item.reportType ? String(item.reportType) : undefined,
      size: typeof item.size === 'number' ? item.size : undefined
    }))
    .filter((item) => item.siteId && item.s3Key)
}

async function callAgent(input: {
  message: string
  sessionId: string
  siteId?: string
  siteName?: string
  attachments?: Array<Pick<AssetRecord, 'name' | 's3Key' | 'contentType' | 'size' | 'tags'>>
}): Promise<AgentReply> {
  if (!env.AGENT_API_TOKEN) {
    return {
      ok: false,
      text: 'The assistant is not configured on this server: AGENT_API_TOKEN is missing.',
      pending: [],
      artifacts: []
    }
  }

  // The agent expects the project it should act on spelled out in the message.
  const context = input.siteId
    ? JSON.stringify({ siteId: input.siteId, siteName: input.siteName })
    : ''
  const text = context ? `CONTEXT ${context}\n\n${input.message}` : input.message

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
  try {
    const res = await fetch(`${env.AGENT_API_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AGENT_API_TOKEN}`
      },
      body: JSON.stringify({
        message: text,
        session_id: input.sessionId,
        ...(input.siteId ? { context: { siteId: input.siteId, siteName: input.siteName } } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((asset) => ({
                s3_key: asset.s3Key,
                name: asset.name,
                content_type: asset.contentType,
                size: asset.size,
                tags: asset.tags
              }))
            }
          : {})
      }),
      signal: controller.signal
    })
    const raw = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      data = {}
    }
    if (!res.ok) {
      const detail = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      return { ok: false, text: `The assistant could not answer: ${detail}`, pending: [], artifacts: [] }
    }
    return {
      ok: true,
      agent: typeof data.agent === 'string' ? data.agent : undefined,
      text: replyText(data),
      pending: toPending(data.pending),
      artifacts: toArtifacts(data.artifacts),
      costUsd: typeof data.cost_usd === 'number' ? data.cost_usd : undefined
    }
  } catch (err) {
    // Surface the exact string so the failure is debuggable, per the project's style.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { ok: false, text: `The assistant could not be reached: ${detail}`, pending: [], artifacts: [] }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------- routes -------------------------------- */

chatRouter.get('/status', asyncHandler(async (_req, res) => {
  let storageReady = false
  let storageError: string | undefined
  try {
    const [threadsReady, messagesReady] = await Promise.all([
      tableIsActive(T.chatThreads),
      tableIsActive(T.chatMessages)
    ])
    storageReady = threadsReady && messagesReady
  } catch (err) {
    storageError = err instanceof Error ? err.message : String(err)
  }

  const configured = Boolean(env.AGENT_API_TOKEN)
  let reachable = false
  if (configured) {
    try {
      const r = await fetch(`${env.AGENT_API_URL}/health`, { signal: AbortSignal.timeout(4000) })
      reachable = r.ok
    } catch {
      reachable = false
    }
  }

  res.json({
    configured,
    reachable,
    storageReady,
    storageError,
    reason: !storageReady ? 'storage_unavailable' : !configured ? 'missing_agent_token' : !reachable ? 'agent_unreachable' : 'ready'
  })
}))

// Status is intentionally public for the page's setup banner; all transcript
// and action routes require a valid portal session.
chatRouter.use(requireAuth)

chatRouter.get('/threads', asyncHandler(async (req, res) => {
  const rows = await queryAll<ChatThreadRecord>(T.chatThreads, {
    IndexName: 'user-index',
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': req.user!.userId }
  })
  res.json({ threads: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })
}))

chatRouter.post('/threads', asyncHandler(async (req, res) => {
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to use the assistant')
  const siteId = optStr(req.body?.siteId, 60)
  if (siteId) await requireSiteAccess(req.user!, siteId)
  const title = optStr(req.body?.title, 120) ?? DEFAULT_TITLE
  const ts = now()
  const thread: ChatThreadRecord = {
    threadId: randomUUID(),
    userId: req.user!.userId,
    title,
    siteId,
    messageCount: 0,
    createdAt: ts,
    updatedAt: ts
  }
  await putItem(T.chatThreads, thread)
  res.status(201).json({ thread })
}))

chatRouter.get('/threads/:threadId', asyncHandler(async (req, res) => {
  const thread = await loadThread(req.user!.userId, req.params.threadId)
  const messages = await listMessages(thread.threadId)
  res.json({ thread, messages })
}))

chatRouter.delete('/threads/:threadId', asyncHandler(async (req, res) => {
  const thread = await loadThread(req.user!.userId, req.params.threadId)
  const messages = await listMessages(thread.threadId)
  await Promise.all(
    messages.map((m) => deleteItem(T.chatMessages, { threadId: m.threadId, messageId: m.messageId }))
  )
  await deleteItem(T.chatThreads, { threadId: thread.threadId })
  res.json({ ok: true })
}))

chatRouter.post('/threads/:threadId/messages', asyncHandler(async (req, res) => {
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to use the assistant')
  const thread = await loadThread(req.user!.userId, req.params.threadId)
  const body = (req.body ?? {}) as Record<string, unknown>
  const attachmentIds = body.attachments === undefined
    ? []
    : (() => {
        if (!Array.isArray(body.attachments)) throw new HttpError(400, '"attachments" must be a list')
        if (body.attachments.length > MAX_CHAT_ATTACHMENTS) {
          throw new HttpError(400, `A chat turn can include at most ${MAX_CHAT_ATTACHMENTS} files`)
        }
        return [...new Set(body.attachments.map((id) => str(id, 'attachment id', 60)))]
      })()
  const message = body.message === undefined && attachmentIds.length
    ? 'Please review the attached project files.'
    : str(body.message, 'message', MAX_MESSAGE_CHARS)

  let attachedAssets: AssetRecord[] = []
  if (attachmentIds.length) {
    if (!thread.siteId) throw new HttpError(400, 'Choose a project before attaching files')
    await requireSiteAccess(req.user!, thread.siteId)
    attachedAssets = await Promise.all(
      attachmentIds.map(async (assetId) => {
        const asset = await getItem<AssetRecord>(T.assets, { siteId: thread.siteId!, assetId })
        if (!asset) throw new HttpError(404, 'An attached project file could not be found')
        if (!asset.s3Key.startsWith(`sites/${thread.siteId}/`)) {
          throw new HttpError(400, 'An attached file does not belong to this project')
        }
        return asset
      })
    )
    if (attachedAssets.reduce((total, asset) => total + (asset.size ?? 0), 0) > 40_000_000) {
      throw new HttpError(400, 'Chat attachments exceed the 40 MB total limit')
    }
  }

  const userMessage: ChatMessageRecord = {
    threadId: thread.threadId,
    messageId: randomUUID(),
    role: 'user',
    text: message,
    userId: req.user!.userId,
    attachments: attachedAssets.map(({ siteId, assetId, name, type, contentType, size, tags }) => ({
      siteId,
      assetId,
      name,
      type,
      contentType,
      size,
      tags
    })),
    createdAt: now()
  }
  await putItem(T.chatMessages, userMessage)

  // Name the thread after what it first asked about.
  const autoTitle =
    thread.messageCount === 0 && (thread.title === DEFAULT_TITLE || !thread.title)
      ? message.length > 80
        ? `${message.slice(0, 77)}…`
        : message
      : undefined

  let siteName: string | undefined
  if (thread.siteId) {
    try {
      siteName = (await getItem<{ name?: string }>(T.sites, { siteId: thread.siteId }))?.name
    } catch {
      siteName = undefined
    }
  }

  const reply = await callAgent({
    message,
    sessionId: thread.threadId,
    siteId: thread.siteId,
    siteName,
    attachments: attachedAssets.map(({ name, s3Key, contentType, size, tags }) => ({
      name,
      s3Key,
      contentType,
      size,
      tags
    }))
  })

  const assistantMessage: ChatMessageRecord = {
    threadId: thread.threadId,
    messageId: randomUUID(),
    role: 'assistant',
    text: reply.text,
    userId: req.user!.userId,
    agent: reply.agent,
    status: reply.ok ? 'ok' : 'error',
    pending: reply.pending,
    artifacts: reply.artifacts,
    costUsd: reply.costUsd,
    createdAt: now()
  }
  await putItem(T.chatMessages, assistantMessage)

  const updatedFields: Record<string, unknown> = {
    updatedAt: assistantMessage.createdAt,
    messageCount: thread.messageCount + 2
  }
  if (autoTitle) updatedFields.title = autoTitle
  await updateFields(T.chatThreads, { threadId: thread.threadId }, updatedFields)

  res.json({
    user: userMessage,
    assistant: assistantMessage,
    thread: {
      ...thread,
      title: autoTitle ?? thread.title,
      messageCount: thread.messageCount + 2,
      updatedAt: assistantMessage.createdAt
    }
  })
}))

async function resolveAction(
  req: Request,
  res: Response,
  decision: 'approve' | 'reject'
): Promise<void> {
  if (!canWrite(req.user!)) throw new HttpError(403, 'You do not have permission to approve changes')
  const thread = await loadThread(req.user!.userId, req.params.threadId)
  const actionId = str(req.params.actionId, 'actionId', 60)
  if (!env.AGENT_API_TOKEN) throw new HttpError(503, 'The assistant is not configured on this server')

  let result = ''
  try {
    const res2 = await fetch(`${env.AGENT_API_URL}/approvals/${actionId}/${decision}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AGENT_API_TOKEN}` },
      signal: AbortSignal.timeout(60_000)
    })
    const raw = await res2.text()
    const data = raw ? (JSON.parse(raw) as { result?: string; error?: string }) : {}
    if (!res2.ok) throw new HttpError(res2.status >= 500 ? 502 : 400, data.error ?? `Agent returned ${res2.status}`)
    result = data.result ?? (decision === 'approve' ? 'Approved.' : 'Rejected.')
  } catch (err) {
    if (err instanceof HttpError) throw err
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    throw new HttpError(502, `The assistant could not be reached: ${detail}`)
  }

  // Reflect the decision on the message that raised the approval.
  const messages = await listMessages(thread.threadId)
  for (const m of messages) {
    const found = (m.pending ?? []).find((p) => p.actionId === actionId)
    if (!found) continue
    found.status = decision === 'approve' ? 'approved' : 'rejected'
    found.resolution = result
    found.resolvedAt = now()
    await putItem(T.chatMessages, m)
    break
  }

  res.json({ actionId, status: decision === 'approve' ? 'approved' : 'rejected', result })
}

chatRouter.post(
  '/threads/:threadId/actions/:actionId/approve',
  asyncHandler((req, res) => resolveAction(req, res, 'approve'))
)

chatRouter.post(
  '/threads/:threadId/actions/:actionId/reject',
  asyncHandler((req, res) => resolveAction(req, res, 'reject'))
)

chatRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof Error && err.name === 'ResourceNotFoundException') {
    res.status(503).json({
      error: 'Assistant chat storage is not initialized. Run the portal infrastructure setup, then retry.'
    })
    return
  }
  next(err)
})
