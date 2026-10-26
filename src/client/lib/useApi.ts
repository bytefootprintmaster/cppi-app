import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

/**
 * Small data-fetching helper: loads `path` and exposes a `reload()` for
 * after-mutation refreshes. `path` may be null to skip fetching.
 */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!path) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setData(await api<T>(path))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}
