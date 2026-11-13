import { T, getItem, putItem, scanAll } from './db'
import type {
  PermissionKey,
  PermissionOverrides,
  Permissions,
  Role,
  RoleRecord,
  SessionUser,
  UploadLimits
} from './types'
import { DEFAULT_UPLOAD_LIMITS } from './types'

/**
 * Roles are named bundles of permissions. Three are built in — `admin`,
 * `manager` and `viewer` — and administrators may add custom roles on top.
 *
 * The built-ins live in code rather than the `roles` table so signing in never
 * depends on a read (and works before the table is provisioned). Custom roles
 * are stored in the table; a role id that resolves to neither falls back to the
 * viewer bundle, which is the safe default.
 */
export const ADMIN_ROLE = 'admin'
export const MANAGER_ROLE = 'manager'
export const VIEWER_ROLE = 'viewer'

export const BUILTIN_ROLE_IDS: readonly string[] = [ADMIN_ROLE, MANAGER_ROLE, VIEWER_ROLE]

const ALL_PERMISSIONS: Permissions = { uploadFiles: true, viewBudget: true, editDetails: true }
const NO_PERMISSIONS: Permissions = { uploadFiles: false, viewBudget: false, editDetails: false }

/**
 * A manager runs the project day to day: uploads files and edits details. Budget
 * visibility is deliberately withheld from the base role — an admin grants it
 * per user (or via a custom role) when someone needs to see the numbers.
 */
const MANAGER_PERMISSIONS: Permissions = { uploadFiles: true, viewBudget: false, editDetails: true }

export function isBuiltinRole(roleId: string): boolean {
  return BUILTIN_ROLE_IDS.includes(roleId)
}

/** The three built-in roles, as records (used to seed the table and as defaults). */
export function builtinRoles(): RoleRecord[] {
  const now = new Date(0).toISOString()
  return [
    {
      roleId: ADMIN_ROLE,
      name: 'Admin',
      builtin: true,
      admin: true,
      permissions: ALL_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    },
    {
      roleId: MANAGER_ROLE,
      name: 'Manager',
      builtin: true,
      permissions: MANAGER_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    },
    {
      roleId: VIEWER_ROLE,
      name: 'Viewer',
      builtin: true,
      permissions: NO_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    }
  ]
}

const BUILTIN_BY_ID = new Map(builtinRoles().map((role) => [role.roleId, role]))

/** Every role, built-ins first and custom roles after, each group by name. */
export async function listRoles(): Promise<RoleRecord[]> {
  let custom: RoleRecord[] = []
  try {
    custom = await scanAll<RoleRecord>(T.roles)
  } catch {
    // The roles table may not be provisioned yet; built-ins still work.
    custom = []
  }
  const customs = custom
    .filter((role) => !isBuiltinRole(role.roleId))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...builtinRoles(), ...customs]
}

/** Resolve one role id to its definition, falling back to viewer. */
export async function loadRole(roleId: Role): Promise<RoleRecord> {
  const builtin = BUILTIN_BY_ID.get(roleId)
  if (builtin) return builtin
  try {
    const row = await getItem<RoleRecord>(T.roles, { roleId })
    if (row) return row
  } catch {
    /* table missing — fall through to the safe default */
  }
  return BUILTIN_BY_ID.get(VIEWER_ROLE)!
}

/** Insert any built-in role rows that are missing. Leaves existing rows alone. */
export async function ensureBuiltinRoles(): Promise<void> {
  for (const role of builtinRoles()) {
    const existing = await getItem<RoleRecord>(T.roles, { roleId: role.roleId })
    if (!existing) await putItem(T.roles, role)
  }
}

/** Merge a role's permissions with any per-user overrides. */
export function resolvePermissions(
  role: RoleRecord | undefined,
  overrides?: PermissionOverrides
): Permissions {
  const base = role?.permissions ?? NO_PERMISSIONS
  const merged: Permissions = { ...base }
  if (overrides) {
    for (const key of Object.keys(overrides) as PermissionKey[]) {
      const value = overrides[key]
      if (typeof value === 'boolean') merged[key] = value
    }
  }
  return merged
}

/** Per-user ceilings, clamped to sane bounds, defaulting to the global guardrails. */
export function resolveLimits(overrides?: Partial<UploadLimits>): UploadLimits {
  return {
    dailyUploads: clampLimit(overrides?.dailyUploads, DEFAULT_UPLOAD_LIMITS.dailyUploads, 1, 1000),
    maxFileMb: clampLimit(overrides?.maxFileMb, DEFAULT_UPLOAD_LIMITS.maxFileMb, 1, 5000)
  }
}

function clampLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

/** True when the user holds a permission, with the admin role bypassing checks. */
export function can(user: SessionUser, key: PermissionKey): boolean {
  if (user.role === ADMIN_ROLE) return true
  return user.permissions?.[key] === true
}
