/* Shared domain types for the CPPI portal. */

export type Role = 'admin' | 'contractor' | 'viewer'
export type UserStatus = 'active' | 'disabled'
export type SiteStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed'
export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked'
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed'
export type AssetType = 'image' | 'document'
export type AssetCategory = 'progress' | 'plan' | 'permit' | 'invoice' | 'other'
export type InviteStatus = 'pending' | 'accepted' | 'revoked'

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
  budget?: number
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
