/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Lod0Json } from '@ifc-lite/export';

type Vec3 = [number, number, number];

function buildBoxMeshFromAabb(min: Vec3, max: Vec3, expressId: number): MeshData {
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

  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 5, 1, 0, 4, 5,
    3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4,
    1, 5, 6, 1, 6, 2,
  ]);

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
    color: [0.35, 0.7, 1.0, 0.35],
    ifcType: 'IfcBuildingElementProxy',
  };
}

export function buildPreviewMeshesFromLod0(lod0: Lod0Json): MeshData[] {
  const meshes: MeshData[] = [];
  for (const el of lod0.elements) {
    meshes.push(buildBoxMeshFromAabb(el.bbox.min as Vec3, el.bbox.max as Vec3, el.expressID));
  }
  return meshes;
}

