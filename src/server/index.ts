import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { env } from './env'
import { authenticate } from './auth'
import { HttpError } from './lib/http'
import { authRouter } from './routes/auth'
import { adminRouter } from './routes/admin'
import { inviteRouter } from './routes/invites'
import { siteRouter } from './routes/sites'
import { dashboardRouter } from './routes/dashboard'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '1mb' }))
app.use(authenticate)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'cppi-app', region: env.AWS_REGION })
})

app.use('/api', authRouter)
app.use('/api/admin', adminRouter)
app.use('/api/invites', inviteRouter)
app.use('/api/sites', siteRouter)
app.use('/api/dashboard', dashboardRouter)

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Serve the built SPA. In production this bundle lives in dist/ next to index.html.
const staticDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'dist')
app.use(express.static(staticDir))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  res.sendFile(path.join(staticDir, 'index.html'), (err) => {
    if (err) next(err)
  })
})

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500
  const message = err instanceof Error ? err.message : 'Internal server error'
  if (status >= 500) console.error('[cppi] error:', err)
  res.status(status).json({ error: message })
})

app.listen(env.PORT, () => {
  console.log(`[cppi] API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
  console.log(`[cppi] region=${env.AWS_REGION} bucket=${env.S3_BUCKET}`)
})
