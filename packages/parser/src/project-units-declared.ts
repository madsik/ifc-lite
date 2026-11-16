/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The resolved shape of a file's declared units: {@link ResolvedUnit} and the
 * {@link ProjectUnits} table that `extractProjectUnits` (project-units.ts)
 * builds. Split out of project-units.ts to keep it under the module-size
 * budget; that module re-exports both.
 */

import { measureUnit } from './project-units-symbols.js';

/** A resolved display unit: the symbol to render plus the factor that converts a
 *  value in this unit to its canonical SI base (`mm` → `1e-3`, `m³/h` → `1/3600`,
 *  `°` → `0.01745…`). `1.0` for SI-base and monetary units. */
export interface ResolvedUnit {
  symbol: string;
  siScale: number;
  /** Additive SI offset, present only for an `IfcConversionBasedUnitWithOffset`
   *  (°F over kelvin): `si = value * siScale + siOffset`. */
  siOffset?: number;
}

/** The file's declared units, keyed by unit-type token. */
export class ProjectUnits {
  /** `null` for a declared unit whose scale could not be resolved (#4690): it
   *  shows no unit rather than the SI default, which would mislabel it. */
  private readonly byType: Map<string, ResolvedUnit | null>;
  private readonly monetaryUnit: ResolvedUnit | null;

  constructor(byType: Map<string, ResolvedUnit | null>, monetary: ResolvedUnit | null) {
    this.byType = byType;
    this.monetaryUnit = monetary;
  }

  static empty(): ProjectUnits {
    return new ProjectUnits(new Map(), null);
  }

  /** The display unit for a property/quantity with IFC measure type
   *  `measureType`. Prefers the file's declared unit and falls back to the
   *  IFC-canonical SI default. `null` for dimensionless / non-measure types. */
  unitForMeasure(measureType: string): ResolvedUnit | null {
    const m = measureUnit(measureType);
    if (!m) return null;
    if (m.kind === 'dimensionless') return null;
    if (m.kind === 'monetary') return this.monetaryUnit;
    const declared = this.byType.get(m.unitType);
    return declared !== undefined ? declared : { symbol: m.defaultSymbol, siScale: 1.0 };
  }

  /** A declared unit whose scale could not be resolved is `undefined` here too. */
  resolvedForUnitType(unitType: string): ResolvedUnit | undefined {
    return this.byType.get(unitType) ?? undefined;
  }

  monetary(): ResolvedUnit | null {
    return this.monetaryUnit;
  }

  get declaredCount(): number {
    return this.byType.size;
  }
}
