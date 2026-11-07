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
  uploadedBy: string
  uploadedByName: string
  uploadedAt: string
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser
    }
  }
}
