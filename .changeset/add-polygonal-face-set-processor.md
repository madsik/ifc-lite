---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Add PolygonalFaceSetProcessor and surface model processors for improved geometry support

### New Geometry Processors
- **PolygonalFaceSetProcessor**: Handle IfcPolygonalFaceSet with triangulation of arbitrary polygons
- **FaceBasedSurfaceModelProcessor**: Process IfcFaceBasedSurfaceModel geometry
- **SurfaceOfLinearExtrusionProcessor**: Handle IfcSurfaceOfLinearExtrusion surfaces
- **ShellBasedSurfaceModelProcessor**: Process IfcShellBasedSurfaceModel geometry

### Performance Optimizations
- Add fast-path decoder functions with point caching for BREP-heavy files (~2x faster)
- Add `get_first_entity_ref_fast`, `get_polyloop_coords_fast`, `get_polyloop_coords_cached`
- Add `has_non_null_attribute()` for fast attribute filtering
- Optimize FacetedBrep with fast-path using `get_face_bound_fast`
- Add WASM-specific sequential iteration to avoid threading overhead
