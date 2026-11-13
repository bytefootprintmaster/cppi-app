import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Avatar, Button } from './ui'
import {
  IconBuilding,
  IconChat,
  IconChevronLeft,
  IconDashboard,
  IconLogOut,
  IconMail,
  IconMenu,
  IconSearch,
  IconUsers,
  IconX
} from './icons'

/** Desktop sidebar open/closed state, shared with the page header toggle. */
const SidebarNav = createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {}
})

function NavItem({ to, end, icon, label }: { to: string; end?: boolean; icon: ReactNode; label: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
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
  const [collapsed, setCollapsed] = useState(false)

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
          <img className="mobile-brand" src="/icons/icon-192.png" alt="CPPI Management" />
        </header>

        <aside id="app-sidebar" className={`sidebar${menuOpen ? ' open' : ''}`}>
          <div className="brand">
            <img className="brand-logo brand-logo-sidebar" src="/cppi-logo.svg" alt="CPPI Management" />
            <button type="button" className="sidebar-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <IconX size={18} />
            </button>
          </div>

          <nav className="nav">
            <NavItem to="/" end icon={<IconDashboard />} label="Dashboard" />
            <NavItem to="/sites" icon={<IconBuilding />} label="Projects" />
            <NavItem to="/search" icon={<IconSearch />} label="Search" />
            <NavItem to="/chat" icon={<IconChat />} label="Assistant" />

            {user?.role === 'admin' ? (
              <>
                <div className="nav-label">Administration</div>
                <NavItem to="/admin/invites" icon={<IconMail />} label="Invitations" />
                <NavItem to="/admin/users" icon={<IconUsers />} label="Users & roles" />
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

        <div className="main">
          <Outlet />
        </div>
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
          <div className="topbar-title">{title}</div>
          {subtitle ? <div className="topbar-sub">{subtitle}</div> : null}
        </div>
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  )
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="content">{children}</div>
}
