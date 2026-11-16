/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `findEntity` and `getInheritanceChain` answer from a name index built once
 * per entity table (#ISSUE). They used to scan the table (`Array.find`) or
 * build a map of it on every call, which the IDS audit does several times per
 * facet. The answers must stay exactly what the scan and the per-call map
 * gave, for every name of every table, any spelling, and unknown names.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { findEntity, getEntities, getInheritanceChain, isEntitySubtypeOf } from './index.js';
import type { IfcEntityInfo, IfcSchemaVersion } from './types.js';

const VERSIONS: readonly IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2'];

/** The lookup as it was: a scan, the first match wins. */
function scanFind(list: readonly IfcEntityInfo[], name: string): IfcEntityInfo | undefined {
  const upper = name.toUpperCase();
  return list.find((e) => e.name.toUpperCase() === upper);
}

/** The inheritance walk as it was: a fresh map per call, the last entry of a name wins. */
function scanChain(list: readonly IfcEntityInfo[], name: string): IfcEntityInfo[] {
  const byName = new Map<string, IfcEntityInfo>();
  for (const e of list) byName.set(e.name.toUpperCase(), e);
  const chain: IfcEntityInfo[] = [];
  let cursor = byName.get(name.toUpperCase());
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.name)) {
    chain.push(cursor);
    seen.add(cursor.name);
    cursor = cursor.parent ? byName.get(cursor.parent.toUpperCase()) : undefined;
  }
  return chain;
}

/** Every name of every table, in its own spelling, upper and lower case, plus names no table has. */
async function probeNames(): Promise<string[]> {
  const names = new Set<string>(['', 'IFCNOTANENTITY', 'IfcWall ', ' IFCWALL', 'IFC_WALL', 'IfcWallType2']);
  for (const v of VERSIONS) {
    for (const e of await getEntities(v)) {
      names.add(e.name);
      names.add(e.name.toUpperCase());
      names.add(e.name.toLowerCase());
    }
  }
  return [...names];
}

describe('findEntity and getInheritanceChain answer as the table scan did (#ISSUE)', () => {
  it('no table repeats an upper-case name, so the first and the last entry of a name are one', async () => {
    for (const v of VERSIONS) {
      const names = (await getEntities(v)).map((e) => e.name.toUpperCase());
      expect(new Set(names).size, v).toBe(names.length);
    }
  });

  it('findEntity returns the very entry the scan returns, for every name and spelling in every version', async () => {
    const names = await probeNames();
    for (const v of VERSIONS) {
      const list = await getEntities(v);
      let found = 0;
      for (const name of names) {
        const expected = scanFind(list, name);
        expect(await findEntity(v, name), `${v} ${name}`).toBe(expected);
        if (expected) found++;
      }
      expect(found, v).toBeGreaterThanOrEqual(list.length * 3);
    }
  });

  it('getInheritanceChain returns the same entries in the same order, for every name and spelling in every version', async () => {
    const names = await probeNames();
    for (const v of VERSIONS) {
      const list = await getEntities(v);
      for (const name of names) {
        const chain = await getInheritanceChain(v, name);
        const expected = scanChain(list, name);
        expect(chain.length, `${v} ${name}`).toBe(expected.length);
        chain.forEach((e, i) => expect(e, `${v} ${name} [${i}]`).toBe(expected[i]));
      }
    }
  });

  it('isEntitySubtypeOf agrees with the scanned chain on a fixed set of pairs', async () => {
    const pairs: Array<[IfcSchemaVersion, string, string, boolean]> = [
      ['IFC4', 'IFCWALL', 'IfcBuildingElement', true],
      ['IFC4', 'IfcWallStandardCase', 'IFCWALL', true],
      ['IFC4', 'IFCWALL', 'IfcSlab', false],
      ['IFC4X3', 'IFCWALL', 'IfcBuiltElement', true],
      ['IFC4X3_ADD2', 'ifcwall', 'IFCROOT', true],
      ['IFC2X3', 'IFCREINFORCINGBAR', 'IfcBuildingElement', true],
      ['IFC4', 'IFCREINFORCINGBAR', 'IfcBuildingElement', false],
      ['IFC4', 'IFCNOTANENTITY', 'IfcRoot', false],
    ];
    for (const [v, entity, target, expected] of pairs) {
      const scanned = scanChain(await getEntities(v), entity).some((e) => e.name.toUpperCase() === target.toUpperCase());
      expect(scanned, `scan ${v} ${entity} ${target}`).toBe(expected);
      expect(await isEntitySubtypeOf(v, entity, target), `${v} ${entity} ${target}`).toBe(expected);
    }
  });

  it('still rejects a version it does not know', async () => {
    const unknown = 'IFC5' as IfcSchemaVersion;
    await expect(findEntity(unknown, 'IFCWALL')).rejects.toThrow('Unsupported IFC schema version: IFC5');
    await expect(getInheritanceChain(unknown, 'IFCWALL')).rejects.toThrow('Unsupported IFC schema version: IFC5');
  });
});

describe('a lookup does not read the whole table again (#ISSUE)', () => {
  afterEach(() => vi.restoreAllMocks());

  // Every table entry the scan or the per-call map reads costs one
  // `toUpperCase`. With the index a lookup costs its own name, plus one per
  // level of the chain, whatever the table size (771 to 1008 entries).
  it.each(VERSIONS)('%s: findEntity and getInheritanceChain cost a few name conversions, not one per entry', async (v) => {
    await findEntity(v, 'IFCWALL'); // the first lookup may build what it needs
    await getInheritanceChain(v, 'IFCWALL');
    const upper = vi.spyOn(String.prototype, 'toUpperCase');
    for (let i = 0; i < 10; i++) await findEntity(v, 'IfcWall');
    const findCalls = upper.mock.calls.length;
    upper.mockClear();
    const chain = await getInheritanceChain(v, 'IfcWall');
    const chainCalls = upper.mock.calls.length;
    upper.mockRestore();
    expect(findCalls).toBeLessThanOrEqual(10);
    expect(chain.length).toBeGreaterThan(3);
    expect(chainCalls).toBeLessThanOrEqual(chain.length + 1);
  });
});
