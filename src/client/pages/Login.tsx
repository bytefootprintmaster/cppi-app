import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { GoogleButton } from '../components/GoogleButton'
import { Loading } from '../components/ui'
import { IconLayers, IconTarget, IconTrend, IconUsers } from '../components/icons'

export function LoginPage() {
  const { user, loading, signInWithGoogle } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  useEffect(() => {
    document.title = 'Sign in · CPPI'
  }, [])

  if (loading) return <Loading label="Loading…" />
  if (user) return <Navigate to={from} replace />

  async function handleCredential(credential: string) {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle(credential)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <section className="login-hero">
        <div className="row" style={{ gap: 12 }}>
          <div className="brand-mark">C</div>
          <div>
            <div className="brand-name">CPPI</div>
            <div className="brand-sub">Construction Portfolio</div>
          </div>
        </div>

        <div style={{ position: 'relative', marginTop: 40 }}>
          <h1>Every building project, one controlled source of truth.</h1>
          <p>
            Plan stages and milestones, collect site photos and documents straight into secure storage, and keep
            every remark in context — for the whole team.
          </p>

          <div className="hero-points">
            <div className="hero-point">
              <span className="dot">
                <IconLayers size={13} />
              </span>
              <div>
                <strong style={{ color: '#fff' }}>Framework-driven delivery</strong>
                <div className="small" style={{ color: '#8fc0ac' }}>
                  Define stages and milestones once, track them across every site.
                </div>
              </div>
            </div>
            <div className="hero-point">
              <span className="dot">
                <IconTarget size={13} />
              </span>
              <div>
                <strong style={{ color: '#fff' }}>Customisable KPIs</strong>
                <div className="small" style={{ color: '#8fc0ac' }}>
                  Choose the numbers that matter to your portfolio.
                </div>
              </div>
            </div>
            <div className="hero-point">
              <span className="dot">
                <IconUsers size={13} />
              </span>
              <div>
                <strong style={{ color: '#fff' }}>Invite-based roles</strong>
                <div className="small" style={{ color: '#8fc0ac' }}>
                  Admins invite contractors with scoped access to specific projects.
                </div>
              </div>
            </div>
            <div className="hero-point">
              <span className="dot">
                <IconTrend size={13} />
              </span>
              <div>
                <strong style={{ color: '#fff' }}>Files in S3, not on a laptop</strong>
                <div className="small" style={{ color: '#8fc0ac' }}>
                  Private buckets and time-limited signed links.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="small" style={{ color: '#6d9c87', position: 'relative' }}>
          © {new Date().getFullYear()} CPPI Portal
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <h2 style={{ fontSize: 24 }}>Sign in</h2>
          <p className="muted" style={{ marginTop: 6, marginBottom: 24 }}>
            Continue with the Google account your administrator invited.
          </p>

          {error ? <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div> : null}

          {busy ? <Loading label="Signing you in…" /> : <GoogleButton onCredential={handleCredential} />}

          <p className="small muted" style={{ marginTop: 22, textAlign: 'center' }}>
            No password to remember — access is granted by invitation.
          </p>
        </div>
      </section>
    </div>
  )
}
