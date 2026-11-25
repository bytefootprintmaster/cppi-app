/**
 * One-time (and safe to re-run) backfill for multi-tenancy.
 *
 *   node scripts/backfill-orgs.mjs
 *
 * Does three things:
 *  1. creates the default workspace (`org_default`) that owns the data which
 *     existed before tenancy;
 *  2. stamps `orgId` onto every legacy user, site and invite so the new
 *     `orgId-index` queries can find them;
 *  3. promotes the emails in `SUPER_ADMIN_EMAILS` to platform super admins in
 *     that workspace.
 *
 * Run `node scripts/setup-infra.mjs` first so the `orgs` table and the
 * `orgId-index` GSIs exist.
 */
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { DynamoDBClient, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb'

for (const candidate of [path.resolve(process.cwd(), '.env')]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate })
    break
  }
}

const region = process.env.AWS_REGION || 'us-east-2'
const prefix = process.env.TABLE_PREFIX || 'cppi_'
const ORGS = `${prefix}orgs`
const USERS = `${prefix}users`
const SITES = `${prefix}sites`
const INVITES = `${prefix}invites`

/** Must match `DEFAULT_ORG_ID` in src/server/types.ts. */
const DEFAULT_ORG_ID = 'org_default'

const ORG_NAME = (process.env.BOOTSTRAP_ORG_NAME || 'CPPI').trim()
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

function intOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}

const LIMITS = {
  docs: intOr(process.env.DEFAULT_ORG_LIMITS_DOCS, 50),
  images: intOr(process.env.DEFAULT_ORG_LIMITS_IMAGES, 200),
  assistantAsks: intOr(process.env.DEFAULT_ORG_LIMITS_ASSISTANT_ASKS, 50),
  period: process.env.DEFAULT_ORG_LIMITS_PERIOD === 'lifetime' ? 'lifetime' : 'monthly'
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true }
})

function slug(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  )
}

async function scanAll(table) {
  const items = []
  let ExclusiveStartKey
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }))
    items.push(...(res.Items ?? []))
    ExclusiveStartKey = res.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

async function ensureDefaultOrg() {
  const existing = await ddb.send(new GetCommand({ TableName: ORGS, Key: { orgId: DEFAULT_ORG_ID } }))
  if (existing.Item) {
    console.log(`• workspace exists: ${DEFAULT_ORG_ID}`)
    return
  }

  const now = new Date().toISOString()
  await ddb.send(
    new PutCommand({
      TableName: ORGS,
      Item: {
        orgId: DEFAULT_ORG_ID,
        name: ORG_NAME,
        slug: slug(ORG_NAME),
        ownerUserId: '',
        status: 'active',
        limits: LIMITS,
        counters: { docs: 0, images: 0, assistantAsks: 0, periodStartedAt: now },
        createdAt: now,
        updatedAt: now
      }
    })
  )
  console.log(`✔ created workspace: ${DEFAULT_ORG_ID} (${ORG_NAME})`)
}

/** Set `orgId` on every row of `table` that has none, keyed by `keyName`. */
async function stampOrg(table, keyName) {
  const rows = await scanAll(table)
  let stamped = 0
  for (const row of rows) {
    if (row.orgId) continue
    const key = row[keyName]
    if (!key) {
      console.log(`  ! ${table}: row without a ${keyName}, skipped`)
      continue
    }
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { [keyName]: key },
        UpdateExpression: 'SET orgId = :o',
        ExpressionAttributeValues: { ':o': DEFAULT_ORG_ID }
      })
    )
    stamped += 1
  }
  console.log(`• ${table}: stamped ${stamped} of ${rows.length} row(s)`)
}

async function promoteSuperAdmins() {
  if (SUPER_ADMIN_EMAILS.length === 0) {
    console.log('• SUPER_ADMIN_EMAILS is empty, nothing to promote')
    return
  }

  for (const email of SUPER_ADMIN_EMAILS) {
    const found = await ddb.send(
      new QueryCommand({
        TableName: USERS,
        IndexName: 'email-index',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': email }
      })
    )
    const users = found.Items ?? []
    if (users.length === 0) {
      console.log(`• no account yet for ${email} (it will be created at first boot)`)
      continue
    }

    for (const user of users) {
      if (user.role === 'super_admin' && user.orgId === DEFAULT_ORG_ID) {
        console.log(`• ${email} is already a super admin`)
        continue
      }
      await ddb.send(
        new UpdateCommand({
          TableName: USERS,
          Key: { userId: user.userId },
          UpdateExpression: 'SET #role = :r, orgId = :o',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':r': 'super_admin', ':o': DEFAULT_ORG_ID }
        })
      )
      console.log(`✔ ${email} → super_admin in ${DEFAULT_ORG_ID}`)
    }
  }
}

await ensureDefaultOrg()
await stampOrg(USERS, 'userId')
await stampOrg(SITES, 'siteId')
await stampOrg(INVITES, 'token')
await promoteSuperAdmins()
console.log('\n✅ Tenancy backfill complete.')
