/**
 * One-time infrastructure provisioning for CPPI.
 *
 *   node scripts/setup-infra.mjs
 *
 * Creates the DynamoDB tables and the private S3 bucket used for files/photos.
 * Safe to re-run: existing resources are left untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand
} from '@aws-sdk/client-dynamodb'
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutPublicAccessBlockCommand,
  S3Client
} from '@aws-sdk/client-s3'

for (const candidate of [path.resolve(process.cwd(), '.env')]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate })
    break
  }
}

const region = process.env.AWS_REGION || 'us-east-2'
const prefix = process.env.TABLE_PREFIX || 'cppi_'
const bucket = process.env.S3_BUCKET || 'cppi-portal-files'
const appUrl = process.env.APP_URL || 'http://cppimi.com'

const ddb = new DynamoDBClient({ region })
const s3 = new S3Client({ region })

const TABLE_DEFS = [
  { name: `${prefix}users`, hash: 'userId', gsis: [{ name: 'email-index', hash: 'email' }] },
  { name: `${prefix}credentials`, hash: 'email' },
  { name: `${prefix}invites`, hash: 'token', gsis: [{ name: 'email-index', hash: 'email' }] },
  { name: `${prefix}sites`, hash: 'siteId' },
  { name: `${prefix}stages`, hash: 'siteId', range: 'stageId' },
  { name: `${prefix}milestones`, hash: 'siteId', range: 'milestoneId' },
  { name: `${prefix}folders`, hash: 'siteId', range: 'folderId' },
  { name: `${prefix}assets`, hash: 'siteId', range: 'assetId' },
  { name: `${prefix}remarks`, hash: 'siteId', range: 'remarkId' },
  { name: `${prefix}budget`, hash: 'siteId', range: 'lineId' },
  { name: `${prefix}budget_categories`, hash: 'siteId', range: 'categoryId' },
  // File search index, written by the agent when it processes an upload.
  // file_index: one row per file (metadata + extracted text + optional vector).
  // file_terms: the inverted index, one row per (word, file) pair.
  { name: `${prefix}file_index`, hash: 'siteId', range: 'docId' },
  { name: `${prefix}file_terms`, hash: 'term', range: 'ref' },
  // Intelligence layer, written by the agent.
  // document_intelligence: what the agent understood about one file (one row per asset).
  // findings: gaps its proactive review has raised (missing doc, expiring certificate, ...).
  // relationships: the property -> project -> contractor -> payment map.
  { name: `${prefix}document_intelligence`, hash: 'siteId', range: 'assetId' },
  { name: `${prefix}findings`, hash: 'siteId', range: 'findingId' },
  { name: `${prefix}relationships`, hash: 'siteId', range: 'relId' },
  { name: `${prefix}kpis`, hash: 'userId' },
  // Assistant chat. chat_threads: one row per saved conversation (listed per user).
  // chat_messages: the turns inside a thread, oldest first.
  { name: `${prefix}chat_threads`, hash: 'threadId', gsis: [{ name: 'user-index', hash: 'userId' }] },
  { name: `${prefix}chat_messages`, hash: 'threadId', range: 'messageId' }
]

async function ensureTables() {
  const existing = new Set((await ddb.send(new ListTablesCommand({}))).TableNames ?? [])
  for (const def of TABLE_DEFS) {
    if (existing.has(def.name)) {
      console.log(`• table exists: ${def.name}`)
      continue
    }

    const attributeDefinitions = [
      { AttributeName: def.hash, AttributeType: 'S' },
      ...(def.range ? [{ AttributeName: def.range, AttributeType: 'S' }] : [])
    ]
    for (const gsi of def.gsis ?? []) {
      if (!attributeDefinitions.some((a) => a.AttributeName === gsi.hash)) {
        attributeDefinitions.push({ AttributeName: gsi.hash, AttributeType: 'S' })
      }
    }

    await ddb.send(
      new CreateTableCommand({
        TableName: def.name,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: def.hash, KeyType: 'HASH' },
          ...(def.range ? [{ AttributeName: def.range, KeyType: 'RANGE' }] : [])
        ],
        AttributeDefinitions: attributeDefinitions,
        ...(def.gsis
          ? {
              GlobalSecondaryIndexes: def.gsis.map((g) => ({
                IndexName: g.name,
                KeySchema: [{ AttributeName: g.hash, KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' }
              }))
            }
          : {})
      })
    )
    console.log(`✔ created table: ${def.name}`)
  }
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
    console.log(`• bucket exists: ${bucket}`)
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region } })
      })
    )
    console.log(`✔ created bucket: ${bucket}`)
  }

  await s3
    .send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true
        }
      })
    )
    .catch((e) => console.warn(`  (public-access-block skipped: ${e?.name ?? e})`))

  await s3
    .send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedOrigins: [appUrl, 'http://localhost:5173', 'http://localhost:8787'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3000
            }
          ]
        }
      })
    )
    .catch((e) => console.warn(`  (CORS skipped: ${e?.name ?? e})`))

  console.log(`✔ bucket ${bucket} is private with CORS for ${appUrl}`)
}

await ensureTables()
await ensureBucket()
console.log('\n✅ Infrastructure ready.')
