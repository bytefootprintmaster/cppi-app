import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { initials } from '../lib/format'
import { IconEye, IconEyeOff, IconMore } from './icons'

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

export function Card({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  )
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

/* ------------------------------- card menu ------------------------------- */

export interface MenuItem {
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
}

/**
 * A 3-dot overflow menu for card actions. Keeps a card's edit/delete actions out
 * of the way until needed, which matters on mobile where always-visible buttons
 * crowd the layout. Clicks are stopped from bubbling so the menu can sit inside
 * a card that is itself clickable.
 */
export function CardMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <div className="card-menu" ref={ref} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="card-menu-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <IconMore size={16} />
      </button>
      {open ? (
        <div className="card-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`card-menu-item${item.danger ? ' danger' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                setOpen(false)
                item.onClick()
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
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

export function RoleBadge({ role, label }: { role: string; label?: string }) {
  const tone: BadgeTone =
    role === 'admin' ? 'green' : role === 'manager' ? 'blue' : role === 'viewer' ? 'gray' : 'amber'
  return <Badge tone={tone}>{label ?? role}</Badge>
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
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // Callers pass inline arrow functions, so the handler is held in a ref: the
  // mount effect below must run once, not re-run on every render and yank focus
  // back out of whatever the reader is typing into.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const node = panel.current
    if (!node) return

    const focusable = () =>
      [...node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((el) => el.offsetParent !== null)

    // Focus the dialog itself so its name is announced before the content.
    node.focus({ preventScroll: true })

    function onKeyDown(event: KeyboardEvent) {
      // Escape closes. Stopping propagation keeps the page behind from also
      // reacting — the mobile drawer listens for Escape too.
      if (event.key === 'Escape') {
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    // Freeze the page behind the dialog. Removing its scrollbar would shift the
    // layout underneath, so the gap is paid back as padding.
    const gap = window.innerWidth - document.documentElement.clientWidth
    const previousOverflow = document.body.style.overflow
    const previousPadding = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (gap > 0) document.body.style.paddingRight = `${gap}px`

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      document.body.style.paddingRight = previousPadding
      opener?.focus?.()
    }
  }, [])

  return (
    <div className="modal-backdrop" onClick={() => close.current()}>
      <div
        className="modal"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={wide ? { maxWidth: 760 } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={() => close.current()} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

/* --------------------------------- tabs ---------------------------------- */

/**
 * The ARIA tabs pattern. Plain buttons announced nothing about which tab was
 * current and could not be driven from the keyboard; this exposes the roles,
 * keeps only the active tab in the tab order, and moves with the arrow keys.
 *
 * The pattern requires a panel per tab, so the caller renders the content in
 * `<TabPanel>` using the same `id` — that keeps the two halves in step.
 */
export function Tabs<T extends string>({
  id,
  tabs,
  value,
  onChange,
  className = ''
}: {
  id: string
  tabs: Array<{ key: T; label: string }>
  value: T
  onChange: (key: T) => void
  className?: string
}) {
  const list = useRef<HTMLDivElement>(null)

  function onKeyDown(event: ReactKeyboardEvent) {
    const keys = tabs.map((tab) => tab.key)
    const index = keys.indexOf(value)
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % keys.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + keys.length) % keys.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = keys.length - 1
    if (next < 0) return
    event.preventDefault()
    onChange(keys[next])
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className={`tabs ${className}`.trim()} role="tablist" ref={list} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          id={`${id}-tab-${tab.key}`}
          role="tab"
          aria-selected={tab.key === value}
          aria-controls={`${id}-panel`}
          tabIndex={tab.key === value ? 0 : -1}
          className={`tab${tab.key === value ? ' active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** The content half of the tabs pattern. `activeKey` names the visible tab. */
export function TabPanel({
  id,
  activeKey,
  children
}: {
  id: string
  activeKey: string
  children: ReactNode
}) {
  return (
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${activeKey}`} tabIndex={0}>
      {children}
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

/* ------------------------------ password input --------------------------- */

export function PasswordInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)

  // Warn before a failed sign-in: the field masks what was typed, so Caps Lock
  // is the one mistake the user cannot see for themselves.
  function trackCaps(event: ReactKeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState('CapsLock'))
  }

  return (
    <>
      <div className="password-wrap">
        <input
          className={`input ${className}`.trim()}
          type={visible ? 'text' : 'password'}
          {...rest}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          onBlur={() => setCapsLock(false)}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
      {capsLock ? (
        <div className="hint password-caps" role="status">
          Caps Lock is on
        </div>
      ) : null}
    </>
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

/* ------------------------------- toasts --------------------------------- */

type ToastTone = 'success' | 'error' | 'info'

interface Toast {
  id: number
  tone: ToastTone
  message: string
}

interface ToastApi {
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Success feedback. Every write in the app used to finish in silence, so the
 * only way to know a save had landed was to look for the changed value. Toasts
 * announce it and then get out of the way; errors stay put until dismissed
 * because they need reading.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { id, tone, message }])
      if (tone !== 'error') window.setTimeout(() => dismiss(id), 4500)
    },
    [dismiss]
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message)
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            <span className="toast-text">{toast.message}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { success: () => {}, error: () => {}, info: () => {} }
}

/* ------------------------------ confirm dialog --------------------------- */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * A promise-based replacement for `window.confirm`. The native dialog cannot be
 * styled, cannot be translated, blocks the whole tab and is ignored by some
 * browsers inside PWAs. This renders in-app and keeps the destructive action on
 * the dialog's own terms.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null)

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setRequest({ options, resolve })),
    []
  )

  function settle(value: boolean) {
    request?.resolve(value)
    setRequest(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? (
        <Modal
          title={request.options.title}
          onClose={() => settle(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => settle(false)}>
                {request.options.cancelLabel ?? 'Cancel'}
              </Button>
              <Button variant={request.options.danger === false ? 'primary' : 'danger'} onClick={() => settle(true)}>
                {request.options.confirmLabel ?? 'Confirm'}
              </Button>
            </>
          }
        >
          {request.options.message ? <p className="confirm-message">{request.options.message}</p> : null}
        </Modal>
      ) : null}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? ((options) => Promise.resolve(window.confirm(options.title)))
}

/**
 * Wraps a modal's close handler so a form with unsaved edits asks before
 * discarding. Wire the result to both the Modal's `onClose` and its Cancel
 * button, or Escape and the backdrop will still drop the work silently.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void): () => Promise<void> {
  const confirm = useConfirm()

  return useCallback(async () => {
    if (!dirty) {
      onClose()
      return
    }
    const ok = await confirm({
      title: 'Discard your changes?',
      message: 'This form has unsaved edits. Closing now will lose them.',
      confirmLabel: 'Discard changes'
    })
    if (ok) onClose()
  }, [confirm, dirty, onClose])
}
