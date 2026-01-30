/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryQuality, MeshData } from '@ifc-lite/geometry';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { GLTFExporter } from './gltf-exporter.js';
import { extractGlbMapping } from './glb.js';
import { generateLod0 } from './lod0-generator.js';
import type { GenerateLod1Result, Lod1MetaJson, Lod0Json, Vec3 } from './lod-geometry-types.js';

type IfcInput = ArrayBuffer | Uint8Array | string;

export type GenerateLod1Options = {
  quality?: GeometryQuality;
  /**
   * Test-only hook to simulate meshing failure and force fallback.
   * Not intended for production use.
   */
  __forceMeshingErrorForTest?: boolean;
};

async function readIfcInput(input: IfcInput): Promise<ArrayBuffer> {
  if (typeof input === 'string') {
    const fs = await import('node:fs/promises');
    return await fs.readFile(input);
  }
  if (input instanceof ArrayBuffer) return input;
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
}

function buildBoxMeshFromAabb(min: Vec3, max: Vec3, expressId: number): MeshData {
  // 8 corners
  const x0 = min[0], y0 = min[1], z0 = min[2];
  const x1 = max[0], y1 = max[1], z1 = max[2];
  const positions = new Float32Array([
    x0, y0, z0, // 0
    x1, y0, z0, // 1
    x1, y1, z0, // 2
    x0, y1, z0, // 3
    x0, y0, z1, // 4
    x1, y0, z1, // 5
    x1, y1, z1, // 6
    x0, y1, z1, // 7
  ]);

  // 12 triangles (two per face)
  const indices = new Uint32Array([
    // bottom (z0)
    0, 1, 2, 0, 2, 3,
    // top (z1)
    4, 6, 5, 4, 7, 6,
    // front (y0)
    0, 5, 1, 0, 4, 5,
    // back (y1)
    3, 2, 6, 3, 6, 7,
    // left (x0)
    0, 3, 7, 0, 7, 4,
    // right (x1)
    1, 5, 6, 1, 6, 2,
  ]);

  // Flat normals are optional for GLTFExporter (it expects normals present).
  // Provide a simple per-vertex normal approximation (will not be perfect but sufficient).
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) {
    normals[i] = 0;
    normals[i + 1] = 0;
    normals[i + 2] = 1;
  }

  return {
    expressId,
    positions,
    normals,
    indices,
    color: [0.8, 0.8, 0.8, 1],
    ifcType: 'IfcBuildingElementProxy',
  };
}

function buildFallbackGeometryFromLod0(lod0: Lod0Json): { meshes: MeshData[]; failed: number[] } {
  const meshes: MeshData[] = [];
  const failed: number[] = [];
  for (const el of lod0.elements) {
    try {
      meshes.push(buildBoxMeshFromAabb(el.bbox.min, el.bbox.max, el.expressID));
    } catch {
      failed.push(el.expressID);
    }
  }
  return { meshes, failed };
}

export async function generateLod1(input: IfcInput, options: GenerateLod1Options = {}): Promise<GenerateLod1Result> {
  // LOD0 is mandatory and used for degraded detection + fallback.
  const lod0 = await generateLod0(input);
  const allExpress = new Set<number>(lod0.elements.map((e) => e.expressID));

  const notes: string[] = [];

  try {
    if (options.__forceMeshingErrorForTest) {
      throw new Error('Forced meshing failure for test');
    }

    const buffer = await readIfcInput(input);
    const gp = new GeometryProcessor({ quality: options.quality });
    await gp.init();
    const geom = await gp.process(new Uint8Array(buffer));

    const exporter = new GLTFExporter(geom);
    const glb = exporter.exportGLB({ includeMetadata: true });
    const mapping = extractGlbMapping(glb);

    const mappedIds = new Set<number>(Object.keys(mapping).map((k) => Number(k)).filter((n) => Number.isFinite(n)));
    const failedElements: number[] = [];
    for (const id of allExpress) {
      if (!mappedIds.has(id)) failedElements.push(id);
    }

    const status: Lod1MetaJson['status'] = failedElements.length > 0 ? 'degraded' : 'ok';
    if (status === 'degraded') {
      notes.push('Some elements did not produce mesh output; GLB contains partial geometry.')
    }

    const meta: Lod1MetaJson = {
      schema: 'ifc-lite-geometry',
      lod: 1,
      status,
      failedElements,
      notes,
      mapping,
    };

    return { glb, meta };
  } catch (e: any) {
    // Full failure => mandatory fallback GLB from LOD0 bboxes
    const errMsg = e instanceof Error ? e.message : String(e);
    notes.push(`Meshing failed; using fallback boxes from LOD0. (${errMsg})`);

    const { meshes } = buildFallbackGeometryFromLod0(lod0);
    const exporter = new GLTFExporter({
      meshes,
      totalTriangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0),
      totalVertices: meshes.reduce((s, m) => s + m.positions.length / 3, 0),
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        hasLargeCoordinates: false,
      },
    } as any);

    const glb = exporter.exportGLB({ includeMetadata: true });
    const mapping = extractGlbMapping(glb);

    const meta: Lod1MetaJson = {
      schema: 'ifc-lite-geometry',
      lod: 1,
      status: 'degraded',
      fallback: 'boxes_from_lod0',
      failedElements: lod0.elements.map((x) => x.expressID),
      notes,
      mapping,
    };

    return { glb, meta };
  }
}

