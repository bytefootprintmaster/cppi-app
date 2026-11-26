import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { FeatureCollection } from 'geojson'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  OVERLAY_GROUPS,
  OVERLAY_PACKS,
  type OverlayLayerConfig,
  type OverlayPack,
  type PlaceKey
} from './mapOverlays'
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
  /** Town/city the project sits in, used to pick which municipal overlays to show. */
  city?: string
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

/**
 * Which municipality's overlays a set of projects calls for. The portal holds
 * data for several towns, so the map shows the pack that matches the pins — and
 * falls back to Ajax when nothing matches, which is how the map behaved before
 * any other town existed.
 */
function placeOf(site: MapSite): PlaceKey | null {
  const where = `${site.city ?? ''} ${site.location ?? ''}`.toLowerCase()
  if (/\bajax\b/.test(where)) return 'ajax'
  if (/\bbarrie\b/.test(where)) return 'barrie'
  if (/\bmilton\b/.test(where)) return 'milton'
  if (/\bcambridge\b/.test(where)) return 'cambridge'
  if (/\boshawa\b/.test(where)) return 'oshawa'
  return null
}

function detectPlace(sites: MapSite[]): PlaceKey {
  for (const site of sites) {
    const match = placeOf(site)
    if (match) return match
  }
  return 'ajax'
}

/** The renderer's layer ids for one overlay, so add/show/hide agree on names. */
function overlayLayerIds(cfg: OverlayLayerConfig): string[] {
  const ids =
    cfg.kind === 'fill'
      ? [`${cfg.id}-fill`, `${cfg.id}-line`]
      : cfg.kind === 'line'
        ? [`${cfg.id}-line`]
        : [`${cfg.id}-circle`]
  if (cfg.labelField) ids.push(`${cfg.id}-label`)
  return ids
}

/** ArcGIS caps a response at 1,000 features; a full load pages through them. */
const ARCGIS_PAGE = 1000
const ARCGIS_MAX_PAGES = 40

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Read one overlay layer. A static file is read whole; ArcGIS layers are paged
 * in full, or — with `bounds` — asked for just the features inside the current
 * view, which is what keeps the pipe networks and the tens of thousands of
 * address points affordable to draw live.
 */
async function fetchOverlayLayer(
  cfg: OverlayLayerConfig,
  bounds?: [[number, number], [number, number]]
): Promise<FeatureCollection> {
  if (cfg.static) {
    const data = await fetchGeo(cfg.url)
    return data ?? EMPTY_FC
  }
  const url = cfg.url
  const headers = { Accept: 'application/geo+json, application/json' }
  try {
    if (bounds) {
      const params = new URLSearchParams({
        where: '1=1',
        geometry: `${bounds[0][0]},${bounds[0][1]},${bounds[1][0]},${bounds[1][1]}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        outSR: '4326',
        f: 'geojson',
        resultRecordCount: String(ARCGIS_PAGE)
      })
      const res = await fetch(`${url}/query?${params}`, { headers })
      if (!res.ok) return EMPTY_FC
      const data = (await res.json()) as FeatureCollection
      return data?.type === 'FeatureCollection' ? data : EMPTY_FC
    }
    const features: FeatureCollection['features'] = []
    for (let page = 0; page < ARCGIS_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        outSR: '4326',
        f: 'geojson',
        resultOffset: String(features.length),
        resultRecordCount: String(ARCGIS_PAGE)
      })
      const res = await fetch(`${url}/query?${params}`, { headers })
      if (!res.ok) break
      const data = (await res.json()) as FeatureCollection
      const batch = Array.isArray(data?.features) ? data.features : []
      features.push(...batch)
      if (batch.length < ARCGIS_PAGE) break
    }
    return { type: 'FeatureCollection', features }
  } catch {
    return EMPTY_FC
  }
}

/**
 * Add a municipality's layers to the map, empty and hidden. Sources exist up
 * front so switching packs later only flips visibility — no add/remove churn
 * mid-view.
 */
function addOverlays(map: MapLibreMap, maplibre: MapLibre, pack: OverlayPack): void {
  const hover: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false]
  for (const cfg of pack.layers) {
    map.addSource(cfg.id, {
      type: 'geojson',
      data: EMPTY_FC,
      promoteId: cfg.promoteId ?? 'OBJECTID'
    })

    if (cfg.kind === 'fill') {
      map.addLayer({
        id: `${cfg.id}-fill`,
        type: 'fill',
        source: cfg.id,
        minzoom: cfg.minZoom,
        paint: {
          'fill-color': cfg.color,
          'fill-opacity': ['case', hover, Math.min((cfg.fillOpacity ?? 0.25) + 0.14, 0.7), cfg.fillOpacity ?? 0.25]
        }
      })
      map.addLayer({
        id: `${cfg.id}-line`,
        type: 'line',
        source: cfg.id,
        minzoom: cfg.minZoom,
        paint: {
          'line-color': cfg.color,
          'line-width': ['case', hover, 1.8, 0.8],
          'line-opacity': ['case', hover, 0.95, 0.5]
        }
      })
      bindHover(map, cfg.id, `${cfg.id}-fill`)
    } else if (cfg.kind === 'line') {
      map.addLayer({
        id: `${cfg.id}-line`,
        type: 'line',
        source: cfg.id,
        minzoom: cfg.minZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': cfg.color,
          'line-width': ['case', hover, 2.6, 1.4],
          'line-opacity': 0.85,
          ...(cfg.dash ? { 'line-dasharray': cfg.dash } : {})
        }
      })
      const target = `${cfg.id}-line`
      map.on('mouseenter', target, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', target, () => {
        map.getCanvas().style.cursor = ''
      })
    } else {
      map.addLayer({
        id: `${cfg.id}-circle`,
        type: 'circle',
        source: cfg.id,
        minzoom: cfg.minZoom,
        paint: {
          'circle-color': cfg.color,
          'circle-radius': ['case', hover, (cfg.radius ?? 3) + 1.5, cfg.radius ?? 3],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1
        }
      })
      bindHover(map, cfg.id, `${cfg.id}-circle`)
    }

    if (cfg.labelField) {
      const field = cfg.labelField
      map.addLayer({
        id: `${cfg.id}-label`,
        type: 'symbol',
        source: cfg.id,
        minzoom: cfg.labelMinZoom ?? 14,
        layout: {
          'text-field': ['coalesce', ['get', field], ''],
          'text-size': 10.5,
          'text-max-width': 9
        },
        paint: { 'text-color': cfg.color, 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 }
      })
      const target =
        cfg.kind === 'fill' ? `${cfg.id}-fill` : cfg.kind === 'line' ? `${cfg.id}-line` : `${cfg.id}-circle`
      map.on('click', target, (event) => {
        const value = String(event.features?.[0]?.properties?.[field] ?? '').trim()
        if (!value) return
        const root = document.createElement('div')
        root.className = 'map-pop'
        const name = document.createElement('div')
        name.className = 'map-pop-name'
        name.textContent = value
        const meta = document.createElement('div')
        meta.className = 'map-pop-meta'
        meta.textContent = cfg.label
        root.append(name, meta)
        new maplibre.Popup({ offset: 12, closeButton: true })
          .setLngLat(event.lngLat)
          .setDOMContent(root)
          .addTo(map)
      })
    }

    for (const id of overlayLayerIds(cfg)) map.setLayoutProperty(id, 'visibility', 'none')
  }
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

  // Which municipality's overlays the pins call for: Ajax today, Barrie when a
  // project sits there. Defaults to Ajax so maps with no located pins are unchanged.
  const place = useMemo(() => detectPlace(sites), [siteSignature])
  const pack = OVERLAY_PACKS[place]
  // One toggle state spans both packs; the ids never collide, so a single record
  // survives a change of municipality without any extra bookkeeping.
  const [overlayOn, setOverlayOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      [...OVERLAY_PACKS.ajax.layers, ...OVERLAY_PACKS.barrie.layers].map((layer) => [
        layer.id,
        layer.defaultOn === true
      ])
    )
  )
  const overlayOnSig = JSON.stringify(overlayOn)
  /** Layers whose full geometry has already been fetched, so a re-toggle is free. */
  const overlayLoadedRef = useRef<Set<string>>(new Set())

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
      // Ajax's wards and neighbourhoods are static files, so they are only worth
      // loading when the map is showing Ajax; every other town draws its layers
      // straight from its own server.
      const startPlace = detectPlace(sitesRef.current)
      const [wards, neighbourhoods] =
        startPlace === 'ajax'
          ? await Promise.all([fetchGeo(WARDS_URL), fetchGeo(NEIGHBOURHOODS_URL)])
          : [null, null]
      if (cancelled || !containerRef.current || mapRef.current) return
      // Wards cover the whole Town, so they frame it; neighbourhoods are the fallback.
      overlayBoundsRef.current =
        (wards ? geoBounds(wards) : null) ?? (neighbourhoods ? geoBounds(neighbourhoods) : null)
      if (wards) setHasWards(true)
      if (neighbourhoods) setHasNeighbourhoods(true)
      // Open on the middle of the town whose overlays are about to draw.
      const startBounds = OVERLAY_PACKS[startPlace].bounds
      const map = new maplibre.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [
          (startBounds[0][0] + startBounds[1][0]) / 2,
          (startBounds[0][1] + startBounds[1][1]) / 2
        ],
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

        // The pins' town's live layers, added hidden so the toggles only flip visibility.
        addOverlays(map, maplibre, OVERLAY_PACKS[startPlace])

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
      // No pins yet — frame the municipality instead so the overlays have context.
      const bounds = overlayBoundsRef.current ?? pack.bounds
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
  }, [siteSignature, mode, ready, place])

  // Show or hide each overlay from the on-map toggles. Only the pack matching the
  // pins is ever visible: Ajax wards never draw over a Barrie project, and vice versa.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const ajaxActive = place === 'ajax'
    for (const id of WARD_LAYERS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', ajaxActive && wardsOn ? 'visible' : 'none')
      }
    }
    for (const id of NEIGHBOURHOOD_LAYERS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', ajaxActive && neighbourhoodsOn ? 'visible' : 'none')
      }
    }
  }, [wardsOn, neighbourhoodsOn, place, ready])

  // Each overlay's visibility follows its own toggle. Only the current pack's
  // layers exist on the map, so the other town's pack is never drawn.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const cfg of pack.layers) {
      const visible = overlayOn[cfg.id] === true
      for (const id of overlayLayerIds(cfg)) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      }
    }
  }, [place, overlayOnSig, ready])

  // Load whichever layers are on. Full layers fetch once and are cached; the
  // heavy ones re-query the visible extent as the map settles.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let cancelled = false
    const load = async () => {
      for (const cfg of pack.layers) {
        if (overlayOn[cfg.id] !== true) continue
        if (map.getZoom() < (cfg.minZoom ?? 0)) continue
        if (!cfg.bbox && overlayLoadedRef.current.has(cfg.id)) continue
        if (cfg.bbox) {
          const b = map.getBounds()
          const bounds: [[number, number], [number, number]] = [
            [b.getWest(), b.getSouth()],
            [b.getEast(), b.getNorth()]
          ]
          const data = await fetchOverlayLayer(cfg, bounds)
          if (cancelled) return
          ;(map.getSource(cfg.id) as GeoJSONSource | undefined)?.setData(data)
        } else {
          const data = await fetchOverlayLayer(cfg)
          if (cancelled) return
          overlayLoadedRef.current.add(cfg.id)
          ;(map.getSource(cfg.id) as GeoJSONSource | undefined)?.setData(data)
        }
      }
    }
    void load()
    const onMove = () => void load()
    map.on('moveend', onMove)
    return () => {
      cancelled = true
      map.off('moveend', onMove)
    }
  }, [place, overlayOnSig, ready])

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
      <div className="map-layer-toggles">
        {OVERLAY_GROUPS.map((group) => {
          const layers = pack.layers.filter((layer) => layer.group === group)
          if (!layers.length) return null
          return (
            <div className="map-layer-section" key={group}>
              <div className="map-layer-group">{group}</div>
              {layers.map((layer) => (
                <button
                  key={layer.id}
                  type="button"
                  className="map-layer-toggle"
                  aria-pressed={overlayOn[layer.id] === true}
                  onClick={() => setOverlayOn((on) => ({ ...on, [layer.id]: !on[layer.id] }))}
                >
                  <span
                    className="map-layer-swatch"
                    style={{
                      borderColor: layer.color,
                      background: `${layer.color}33`,
                      ...(layer.dash ? { borderStyle: 'dashed' } : {})
                    }}
                    aria-hidden="true"
                  />
                  {layer.label}
                </button>
              ))}
            </div>
          )
        })}
        {place === 'ajax' && (hasWards || hasNeighbourhoods) ? (
          <div className="map-layer-section">
            <div className="map-layer-group">Administration</div>
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
    </div>
  )
}
