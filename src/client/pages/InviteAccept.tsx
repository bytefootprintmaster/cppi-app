import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, setToken } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { GoogleButton } from '../components/GoogleButton'
import { Button, Card, ErrorNote, Field, Loading, PasswordInput, RoleBadge, useToast } from '../components/ui'
import { IconCheck, IconMail } from '../components/icons'

interface InvitePreview {
  invite: {
    /** A workspace invitation founds a new workspace; a member one joins an existing one. */
    kind: 'member' | 'workspace'
    orgName?: string
    role: string
    email?: string
    siteIds: string[]
    note?: string
    status: string
    expired: boolean
  }
}

/**
 * Setting a password from an invitation link.
 *
 * This is how a site inspector gets in: the office emails a link, the worker
 * types their name and a password here, and the same request creates the account
 * with the invited role and projects — no Google account, no second sign-in.
 */
function ClaimForm({ token, email, onDone }: { token: string; email?: string; onDone: () => void }) {
  const { refresh } = useAuth()
  const toast = useToast()
  const [name, setName] = useState('')
  const [address, setAddress] = useState(email ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setProblem(null)
    if (password.length < 8) {
      setProblem('Choose a password of at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setProblem('The two passwords do not match.')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ token: string }>(`/invites/${token}/register`, {
        method: 'POST',
        body: { name: name.trim(), email: address.trim(), password }
      })
      setToken(res.token)
      await refresh()
      toast.success('Your account is ready.')
      onDone()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not set up your account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 20 }}>
      <Field label="Your name">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          required
        />
      </Field>
      <Field label="Email" hint={email ? 'This is the address the invitation was sent to.' : undefined}>
        <input
          className="input"
          type="email"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          readOnly={Boolean(email)}
          autoComplete="email"
          required
        />
      </Field>
      <Field label="Choose a password" hint="At least 8 characters.">
        <PasswordInput
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field label="Repeat the password">
        <PasswordInput
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <ErrorNote message={problem} />
      <Button type="submit" loading={busy}>
        Create my account
      </Button>
    </form>
  )
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
      await signInWithGoogle(credential, token)
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
  const isWorkspace = invite.kind === 'workspace'

  return (
    <div className="login-shell">
      <section className="login-hero">
        <img className="brand-logo brand-logo-hero" src="/cppi-logo.svg" alt="CPPI Management" />
        <div>
          <h1>{isWorkspace ? 'Your workspace is ready to set up.' : 'You have been invited.'}</h1>
          <p>
            {isWorkspace
              ? 'Accept the invitation to start your own CPPI workspace — add your projects, files and team from scratch.'
              : 'Accept the invitation to join the CPPI portal and access the building projects you are working on.'}
          </p>
        </div>
        <div className="small login-hero-foot">
          © {new Date().getFullYear()} CPPI Portal
        </div>
      </section>

      <section className="login-panel">
        <div className="auth-panel-brand">
          <img src="/cppi-logo.svg" alt="CPPI Management" />
        </div>
        <div className="login-card">
          <Card>
            <div className="card-body">
              <div className="row" style={{ gap: 10 }}>
                <IconMail size={20} />
                <h2 style={{ fontSize: 20 }}>{isWorkspace ? 'Workspace invitation' : 'Invitation details'}</h2>
              </div>

              <div className="stack" style={{ gap: 12, marginTop: 18 }}>
                <div className="row-between">
                  <span className="small muted">Role</span>
                  <RoleBadge role={invite.role} label={isWorkspace ? 'Workspace admin' : undefined} />
                </div>
                {isWorkspace ? (
                  <div className="row-between">
                    <span className="small muted">Workspace</span>
                    <strong>{invite.orgName || 'To be named'}</strong>
                  </div>
                ) : null}
                {invite.email ? (
                  <div className="row-between">
                    <span className="small muted">Issued for</span>
                    <strong>{invite.email}</strong>
                  </div>
                ) : null}
                {isWorkspace ? (
                  <div className="row-between">
                    <span className="small muted">Projects</span>
                    <strong>Starts empty</strong>
                  </div>
                ) : (
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
                )}
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
                  <p className="small muted" style={{ marginBottom: 4 }}>
                    Choose a password to finish setting up your account. {invite.email ? 'Use the email address above.' : ''}
                  </p>
                  <ClaimForm
                    token={token}
                    email={invite.email}
                    onDone={() => {
                      setAccepted(true)
                      // Home routes a site inspector straight to the capture screen.
                      window.setTimeout(() => navigate('/', { replace: true }), 1200)
                    }}
                  />
                  <div className="row" style={{ gap: 10, marginTop: 18, marginBottom: 14 }}>
                    <span className="divider-line" />
                    <span className="small muted">or</span>
                    <span className="divider-line" />
                  </div>
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
