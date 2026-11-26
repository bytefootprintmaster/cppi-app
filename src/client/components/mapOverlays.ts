/**
 * Municipal open GIS layers drawn live from each town's public ArcGIS services.
 * The portal reads them directly rather than importing snapshots: the services
 * send `application/geo+json` with CORS enabled, so MapLibre can query them from
 * the browser and the map is never out of date. Oshawa is the exception — its
 * zoning arrives as a plain GeoJSON file the Town supplied, served as a static
 * asset beside the Ajax wards.
 *
 * One pack per municipality. The map shows the pack that matches a project's
 * town, so Ajax wards never draw over a Barrie job and vice versa.
 *
 * Each layer is one switchable overlay. `bbox` marks the layers with too many
 * features to hold in the browser (address points, pipe runs) — those are queried
 * for the visible extent only, and `minZoom` keeps them off until the user is
 * zoomed in far enough for them to read.
 */

export type PlaceKey = 'ajax' | 'barrie' | 'milton' | 'cambridge' | 'oshawa'

export const OVERLAY_GROUPS = ['Planning', 'Parks & trails', 'Infrastructure', 'Context'] as const
export type OverlayGroup = (typeof OVERLAY_GROUPS)[number]

export interface OverlayLayerConfig {
  /** Source and layer id base; the renderer appends `-fill`/`-line`/`-circle`/`-label`. */
  id: string
  group: OverlayGroup
  /** Toggle label. */
  label: string
  kind: 'fill' | 'line' | 'circle'
  color: string
  /**
   * An ArcGIS layer's `.../MapServer/<n>` endpoint (the renderer appends
   * `/query`), or — when `static` is set — the path to a served GeoJSON file.
   */
  url: string
  /** The `url` is a plain GeoJSON file, not an ArcGIS query endpoint. */
  static?: boolean
  /** Feature id property for hover state; ArcGIS results id themselves. */
  promoteId?: string
  /** Property to label with; the label layer is only drawn above `labelMinZoom`. */
  labelField?: string
  labelMinZoom?: number
  /** Layer stays hidden (and unqueried) below this zoom. */
  minZoom?: number
  /** Query only the visible extent, refreshing as the map moves. */
  bbox?: boolean
  /** Switched on when the map first shows this municipality. */
  defaultOn?: boolean
  /** Dashed stroke, in line-widths. */
  dash?: number[]
  /** Point radius, in pixels. */
  radius?: number
  fillOpacity?: number
}

export interface OverlayPack {
  /** Extent in WGS84, used to frame an empty project map. */
  bounds: [[number, number], [number, number]]
  layers: OverlayLayerConfig[]
}

/** The Town of Ajax's published layers, all under one MapServer. */
const AJAX = 'https://ajaxmaps.ajax.ca/gisernie/rest/services/Public/Ajax_Open_Data/MapServer'

/** The City of Barrie's published layers, split across themed services. */
const BARRIE = 'https://gispublic.barrie.ca/arcgis/rest/services/Open_Data'

/** The Town of Milton's published layers, all under one ArcGIS Server. */
const MILTON = 'https://api.milton.ca/arcgis/rest/services'

/** Cambridge's layers: the City's own server, plus hosted services on ArcGIS Online. */
const CAMBRIDGE = 'https://maps.cambridge.ca/arcgispub03/rest/services'
const CAMBRIDGE_HOST = 'https://services5.arcgis.com/LTaPSxJTf948f8sm/arcgis/rest/services'

export const OVERLAY_PACKS: Record<PlaceKey, OverlayPack> = {
  ajax: {
    // The Town's extent, so an empty Ajax map frames it.
    bounds: [
      [-79.0909, 43.8147],
      [-78.9678, 43.9237]
    ],
    layers: [
      /* ------------------------------- planning ------------------------------ */
      {
        id: 'ajax-zoning',
        group: 'Planning',
        label: 'Zoning By-Law',
        kind: 'fill',
        color: '#6d28d9',
        url: `${AJAX}/16`, // Zoning (1,053 polygons)
        labelField: 'ZONE_',
        labelMinZoom: 13.5,
        fillOpacity: 0.26,
        defaultOn: true
      },
      {
        id: 'ajax-op-landuse',
        group: 'Planning',
        label: 'Official Plan land use',
        kind: 'fill',
        color: '#a21caf',
        url: `${AJAX}/15`, // Official Plan Land Use designations (356)
        labelField: 'OP_DESIG',
        labelMinZoom: 13,
        fillOpacity: 0.2
      },

      /* ---------------------------- parks & trails ---------------------------- */
      {
        id: 'ajax-parks',
        group: 'Parks & trails',
        label: 'Parks',
        kind: 'fill',
        color: '#15803d',
        url: `${AJAX}/22`, // Ajax Parks (132)
        labelField: 'NAME',
        labelMinZoom: 14,
        fillOpacity: 0.3,
        defaultOn: true
      },
      {
        id: 'ajax-trails',
        group: 'Parks & trails',
        label: 'Trails',
        kind: 'line',
        color: '#65a30d',
        url: `${AJAX}/14`, // Ajax Recreational Trails (645)
        labelField: 'NAME',
        labelMinZoom: 15,
        dash: [2, 1.4]
      },
      {
        id: 'ajax-waterbodies',
        group: 'Parks & trails',
        label: 'Waterbodies',
        kind: 'line',
        color: '#0284c7',
        url: `${AJAX}/13` // Waterbodies (3,150)
      },

      /* ---------------------------- infrastructure ---------------------------- */
      {
        id: 'ajax-swm-ponds',
        group: 'Infrastructure',
        label: 'Stormwater ponds',
        kind: 'fill',
        color: '#0d9488',
        url: `${AJAX}/20`, // Storm Water Management Pond (65)
        labelField: 'POND_NAME',
        labelMinZoom: 14,
        fillOpacity: 0.3
      },
      {
        id: 'ajax-town-facilities',
        group: 'Infrastructure',
        label: 'Town facilities',
        kind: 'fill',
        color: '#0e7490',
        url: `${AJAX}/21`, // Town Facilities (56)
        labelField: 'NAME',
        labelMinZoom: 14,
        fillOpacity: 0.28
      },

      /* -------------------------------- context -------------------------------- */
      {
        id: 'ajax-address',
        group: 'Context',
        label: 'Address points',
        kind: 'circle',
        color: '#64748b',
        url: `${AJAX}/10`, // Ajax Address Points (38,444)
        labelField: 'ADDRESS',
        labelMinZoom: 17,
        minZoom: 16,
        radius: 2.2,
        bbox: true
      },
      {
        id: 'ajax-heritage',
        group: 'Context',
        label: 'Heritage inventory',
        kind: 'circle',
        color: '#be185d',
        url: `${AJAX}/2`, // Heritage Inventory (257)
        labelField: 'ADDRESS',
        labelMinZoom: 15,
        radius: 4
      },
      {
        id: 'ajax-cultural',
        group: 'Context',
        label: 'Cultural inventory',
        kind: 'circle',
        color: '#9333ea',
        url: `${AJAX}/0`, // Cultural Inventory (254)
        labelField: 'NAME',
        labelMinZoom: 15,
        radius: 4
      }
    ]
  },

  barrie: {
    // The City's extent, so an empty Barrie map frames it.
    bounds: [
      [-79.7607, 44.2921],
      [-79.5835, 44.4509]
    ],
    layers: [
      /* ------------------------------- planning ------------------------------ */
      {
        id: 'barrie-zoning',
        group: 'Planning',
        label: 'Zoning By-Law',
        kind: 'fill',
        color: '#6d28d9',
        url: `${BARRIE}/Planning/MapServer/0`, // In Force Zoning By-Law (4,330)
        labelField: 'LABEL',
        labelMinZoom: 13.5,
        fillOpacity: 0.26,
        defaultOn: true
      },
      {
        id: 'barrie-op-landuse',
        group: 'Planning',
        label: 'Official Plan land use',
        kind: 'fill',
        color: '#a21caf',
        url: `${BARRIE}/LandUsePlanning_OfficialPlan/MapServer/10`, // Land Use (2,233)
        labelField: 'LABEL',
        labelMinZoom: 13,
        fillOpacity: 0.2
      },

      /* ---------------------------- parks & trails ---------------------------- */
      {
        id: 'barrie-parks',
        group: 'Parks & trails',
        label: 'Parks',
        kind: 'fill',
        color: '#15803d',
        url: `${BARRIE}/FacilitiesStreets/MapServer/32`, // Park parcels (140)
        labelField: 'NAME',
        labelMinZoom: 14,
        fillOpacity: 0.3,
        defaultOn: true
      },
      {
        id: 'barrie-trails',
        group: 'Parks & trails',
        label: 'Trails',
        kind: 'line',
        color: '#65a30d',
        url: `${BARRIE}/Trail/MapServer/0`, // Trail segments (2,594)
        dash: [2, 1.4]
      },

      /* ---------------------------- infrastructure ---------------------------- */
      {
        id: 'barrie-water',
        group: 'Infrastructure',
        label: 'Water mains',
        kind: 'line',
        color: '#2563eb',
        url: `${BARRIE}/WaterInfrastructure/MapServer/7`, // Water Main (6,107)
        minZoom: 14,
        bbox: true
      },
      {
        id: 'barrie-sanitary',
        group: 'Infrastructure',
        label: 'Sanitary pipes',
        kind: 'line',
        color: '#dc2626',
        url: `${BARRIE}/SanitaryInfrastructure/MapServer/2`, // Sanitary Pipe (9,235)
        minZoom: 14,
        bbox: true
      },
      {
        id: 'barrie-storm',
        group: 'Infrastructure',
        label: 'Storm sewers',
        kind: 'line',
        color: '#0d9488',
        url: `${BARRIE}/StormInfrastructure/MapServer/1`, // Storm Linear (12,075)
        minZoom: 14,
        bbox: true
      },

      /* -------------------------------- context -------------------------------- */
      {
        id: 'barrie-address',
        group: 'Context',
        label: 'Address points',
        kind: 'circle',
        color: '#64748b',
        url: `${BARRIE}/AddressVW/MapServer/0`, // Address VW (60,914)
        labelField: 'FULLADDR',
        labelMinZoom: 17,
        minZoom: 16,
        radius: 2.2,
        bbox: true
      },
      {
        id: 'barrie-roads',
        group: 'Context',
        label: 'Road segments',
        kind: 'line',
        color: '#475569',
        url: `${BARRIE}/FacilitiesStreets/MapServer/10`, // Road Segment (3,644)
        labelField: 'FULLNAME',
        labelMinZoom: 15,
        minZoom: 13
      },
      {
        id: 'barrie-road-polygons',
        group: 'Context',
        label: 'Road polygons',
        kind: 'fill',
        color: '#94a3b8',
        url: `${BARRIE}/ExternalData/MapServer/5`, // Road Polygon 2016 (5,321)
        fillOpacity: 0.16
      },
      {
        id: 'barrie-heritage',
        group: 'Context',
        label: 'Cultural heritage',
        kind: 'circle',
        color: '#be185d',
        url: `${BARRIE}/FacilitiesStreets/MapServer/0`, // Cultural Heritage (94)
        labelField: 'TITLE',
        labelMinZoom: 15,
        radius: 4.5
      }
    ]
  },

  milton: {
    // The Town's extent, so an empty Milton map frames it.
    bounds: [
      [-80.161, 43.4172],
      [-79.7249, 43.6289]
    ],
    layers: [
      /* ------------------------------- planning ------------------------------ */
      {
        id: 'milton-zoning-urban',
        group: 'Planning',
        label: 'Urban zoning',
        kind: 'fill',
        color: '#6d28d9',
        url: `${MILTON}/WebMaps/UrbanZoning_202512171429/MapServer/8`, // Urban Zoning (2,543)
        labelField: 'LABEL',
        labelMinZoom: 13.5,
        fillOpacity: 0.26,
        defaultOn: true
      },
      {
        id: 'milton-zoning-rural',
        group: 'Planning',
        label: 'Rural zoning',
        kind: 'fill',
        color: '#7c3aed',
        url: `${MILTON}/WebMaps/RuralZoning/MapServer/9`, // Rural Zoning (533)
        labelField: 'LABEL',
        labelMinZoom: 13.5,
        fillOpacity: 0.24
      },

      /* ---------------------------- parks & trails ---------------------------- */
      {
        id: 'milton-parks',
        group: 'Parks & trails',
        label: 'Parks',
        kind: 'fill',
        color: '#15803d',
        url: `${MILTON}/Datasets/Parks/MapServer/0`, // Parks (94)
        labelField: 'NAME',
        labelMinZoom: 14,
        fillOpacity: 0.3,
        defaultOn: true
      },
      {
        id: 'milton-trails',
        group: 'Parks & trails',
        label: 'Trails',
        kind: 'line',
        color: '#65a30d',
        url: `${MILTON}/Datasets/Trails/MapServer/0`, // Trails (2,107)
        dash: [2, 1.4]
      },
      {
        id: 'milton-park-amenities',
        group: 'Parks & trails',
        label: 'Park amenities',
        kind: 'circle',
        color: '#16a34a',
        url: `${MILTON}/Datasets/Park_Amenities/MapServer/0`,
        labelField: 'NAME',
        labelMinZoom: 16,
        radius: 3.5
      },

      /* ---------------------------- infrastructure ---------------------------- */
      {
        id: 'milton-facilities',
        group: 'Infrastructure',
        label: 'Town facilities',
        kind: 'circle',
        color: '#0e7490',
        url: `${MILTON}/Datasets/Town_Facilities/MapServer/0`, // Town Facilities (19)
        labelField: 'NAME',
        labelMinZoom: 15,
        radius: 4.5
      },

      /* -------------------------------- context -------------------------------- */
      {
        id: 'milton-address',
        group: 'Context',
        label: 'Address points',
        kind: 'circle',
        color: '#64748b',
        url: `${MILTON}/Datasets/Address_Pts/MapServer/0`, // Address Points (46,476)
        labelField: 'DISPLAY_NAME',
        labelMinZoom: 17,
        minZoom: 16,
        radius: 2.2,
        bbox: true
      },
      {
        id: 'milton-wards',
        group: 'Context',
        label: 'Ward boundaries',
        kind: 'fill',
        color: '#0f6b48',
        url: `${MILTON}/Datasets/Wards/MapServer/0`, // Wards (4)
        labelField: 'Name',
        labelMinZoom: 11,
        fillOpacity: 0.05
      },
      {
        id: 'milton-roads',
        group: 'Context',
        label: 'Road segments',
        kind: 'line',
        color: '#475569',
        url: `${MILTON}/Datasets/Roads/MapServer/0`, // Roads (3,344)
        labelField: 'STREET_NAME',
        labelMinZoom: 15,
        minZoom: 13
      },
      {
        id: 'milton-heritage',
        group: 'Context',
        label: 'Designated heritage',
        kind: 'circle',
        color: '#be185d',
        url: `${MILTON}/Datasets/HeritageProperties/MapServer/0`, // Heritage Properties (978)
        labelMinZoom: 15,
        radius: 4
      },
      {
        id: 'milton-schools',
        group: 'Context',
        label: 'Schools',
        kind: 'circle',
        color: '#b45309',
        url: `${MILTON}/Datasets/Schools/MapServer/0`, // Schools (36)
        labelField: 'NAME',
        labelMinZoom: 15,
        radius: 4
      }
    ]
  },

  cambridge: {
    // The City's extent, so an empty Cambridge map frames it.
    bounds: [
      [-80.4131, 43.3323],
      [-80.2509, 43.4721]
    ],
    layers: [
      /* ------------------------------- planning ------------------------------ */
      {
        id: 'cambridge-zoning',
        group: 'Planning',
        label: 'Zoning By-Law',
        kind: 'fill',
        color: '#6d28d9',
        url: `${CAMBRIDGE_HOST}/HybridZoningBylaw/FeatureServer/0`, // Hybrid Zoning Bylaw (4,534)
        labelField: 'MAP_LABEL',
        labelMinZoom: 14,
        fillOpacity: 0.26,
        defaultOn: true
      },
      {
        id: 'cambridge-op-landuse',
        group: 'Planning',
        label: 'Official Plan land use',
        kind: 'fill',
        color: '#a21caf',
        url: `${CAMBRIDGE_HOST}/Landuse_2012/FeatureServer/0`, // Land Use 2012 (427)
        labelField: 'OP_LAND_USE_CATEGORY',
        labelMinZoom: 13.5,
        fillOpacity: 0.2
      },
      {
        id: 'cambridge-secondary-plans',
        group: 'Planning',
        label: 'Secondary plans',
        kind: 'fill',
        color: '#7c3aed',
        url: `${CAMBRIDGE_HOST}/Secondary%20Plans/FeatureServer/0`, // Secondary Plans (4)
        labelField: 'NAME',
        labelMinZoom: 12.5,
        fillOpacity: 0.12
      },
      {
        id: 'cambridge-oz-amendments',
        group: 'Planning',
        label: 'OP & zoning amendments',
        kind: 'fill',
        color: '#db2777',
        url: `${CAMBRIDGE_HOST}/OZ/FeatureServer/0`, // OP & Zoning Bylaw Amendments (214)
        labelField: 'REFERENCEFILE',
        labelMinZoom: 15,
        fillOpacity: 0.24
      },

      /* ---------------------------- parks & trails ---------------------------- */
      {
        id: 'cambridge-parks',
        group: 'Parks & trails',
        label: 'Parks',
        kind: 'fill',
        color: '#15803d',
        url: `${CAMBRIDGE}/OpenData1/MapServer/6`, // Parks (243)
        labelField: 'PARK_NAME',
        labelMinZoom: 14,
        fillOpacity: 0.3,
        defaultOn: true
      },
      {
        id: 'cambridge-trails',
        group: 'Parks & trails',
        label: 'Trails',
        kind: 'line',
        color: '#65a30d',
        url: `${CAMBRIDGE}/OpenData1/MapServer/11`, // Trails (1,961)
        labelField: 'TRAIL_NAME',
        labelMinZoom: 15,
        dash: [2, 1.4]
      },
      {
        id: 'cambridge-bikeway',
        group: 'Parks & trails',
        label: 'Bikeway network',
        kind: 'line',
        color: '#0891b2',
        url: `${CAMBRIDGE}/OpenData3/MapServer/2`, // Bikeway Network (1,541)
        labelField: 'NAME',
        labelMinZoom: 15,
        dash: [1.4, 1.4]
      },

      /* ---------------------------- infrastructure ---------------------------- */
      {
        id: 'cambridge-water',
        group: 'Infrastructure',
        label: 'Water mains',
        kind: 'line',
        color: '#2563eb',
        url: `${CAMBRIDGE_HOST}/WaterPipe/FeatureServer/0`, // Water Pipe (14,352)
        minZoom: 14,
        bbox: true
      },

      /* -------------------------------- context -------------------------------- */
      {
        id: 'cambridge-address',
        group: 'Context',
        label: 'Address points',
        kind: 'circle',
        color: '#64748b',
        url: `${CAMBRIDGE_HOST}/AddressPoints/FeatureServer/0`, // Address Points (54,083)
        labelField: 'ADDRESS_LABEL',
        labelMinZoom: 17,
        minZoom: 16,
        radius: 2.2,
        bbox: true
      },
      {
        id: 'cambridge-heritage',
        group: 'Context',
        label: 'Heritage parcels',
        kind: 'fill',
        color: '#be185d',
        url: `${CAMBRIDGE_HOST}/HeritageParcels/FeatureServer/0`, // Heritage Parcels (1,161)
        labelField: 'STREET_NAME',
        labelMinZoom: 16,
        fillOpacity: 0.22
      },
      {
        id: 'cambridge-roads',
        group: 'Context',
        label: 'Road segments',
        kind: 'line',
        color: '#475569',
        url: `${CAMBRIDGE_HOST}/Roads/FeatureServer/0`, // Roads (3,981)
        labelField: 'STREET_NAME',
        labelMinZoom: 15,
        minZoom: 13
      },
      {
        id: 'cambridge-wards',
        group: 'Context',
        label: 'Ward boundaries',
        kind: 'fill',
        color: '#0f6b48',
        url: `${CAMBRIDGE}/OpenData2/MapServer/20`, // Wards (8)
        labelField: 'MAP_LABEL',
        labelMinZoom: 11,
        fillOpacity: 0.05
      },
      {
        id: 'cambridge-planning-neighbourhoods',
        group: 'Context',
        label: 'Planning neighbourhoods',
        kind: 'fill',
        color: '#b45309',
        url: `${CAMBRIDGE}/OpenData1/MapServer/18`, // Planning Neighbourhoods (38)
        labelField: 'NHOOD_NAME',
        labelMinZoom: 12.4,
        fillOpacity: 0.04
      }
    ]
  },

  oshawa: {
    // The City's extent, so an empty Oshawa map frames it.
    bounds: [
      [-78.9585, 43.8501],
      [-78.7963, 44.0473]
    ],
    layers: [
      /* ------------------------------- planning ------------------------------ */
      {
        id: 'oshawa-zoning',
        group: 'Planning',
        label: 'Zoning By-Law',
        kind: 'fill',
        color: '#6d28d9',
        // A GeoJSON file the City supplied, served beside the Ajax overlays.
        url: '/geo/oshawa-zoning.geojson', // Zoning (2,461 polygons)
        static: true,
        promoteId: 'OBJECTID_1',
        labelField: 'DESCRIPTION',
        labelMinZoom: 13.5,
        fillOpacity: 0.26,
        defaultOn: true
      }
    ]
  }
}
