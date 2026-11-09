import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre parses tiles in a web worker and, once bundled, looks for the worker
// file sitting beside its own chunk — a file Vite never emits. Importing it as
// a URL gives us an asset Vite does emit, so the worker loads in dev and prod.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { formatMoney } from '../lib/format'
import type { SiteStatus } from '../../server/types'

/** A project reduced to what a pin needs to say. */
export interface MapSite {
  siteId: string
  name: string
  code?: string
  location?: string
  status: SiteStatus
  lat: number
  lng: number
  budgeted?: number
}

/** Pin colour per status, keyed to the same meaning as the status badges. */
const STATUS_CLASS: Record<SiteStatus, string> = {
  planning: 'planning',
  in_progress: 'active',
  on_hold: 'hold',
  completed: 'done'
}

const STATUS_LABEL: Record<SiteStatus, string> = {
  planning: 'Planning',
  in_progress: 'In progress',
  on_hold: 'On hold',
  completed: 'Completed'
}

/**
 * A key-free light basemap. The portal's own palette is green-on-white, so the
 * muted Positron style keeps the map from fighting the surrounding cards.
 */
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

const MIN_PIN = 18
const MAX_PIN = 40

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

/** The MapLibre module namespace, captured when the on-demand import resolves. */
type MapLibre = typeof import('maplibre-gl')

interface MapViewProps {
  sites: MapSite[]
  /**
   * `portfolio` fits every pin in view; `single` locks onto the one project
   * (used by the locator map on a project page).
   */
  mode?: 'portfolio' | 'single'
  height?: number
  /** Called when a pin's popup action is used. */
  onSelect?: (siteId: string) => void
}

/**
 * A thin React wrapper around MapLibre GL JS. Markers are DOM elements rather
 * than GL layers: a portfolio is tens of projects, not thousands, and DOM pins
 * let the pins carry the app's own styling and real popups.
 *
 * The library itself is imported on demand, so its weight is only paid on the
 * pages that actually show a map.
 */
export function MapView({ sites, mode = 'portfolio', height = 460, onSelect }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const moduleRef = useRef<MapLibre | null>(null)
  const markersRef = useRef<Marker[]>([])
  const [ready, setReady] = useState(false)

  // Keep the latest callback without forcing a redraw when the parent re-renders.
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect

  // Create the map once; markers are rebuilt by the effect below.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const maplibre = await import('maplibre-gl')
      if (cancelled || !containerRef.current || mapRef.current) return
      moduleRef.current = maplibre
      maplibre.setWorkerUrl(workerUrl)
      const map = new maplibre.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [-96, 38],
        zoom: 2,
        attributionControl: { compact: true }
      })
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
      map.on('load', () => setReady(true))
      mapRef.current = map
    })()
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      moduleRef.current = null
      markersRef.current = []
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const maplibre = moduleRef.current
    if (!map || !maplibre || !ready || sites.length === 0) return

    for (const marker of markersRef.current) marker.remove()
    markersRef.current = []

    // Scale pin size by budget so a glance shows which projects are the big ones.
    const maxBudget = Math.max(1, ...sites.map((s) => s.budgeted ?? 0))

    for (const site of sites) {
      const size =
        MIN_PIN + (MAX_PIN - MIN_PIN) * Math.sqrt(Math.max(0, site.budgeted ?? 0) / maxBudget)

      const el = document.createElement('button')
      el.type = 'button'
      el.className = `map-pin map-pin-${STATUS_CLASS[site.status]}${mode === 'single' ? ' map-pin-single' : ''}`
      el.style.width = `${Math.round(size)}px`
      el.style.height = `${Math.round(size)}px`
      el.setAttribute('aria-label', `${site.name} — ${STATUS_LABEL[site.status]}`)

      const budget =
        typeof site.budgeted === 'number' && site.budgeted > 0
          ? `<div class="map-pop-meta">Budget ${escapeHtml(formatMoney(site.budgeted, { compact: true }))}</div>`
          : ''

      const node = document.createElement('div')
      node.className = 'map-pop'
      node.innerHTML = `
        <div class="map-pop-name">${escapeHtml(site.name)}</div>
        <div class="map-pop-status map-pop-status-${STATUS_CLASS[site.status]}">${STATUS_LABEL[site.status]}</div>
        ${site.location ? `<div class="map-pop-meta">${escapeHtml(site.location)}</div>` : ''}
        ${budget}
      `
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'map-pop-open'
      open.textContent = 'Open project'
      open.addEventListener('click', () => selectRef.current?.(site.siteId))
      node.appendChild(open)

      const marker = new maplibre.Marker({ element: el, anchor: 'center' })
        .setLngLat([site.lng, site.lat])
        .setPopup(new maplibre.Popup({ offset: size / 2 + 6, closeButton: false }).setDOMContent(node))
        .addTo(map)

      markersRef.current.push(marker)
    }

    if (sites.length === 1 || mode === 'single') {
      map.easeTo({ center: [sites[0].lng, sites[0].lat], zoom: 13 })
    } else {
      const bounds = new maplibre.LngLatBounds()
      for (const site of sites) bounds.extend([site.lng, site.lat])
      map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 })
    }
  }, [sites, mode, ready])

  // MapLibre measures its container once; tell it when the box changes (e.g.
  // the map is inside a tab that was hidden when the page first rendered).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => mapRef.current?.resize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    // The height is handed to CSS so phones can cap it against the viewport.
    <div className="map-shell" style={{ '--map-h': `${height}px` } as CSSProperties}>
      <div className="map-canvas" ref={containerRef} />
    </div>
  )
}
