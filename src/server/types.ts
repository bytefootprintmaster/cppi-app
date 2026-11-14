/* Shared domain types for the CPPI portal. */

/**
 * A role id. Built-in ids are `admin`, `manager` and `viewer`; administrators may
 * also create custom roles. Role definitions live in {@link RoleRecord}.
 */
export type Role = string
export type UserStatus = 'active' | 'disabled'
export type SiteStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed'
export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked'
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed'
export type AssetType = 'image' | 'document'
export type AssetCategory = 'progress' | 'plan' | 'permit' | 'invoice' | 'other'
export type InviteStatus = 'pending' | 'accepted' | 'revoked'
/** Kind of cost a budget line belongs to. Land is bought, the other two are built. */
export type BudgetGroup = 'land' | 'soft' | 'hard'

/** The permissions an administrator can grant, on top of the role's defaults. */
export interface Permissions {
  /** Add and manage project files. */
  uploadFiles: boolean
  /** Download project files. Defaults to allowed for new users and roles. */
  downloadFiles: boolean
  /** See budget totals and cost lines. */
  viewBudget: boolean
  /** Edit project details, stages, milestones and folders. */
  editDetails: boolean
}

export type PermissionKey = keyof Permissions
/** Per-user overrides; a key that is absent keeps the role's default. */
export type PermissionOverrides = Partial<Permissions>

export const PERMISSION_KEYS: PermissionKey[] = ['uploadFiles', 'downloadFiles', 'viewBudget', 'editDetails']
export const PERMISSION_LABEL: Record<PermissionKey, string> = {
  uploadFiles: 'Upload files',
  downloadFiles: 'Download files',
  viewBudget: 'See budget',
  editDetails: 'Edit details'
}
export const PERMISSION_HINT: Record<PermissionKey, string> = {
  uploadFiles: 'Add, tag and delete project files.',
  downloadFiles: 'Download project files from the Files and Search pages.',
  viewBudget: 'Open the budget tab and see cost figures.',
  editDetails: 'Edit project details, stages, milestones and folders.'
}

/** Per-user ceilings that apply whatever the role is. */
export interface UploadLimits {
  /** Files a user may upload per calendar day. */
  dailyUploads: number
  /** Largest single file a user may upload, in megabytes. */
  maxFileMb: number
}

/** The guardrails every account starts with before any per-user override. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { dailyUploads: 50, maxFileMb: 500 }

/**
 * A named bundle of permissions. Admins pick one for each user, and may add
 * their own on top of the three built-ins (`admin`, `manager`, `viewer`).
 */
export interface RoleRecord {
  roleId: string
  name: string
  /** Built-in roles cannot be renamed or deleted. */
  builtin: boolean
  /** The administrator role bypasses every permission check. */
  admin?: boolean
  permissions: Permissions
  createdAt: string
  updatedAt: string
}

export interface SessionUser {
  userId: string
  email: string
  name: string
  picture?: string
  role: Role
  siteIds: string[]
  /** Effective permissions after the role and any per-user overrides. */
  permissions: Permissions
  /** Effective upload ceilings for this user. */
  limits: UploadLimits
}

export interface UserRecord {
  userId: string
  email: string
  name: string
  picture?: string
  role: Role
  siteIds: string[]
  status: UserStatus
  /** Per-user permission overrides, applied on top of the role's defaults. */
  permissions?: PermissionOverrides
  /** Per-user upload ceilings; unset fields fall back to the defaults. */
  limits?: Partial<UploadLimits>
  createdAt: string
  lastLoginAt?: string
}

export interface SiteRecord {
  siteId: string
  name: string
  code?: string
  description?: string
  /**
   * One-line label shown in lists and on the map. Derived from the structured
   * address below so a project always reads the same way everywhere.
   */
  location?: string
  /** Full street address, e.g. "27 Mandrake St". The GIS map prefers this. */
  address?: string
  /** City / town. Used as the fallback when no street address is entered. */
  city?: string
  /** Province, state or region. */
  region?: string
  postalCode?: string
  country?: string
  /** Coordinates. Entered by hand, or resolved by the geocoder; absent until set. */
  lat?: number
  lng?: number
  /** How the pin was placed: typed by a person or matched by the geocoder. */
  geoSource?: 'manual' | 'geocode'
  /** What the geocoder actually matched, so a wrong pin can be spotted. */
  geocodeLabel?: string
  geocodedAt?: string
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

/* --------------------------------- timeline --------------------------------- */

/**
 * What a timeline entry is. Every kind is derived from a record the portal
 * already keeps, so the timeline needs no storage of its own and always matches
 * the project data.
 */
export type TimelineEventKind =
  | 'project_created'
  | 'project_start'
  | 'project_target'
  | 'stage_start'
  | 'stage_end'
  | 'milestone_due'
  | 'milestone_completed'
  | 'file_uploaded'
  | 'remark'
  | 'finding'

/** One entry on a project's timeline. */
export interface TimelineEvent {
  /** Stable id, so list keys survive a re-fetch. */
  id: string
  kind: TimelineEventKind
  title: string
  detail?: string
  /** ISO timestamp the event happened (or is planned for). */
  at: string
  /** True when `at` is a future planned date rather than something recorded. */
  planned?: boolean
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
  /** Project assets attached to this turn. */
  attachments?: Array<Pick<AssetRecord, 'siteId' | 'assetId' | 'name' | 'type' | 'contentType' | 'size' | 'tags'>>
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
