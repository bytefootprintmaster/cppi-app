import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Avatar, Button } from './ui'
import {
  IconBuilding,
  IconCamera,
  IconChat,
  IconChevronLeft,
  IconDashboard,
  IconLogOut,
  IconMail,
  IconMenu,
  IconScale,
  IconSearch,
  IconUsers,
  IconX
} from './icons'

/** Sidebar open/closed state, shared with the page header toggle. */
const SidebarNav = createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {}
})

const SIDEBAR_KEY = 'cppi.sidebarCollapsed'

/** Mirrors react-router's own matching so the visual and announced active link agree. */
function isCurrent(pathname: string, to: string, end?: boolean): boolean {
  if (end) return pathname === to || pathname === `${to}/`
  const base = to.endsWith('/') ? to : `${to}/`
  return pathname === to || pathname.startsWith(base)
}

function NavItem({
  to,
  end,
  icon,
  label,
  pathname
}: {
  to: string
  end?: boolean
  icon: ReactNode
  label: string
  pathname: string
}) {
  const current = isCurrent(pathname, to, end)
  return (
    <NavLink
      to={to}
      end={end}
      className={`nav-item${current ? ' active' : ''}`}
      // `active` is only a colour change; aria-current is what a screen reader
      // announces, so the two have to be driven from the same value.
      aria-current={current ? 'page' : undefined}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  )
}

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  // Remembered per browser so a collapsed sidebar stays collapsed across reloads.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1')

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  // Dismiss the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  // Close on Escape and stop the page behind the drawer from scrolling.
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [menuOpen])

  return (
    <SidebarNav.Provider value={{ collapsed, toggle: () => setCollapsed((value) => !value) }}>
      <div className={`app-shell${collapsed ? ' is-collapsed' : ''}`}>
        {/* Keyboard users should not have to tab the whole sidebar on every page. */}
        <a className="skip-link" href="#app-main">
          Skip to content
        </a>

        <header className="mobile-bar">
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu />
          </button>
          <img
            className="mobile-brand"
            src="/android-chrome-192x192.png"
            alt="CPPI Management"
            width={26}
            height={26}
          />
        </header>

        <aside id="app-sidebar" className={`sidebar${menuOpen ? ' open' : ''}`}>
          <div className="brand">
            <img className="brand-logo brand-logo-sidebar" src="/cppi-logo.svg" alt="CPPI Management" />
            <button type="button" className="sidebar-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <IconX size={18} />
            </button>
          </div>

          <nav className="nav">
            <NavItem to="/" end icon={<IconDashboard />} label="Dashboard" pathname={location.pathname} />
            <NavItem to="/sites" icon={<IconBuilding />} label="Projects" pathname={location.pathname} />
            <NavItem to="/search" icon={<IconSearch />} label="Search" pathname={location.pathname} />
            <NavItem to="/regulations" icon={<IconScale />} label="Regulations" pathname={location.pathname} />
            <NavItem to="/chat" icon={<IconChat />} label="Assistant" pathname={location.pathname} />

            {user?.role === 'admin' ? (
              <>
                <div className="nav-label">Administration</div>
                <NavItem to="/admin/invites" icon={<IconMail />} label="Invitations" pathname={location.pathname} />
                <NavItem to="/admin/users" icon={<IconUsers />} label="Users & roles" pathname={location.pathname} />
                {/* Opens the real four-button capture screen a site inspector gets,
                    so an admin can see the field app first-hand. The field header
                    carries a "Back to office" link for anyone without the
                    inspector surface. */}
                <NavItem
                  to="/inspector"
                  icon={<IconCamera />}
                  label="Site inspector view"
                  pathname={location.pathname}
                />
              </>
            ) : null}
          </nav>

          <div className="sidebar-footer">
            <div className="user-chip">
              <Avatar name={user?.name} src={user?.picture} />
              <div style={{ minWidth: 0 }}>
                <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user?.name}
                </div>
                <div className="role">{user?.role}</div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="btn-icon"
              title="Sign out"
              style={{ width: '100%', marginTop: 6 }}
              onClick={() => {
                signOut()
                navigate('/login')
              }}
            >
              <IconLogOut size={16} />
              <span>Sign out</span>
            </Button>
          </div>
        </aside>

        {menuOpen ? <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} /> : null}

        <main className="main" id="app-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </SidebarNav.Provider>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  const { collapsed, toggle } = useContext(SidebarNav)

  return (
    <div className="topbar">
      <div className="topbar-lead">
        <button
          type="button"
          className="topbar-nav-toggle"
          aria-label={collapsed ? 'Show navigation' : 'Hide navigation'}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <IconMenu /> : <IconChevronLeft />}
        </button>
        <div>
          {/* The page's one h1. Rendered as a heading so the document has a
              name a screen reader can jump to; styled as before. */}
          <h1 className="topbar-title">{title}</h1>
          {subtitle ? <div className="topbar-sub">{subtitle}</div> : null}
        </div>
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  )
}

export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`content ${className}`.trim()}>{children}</div>
}
