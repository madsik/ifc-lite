/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic alignment candidates (post-RTC)
 *
 * Goal:
 * - Keep RTC as a precision mechanism (GPU safety).
 * - Separately infer a "semantic" world transform per model (IfcSite/Building/Storey/WCS/MapConversion/etc).
 *
 * Conventions:
 * - All candidate transforms are expressed in **IFC coordinates** (Z-up).
 * - Units: **meters** (we apply IFC length-unit scale).
 * - Mat4 is **column-major** (WebGL style): elements m[0..15].
 *
 * Important: This module is an analyzer. It does NOT apply any transforms to geometry.
 */

export type Vec3 = { x: number; y: number; z: number }
export type Mat4 = Float64Array // length 16, column-major

export type CandidateSource =
  | 'ifc-map-conversion'
  | 'ifc-wcs'
  | 'ifc-site'
  | 'ifc-building'
  | 'ifc-storey-dominant'
  | 'geometry-anchor'

export interface SemanticCandidate {
  id: string
  source: CandidateSource
  /** Transform from IFC local model coords -> candidate "world" coords (IFC Z-up, meters). */
  T_ifc_to_world: Mat4
  /** Translation component (meters, IFC Z-up). */
  t: Vec3
  /** Yaw about +Z in degrees (best-effort; pitch/roll ignored). */
  yawDeg: number
  notes: string[]
}

export interface ScoreBreakdown {
  /** Base weight by candidate source (legacy name: sourceWeight). */
  sourceWeight: number
  /** Alias for sourceWeight to match reports (Phase 2.5). */
  baseWeight?: number
  completeness: number
  plausibility: number
  clusterBonus: number
  /** Penalty applied when candidate is far from all cluster centroids. */
  farPenalty?: number
  /** Penalty derived from plausibility-related penalty terms. */
  plausibilityPenalty?: number
  penalties: Array<{ id: string; amount: number; reason: string }>
  /** Final score in [0..1] (legacy name: total). */
  total: number
  /** Alias for total to match reports (Phase 2.5). */
  finalScore?: number
}

export interface RankedCandidate extends SemanticCandidate {
  score: number
  breakdown: ScoreBreakdown
  rejected?: { reason: string }
}

export interface FederationHint {
  /** Reference translation in IFC Z-up meters (e.g., best candidate from reference model). */
  referenceTranslationIfc?: Vec3
  /** Typical site-scale radius in meters used to compute cluster bonus. Default: 50m. */
  clusterSigmaM?: number
  /** Cluster centroids (IFC Z-up, meters). Used for multi-cluster proximity scoring. */
  clusterCentroidsIfc?: Vec3[]
  /** Sigma for cluster proximity in meters. Default: 50m. */
  clusterSigmaMeters?: number
  /** If true, cluster proximity bonus is emphasized vs referenceTranslationIfc. */
  preferCluster?: boolean
}

// Keep this minimal: only what we need from a parser-lite data store.
export interface IfcModelLike {
  source: Uint8Array
  entityIndex: {
    byId: Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>
    byType: Map<string, number[]>
  }
  spatialHierarchy?: {
    byStorey: Map<number, number[]>
  }
  /** Optional geometry-derived anchor (IFC coords, meters). */
  __geomAnchorIfc?: Vec3
}

const DEG = 180 / Math.PI

function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

function isFiniteVec3(a: Vec3 | null | undefined): a is Vec3 {
  return Boolean(a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z))
}

function len2(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function mat4Identity(): Mat4 {
  const m = new Float64Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  return m
}

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  // Column-major multiply: out = a * b
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0]
    const b1 = b[c * 4 + 1]
    const b2 = b[c * 4 + 2]
    const b3 = b[c * 4 + 3]
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return out
}

function mat4FromBasisAndTranslation(x: Vec3, y: Vec3, z: Vec3, t: Vec3): Mat4 {
  const m = new Float64Array(16)
  // Column 0 = X axis
  m[0] = x.x
  m[1] = x.y
  m[2] = x.z
  m[3] = 0
  // Column 1 = Y axis
  m[4] = y.x
  m[5] = y.y
  m[6] = y.z
  m[7] = 0
  // Column 2 = Z axis
  m[8] = z.x
  m[9] = z.y
  m[10] = z.z
  m[11] = 0
  // Column 3 = translation
  m[12] = t.x
  m[13] = t.y
  m[14] = t.z
  m[15] = 1
  return m
}

function mat4Translation(m: Mat4): Vec3 {
  return { x: m[12], y: m[13], z: m[14] }
}

function mat4YawDeg(m: Mat4): number {
  // Column-major rotation part:
  // X axis = (m[0], m[1], m[2])
  // Y axis = (m[4], m[5], m[6])
  // In Z-up, yaw is rotation around Z: atan2(xAxis.y, xAxis.x)
  const x0 = m[0]
  const x1 = m[1]
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return 0
  return Math.atan2(x1, x0) * DEG
}

function normalize(a: Vec3): Vec3 {
  const d2 = len2(a)
  if (!Number.isFinite(d2) || d2 <= 0) return { x: 0, y: 0, z: 0 }
  const inv = 1 / Math.sqrt(d2)
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

// --- IFC parsing helpers (on-demand) ---

type ParsedEntity = { expressId: number; type: string; attributes: any[] }

function getByTypeIds(model: IfcModelLike, ifcTypeUpper: string): number[] {
  return model.entityIndex.byType.get(ifcTypeUpper) ?? []
}

function getEntityRef(model: IfcModelLike, id: number) {
  return model.entityIndex.byId.get(id) ?? null
}

const _td = new TextDecoder()

/**
 * Parse a single STEP entity line on-demand from the source buffer.
 *
 * Output shape matches the parser's EntityExtractor enough for our needs:
 * - `type`: IFC entity type (e.g., "IFCLOCALPLACEMENT")
 * - `attributes`: parsed STEP attribute list (refs as numbers, lists as arrays, strings as JS strings)
 */
function parseEntityOnDemand(model: IfcModelLike, id: number): ParsedEntity | null {
  const ref = getEntityRef(model, id)
  if (!ref) return null
  try {
    const text = _td.decode(model.source.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength))
    // Parse: #ID = TYPE(attr1, attr2, ...)
    const match = text.match(/^#(\d+)\s*=\s*(\w+)\((.*)\)\s*;?\s*$/i)
    if (!match) return null
    const type = String(match[2] || '').trim()
    const paramsText = String(match[3] || '')
    const attributes = parseAttributeList(paramsText)
    return { expressId: id, type, attributes }
  } catch {
    return null
  }
}

function parseAttributeList(paramsText: string): any[] {
  if (!paramsText || !paramsText.trim()) return []
  const attributes: any[] = []
  let depth = 0
  let current = ''
  let inString = false

  for (let i = 0; i < paramsText.length; i++) {
    const ch = paramsText[i]
    if (ch === "'") {
      if (inString) {
        // STEP escaped quote: ''
        if (i + 1 < paramsText.length && paramsText[i + 1] === "'") {
          current += "''"
          i++
          continue
        }
        inString = false
      } else {
        inString = true
      }
      current += ch
      continue
    }
    if (inString) {
      current += ch
      continue
    }
    if (ch === '(') {
      depth++
      current += ch
      continue
    }
    if (ch === ')') {
      depth--
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      attributes.push(parseAttributeValue(current.trim()))
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) attributes.push(parseAttributeValue(current.trim()))
  return attributes
}

function parseAttributeValue(value: string): any {
  const v = String(value ?? '').trim()
  if (!v || v === '$') return null

  // Typed value: IFCTYPE(inner)
  const typed = v.match(/^([A-Z][A-Z0-9_]*)\((.+)\)$/i)
  if (typed) {
    return [typed[1], parseAttributeValue(typed[2].trim())]
  }

  // List: (a,b,c)
  if (v.startsWith('(') && v.endsWith(')')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    const items: any[] = []
    let depth = 0
    let cur = ''
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch === '(') {
        depth++
        cur += ch
      } else if (ch === ')') {
        depth--
        cur += ch
      } else if (ch === ',' && depth === 0) {
        const item = cur.trim()
        if (item) items.push(parseAttributeValue(item))
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur.trim()) items.push(parseAttributeValue(cur.trim()))
    return items
  }

  // Reference: #123
  if (v.startsWith('#')) {
    const id = parseInt(v.slice(1), 10)
    return Number.isFinite(id) ? id : null
  }

  // String: 'text'
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }

  // Number
  const num = parseFloat(v)
  if (Number.isFinite(num)) return num

  // Enum / identifier
  return v
}

// --- Unit scale (model units -> meters) ---

const SI_PREFIX_MULTIPLIERS: Record<string, number> = {
  ATTO: 1e-18,
  FEMTO: 1e-15,
  PICO: 1e-12,
  NANO: 1e-9,
  MICRO: 1e-6,
  MILLI: 1e-3,
  CENTI: 1e-2,
  DECI: 1e-1,
  DECA: 1e1,
  HECTO: 1e2,
  KILO: 1e3,
  MEGA: 1e6,
  GIGA: 1e9,
  TERA: 1e12,
}

const CONVERSION_BASED_UNIT_FACTORS: Record<string, number> = {
  FOOT: 0.3048,
  FEET: 0.3048,
  "'FOOT'": 0.3048,
  INCH: 0.0254,
  "'INCH'": 0.0254,
  YARD: 0.9144,
  "'YARD'": 0.9144,
  MILE: 1609.344,
  "'MILE'": 1609.344,
}

function extractLengthUnitScaleLite(model: IfcModelLike): number {
  // Follow: IFCPROJECT.UnitsInContext -> IFCUNITASSIGNMENT.Units -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT
  const projectIds = getByTypeIds(model, 'IFCPROJECT')
  if (projectIds.length === 0) return 1
  const project = parseEntityOnDemand(model, projectIds[0])
  if (!project) return 1
  const unitsRef = asRef(project.attributes?.[8])
  if (!unitsRef) return 1
  const unitAssign = parseEntityOnDemand(model, unitsRef)
  if (!unitAssign || unitAssign.type.toUpperCase() !== 'IFCUNITASSIGNMENT') return 1
  const unitsList = unitAssign.attributes?.[0]
  if (!Array.isArray(unitsList)) return 1

  for (const uRef of unitsList) {
    const id = asRef(uRef)
    if (!id) continue
    const unit = parseEntityOnDemand(model, id)
    if (!unit) continue
    const unitType = unit.type.toUpperCase()
    const attrs = unit.attributes ?? []

    if (unitType === 'IFCSIUNIT') {
      const unitTypeValue = attrs[1]
      const isLength =
        typeof unitTypeValue === 'string' && unitTypeValue.replace(/\./g, '').toUpperCase() === 'LENGTHUNIT'
      if (!isLength) continue
      const prefix = attrs[2]
      if (prefix === null || prefix === undefined || prefix === '$') return 1
      const prefixStr = typeof prefix === 'string' ? prefix.replace(/\./g, '').toUpperCase() : ''
      return SI_PREFIX_MULTIPLIERS[prefixStr] ?? 1
    }

    if (unitType === 'IFCCONVERSIONBASEDUNIT') {
      const unitTypeValue = attrs[1]
      const isLength =
        typeof unitTypeValue === 'string' && unitTypeValue.replace(/\./g, '').toUpperCase() === 'LENGTHUNIT'
      if (!isLength) continue
      const unitName = attrs[2]
      if (typeof unitName === 'string') {
        const known = CONVERSION_BASED_UNIT_FACTORS[unitName.toUpperCase()]
        if (known !== undefined) return known
      }
      // Try ConversionFactor -> IFCMEASUREWITHUNIT -> ValueComponent (typed value) -> meters
      const convRef = asRef(attrs[3])
      if (!convRef) continue
      const mwu = parseEntityOnDemand(model, convRef)
      if (!mwu) continue
      const valueAttr = mwu.attributes?.[0]
      if (typeof valueAttr === 'number' && Number.isFinite(valueAttr)) return valueAttr
      if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number' && Number.isFinite(valueAttr[1])) {
        return valueAttr[1]
      }
    }
  }

  return 1
}

function asRef(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function asNum(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asNum3(coords: any, unitScale: number): Vec3 | null {
  if (!Array.isArray(coords) || coords.length < 2) return null
  const x = asNum(coords[0])
  const y = asNum(coords[1])
  const z = asNum(coords[2] ?? 0)
  if (x === null || y === null || z === null) return null
  return { x: x * unitScale, y: y * unitScale, z: z * unitScale }
}

function axis2PlacementToMat4(model: IfcModelLike, axis2Id: number, unitScale: number): Mat4 | null {
  const axis2 = parseEntityOnDemand(model, axis2Id)
  if (!axis2) return null
  const ty = axis2.type.toUpperCase()

  if (ty === 'IFCAXIS2PLACEMENT3D') {
    // attrs: [0] Location (IfcCartesianPoint), [1] Axis (IfcDirection optional), [2] RefDirection (IfcDirection optional)
    const locId = asRef(axis2.attributes[0])
    const axisId = asRef(axis2.attributes[1])
    const refId = asRef(axis2.attributes[2])

    const locEnt = locId ? parseEntityOnDemand(model, locId) : null
    const axisEnt = axisId ? parseEntityOnDemand(model, axisId) : null
    const refEnt = refId ? parseEntityOnDemand(model, refId) : null

    // IfcCartesianPoint attrs: [0] Coordinates (list)
    const t = locEnt ? asNum3(locEnt.attributes?.[0], unitScale) : null
    const zDirRaw = axisEnt ? asNum3(axisEnt.attributes?.[0], 1) : null
    const xDirRaw = refEnt ? asNum3(refEnt.attributes?.[0], 1) : null

    const zDir = normalize(isFiniteVec3(zDirRaw) ? zDirRaw : { x: 0, y: 0, z: 1 })
    const xDir0 = normalize(isFiniteVec3(xDirRaw) ? xDirRaw : { x: 1, y: 0, z: 0 })

    // Orthonormalize X against Z (Gram-Schmidt) to avoid drift.
    const xProj = sub(xDir0, { x: zDir.x * dot(xDir0, zDir), y: zDir.y * dot(xDir0, zDir), z: zDir.z * dot(xDir0, zDir) })
    const xDir = normalize(xProj)
    const yDir = normalize(cross(zDir, xDir))

    if (!isFiniteVec3(t)) return null
    return mat4FromBasisAndTranslation(xDir, yDir, zDir, t)
  }

  if (ty === 'IFCAXIS2PLACEMENT2D') {
    // attrs: [0] Location (IfcCartesianPoint), [1] RefDirection (IfcDirection optional)
    const locId = asRef(axis2.attributes[0])
    const refId = asRef(axis2.attributes[1])
    const locEnt = locId ? parseEntityOnDemand(model, locId) : null
    const refEnt = refId ? parseEntityOnDemand(model, refId) : null
    const t2 = locEnt ? asNum3(locEnt.attributes?.[0], unitScale) : null
    const xDirRaw = refEnt ? asNum3(refEnt.attributes?.[0], 1) : null
    const xDir = normalize(isFiniteVec3(xDirRaw) ? xDirRaw : { x: 1, y: 0, z: 0 })
    const zDir = { x: 0, y: 0, z: 1 }
    const yDir = normalize(cross(zDir, xDir))
    if (!isFiniteVec3(t2)) return null
    return mat4FromBasisAndTranslation(xDir, yDir, zDir, { x: t2.x, y: t2.y, z: 0 })
  }

  return null
}

function localPlacementToMat4(
  model: IfcModelLike,
  localPlacementId: number,
  unitScale: number,
  memo: Map<number, Mat4>
): Mat4 | null {
  if (memo.has(localPlacementId)) return memo.get(localPlacementId) ?? null
  const lp = parseEntityOnDemand(model, localPlacementId)
  if (!lp || lp.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return null
  // IfcLocalPlacement attrs: [0] PlacementRelTo (IfcObjectPlacement optional), [1] RelativePlacement (IfcAxis2Placement)
  const relToId = asRef(lp.attributes[0])
  const relPlaceId = asRef(lp.attributes[1])
  const rel = relPlaceId ? axis2PlacementToMat4(model, relPlaceId, unitScale) : null
  if (!rel) return null
  const parent = relToId ? localPlacementToMat4(model, relToId, unitScale, memo) : null
  const out = parent ? mat4Mul(parent, rel) : rel
  memo.set(localPlacementId, out)
  return out
}

function productObjectPlacementMat4(model: IfcModelLike, productId: number, unitScale: number, memo: Map<number, Mat4>): Mat4 | null {
  const ent = parseEntityOnDemand(model, productId)
  if (!ent) return null
  // IfcProduct: ObjectPlacement at index 5
  const placementId = asRef(ent.attributes?.[5])
  if (!placementId) return null
  return localPlacementToMat4(model, placementId, unitScale, memo)
}

function wcsToMat4(model: IfcModelLike, unitScale: number): Mat4 | null {
  const ctxIds = getByTypeIds(model, 'IFCGEOMETRICREPRESENTATIONCONTEXT')
  if (ctxIds.length === 0) return null
  // Prefer a context with a WorldCoordinateSystem ref.
  for (const id of ctxIds.slice(0, 4)) {
    const ctx = parseEntityOnDemand(model, id)
    if (!ctx) continue
    const wcsId = asRef(ctx.attributes?.[4])
    if (!wcsId) continue
    const m = axis2PlacementToMat4(model, wcsId, unitScale)
    if (m) return m
  }
  return null
}

function dominantStoreyId(model: IfcModelLike): number | null {
  const storeyIds = getByTypeIds(model, 'IFCBUILDINGSTOREY')
  if (storeyIds.length === 0) return null
  const byStorey = model.spatialHierarchy?.byStorey
  if (!byStorey || typeof byStorey.get !== 'function') return storeyIds[0]
  let best: { id: number; count: number } | null = null
  for (const sid of storeyIds) {
    const c = byStorey.get(sid)?.length ?? 0
    if (!best || c > best.count) best = { id: sid, count: c }
  }
  return best?.id ?? storeyIds[0]
}

// --- Candidate extraction ---

export function extractCandidates(ifcModel: IfcModelLike): SemanticCandidate[] {
  const out: SemanticCandidate[] = []
  const notesCommon: string[] = []

  const unitScale = Number(extractLengthUnitScaleLite(ifcModel)) || 1
  notesCommon.push(`unitScaleToMeters=${unitScale}`)

  const placementMemo = new Map<number, Mat4>()

  // A) MapConversion (+ ProjectedCRS) via parser's georeferencing extractor is NOT used here (avoid extra passes).
  // Instead, we use WASM georef when available via higher-level code; this module focuses on placement semantics.
  // However, if the model contains IfcMapConversion, we can still parse it and build an equivalent transform.
  const mapConvIds = getByTypeIds(ifcModel, 'IFCMAPCONVERSION')
  if (mapConvIds.length > 0) {
    const mc = parseEntityOnDemand(ifcModel, mapConvIds[0])
    if (mc) {
      // IfcMapConversion attrs (IFC4):
      // [2] Eastings, [3] Northings, [4] OrthogonalHeight, [5] XAxisAbscissa?, [6] XAxisOrdinate?, [7] Scale?
      const east = (asNum(mc.attributes?.[2]) ?? 0) * unitScale
      const north = (asNum(mc.attributes?.[3]) ?? 0) * unitScale
      const h = (asNum(mc.attributes?.[4]) ?? 0) * unitScale
      const xa = asNum(mc.attributes?.[5])
      const xo = asNum(mc.attributes?.[6])
      const scale = asNum(mc.attributes?.[7]) ?? 1
      const yaw = xa !== null && xo !== null ? Math.atan2(xo, xa) : 0
      const c = Math.cos(yaw)
      const s = Math.sin(yaw)

      // Column-major rotation about Z, with scale.
      const xAxis = { x: scale * c, y: scale * s, z: 0 }
      const yAxis = { x: -scale * s, y: scale * c, z: 0 }
      const zAxis = { x: 0, y: 0, z: 1 }
      const t = { x: east, y: north, z: h }
      const m = mat4FromBasisAndTranslation(xAxis, yAxis, zAxis, t)

      const crsNotes: string[] = []
      const crsIds = getByTypeIds(ifcModel, 'IFCPROJECTEDCRS')
      if (crsIds.length > 0) {
        const crs = parseEntityOnDemand(ifcModel, crsIds[0])
        const crsName = typeof crs?.attributes?.[0] === 'string' ? String(crs?.attributes?.[0]) : ''
        if (crsName) crsNotes.push(`ProjectedCRS=${crsName}`)
      }

      out.push({
        id: `A_mapConversion_${mc.expressId}`,
        source: 'ifc-map-conversion',
        T_ifc_to_world: m,
        t,
        yawDeg: yaw * DEG,
        notes: [...notesCommon, ...crsNotes, 'IfcMapConversion present (local->projected)'],
      })
    }
  }

  // B) GeometricRepresentationContext.WCS
  const wcs = wcsToMat4(ifcModel, unitScale)
  if (wcs) {
    out.push({
      id: 'B_wcs',
      source: 'ifc-wcs',
      T_ifc_to_world: wcs,
      t: mat4Translation(wcs),
      yawDeg: mat4YawDeg(wcs),
      notes: [...notesCommon, 'IfcGeometricRepresentationContext.WorldCoordinateSystem'],
    })
  }

  // C) IfcSite placement chain
  const siteIds = getByTypeIds(ifcModel, 'IFCSITE')
  if (siteIds.length > 0) {
    const m = productObjectPlacementMat4(ifcModel, siteIds[0], unitScale, placementMemo)
    if (m) {
      out.push({
        id: `C_site_${siteIds[0]}`,
        source: 'ifc-site',
        T_ifc_to_world: m,
        t: mat4Translation(m),
        yawDeg: mat4YawDeg(m),
        notes: [...notesCommon, 'IfcSite.ObjectPlacement chain'],
      })
    }
  }

  // D) IfcBuilding placement chain
  const bldIds = getByTypeIds(ifcModel, 'IFCBUILDING')
  if (bldIds.length > 0) {
    const m = productObjectPlacementMat4(ifcModel, bldIds[0], unitScale, placementMemo)
    if (m) {
      out.push({
        id: `D_building_${bldIds[0]}`,
        source: 'ifc-building',
        T_ifc_to_world: m,
        t: mat4Translation(m),
        yawDeg: mat4YawDeg(m),
        notes: [...notesCommon, 'IfcBuilding.ObjectPlacement chain'],
      })
    }
  }

  // E) Dominant storey placement chain
  const storeyId = dominantStoreyId(ifcModel)
  if (storeyId) {
    const m = productObjectPlacementMat4(ifcModel, storeyId, unitScale, placementMemo)
    if (m) {
      const count = ifcModel.spatialHierarchy?.byStorey?.get(storeyId)?.length ?? null
      out.push({
        id: `E_storey_${storeyId}`,
        source: 'ifc-storey-dominant',
        T_ifc_to_world: m,
        t: mat4Translation(m),
        yawDeg: mat4YawDeg(m),
        notes: [...notesCommon, `IfcBuildingStorey.ObjectPlacement chain (dominant storey, count=${count ?? 'unknown'})`],
      })
    }
  }

  // F) Geometry-derived anchor (bbox center etc.) - optional hint injected by caller.
  if (isFiniteVec3(ifcModel.__geomAnchorIfc)) {
    const m = mat4FromBasisAndTranslation(v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), ifcModel.__geomAnchorIfc)
    out.push({
      id: 'F_geom_anchor',
      source: 'geometry-anchor',
      T_ifc_to_world: m,
      t: { ...ifcModel.__geomAnchorIfc },
      yawDeg: 0,
      notes: [...notesCommon, 'Geometry-derived anchor (caller-provided)'],
    })
  }

  return out
}

// --- Scoring ---

const SOURCE_WEIGHTS: Record<CandidateSource, number> = {
  'ifc-map-conversion': 0.85,
  'ifc-wcs': 0.7,
  'ifc-site': 0.9,
  'ifc-building': 0.82,
  'ifc-storey-dominant': 0.72,
  'geometry-anchor': 0.35,
}

// Guardrails for plausibility (meters)
const MAX_REASONABLE_TRANSLATION_M = 10_000_000 // 10,000km

export function scoreCandidates(candidates: SemanticCandidate[], federationHint?: FederationHint): RankedCandidate[] {
  const refT = federationHint?.referenceTranslationIfc
  const sigma = Number(federationHint?.clusterSigmaMeters ?? federationHint?.clusterSigmaM ?? 50)
  const sigmaSafe = Number.isFinite(sigma) && sigma > 0 ? sigma : 50
  const centroids = Array.isArray(federationHint?.clusterCentroidsIfc) ? (federationHint?.clusterCentroidsIfc as Vec3[]) : null
  const preferCluster = Boolean(federationHint?.preferCluster)

  const ranked: RankedCandidate[] = candidates.map((c) => {
    const penalties: Array<{ id: string; amount: number; reason: string }> = []
    const base = SOURCE_WEIGHTS[c.source] ?? 0.5

    // Completeness: we currently only require finite translation and finite yaw.
    const finiteT = isFiniteVec3(c.t)
    const finiteYaw = Number.isFinite(c.yawDeg)
    const completeness = clamp01((finiteT ? 0.7 : 0) + (finiteYaw ? 0.3 : 0))

    // Plausibility: reject absurd translations / NaNs.
    let plausibility = 1
    const maxAbs = Math.max(Math.abs(c.t.x), Math.abs(c.t.y), Math.abs(c.t.z))
    if (!finiteT || !Number.isFinite(maxAbs)) {
      plausibility = 0
      penalties.push({ id: 'P_NON_FINITE', amount: 1.0, reason: 'non-finite translation' })
    } else if (maxAbs > MAX_REASONABLE_TRANSLATION_M) {
      plausibility = 0
      penalties.push({ id: 'P_ABSURD', amount: 1.0, reason: `translation exceeds ${MAX_REASONABLE_TRANSLATION_M}m` })
    } else {
      // Mild penalty if extremely large (but not absurd). This biases toward semantic placements when present.
      if (maxAbs > 500_000) penalties.push({ id: 'P_VERY_LARGE', amount: 0.15, reason: 'very large translation magnitude' })
      if (maxAbs > 5_000_000) penalties.push({ id: 'P_HUGE', amount: 0.35, reason: 'huge translation magnitude' })
    }

    // Cluster bonus (single reference): prefer candidates near federation reference translation (site-scale proximity).
    let clusterBonus = 0
    if (finiteT && isFiniteVec3(refT)) {
      const d = dist(c.t, refT)
      // Gaussian-like bonus in [0..0.25]
      const g = Math.exp(-(d * d) / (2 * sigmaSafe * sigmaSafe))
      clusterBonus = 0.25 * clamp01(g)
    }

    // Cluster bonus (multi-centroid): prefer candidates near ANY cluster centroid.
    // bonus = max_i exp(-(d_i^2)/(2*sigma^2)) mapped to [0..0.25]
    let farPenalty = 0
    if (finiteT && centroids && centroids.length > 0) {
      let bestG = 0
      let minD = Infinity
      for (const cc of centroids) {
        if (!isFiniteVec3(cc)) continue
        const d = dist(c.t, cc)
        minD = Math.min(minD, d)
        const g = Math.exp(-(d * d) / (2 * sigmaSafe * sigmaSafe))
        if (Number.isFinite(g) && g > bestG) bestG = g
      }
      const bonus = 0.25 * clamp01(bestG)
      // Optionally prefer centroid-based bonus over ref-based bonus.
      clusterBonus = preferCluster ? Math.max(clusterBonus, bonus) : Math.max(bonus, clusterBonus)

      // Penalize candidates far from ALL centroids.
      if (Number.isFinite(minD) && minD > 3 * sigmaSafe) {
        farPenalty = 0.15
      }
    }

    // Sum penalties (cap).
    const penaltySum = Math.min(1, penalties.reduce((s, p) => s + Math.max(0, p.amount), 0))
    const plausibilityPenalty = penaltySum

    // Total score in [0..1] (best-effort).
    const total = clamp01(base * 0.55 + completeness * 0.2 + plausibility * 0.25 + clusterBonus - penaltySum * 0.35 - farPenalty)

    const breakdown: ScoreBreakdown = {
      sourceWeight: base,
      baseWeight: base,
      completeness,
      plausibility,
      clusterBonus,
      farPenalty: farPenalty ? -farPenalty : 0,
      plausibilityPenalty: plausibilityPenalty ? -plausibilityPenalty : 0,
      penalties,
      total,
      finalScore: total,
    }

    const rejected =
      plausibility <= 0 || completeness <= 0
        ? { reason: penalties.map((p) => p.reason).join('; ') || 'invalid' }
        : undefined

    return {
      ...c,
      score: total,
      breakdown,
      rejected,
    }
  })

  // Sort: non-rejected first, then by score descending.
  ranked.sort((a, b) => {
    const ar = a.rejected ? 1 : 0
    const br = b.rejected ? 1 : 0
    if (ar !== br) return ar - br
    return (b.score ?? 0) - (a.score ?? 0)
  })

  return ranked
}

