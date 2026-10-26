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
  TABLE_PREFIX: process.env.TABLE_PREFIX ?? 'cppi_'
}

if (isProd && env.JWT_SECRET === 'dev-insecure-secret-change-me') {
  console.warn('[cppi] WARNING: JWT_SECRET is not set — refusing to run with the insecure default is recommended.')
}

if (!env.GOOGLE_CLIENT_ID) {
  console.warn('[cppi] WARNING: GOOGLE_CLIENT_ID is not set — Google sign-in will not work.')
}
