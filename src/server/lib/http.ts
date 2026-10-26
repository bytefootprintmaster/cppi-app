import type { NextFunction, Request, RequestHandler, Response } from 'express'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Wrap an async route handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** Read a required string body/param field. */
export function str(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" is required`)
  }
  const v = value.trim()
  if (v.length > max) throw new HttpError(400, `"${field}" is too long`)
  return v
}

export function optStr(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'Expected a string')
  const v = value.trim()
  if (v === '') return undefined
  if (v.length > max) throw new HttpError(400, 'Value is too long')
  return v
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, `"${field}" must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}
