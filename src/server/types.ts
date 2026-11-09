/* Shared domain types for the CPPI portal. */

export type Role = 'admin' | 'contractor' | 'viewer'
export type UserStatus = 'active' | 'disabled'
export type SiteStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed'
export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked'
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed'
export type AssetType = 'image' | 'document'
export type AssetCategory = 'progress' | 'plan' | 'permit' | 'invoice' | 'other'
export type InviteStatus = 'pending' | 'accepted' | 'revoked'
/** Kind of cost a budget line belongs to. Land is bought, the other two are built. */
export type BudgetGroup = 'land' | 'soft' | 'hard'

export interface SessionUser {
  userId: string
  email: string
  name: string
  picture?: string
  role: Role
  siteIds: string[]
}

export interface UserRecord extends SessionUser {
  status: UserStatus
  createdAt: string
  lastLoginAt?: string
}

export interface SiteRecord {
  siteId: string
  name: string
  code?: string
  description?: string
  location?: string
  status: SiteStatus
  startDate?: string
  targetDate?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface StageRecord {
  siteId: string
  stageId: string
  name: string
  description?: string
  order: number
  status: StageStatus
  startDate?: string
  endDate?: string
  createdAt: string
  updatedAt: string
}

export interface MilestoneRecord {
  siteId: string
  milestoneId: string
  stageId: string
  name: string
  description?: string
  dueDate?: string
  status: MilestoneStatus
  completedAt?: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface AssetFolderRecord {
  siteId: string
  folderId: string
  name: string
  description?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface AssetRecord {
  siteId: string
  assetId: string
  name: string
  type: AssetType
  category: AssetCategory
  s3Key: string
  contentType?: string
  size?: number
  stageId?: string
  /** Folder the file lives in. Unset means the project root (unsorted). */
  folderId?: string
  /** Free-form labels for filtering and search. Deduped, case-insensitively. */
  tags?: string[]
  uploadedBy: string
  uploadedByName: string
  uploadedAt: string
}

/**
 * The twelve evidence classes (spec section 2). A file may carry several. The
 * agent is code-guarded so a drawing, quotation, survey plan or certificate can
 * never be recorded as `construction_progress`.
 */
export type EvidenceClass =
  | 'land_survey'
  | 'design'
  | 'engineering'
  | 'permit_approval'
  | 'contractor_compliance'
  | 'procurement_quote'
  | 'executed_contract'
  | 'commencement'
  | 'construction_progress'
  | 'inspection_verification'
  | 'financial_payment'
  | 'completion_occupancy'

/** How a fact was arrived at: a verified fact, read off the document, or inferred. */
export type VerificationStatus = 'verified' | 'extracted' | 'ai_interpretation'

/** One key/value fact pulled from a document, tagged with its verification. */
export interface ExtractedFact {
  label: string
  value: string
  verification?: VerificationStatus
}

export interface RemarkRecord {
  siteId: string
  remarkId: string
  text: string
  stageId?: string
  authorId: string
  authorName: string
  authorRole: Role
  createdAt: string
  /** ---- Expanded document intelligence (all optional, agent-written) ---- */
  /** One-line summary of the document this remark is about. */
  summary?: string
  /** Key information pulled from the file. */
  extracted?: ExtractedFact[]
  /** Why the file matters to this project. */
  relevance?: string
  /** One or more of the twelve evidence classes. */
  evidenceClasses?: EvidenceClass[]
  /** How the document as a whole was understood. */
  verificationStatus?: VerificationStatus
  /** What the document does NOT prove. */
  limitations?: string
  /** Suggested next steps. */
  recommendedActions?: string[]
  /** Other project documents this one relates to. */
  relatedDocuments?: string[]
  /** File name the remark is about. */
  sourceDocument?: string
  /** Page / image reference inside the file. */
  sourceRef?: string
  /** 0..1 confidence in the extraction. */
  confidence?: number
  /** Set when the evidence guard overrode a class (e.g. a drawing labelled as progress). */
  classificationNotes?: string[]
  /** Which processor produced this record, e.g. "docintel-1". */
  processingVersion?: string
  processedBy?: string
}

/**
 * One row per asset: the agent's structured understanding of a single file
 * (spec sections 1, 2, 6). Re-analysing a file updates the row and appends a
 * revision rather than overwriting the earlier conclusions.
 */
export interface DocumentIntelligenceRecord {
  siteId: string
  assetId: string
  s3Key?: string
  name?: string
  category?: AssetCategory
  docType?: string
  issuer?: string
  documentDate?: string
  referenceNumber?: string
  property?: string
  project?: string
  summary?: string
  facts?: ExtractedFact[]
  /** Technical / regulatory / financial / contractual detail. */
  extracts?: { kind: string; detail: string; verification?: VerificationStatus }[]
  purpose?: string
  relevance?: string
  evidenceClasses?: EvidenceClass[]
  verificationStatus?: VerificationStatus
  missingInformation?: string[]
  inconsistencies?: string[]
  risks?: string[]
  limitations?: string
  recommendedActions?: string[]
  confidence?: number
  sourceRef?: string
  classificationNotes?: string[]
  processingVersion?: string
  processedBy?: string
  revisionHistory?: { at: string; processingVersion?: string; summary?: string; confidence?: number }[]
  createdAt: string
  updatedAt: string
}

/** What a proactive review may flag (spec section 7). */
export type FindingKind =
  | 'missing_document'
  | 'expiring_certificate'
  | 'unsigned_quotation'
  | 'unapproved_change'
  | 'missing_inspection'
  | 'inconsistency'

export type FindingSeverity = 'low' | 'medium' | 'high'
export type FindingStatus = 'open' | 'resolved'

/** A documentation gap the agent noticed. Advice only — never a dashboard change. */
export interface FindingRecord {
  siteId: string
  findingId: string
  kind: FindingKind
  severity: FindingSeverity
  title: string
  detail?: string
  relatedAssets?: string[]
  status: FindingStatus
  source?: string
  createdBy: string
  createdAt: string
  updatedAt?: string
}

/** One edge of the project relationship map (spec section 4). */
export interface RelationshipRecord {
  siteId: string
  relId: string
  fromType: string
  fromId: string
  fromLabel?: string
  relation: string
  toType: string
  toId: string
  toLabel?: string
  note?: string
  createdBy: string
  createdAt: string
}

/**
 * A named bucket of cost lines inside one group — the middle layer of the
 * budget tree (e.g. Hard costs → Structural). Each project keeps its own list,
 * managed by admins.
 */
export interface BudgetCategoryRecord {
  siteId: string
  categoryId: string
  group: BudgetGroup
  name: string
  description?: string
  order: number
  createdAt: string
  updatedAt: string
}

/**
 * One budgeted cost against a project. The amounts mirror an accountant's
 * workbook: `budget` is the approved figure excluding HST, `spent` is what has
 * been paid net of HST, and `hst` is the HST paid on top of it.
 */
export interface BudgetLineRecord {
  siteId: string
  lineId: string
  group: BudgetGroup
  /** Category this line sits under. Unset (or empty) means uncategorised. */
  categoryId?: string
  /** Cost code from the workbook, e.g. "S.13" or "H.06 10 00". */
  code?: string
  name: string
  budget: number
  spent: number
  hst: number
  order: number
  createdAt: string
  updatedAt: string
}

/**
 * One row of the file search index, written by the agent when it processes an
 * upload. `docId` is derived from the S3 key, so re-processing a file updates the
 * same row instead of creating a second one.
 */
export interface FileIndexRecord {
  siteId: string
  docId: string
  s3Key: string
  name: string
  kind: AssetType
  contentType?: string
  size?: number
  etag?: string
  /** Filled in once the agent has registered the matching asset row. */
  assetId?: string
  stageId?: string
  uploadedAt?: string
  /** Bounded copy of the extracted text; empty for files with no readable text. */
  text?: string
  excerpt?: string
  textChars?: number
  truncated?: boolean
  indexedAt?: string
}

/**
 * One row of the inverted index: a word and the file it was found in. The range
 * key `ref` is `${siteId}#${docId}`, so every posting for a file shares a prefix.
 */
export interface FileTermRecord {
  term: string
  ref: string
  siteId: string
  docId: string
  /** Occurrences in the file body. */
  tf: number
  /** Occurrences in the file name — a much stronger signal. */
  ntf: number
}

export interface InviteRecord {
  token: string
  email?: string
  role: Role
  siteIds: string[]
  note?: string
  status: InviteStatus
  createdBy: string
  createdAt: string
  expiresAt: string
  acceptedBy?: string
  acceptedAt?: string
}

export interface KpiConfig {
  userId: string
  kpis: string[]
  updatedAt: string
}

/* ------------------------------- assistant chat ------------------------------- */

export type ChatRole = 'user' | 'assistant'
export type ChatMessageStatus = 'ok' | 'error'
export type ChatPendingStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** One saved conversation in the portal's Assistant page. */
export interface ChatThreadRecord {
  threadId: string
  userId: string
  title: string
  /** Project the conversation was started from, when the user was on a page. */
  siteId?: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

/** A dashboard change the agent parked for the user to approve. */
export interface ChatPendingAction {
  actionId: string
  tool: string
  preview: string
  status: ChatPendingStatus
  resolution?: string
  resolvedAt?: string
}

/** A file the agent produced during a turn (currently PDF reports). */
export interface ChatArtifact {
  kind: 'report'
  siteId: string
  assetId?: string
  s3Key?: string
  name: string
  title?: string
  reportType?: string
  size?: number
}

export interface ChatMessageRecord {
  threadId: string
  messageId: string
  role: ChatRole
  text: string
  userId: string
  /** Agent that handled the turn ("progress" / "general"). Assistant messages only. */
  agent?: string
  status?: ChatMessageStatus
  /** Approvals raised by this turn, still resolvable from the chat. */
  pending?: ChatPendingAction[]
  /** Reports the agent created during this turn. */
  artifacts?: ChatArtifact[]
  costUsd?: number
  createdAt: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser
    }
  }
}
