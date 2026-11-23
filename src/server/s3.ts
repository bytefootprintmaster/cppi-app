import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env'
import { HttpError } from './lib/http'

export const s3 = new S3Client({ region: env.AWS_REGION })

/** Deterministic, collision-free object key for a site asset. */
export function buildObjectKey(siteId: string, kind: 'image' | 'document', fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
  return `sites/${siteId}/${kind}/${randomUUID()}-${safe}`
}

export function presignUpload(key: string, contentType: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn }
  )
}

export function presignDownload(key: string, expiresIn = 900, downloadName?: string): Promise<string> {
  const responseDisposition = downloadName
    ? `attachment; filename="${downloadName.replace(/[^a-zA-Z0-9._ -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
    : undefined
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: responseDisposition
    }),
    { expiresIn }
  )
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
}

/**
 * Write an object the server produced itself (the site-report PDF), as opposed
 * to the presigned PUT a browser uses. The body is buffered in memory, which is
 * fine for a generated PDF.
 */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType })
  )
}

/** Read an object back into memory, e.g. to embed on-site photos in a report. */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  if (!res.Body) throw new HttpError(404, 'That file is no longer in storage')
  return (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
}
