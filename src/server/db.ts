import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb'
import { env } from './env'

const base = new DynamoDBClient({ region: env.AWS_REGION })

export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true }
})

/** Table names (single prefix, several purpose-built tables). */
export const T = {
  users: `${env.TABLE_PREFIX}users`,
  credentials: `${env.TABLE_PREFIX}credentials`,
  invites: `${env.TABLE_PREFIX}invites`,
  sites: `${env.TABLE_PREFIX}sites`,
  stages: `${env.TABLE_PREFIX}stages`,
  milestones: `${env.TABLE_PREFIX}milestones`,
  assets: `${env.TABLE_PREFIX}assets`,
  remarks: `${env.TABLE_PREFIX}remarks`,
  kpis: `${env.TABLE_PREFIX}kpis`
} as const

export async function getItem<Item>(table: string, key: Record<string, unknown>): Promise<Item | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }))
  return res.Item as Item | undefined
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function putItem(table: string, item: Record<string, any>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table, Item: item }))
}

export async function deleteItem(table: string, key: Record<string, unknown>): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: table, Key: key }))
}

export async function updateFields(
  table: string,
  key: Record<string, unknown>,
  fields: Record<string, unknown>
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets: string[] = []
  entries.forEach(([k, v], i) => {
    names[`#f${i}`] = k
    values[`:v${i}`] = v
    sets.push(`#f${i} = :v${i}`)
  })
  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  )
}

interface QueryOpts {
  KeyConditionExpression: string
  ExpressionAttributeValues: Record<string, unknown>
  ExpressionAttributeNames?: Record<string, string>
  IndexName?: string
}

export async function queryAll<Item>(table: string, opts: QueryOpts): Promise<Item[]> {
  const items: Item[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(
      new QueryCommand({ TableName: table, ...opts, ExclusiveStartKey })
    )
    for (const item of res.Items ?? []) items.push(item as Item)
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (ExclusiveStartKey)
  return items
}

export async function scanAll<Item>(table: string): Promise<Item[]> {
  const items: Item[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }))
    for (const item of res.Items ?? []) items.push(item as Item)
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (ExclusiveStartKey)
  return items
}
