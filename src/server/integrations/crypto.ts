import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '../env'
import { HttpError } from '../lib/http'

/**
 * Encryption for the secrets we hold on a user's behalf — chiefly the Google
 * refresh token. AES-256-GCM gives us confidentiality *and* tamper detection, so
 * a corrupted or swapped ciphertext fails to open rather than decrypting to
 * nonsense.
 *
 * The key comes from `TOKEN_ENCRYPTION_KEY` when set; otherwise one is derived
 * from `JWT_SECRET`, so a single-node install works without extra configuration.
 * A stored value never leaves the server: callers decrypt in memory and hand
 * only short-lived access tokens to anything downstream.
 */
function key(): Buffer {
  const configured = env.TOKEN_ENCRYPTION_KEY
  if (configured) {
    const base64 = Buffer.from(configured, 'base64')
    if (base64.length === 32) return base64
    const hex = Buffer.from(configured, 'hex')
    if (hex.length === 32) return hex
    throw new HttpError(500, 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 or hex encoded')
  }
  return createHash('sha256').update(`${env.JWT_SECRET}:cppi-integrations`).digest()
}

/** Encrypt a secret into `iv.tag.ciphertext`, each part base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`
}

/** Reverse {@link encryptSecret}. Throws if the value was tampered with. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) throw new HttpError(500, 'Stored secret is malformed')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]).toString('utf8')
}
