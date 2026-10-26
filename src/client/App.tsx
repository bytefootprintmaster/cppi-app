import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { Layout } from './components/Layout'
import { InstallPrompt } from './components/InstallPrompt'
import { Loading } from './components/ui'
import { LoginPage } from './pages/Login'
import { DashboardPage } from './pages/Dashboard'
import { SitesPage } from './pages/Sites'
import { SiteDetailPage } from './pages/SiteDetail'
import { AdminInvitesPage } from './pages/AdminInvites'
import { AdminUsersPage } from './pages/AdminUsers'
import { InviteAcceptPage } from './pages/InviteAccept'

function Protected({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <Loading label="Checking your session…" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InviteAcceptPage />} />

        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/sites/:siteId" element={<SiteDetailPage />} />
          <Route
            path="/admin/invites"
            element={
              <Protected admin>
                <AdminInvitesPage />
              </Protected>
            }
          />
          <Route
            path="/admin/users"
            element={
              <Protected admin>
                <AdminUsersPage />
              </Protected>
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <InstallPrompt />
    </>
  )
}
