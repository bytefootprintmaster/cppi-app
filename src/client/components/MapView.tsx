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
 * Town of Ajax GIS overlays, served as plain static assets so the geometry can be
 * swapped — or joined by further Town layers — without a rebuild. Both are
 * already WGS84 (CRS84), MapLibre's native CRS, so nothing is reprojected.
 *
 * Wards are the administrative boundaries (3 polygons); neighbourhoods are the
 * named community areas inside them (28 polygons). They are drawn in two hues and
 * two stroke styles — dashed amber over solid green — so both stay readable when
 * they are switched on together.
 */
const WARDS_URL = '/geo/ajax-wards.geojson'
const WARD_SOURCE = 'cppi-wards'
const WARD_FILL = 'cppi-wards-fill'
const WARD_LINE = 'cppi-wards-line'
const WARD_LABEL = 'cppi-wards-label'
const WARD_LAYERS = [WARD_FILL, WARD_LINE, WARD_LABEL]

const NEIGHBOURHOODS_URL = '/geo/ajax-neighbourhoods.geojson'
const NEIGHBOURHOOD_SOURCE = 'cppi-neighbourhoods'
const NEIGHBOURHOOD_FILL = 'cppi-neighbourhoods-fill'
const NEIGHBOURHOOD_LINE = 'cppi-neighbourhoods-line'
const NEIGHBOURHOOD_LABEL = 'cppi-neighbourhoods-label'
const NEIGHBOURHOOD_LAYERS = [NEIGHBOURHOOD_FILL, NEIGHBOURHOOD_LINE, NEIGHBOURHOOD_LABEL]

/** Overlay palette, kept beside the layers that paint it. */
const WARD_COLOR = '#0f6b48' // the portal's green-600
const NEIGHBOURHOOD_COLOR = '#b45309' // amber, distinct from every pin colour

/** Fetch one overlay; a missing or malformed file just disables that layer. */
async function fetchGeo(url: string): Promise<FeatureCollection | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as FeatureCollection
    return data?.type === 'FeatureCollection' && Array.isArray(data.features) ? data : null
  } catch {
    return null
  }
}

/** The extent of every polygon, so the map can frame the Town when no project has a pin. */
function geoBounds(collection: FeatureCollection): [[number, number], [number, number]] | null {
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
  for (const feature of collection.features) {
    const geometry = feature.geometry as { coordinates?: unknown } | null
    if (geometry?.coordinates) visit(geometry.coordinates)
  }
  if (!Number.isFinite(minLng)) return null
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ]
}

/** Highlight whichever polygon the pointer is over, for one overlay source. */
function bindHover(map: MapLibreMap, source: string, layer: string): void {
  let hovered: string | number | null = null
  const clear = () => {
    if (hovered !== null) map.setFeatureState({ source, id: hovered }, { hover: false })
    hovered = null
  }
  map.on('mousemove', layer, (event) => {
    const feature = event.features?.[0]
    if (!feature || feature.id === undefined) return
    map.getCanvas().style.cursor = 'pointer'
    if (feature.id === hovered) return
    clear()
    hovered = feature.id
    map.setFeatureState({ source, id: hovered }, { hover: true })
  })
  map.on('mouseleave', layer, () => {
    map.getCanvas().style.cursor = ''
    clear()
  })
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
  const [neighbourhoodsOn, setNeighbourhoodsOn] = useState(true)
  const [hasNeighbourhoods, setHasNeighbourhoods] = useState(false)
  const overlayBoundsRef = useRef<[[number, number], [number, number]] | null>(null)
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
      // Both overlays load together so the map is created once, with its extent known.
      const [wards, neighbourhoods] = await Promise.all([fetchGeo(WARDS_URL), fetchGeo(NEIGHBOURHOODS_URL)])
      if (cancelled || !containerRef.current || mapRef.current) return
      // Wards cover the whole Town, so they frame it; neighbourhoods are the fallback.
      overlayBoundsRef.current =
        (wards ? geoBounds(wards) : null) ?? (neighbourhoods ? geoBounds(neighbourhoods) : null)
      if (wards) setHasWards(true)
      if (neighbourhoods) setHasNeighbourhoods(true)
      const map = new maplibre.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [-79.02, 43.87],
        zoom: 11,
        attributionControl: { compact: true }
      })
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
      map.on('load', () => {
        // Overlays first so project pins always draw on top of them, and so the
        // administrative ward outline sits above the finer neighbourhood mesh.
        if (neighbourhoods) {
          map.addSource(NEIGHBOURHOOD_SOURCE, {
            type: 'geojson',
            data: neighbourhoods,
            promoteId: 'OBJECTID'
          })
          map.addLayer({
            id: NEIGHBOURHOOD_FILL,
            type: 'fill',
            source: NEIGHBOURHOOD_SOURCE,
            paint: {
              'fill-color': NEIGHBOURHOOD_COLOR,
              'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.11, 0.035]
            }
          })
          map.addLayer({
            id: NEIGHBOURHOOD_LINE,
            type: 'line',
            source: NEIGHBOURHOOD_SOURCE,
            paint: {
              'line-color': NEIGHBOURHOOD_COLOR,
              'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.9, 1],
              'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0.45],
              // Dashed, so a community area never reads as an administrative boundary.
              'line-dasharray': [2, 1.6]
            }
          })
          map.addLayer({
            id: NEIGHBOURHOOD_LABEL,
            type: 'symbol',
            source: NEIGHBOURHOOD_SOURCE,
            // 28 names would crowd the town at the default zoom, so they appear as
            // the user zooms in.
            minzoom: 12.4,
            layout: {
              'text-field': ['get', 'NAME'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 12.4, 10.5, 15, 12.5],
              'text-letter-spacing': 0.04,
              'text-max-width': 8,
              // Busier neighbourhoods win a label collision, so the map stays legible.
              'symbol-sort-key': ['-', 0, ['to-number', ['get', 'POP_2011'], 0]]
            },
            paint: {
              'text-color': '#7c3a06',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5
            }
          })
          bindHover(map, NEIGHBOURHOOD_SOURCE, NEIGHBOURHOOD_FILL)
        }

        if (wards) {
          map.addSource(WARD_SOURCE, { type: 'geojson', data: wards, promoteId: 'WARD_NUM' })
          map.addLayer({
            id: WARD_FILL,
            type: 'fill',
            source: WARD_SOURCE,
            paint: {
              'fill-color': WARD_COLOR,
              'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.15, 0.055]
            }
          })
          map.addLayer({
            id: WARD_LINE,
            type: 'line',
            source: WARD_SOURCE,
            paint: {
              'line-color': WARD_COLOR,
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
          bindHover(map, WARD_SOURCE, WARD_FILL)
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
      // No pins yet — frame the Town instead so the overlays have context.
      const bounds = overlayBoundsRef.current
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

  // Show or hide each overlay from the on-map toggles.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const id of WARD_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wardsOn ? 'visible' : 'none')
    }
    for (const id of NEIGHBOURHOOD_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', neighbourhoodsOn ? 'visible' : 'none')
    }
  }, [wardsOn, neighbourhoodsOn, ready])

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
      {hasWards || hasNeighbourhoods ? (
        <div className="map-layer-toggles">
          {hasWards ? (
            <button
              type="button"
              className="map-layer-toggle"
              aria-pressed={wardsOn}
              onClick={() => setWardsOn((on) => !on)}
            >
              <span className="map-layer-swatch" aria-hidden="true" />
              Ward boundaries
            </button>
          ) : null}
          {hasNeighbourhoods ? (
            <button
              type="button"
              className="map-layer-toggle map-layer-toggle-neigh"
              aria-pressed={neighbourhoodsOn}
              onClick={() => setNeighbourhoodsOn((on) => !on)}
            >
              <span className="map-layer-swatch" aria-hidden="true" />
              Neighbourhoods
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
