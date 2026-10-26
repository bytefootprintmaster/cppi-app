import type { ReactNode } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Avatar, Button } from './ui'
import { IconBuilding, IconDashboard, IconLogOut, IconMail, IconUsers } from './icons'

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <div className="brand-name">CPPI</div>
            <div className="brand-sub">Project Portal</div>
          </div>
        </div>

        <nav className="nav">
          <NavItem to="/" end icon={<IconDashboard />} label="Dashboard" />
          <NavItem to="/sites" icon={<IconBuilding />} label="Projects" />

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

      <div className="main">
        <Outlet />
      </div>
    </div>
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
  return (
    <div className="topbar">
      <div>
        <div className="topbar-title">{title}</div>
        {subtitle ? <div className="topbar-sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  )
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="content">{children}</div>
}
