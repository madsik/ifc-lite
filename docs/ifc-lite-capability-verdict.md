<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

## IFC-Lite capability verdict: LOD0 vs LOD1

This is a **static + runtime audit** of IFC-Lite in this workspace (`ifc-lite/`). It answers:

- **LOD1**: can IFC-Lite produce progressive visual geometry (meshes)?
- **LOD0**: can IFC-Lite produce a lightweight analytical layer (bounds/heatmap-ready) without tessellation?

### Phase 1 — Does IFC-Lite explicitly define “LOD0 / LOD1”?

**Finding:** IFC-Lite does **not** define a first-class “LOD0=bounds / LOD1=mesh” abstraction in the core geometry pipeline. It has **progressive mesh streaming** (implicit “LOD-like” behavior) and a **detail selector** for meshes.

Evidence:

- Progressive mesh streaming entrypoint: `packages/geometry/src/index.ts` (`GeometryProcessor.processStreaming(...)`)
- Mesh collection is triangle-based (WASM `parseMeshes` / `parseMeshesAsync`): `packages/geometry/src/ifc-lite-mesh-collector.ts`
- Mesh “detail selection” is separate from LOD0/LOD1 semantics: `packages/geometry/src/lod.ts` (`DetailSelector`)

### Phase 2 — Geometry pipeline inspection (Rust/WASM)

#### Entry points (mesh generation)

**Yes, geometry is triangulated**: the Rust geometry pipeline routes IFC representation items to processors that generate meshes (triangles).

Evidence:

- Router dispatches IFC representation entities to processors that return `Mesh`: `rust/geometry/src/router.rs` (`GeometryProcessor::process(...)`)
- Example processor builds meshes from IFC representation entities: `rust/geometry/src/processors.rs` (e.g. `ExtrudedAreaSolidProcessor::process(...)`)
- JS/WASM mesh collection calls `IfcAPI.parseMeshes(...)` and converts to `MeshData`: `packages/geometry/src/ifc-lite-mesh-collector.ts` (`collectMeshes()` / `collectMeshesStreaming()`)

#### Bounds without tessellation (pre-mesh phase)

**Yes (model-level), No (per-element, built-in).**

- **Model-level bounds** can be computed **without mesh generation** via a fast scan of IFC text for points / placement-related points.
- **Per-element bounds** are not exposed as a dedicated “no-mesh bounds API” in the parser/geometry core; bounds are typically derived **from mesh data** after geometry exists.

Evidence (no-mesh model bounds scan):

- `rust/core/src/model_bounds.rs`
  - `scan_model_bounds(content: &str)` — scans `IFCCARTESIANPOINT`
  - `scan_placement_bounds(content: &str)` — focuses on placement-related points

Evidence (bounds derived from geometry):

- `rust/wasm-bindings/src/zero_copy.rs` exposes `bounds_min()` / `bounds_max()` computed from `mesh.bounds()` (**post-mesh**)
- `packages/query/src/ifc-query.ts` requires geometry-built spatial index:
  - `inBounds(...)` throws if `store.spatialIndex` is missing (“Geometry must be processed first.”)

**Answer (requested):**

- **Can IFC-Lite compute bounds WITHOUT mesh generation?** **Yes, at model-level** (fast scan) — **not per-element as a first-class API**.
- **Are bounds derived from geometry or IFC placements?** **Mostly geometry-derived** (mesh bounds), with an additional **placement/point-derived** model-bounds scan.

### Phase 3 — Data model exposure (JS/TS side)

#### Available per-element data BEFORE geometry

From the parsed IFC data store (columnar):

| Data | Available? | Evidence |
|---|---:|---|
| expressId | Yes | `packages/data/src/entity-table.ts` (`expressId` array) |
| type name / enum | Yes | `packages/data/src/entity-table.ts` (`getTypeName`) |
| GlobalId | Yes | `packages/data/src/entity-table.ts` (`getGlobalId`) |
| Name/Description/ObjectType | Yes | `packages/data/src/entity-table.ts` (`getName`, `getDescription`, `getObjectType`) |
| Relationships / hierarchy | Yes | `packages/parser/src/spatial-hierarchy-builder.ts` + relationship graph building in parser |
| Placement transforms (world matrices) | **No (not exposed as a standalone API)** | Parser doesn’t publish a per-element transform/matrix interface; placement parsing lives inside geometry processing. |
| Per-element bounds | **No (pre-geometry)** | Bounds APIs present are mesh-based or model-level scan. |

#### Available per-element data AFTER geometry

| Data | Available? | Evidence |
|---|---:|---|
| Mesh buffers (positions/normals/indices) | Yes | `packages/geometry/src/ifc-lite-mesh-collector.ts` |
| expressId ↔ mesh association | Yes | `MeshData.expressId` in collector |
| Per-mesh AABB bounds | Yes | `rust/wasm-bindings/src/zero_copy.rs` (`bounds_min` / `bounds_max`) |
| Spatial queries (raycast / inBounds) | Yes (requires spatial index built from geometry) | `packages/query/src/ifc-query.ts` (`inBounds`, `raycast`) |
| Instance transform matrices (instanced path) | Yes | `rust/wasm-bindings/src/zero_copy.rs` (`InstanceData.transform`) |

**Heatmap/analytics feasibility (requested):**

- You can build **property-driven overlays** (classification, validation results, etc.) **without geometry** (because expressId/globalId + properties exist pre-geometry).
- Any overlay that needs **screen-space rendering** or **bounds-based spatial queries** requires either:
  - actual meshes (post-geometry), or
  - a separate placement/bounds extraction step (not provided as a built-in parser API).

### Phase 4 — Runtime experiment (timing truth)

Measured via Node script using built `dist/` modules (no source edits) on `tests/models/ifcopenshell/928-column.ifc`:

```json
{
  "file": "tests/models/ifcopenshell/928-column.ifc",
  "bytes": 6239,
  "read_ms": 0.7542,
  "parseColumnar_ms": 4.1712,
  "first_batch_ms": 33.1951,
  "full_geometry_ms": 34.2209,
  "batches": 1
}
```

Timeline:

IFC bytes loaded  
↓  
**metadata available** (parseColumnar complete; entities/properties/relationships)  
↓  
**first triangles** (first `processStreaming` batch)  
↓  
full geometry complete

### Phase 5 — Classification (hard decision)

**Classification: TYPE 2 — Geometry + lightweight analytical base (LOD0 possible).**

Backed by:

- **LOD1 (geometry): YES** — progressive mesh pipeline exists and is the primary design (`GeometryProcessor.processStreaming`, WASM `parseMeshesAsync`).
- **LOD0 (analytics): PARTIAL** — rich per-element metadata exists pre-geometry, and model-level bounds can be scanned without meshing (`rust/core/src/model_bounds.rs`), but **per-element bounds/transforms are not exposed as a dedicated pre-geometry API**.

### Phase 6 — Go / No-Go decisions

#### LOD1 geometry (meshes)
- **GO**: IFC-Lite is suitable as a **LOD1 mesh engine**, including progressive streaming.

#### LOD0 analytical usage (bounds / heatmap base)
- **GO for metadata-only overlays**: expressId/globalId/property-driven analytics does **not** require geometry.
- **CONDITIONAL GO for bounds-based LOD0**: requires a separate bounds/placement extraction step (not provided as a built-in parser API). Model-level bounds scan exists; per-element bounds need extra work.

#### Replace an existing “LOD0 heatmap logic” that relies on per-element bounds/transforms
- **NO-GO (without additional implementation)**: core IFC-Lite does not expose per-element placement/world matrices + bounds prior to meshing.

