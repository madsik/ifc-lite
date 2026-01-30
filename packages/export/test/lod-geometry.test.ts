/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateLod0 } from '../src/lod0-generator.js';
import { generateLod1 } from '../src/lod1-generator.js';

function fixturePath(name: string): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, 'fixtures', 'lod', name);
}

function assertVec3(v: any) {
  expect(Array.isArray(v)).toBe(true);
  expect(v.length).toBe(3);
  for (const n of v) expect(typeof n).toBe('number');
}

function assertMat4RowMajor(v: any) {
  expect(Array.isArray(v)).toBe(true);
  expect(v.length).toBe(16);
  for (const n of v) expect(typeof n).toBe('number');
}

describe('LOD geometry generation', () => {
  it('LOD0: produces bbox JSON schema + elements', async () => {
    const buf = await readFile(fixturePath('simple.ifc'));
    const lod0 = await generateLod0(new Uint8Array(buf));

    expect(lod0.schema).toBe('ifc-lite-geometry');
    expect(lod0.lod).toBe(0);
    expect(lod0.units).toBe('m');
    expect(Array.isArray(lod0.elements)).toBe(true);
    expect(lod0.elements.length).toBeGreaterThan(0);

    const e = lod0.elements.find((x) => x.ifcClass === 'IfcWall') ?? lod0.elements[0];
    expect(typeof e.expressID).toBe('number');
    expect(typeof e.ifcClass).toBe('string');
    assertMat4RowMajor(e.transform);
    assertVec3(e.bbox.min);
    assertVec3(e.bbox.max);
    assertVec3(e.centroid);
    expect(e.bbox_source === 'shape' || e.bbox_source === 'fallback').toBe(true);
  });

  it('LOD1: always produces a GLB + meta (ok or degraded)', async () => {
    const buf = await readFile(fixturePath('simple.ifc'));
    const { glb, meta } = await generateLod1(new Uint8Array(buf));

    expect(glb instanceof Uint8Array).toBe(true);
    expect(glb.byteLength).toBeGreaterThan(16);
    // GLB header magic "glTF"
    expect(String.fromCharCode(glb[0], glb[1], glb[2], glb[3])).toBe('glTF');

    expect(meta.schema).toBe('ifc-lite-geometry');
    expect(meta.lod).toBe(1);
    expect(meta.status === 'ok' || meta.status === 'degraded').toBe(true);
    expect(Array.isArray(meta.failedElements)).toBe(true);
    expect(Array.isArray(meta.notes)).toBe(true);
    expect(typeof meta.mapping).toBe('object');
  });

  it('Contract: LOD0 always produced; LOD1 fallback always produces artifact + degraded meta', async () => {
    const buf = await readFile(fixturePath('degraded.ifc'));

    const lod0 = await generateLod0(new Uint8Array(buf));
    expect(lod0.elements.length).toBeGreaterThan(0);

    const { glb, meta } = await generateLod1(new Uint8Array(buf), { __forceMeshingErrorForTest: true });
    expect(String.fromCharCode(glb[0], glb[1], glb[2], glb[3])).toBe('glTF');
    expect(meta.status).toBe('degraded');
    expect(meta.fallback).toBe('boxes_from_lod0');
    expect(meta.failedElements.length).toBeGreaterThan(0);
  });
});

