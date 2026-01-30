<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

## LOD0 + LOD1 geometry (IFC-Lite) — Changelog

### Summary

- **LOD0 (mandatory)**: placement-based **bbox JSON** generator (`lod0_preview.json`)
- **LOD1 (mandatory)**: best-effort **GLB** generator (`lod1.glb`) with **meta sidecar** (`lod1.meta.json`)
- **Fallback**: if meshing fails, LOD1 emits a **box-based GLB** from LOD0 and marks `status:"degraded"`.
- **Viewer**: can load these artifacts, toggle preview/full, and auto-switch to LOD1 when available.

### Files changed / added

- **LOD generators + helpers**
  - `packages/export/src/lod0-generator.ts`
  - `packages/export/src/lod1-generator.ts`
  - `packages/export/src/lod-geometry-types.ts`
  - `packages/export/src/lod-geometry-utils.ts`
  - `packages/export/src/glb.ts`
  - `packages/export/src/index.ts`
  - `packages/export/src/parquet.ts` (separate entrypoint)
  - `packages/wasm/package.json` (exports: add `./pkg/ifc-lite_bg.wasm`)
  - `packages/geometry/src/ifc-lite-bridge.ts` (Node WASM init loads bytes via `fs`)
  - `packages/geometry/src/lod.ts` + `packages/geometry/src/index.ts` (remove “LOD0=full mesh” naming)

- **Viewer integration**
  - `apps/viewer/src/store/slices/dataSlice.ts`
  - `apps/viewer/src/store/index.ts`
  - `apps/viewer/src/utils/lodGeometry.ts`
  - `apps/viewer/src/hooks/useIfc.ts`
  - `apps/viewer/src/components/viewer/MainToolbar.tsx`

- **Tests + fixtures**
  - `packages/export/test/fixtures/lod/simple.ifc`
  - `packages/export/test/fixtures/lod/degraded.ifc`
  - `packages/export/test/lod-geometry.test.ts`

- **Docs**
  - `docs/ifc-lite-geometry.md`

- **CLI**
  - `scripts/generate-lod-artifacts.mjs`

### How to run generators

From `ifc-lite/`:

```bash
 npx -y pnpm@latest install
 npx -y pnpm@latest --filter @ifc-lite/export build
node scripts/generate-lod-artifacts.mjs path/to/model.ifc --out out/dir
```

Outputs:

- `out/dir/lod0_preview.json`
- `out/dir/lod1.glb`
- `out/dir/lod1.meta.json`

### How to use in the viewer

- In the IFC-Lite viewer toolbar:
  - Click **Upload** to select `lod0_preview.json`, `lod1.glb`, and `lod1.meta.json`
  - Use **Geometry Mode**:
    - **Preview (LOD0)**
    - **Full geometry (LOD1)** (auto-switches when GLB is present; shows degraded note if applicable)

### How to test

From `ifc-lite/`:

```bash
npx -y pnpm@latest --filter @ifc-lite/export test
```

### Example outputs

LOD0 snippet:

```json
{
  "schema": "ifc-lite-geometry",
  "lod": 0,
  "units": "m",
  "elements": [
    {
      "expressID": 40,
      "ifcClass": "IfcWall",
      "transform": [1,0,0,1, 0,1,0,0, 0,0,1,0, 0,0,0,1],
      "bbox": { "min": [0,0,0], "max": [2,0.3,3] },
      "centroid": [1,0.15,1.5],
      "bbox_source": "shape"
    }
  ]
}
```

LOD1 meta snippet (fallback):

```json
{
  "schema": "ifc-lite-geometry",
  "lod": 1,
  "status": "degraded",
  "fallback": "boxes_from_lod0",
  "failedElements": [40],
  "notes": ["Meshing failed; using fallback boxes from LOD0. (...)"]
}
```

