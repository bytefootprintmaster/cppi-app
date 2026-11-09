import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'
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

const PROJECT_SOURCE = 'cppi-projects'

function popupContent(sites: MapSite[], onSelect?: (siteId: string) => void): HTMLElement {
  const root = document.createElement('div')
  root.className = 'map-pop'

  const heading = document.createElement('div')
  heading.className = 'map-pop-name'
  heading.textContent = sites.length === 1 ? sites[0].name : `${sites.length} projects at this location`
  root.appendChild(heading)

  for (const site of sites) {
    const item = document.createElement('div')
    item.className = 'map-pop-item'

    if (sites.length > 1) {
      const name = document.createElement('div')
      name.className = 'map-pop-item-name'
      name.textContent = site.name
      item.appendChild(name)
    }

    const status = document.createElement('div')
    status.className = `map-pop-status map-pop-status-${STATUS_CLASS[site.status]}`
    status.textContent = STATUS_LABEL[site.status]
    item.appendChild(status)

    if (site.location) {
      const location = document.createElement('div')
      location.className = 'map-pop-meta'
      location.textContent = site.location
      item.appendChild(location)
    }
    if (site.budgeted) {
      const budget = document.createElement('div')
      budget.className = 'map-pop-meta'
      budget.textContent = `Budget ${formatMoney(site.budgeted, { compact: true })}`
      item.appendChild(budget)
    }

    if (onSelect) {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'map-pop-open'
      open.textContent = 'Open project'
      open.addEventListener('click', () => onSelect(site.siteId))
      item.appendChild(open)
    }
    root.appendChild(item)
  }

  return root
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
 * A thin React wrapper around MapLibre GL JS. The clustered source keeps
 * co-located projects individually accessible instead of drawing pins on top
 * of each other.
 *
 * The library itself is imported on demand, so its weight is only paid on the
 * pages that actually show a map.
 */
export function MapView({ sites, mode = 'portfolio', height = 460, onSelect }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const moduleRef = useRef<MapLibre | null>(null)
  const sitesRef = useRef(sites)
  sitesRef.current = sites
  const [ready, setReady] = useState(false)
  const siteSignature = JSON.stringify(sites)

  // Keep the latest callback without forcing a redraw when the parent re-renders.
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect

  // Create the map and clustered layers once; the data effect updates features.
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
      map.on('load', () => {
        map.addSource(PROJECT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterRadius: 44,
          clusterMaxZoom: 14
        })
        map.addLayer({
          id: 'project-clusters',
          type: 'circle',
          source: PROJECT_SOURCE,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': '#0f6b48',
            'circle-radius': ['step', ['get', 'point_count'], 19, 5, 23, 15, 28],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
          }
        })
        map.addLayer({
          id: 'project-cluster-count',
          type: 'symbol',
          source: PROJECT_SOURCE,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 13
          },
          paint: { 'text-color': '#ffffff' }
        })
        map.addLayer({
          id: 'project-points',
          type: 'circle',
          source: PROJECT_SOURCE,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': [
              'match',
              ['get', 'status'],
              'planning', '#94a3b8',
              'in_progress', '#10935f',
              'on_hold', '#b45309',
              'completed', '#1d4ed8',
              '#10935f'
            ],
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['get', 'budgeted'],
              0, 9,
              100000, 12,
              1000000, 16,
              5000000, 20
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
          }
        })

        map.on('click', 'project-clusters', (event) => {
          const feature = event.features?.[0] as MapGeoJSONFeature | undefined
          if (!feature) return
          const clusterId = Number(feature.properties?.cluster_id)
          const coordinates = feature.geometry.type === 'Point' ? feature.geometry.coordinates : null
          const source = map.getSource(PROJECT_SOURCE) as GeoJSONSource
          if (!Number.isFinite(clusterId) || !coordinates) return
          void source.getClusterLeaves(clusterId, 100, 0).then((leaves) => {
            const projects = leaves
              .map((leaf) => leaf.properties as unknown as MapSite | null)
              .filter((site): site is MapSite => Boolean(site?.siteId))
            if (!projects.length) return
            new maplibre.Popup({ offset: 18, closeButton: true })
              .setLngLat(coordinates as [number, number])
              .setDOMContent(popupContent(projects, selectRef.current))
              .addTo(map)
          })
        })
        map.on('click', 'project-points', (event) => {
          const feature = event.features?.[0] as MapGeoJSONFeature | undefined
          if (!feature || feature.geometry.type !== 'Point') return
          const site = feature.properties as unknown as MapSite
          new maplibre.Popup({ offset: 18, closeButton: true })
            .setLngLat(feature.geometry.coordinates as [number, number])
            .setDOMContent(popupContent([site], selectRef.current))
            .addTo(map)
        })

        for (const layer of ['project-clusters', 'project-points']) {
          map.on('mouseenter', layer, () => {
            map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', layer, () => {
            map.getCanvas().style.cursor = ''
          })
        }
        setReady(true)
      })
      mapRef.current = map
    })()
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      moduleRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const maplibre = moduleRef.current
    if (!map || !maplibre || !ready) return
    const source = map.getSource(PROJECT_SOURCE) as GeoJSONSource | undefined
    const currentSites = sitesRef.current
    if (!source || currentSites.length === 0) return

    void source.setData({
      type: 'FeatureCollection',
      features: currentSites.map((site) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [site.lng, site.lat] },
        properties: {
          siteId: site.siteId,
          name: site.name,
          code: site.code ?? '',
          location: site.location ?? '',
          status: site.status,
          budgeted: site.budgeted ?? 0
        }
      }))
    })

    if (currentSites.length === 1 || mode === 'single') {
      map.easeTo({ center: [currentSites[0].lng, currentSites[0].lat], zoom: 13 })
    } else {
      const bounds = new maplibre.LngLatBounds()
      for (const site of currentSites) bounds.extend([site.lng, site.lat])
      map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 })
    }
  }, [siteSignature, mode, ready])

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
