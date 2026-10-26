import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'

declare global {
  interface Window {
    google?: any
  }
}

let gsiPromise: Promise<void> | null = null

function loadGsi(): Promise<void> {
  if (gsiPromise) return gsiPromise
  gsiPromise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load Google Identity Services'))
    document.head.appendChild(script)
  })
  return gsiPromise
}

export function GoogleButton({
  onCredential,
  text = 'continue_with'
}: {
  onCredential: (credential: string) => void
  text?: 'signin_with' | 'signup_with' | 'continue_with'
}) {
  const { config } = useAuth()
  const hostRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onCredential)
  const [error, setError] = useState<string | null>(null)

  callbackRef.current = onCredential

  useEffect(() => {
    const clientId = config?.googleClientId
    if (!clientId || !hostRef.current) return
    let cancelled = false

    loadGsi()
      .then(() => {
        if (cancelled || !window.google?.accounts?.id || !hostRef.current) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential: string }) => callbackRef.current(response.credential),
          ux_mode: 'popup'
        })
        window.google.accounts.id.renderButton(hostRef.current, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text,
          logo_alignment: 'left',
          width: 320
        })
      })
      .catch((err: Error) => setError(err.message))

    return () => {
      cancelled = true
    }
  }, [config?.googleClientId, text])

  if (!config?.googleClientId) {
    return (
      <div className="alert alert-info">
        Google sign-in is not configured yet. Set <span className="mono">GOOGLE_CLIENT_ID</span> on the server to
        enable it.
      </div>
    )
  }

  return (
    <div>
      {error ? (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <div ref={hostRef} className="google-btn-host" />
    </div>
  )
}
