import { useEffect, useState } from 'react'
import { Button } from './ui'
import { IconX } from './icons'

/**
 * Passive "install as an app" prompt.
 *
 * Chromium fires `beforeinstallprompt` once the PWA criteria are met and we
 * replay it from our own button. iOS/Safari never fires that event, so there we
 * show the manual Share → Add to Home Screen instructions instead.
 */
const DISMISS_KEY = 'cppi:install-dismissed'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIosSafari() {
  const ua = window.navigator.userAgent
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)
  if (!ios) return false
  // Chrome/Firefox/Edge on iOS cannot install web apps, so don't mislead them.
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isStandalone()) return
    if (localStorage.getItem(DISMISS_KEY) === '1') return

    function onBeforeInstall(event: Event) {
      event.preventDefault()
      setDeferred(event as BeforeInstallPromptEvent)
      setShowIosHint(false)
      setVisible(true)
    }

    function onInstalled() {
      localStorage.setItem(DISMISS_KEY, '1')
      setVisible(false)
      setDeferred(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // Give the page a moment to settle before interrupting on iOS.
    const timer = isIosSafari()
      ? window.setTimeout(() => {
          setShowIosHint(true)
          setVisible(true)
        }, 2500)
      : undefined

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setVisible(false)
  }

  async function install() {
    if (!deferred) return
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'accepted') dismiss()
  }

  if (!visible) return null

  return (
    <div className="install-banner" role="dialog" aria-label="Install CPPI as an app">
      <div className="brand-mark" aria-hidden="true">
        C
      </div>

      <div className="install-copy">
        <div className="install-title">Install CPPI</div>
        <div className="install-sub">
          {showIosHint ? (
            <>
              Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </>
          ) : (
            <>Open it full screen, straight from your home screen.</>
          )}
        </div>
      </div>

      {!showIosHint && deferred ? (
        <Button size="sm" onClick={() => void install()}>
          Install
        </Button>
      ) : null}

      <button type="button" className="install-close" onClick={dismiss} aria-label="Not now">
        <IconX size={14} />
      </button>
    </div>
  )
}
