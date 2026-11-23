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
import { SearchPage } from './pages/Search'
import { RegulationsPage } from './pages/Regulations'
import { ChatPage } from './pages/Chat'
import { AdminInvitesPage } from './pages/AdminInvites'
import { AdminUsersPage } from './pages/AdminUsers'
import { InviteAcceptPage } from './pages/InviteAccept'
import { InspectorCapturePage, InspectorReportsPage } from './pages/Inspector'

function Protected({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <Loading label="Checking your session…" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

/**
 * The office portal. A site inspector is deliberately kept out of it: their
 * account opens the four-button capture screen instead, so a gloved worker never
 * meets a sidebar, a budget or a file tree they have no business in.
 */
function StandardShell() {
  const { user } = useAuth()
  if (user?.surface === 'inspector') return <Navigate to="/inspector" replace />
  return <Layout />
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InviteAcceptPage />} />

        <Route
          path="/inspector"
          element={
            <Protected>
              <InspectorCapturePage />
            </Protected>
          }
        />
        <Route
          path="/inspector/reports"
          element={
            <Protected>
              <InspectorReportsPage />
            </Protected>
          }
        />

        <Route
          element={
            <Protected>
              <StandardShell />
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/sites/:siteId" element={<SiteDetailPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/regulations" element={<RegulationsPage />} />
          <Route path="/chat" element={<ChatPage />} />
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
