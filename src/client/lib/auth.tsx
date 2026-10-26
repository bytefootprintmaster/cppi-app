import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, setToken } from './api'
import type { SessionUser } from '../../server/types'

export interface AppConfig {
  appName: string
  googleClientId: string
  appUrl: string
}

interface AuthValue {
  user: SessionUser | null
  config: AppConfig | null
  loading: boolean
  signInWithGoogle: (credential: string) => Promise<SessionUser>
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null)
      return
    }
    try {
      const res = await api<{ user: SessionUser }>('/auth/me')
      setUser(res.user)
    } catch {
      setToken(null)
      setUser(null)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        setConfig(await api<AppConfig>('/config'))
      } catch {
        /* config endpoint unreachable */
      }
      await refresh()
      setLoading(false)
    })()
  }, [refresh])

  const signInWithGoogle = useCallback(async (credential: string) => {
    const res = await api<{ token: string; user: SessionUser }>('/auth/google', {
      method: 'POST',
      body: { credential }
    })
    setToken(res.token)
    setUser(res.user)
    return res.user
  }, [])

  const signOut = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({ user, config, loading, signInWithGoogle, signOut, refresh }),
    [user, config, loading, signInWithGoogle, signOut, refresh]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
