import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { GoogleButton } from '../components/GoogleButton'
import { Button, Card, ErrorNote, Loading, RoleBadge } from '../components/ui'
import { IconCheck, IconMail } from '../components/icons'

interface InvitePreview {
  invite: {
    role: string
    email?: string
    siteIds: string[]
    note?: string
    status: string
    expired: boolean
  }
}

export function InviteAcceptPage() {
  const { token = '' } = useParams()
  const { user, loading: authLoading, signInWithGoogle, refresh } = useAuth()
  const navigate = useNavigate()
  const { data, error, loading } = useApi<InvitePreview>(`/invites/${token}`)
  const [busy, setBusy] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    document.title = 'Invitation · CPPI'
  }, [])

  async function accept() {
    setBusy(true)
    setAcceptError(null)
    try {
      await api(`/invites/${token}/accept`, { method: 'POST' })
      await refresh()
      setAccepted(true)
      window.setTimeout(() => navigate('/', { replace: true }), 1200)
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not accept the invitation')
    } finally {
      setBusy(false)
    }
  }

  async function handleCredential(credential: string) {
    setAcceptError(null)
    try {
      await signInWithGoogle(credential)
      await accept()
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Sign in failed')
    }
  }

  if (authLoading || (loading && !data)) return <Loading label="Loading invitation…" />

  if (error || !data) {
    return (
      <div className="login-shell" style={{ gridTemplateColumns: '1fr' }}>
        <section className="login-panel">
          <div className="login-card">
            <Card>
              <div className="card-body">
                <h2>Invitation not available</h2>
                <ErrorNote message={error ?? 'This invitation link is not valid.'} />
                <Link className="btn btn-ghost" to="/">
                  Go to CPPI
                </Link>
              </div>
            </Card>
          </div>
        </section>
      </div>
    )
  }

  const invite = data.invite
  const unusable = invite.status !== 'pending' || invite.expired

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
        <div style={{ position: 'relative' }}>
          <h1>You have been invited.</h1>
          <p>
            Accept the invitation to join the CPPI portal and access the building projects you are working on.
          </p>
        </div>
        <div className="small" style={{ color: '#6d9c87', position: 'relative' }}>
          © {new Date().getFullYear()} CPPI Portal
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <Card>
            <div className="card-body">
              <div className="row" style={{ gap: 10 }}>
                <IconMail size={20} />
                <h2 style={{ fontSize: 20 }}>Invitation details</h2>
              </div>

              <div className="stack" style={{ gap: 12, marginTop: 18 }}>
                <div className="row-between">
                  <span className="small muted">Role</span>
                  <RoleBadge role={invite.role} />
                </div>
                {invite.email ? (
                  <div className="row-between">
                    <span className="small muted">Issued for</span>
                    <strong>{invite.email}</strong>
                  </div>
                ) : null}
                <div className="row-between">
                  <span className="small muted">Projects</span>
                  <strong>
                    {invite.role === 'admin'
                      ? 'All projects'
                      : invite.siteIds.length === 0
                        ? 'None yet'
                        : `${invite.siteIds.length} project(s)`}
                  </strong>
                </div>
                {invite.note ? (
                  <div className="row-between">
                    <span className="small muted">Note</span>
                    <strong>{invite.note}</strong>
                  </div>
                ) : null}
                <div className="row-between">
                  <span className="small muted">Status</span>
                  <strong>{unusable ? invite.expired ? 'Expired' : invite.status : 'Ready to accept'}</strong>
                </div>
              </div>

              <ErrorNote message={acceptError} />

              {accepted ? (
                <div className="alert alert-info" style={{ marginTop: 18, display: 'flex', gap: 8 }}>
                  <IconCheck size={16} />
                  Invitation accepted — taking you to your dashboard…
                </div>
              ) : unusable ? (
                <div className="alert alert-error" style={{ marginTop: 18 }}>
                  This invitation can no longer be used. Ask an administrator for a new link.
                </div>
              ) : user ? (
                <div style={{ marginTop: 20 }}>
                  <p className="small muted" style={{ marginBottom: 12 }}>
                    Signed in as <strong>{user.email}</strong>.
                  </p>
                  <Button loading={busy} onClick={() => void accept()}>
                    Accept invitation
                  </Button>
                </div>
              ) : (
                <div style={{ marginTop: 20 }}>
                  <p className="small muted" style={{ marginBottom: 12 }}>
                    Sign in with Google to accept. {invite.email ? 'Use the email address above.' : ''}
                  </p>
                  <GoogleButton onCredential={handleCredential} text="continue_with" />
                </div>
              )}
            </div>
          </Card>
        </div>
      </section>
    </div>
  )
}
