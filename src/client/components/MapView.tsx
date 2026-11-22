import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { FeatureCollection } from 'geojson'
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

/**
 * Ajax municipal ward boundaries (Town of Ajax, 2018), served as a plain static
 * asset so the geometry can be swapped — or joined by other Town GIS layers —
 * without a rebuild. Coordinates are already WGS84, MapLibre's native CRS.
 */
const WARDS_URL = '/geo/ajax-wards.geojson'
const WARD_SOURCE = 'cppi-wards'
const WARD_FILL = 'cppi-wards-fill'
const WARD_LINE = 'cppi-wards-line'
const WARD_LABEL = 'cppi-wards-label'
const WARD_LAYERS = [WARD_FILL, WARD_LINE, WARD_LABEL]

/** Fetch the ward geometry; a missing or malformed file just disables the overlay. */
async function fetchWards(): Promise<FeatureCollection | null> {
  try {
    const res = await fetch(WARDS_URL, { headers: { Accept: 'application/geo+json, application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as FeatureCollection
    return data?.type === 'FeatureCollection' && Array.isArray(data.features) ? data : null
  } catch {
    return null
  }
}

/** The extent of every ward, so the map can frame the Town when no project has a pin yet. */
function wardBounds(wards: FeatureCollection): [[number, number], [number, number]] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lng, lat] = coords as [number, number]
      minLng = Math.min(minLng, lng)
      minLat = Math.min(minLat, lat)
      maxLng = Math.max(maxLng, lng)
      maxLat = Math.max(maxLat, lat)
      return
    }
    if (Array.isArray(coords)) for (const child of coords) visit(child)
  }
  for (const feature of wards.features) {
    const geometry = feature.geometry as { coordinates?: unknown } | null
    if (geometry?.coordinates) visit(geometry.coordinates)
  }
  if (!Number.isFinite(minLng)) return null
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ]
}

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
  const [wardsOn, setWardsOn] = useState(true)
  const [hasWards, setHasWards] = useState(false)
  const wardBoundsRef = useRef<[[number, number], [number, number]] | null>(null)
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
      const wards = await fetchWards()
      if (cancelled || !containerRef.current || mapRef.current) return
      if (wards) {
        wardBoundsRef.current = wardBounds(wards)
        setHasWards(true)
      }
      const map = new maplibre.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [-79.02, 43.87],
        zoom: 11,
        attributionControl: { compact: true }
      })
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
      map.on('load', () => {
        // Wards are added first so project pins always draw on top of them.
        if (wards) {
          map.addSource(WARD_SOURCE, { type: 'geojson', data: wards, promoteId: 'WARD_NUM' })
          map.addLayer({
            id: WARD_FILL,
            type: 'fill',
            source: WARD_SOURCE,
            paint: {
              'fill-color': '#0f6b48',
              'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.15, 0.055]
            }
          })
          map.addLayer({
            id: WARD_LINE,
            type: 'line',
            source: WARD_SOURCE,
            paint: {
              'line-color': '#0f6b48',
              'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 1.1],
              'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.5]
            }
          })
          map.addLayer({
            id: WARD_LABEL,
            type: 'symbol',
            source: WARD_SOURCE,
            layout: {
              'text-field': ['concat', 'Ward ', ['to-string', ['get', 'WARD_NUM']]],
              'text-size': 11.5,
              'text-letter-spacing': 0.08
            },
            paint: {
              'text-color': '#12513a',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5
            }
          })

          // Highlight whichever ward the pointer is over.
          let hovered: string | number | null = null
          const clearHover = () => {
            if (hovered !== null) map.setFeatureState({ source: WARD_SOURCE, id: hovered }, { hover: false })
            hovered = null
          }
          map.on('mousemove', WARD_FILL, (event) => {
            const feature = event.features?.[0]
            if (!feature || feature.id === undefined) return
            map.getCanvas().style.cursor = 'pointer'
            if (feature.id === hovered) return
            clearHover()
            hovered = feature.id
            map.setFeatureState({ source: WARD_SOURCE, id: hovered }, { hover: true })
          })
          map.on('mouseleave', WARD_FILL, () => {
            map.getCanvas().style.cursor = ''
            clearHover()
          })
        }

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
    if (!source) return

    if (currentSites.length === 0) {
      void source.setData({ type: 'FeatureCollection', features: [] })
      // No pins yet — frame the Town instead so the ward overlay has context.
      const bounds = wardBoundsRef.current
      if (bounds) {
        const box = new maplibre.LngLatBounds(bounds[0], bounds[1])
        map.fitBounds(box, { padding: 40, duration: 0 })
      }
      return
    }

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

  // Show or hide the ward overlay from the on-map toggle.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const visibility = wardsOn ? 'visible' : 'none'
    for (const id of WARD_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    }
  }, [wardsOn, ready])

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
      {hasWards ? (
        <button
          type="button"
          className="map-ward-toggle"
          aria-pressed={wardsOn}
          onClick={() => setWardsOn((on) => !on)}
        >
          <span className="map-ward-swatch" aria-hidden="true" />
          Ward boundaries
        </button>
      ) : null}
    </div>
  )
}
