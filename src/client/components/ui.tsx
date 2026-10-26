import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { initials } from '../lib/format'

/* --------------------------------- button -------------------------------- */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  loading?: boolean
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant}${size === 'sm' ? ' btn-sm' : ''} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : null}
      {children}
    </button>
  )
}

/* ---------------------------------- card --------------------------------- */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`.trim()}>{children}</div>
}

export function CardHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="card-header">
      <div>
        <div className="card-title">{title}</div>
        {sub ? <div className="card-sub">{sub}</div> : null}
      </div>
      {action}
    </div>
  )
}

/* --------------------------------- badge --------------------------------- */

export type BadgeTone = 'green' | 'blue' | 'amber' | 'red' | 'gray'

export function Badge({ tone = 'gray', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

const SITE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  planning: { label: 'Planning', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'green' },
  on_hold: { label: 'On hold', tone: 'amber' },
  completed: { label: 'Completed', tone: 'gray' }
}

const STAGE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  not_started: { label: 'Not started', tone: 'gray' },
  in_progress: { label: 'In progress', tone: 'green' },
  completed: { label: 'Completed', tone: 'blue' },
  blocked: { label: 'Blocked', tone: 'red' }
}

const MILESTONE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'gray' },
  in_progress: { label: 'In progress', tone: 'green' },
  completed: { label: 'Done', tone: 'blue' }
}

export function SiteStatusBadge({ status }: { status: string }) {
  const s = SITE_STATUS[status] ?? { label: status, tone: 'gray' as BadgeTone }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export function StageStatusBadge({ status }: { status: string }) {
  const s = STAGE_STATUS[status] ?? { label: status, tone: 'gray' as BadgeTone }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export function MilestoneStatusBadge({ status }: { status: string }) {
  const s = MILESTONE_STATUS[status] ?? { label: status, tone: 'gray' as BadgeTone }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export function RoleBadge({ role }: { role: string }) {
  const tone: BadgeTone = role === 'admin' ? 'green' : role === 'contractor' ? 'blue' : 'gray'
  return <Badge tone={tone}>{role}</Badge>
}

/* -------------------------------- avatar --------------------------------- */

export function Avatar({ name, src, size = 'md' }: { name?: string; src?: string; size?: 'md' | 'lg' }) {
  const cls = `avatar${size === 'lg' ? ' avatar-lg' : ''}`
  if (src) return <img className={cls} src={src} alt={name ?? 'avatar'} referrerPolicy="no-referrer" />
  return <div className={cls}>{initials(name)}</div>
}

/* ------------------------------- progress -------------------------------- */

export function Progress({ percent }: { percent: number }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${value}%` }} />
    </div>
  )
}

/* --------------------------------- modal --------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={wide ? { maxWidth: 760 } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

/* --------------------------------- field --------------------------------- */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

/* --------------------------------- empty --------------------------------- */

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="small">{children}</div> : null}
    </div>
  )
}

export function ErrorNote({ message }: { message?: string | null }) {
  if (!message) return null
  return <div className="alert alert-error" style={{ marginBottom: 14 }}>{message}</div>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center-screen" style={{ minHeight: 220 }}>
      <div className="row">
        <span className="spinner" />
        <span className="muted">{label}</span>
      </div>
    </div>
  )
}
