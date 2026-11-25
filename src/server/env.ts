import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// Load .env from the project root (works whether cwd is the repo root or /httpdocs).
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env')
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate })
    break
  }
}

const isProd = (process.env.NODE_ENV ?? 'development') === 'production'

/** A non-negative whole number from the environment, or the fallback. */
function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  isProd,
  PORT: Number(process.env.PORT ?? 8787),
  APP_URL: process.env.APP_URL ?? 'http://localhost:5173',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  AWS_REGION: process.env.AWS_REGION ?? 'us-east-2',
  S3_BUCKET: process.env.S3_BUCKET ?? 'cppi-portal-files',
  ADMIN_EMAILS: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  BOOTSTRAP_ADMIN_EMAIL: (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase(),
  BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  BOOTSTRAP_ADMIN_NAME: (process.env.BOOTSTRAP_ADMIN_NAME ?? 'Harikrishnan Midhun').trim(),
  // ---- Multi-tenancy ------------------------------------------------------
  /** Name given to the workspace that owns the data existing before tenancy. */
  BOOTSTRAP_ORG_NAME: (process.env.BOOTSTRAP_ORG_NAME ?? 'CPPI').trim(),
  /**
   * Platform super admins. They own the default workspace and are the only
   * accounts that may invite someone to become the admin of a new workspace.
   */
  SUPER_ADMIN_EMAILS: (process.env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Product limits every workspace starts with. */
  DEFAULT_ORG_LIMITS_DOCS: positiveInt(process.env.DEFAULT_ORG_LIMITS_DOCS, 50),
  DEFAULT_ORG_LIMITS_IMAGES: positiveInt(process.env.DEFAULT_ORG_LIMITS_IMAGES, 200),
  DEFAULT_ORG_LIMITS_ASSISTANT_ASKS: positiveInt(process.env.DEFAULT_ORG_LIMITS_ASSISTANT_ASKS, 50),
  DEFAULT_ORG_LIMITS_PERIOD: (process.env.DEFAULT_ORG_LIMITS_PERIOD === 'lifetime'
    ? 'lifetime'
    : 'monthly') as 'lifetime' | 'monthly',
  // ---- Integrations -------------------------------------------------------
  /** Where Google sends the browser back after a user connects Gmail/Drive. */
  GOOGLE_OAUTH_REDIRECT_URL: (process.env.GOOGLE_OAUTH_REDIRECT_URL ?? '').trim(),
  /**
   * 32-byte key (base64 or hex) that encrypts stored Google refresh tokens. Left
   * unset, a key is derived from JWT_SECRET so a single-node install still works.
   */
  TOKEN_ENCRYPTION_KEY: (process.env.TOKEN_ENCRYPTION_KEY ?? '').trim(),
  TABLE_PREFIX: process.env.TABLE_PREFIX ?? 'cppi_',
  // The Python agent's optional HTTP ingress, which backs the Assistant chat.
  AGENT_API_URL: (process.env.AGENT_API_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, ''),
  AGENT_API_TOKEN: process.env.AGENT_API_TOKEN ?? ''
}

if (isProd && env.JWT_SECRET === 'dev-insecure-secret-change-me') {
  console.warn('[cppi] WARNING: JWT_SECRET is not set — refusing to run with the insecure default is recommended.')
}

if (!env.GOOGLE_CLIENT_ID) {
  console.warn('[cppi] WARNING: GOOGLE_CLIENT_ID is not set — Google sign-in will not work.')
}

if (!env.AGENT_API_TOKEN) {
  console.warn('[cppi] WARNING: AGENT_API_TOKEN is not set — the Assistant chat will be unavailable.')
}
