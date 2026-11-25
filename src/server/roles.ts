import { T, getItem, putItem, scanAll } from './db'
import type {
  PermissionKey,
  PermissionOverrides,
  Permissions,
  Role,
  RoleRecord,
  SessionUser,
  Surface,
  UploadLimits
} from './types'
import { DEFAULT_UPLOAD_LIMITS } from './types'

/**
 * Roles are named bundles of permissions. Five are built in — `super_admin`,
 * `admin`, `manager`, `viewer` and `site_inspector` — and administrators may add
 * custom roles on top.
 *
 * The built-ins live in code rather than the `roles` table so signing in never
 * depends on a read (and works before the table is provisioned). Custom roles
 * are stored in the table; a role id that resolves to neither falls back to the
 * viewer bundle, which is the safe default.
 */
export const ADMIN_ROLE = 'admin'
export const MANAGER_ROLE = 'manager'
export const VIEWER_ROLE = 'viewer'
/**
 * A platform-level role: it sees every workspace and is the only role allowed to
 * create one. It is deliberately not offered to an org admin as something to
 * assign, so `listRoles()` leaves it out — see {@link listRoles}.
 */
export const SUPER_ADMIN_ROLE = 'super_admin'
/**
 * A site worker with a phone and gloves. This role exists for the field capture
 * screen: it may add files and send site reports, and nothing else. Its `surface`
 * is what keeps the account out of the office portal entirely.
 */
export const SITE_INSPECTOR_ROLE = 'site_inspector'

export const BUILTIN_ROLE_IDS: readonly string[] = [
  ADMIN_ROLE,
  MANAGER_ROLE,
  VIEWER_ROLE,
  SITE_INSPECTOR_ROLE,
  SUPER_ADMIN_ROLE
]

const ALL_PERMISSIONS: Permissions = {
  uploadFiles: true,
  downloadFiles: true,
  viewBudget: true,
  editDetails: true
}
const VIEWER_PERMISSIONS: Permissions = {
  uploadFiles: false,
  downloadFiles: true,
  viewBudget: false,
  editDetails: false
}

/**
 * An inspector captures evidence: photos, files and a spoken report. They need
 * to upload and to open back their own reports, so downloads stay on — but they
 * never see a budget or edit a project's details.
 */
const SITE_INSPECTOR_PERMISSIONS: Permissions = {
  uploadFiles: true,
  downloadFiles: true,
  viewBudget: false,
  editDetails: false
}

/**
 * A manager runs the project day to day: uploads files and edits details. Budget
 * visibility is deliberately withheld from the base role — an admin grants it
 * per user (or via a custom role) when someone needs to see the numbers.
 */
const MANAGER_PERMISSIONS: Permissions = {
  uploadFiles: true,
  downloadFiles: true,
  viewBudget: false,
  editDetails: true
}

export function isBuiltinRole(roleId: string): boolean {
  return BUILTIN_ROLE_IDS.includes(roleId)
}

/** The built-in roles, as records (used to seed the table and as defaults). */
export function builtinRoles(): RoleRecord[] {
  const now = new Date(0).toISOString()
  return [
    {
      roleId: SUPER_ADMIN_ROLE,
      name: 'Super admin',
      builtin: true,
      admin: true,
      permissions: ALL_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    },
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
      permissions: VIEWER_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    },
    {
      roleId: SITE_INSPECTOR_ROLE,
      name: 'Site inspector',
      builtin: true,
      surface: 'inspector',
      permissions: SITE_INSPECTOR_PERMISSIONS,
      createdAt: now,
      updatedAt: now
    }
  ]
}

const BUILTIN_BY_ID = new Map(builtinRoles().map((role) => [role.roleId, role]))

/**
 * Every role an administrator may assign, built-ins first and custom roles after,
 * each group by name. The platform-only `super_admin` role is left out: an org
 * admin can never grant it, and it is not theirs to see.
 */
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
  const builtins = builtinRoles().filter((role) => role.roleId !== SUPER_ADMIN_ROLE)
  return [...builtins, ...customs]
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

/**
 * The screen a role opens. Only the built-in site inspector role is restricted;
 * every other role — built-in or custom — lands in the standard portal.
 */
export function resolveSurface(role: RoleRecord | undefined): Surface {
  return role?.surface === 'inspector' ? 'inspector' : 'standard'
}

/** Merge a role's permissions with any per-user overrides. */
export function resolvePermissions(
  role: RoleRecord | undefined,
  overrides?: PermissionOverrides
): Permissions {
  const base = role?.permissions ?? VIEWER_PERMISSIONS
  // Older custom role records predate downloadFiles; keep downloads enabled for
  // those roles unless an administrator explicitly disables the permission.
  const merged: Permissions = { ...base, downloadFiles: base.downloadFiles ?? true }
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

/** True when the user holds a permission, with the admin roles bypassing checks. */
export function can(user: SessionUser, key: PermissionKey): boolean {
  if (user.role === ADMIN_ROLE || user.role === SUPER_ADMIN_ROLE) return true
  return user.permissions?.[key] === true
}

/** A platform-level account: manages every workspace and creates new ones. */
export function isSuperAdmin(user: SessionUser): boolean {
  return user.role === SUPER_ADMIN_ROLE
}

/** A workspace administrator. A super admin counts as one wherever they act. */
export function isAdmin(user: SessionUser): boolean {
  return user.role === ADMIN_ROLE || isSuperAdmin(user)
}
