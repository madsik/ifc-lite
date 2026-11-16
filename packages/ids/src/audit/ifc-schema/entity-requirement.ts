/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity-name checks that need more than one facet (IDS-007).
 *
 * - IDS entity names are upper case (`IFCWALL`); `IfcWall` names nothing
 *   (corpus: entity/invalid-entities_must_be_specified_as_uppercase_strings).
 * - An entity facet in the requirements is checked against the elements the
 *   applicability selects, by exact class (IDS 1.0 entity facets do not match
 *   subclasses). When no class the requirement admits is one the
 *   applicability admits, every applicable element fails, so the
 *   specification can only ever fail (corpus: entity/invalid-an_entity_not_
 *   matching_the_specified_class_should_fail, …_subclasses_are_not_considered_
 *   as_matching, …_as_a_xsd_regex_pattern_1_2, …_as_an_enumeration_3_3).
 * - In IFC2X3 an element of an occurrence class (`IFCDISTRIBUTIONCONTROLELEMENT`)
 *   typed by a type object of the IDS occurrence/type mapping table also
 *   matches the table's name for it (`IFCSENSOR`), and the validator matches
 *   either name on it (`matchesIfc2x3Mapping`). So a pair meets when both
 *   facets admit one row's element, decided as the validator decides it,
 *   for simple values, enumerations and patterns. Two mapping names, or a
 *   class above the occurrence class, still never meet (#ISSUE).
 */

import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import type { IfcSchemaVersion } from '@ifc-lite/data';
import type { IDSEntityFacet } from '../../types.js';
import type { IDSAuditIssue } from '../types.js';
import { matchConstraint } from '../../constraints/index.js';
import { IFC2X3_TYPE_MAPPING_ROWS, type Ifc2x3TypeMappingRow } from '../../facets/ifc2x3-type-mapping.js';

export type EntityResolver = (facet: IDSEntityFacet, version: IfcSchemaVersion) => Promise<string[]>;

/** Literal entity names (simple value or enumeration) must be written in upper case. */
export function auditEntityNameCase(facet: IDSEntityFacet, path: string, issues: IDSAuditIssue[]): void {
  const names = facet.name.type === 'simpleValue' ? [facet.name.value]
    : facet.name.type === 'enumeration' ? facet.name.values
      : [];
  for (const name of names) {
    if (!name || name === name.toUpperCase()) continue;
    issues.push({
      severity: 'error',
      code: 'E_IFC_ENTITY_CASE',
      message: `entity name "${name}" must be upper case ("${name.toUpperCase()}"); IDS entity names are case-sensitive`,
      path: `${path}.name`,
      facetType: 'entity',
      detail: { value: name, expected: name.toUpperCase() },
    });
  }
}

export async function auditEntityRequirement(
  requirement: IDSEntityFacet,
  applicability: IDSEntityFacet | undefined,
  version: IfcSchemaVersion,
  resolve: EntityResolver,
  path: string,
  issues: IDSAuditIssue[],
): Promise<void> {
  if (!applicability) return;
  const [applicable, required] = await Promise.all([resolve(applicability, version), resolve(requirement, version)]);
  // An unresolvable side (bad pattern, unknown schema) proves nothing.
  if (applicable.length === 0 || required.length === 0) return;
  const admitted = new Set(required.map((name) => name.toUpperCase()));
  if (applicable.some((name) => admitted.has(name.toUpperCase()))) return;
  if (version === 'IFC2X3' && meetThroughMapping([applicability, applicable], [requirement, required])) return;
  issues.push({
    severity: 'error',
    code: 'E_IFC_ENTITY_IMPOSSIBLE',
    message: `the required entity (${preview(required)}) is never one of the applicable entities (${preview(applicable)}) in ${version}, so every applicable element fails; IDS entity facets match the exact class, not subclasses`,
    path: `${path}.name`,
    facetType: 'entity',
    detail: { required: preview(required), applicable: preview(applicable), version },
  });
}

type Side = [facet: IDSEntityFacet, classes: readonly string[]];

/**
 * IFC2X3: whether one element of a mapping row can meet both facets. A facet
 * admits that element when its resolved classes hold the row's occurrence
 * class, or when its name matches the row's name as the validator matches it
 * (`matchConstraint`, case-insensitive).
 */
function meetThroughMapping(...sides: [Side, Side]): boolean {
  const admitters = sides.map(([facet, classes]) => {
    const upper = new Set(classes.map((name) => name.toUpperCase()));
    return (row: Ifc2x3TypeMappingRow) => upper.has(row.occurrence) || matchesName(facet, row.alias);
  });
  return IFC2X3_TYPE_MAPPING_ROWS.some((row) => admitters.every((admits) => admits(row)));
}

/** A pattern the validator cannot evaluate fails its specification there; here it matches no mapping name, so the verdict stays the class check's. */
function matchesName(facet: IDSEntityFacet, name: string): boolean {
  try {
    return matchConstraint(facet.name, name, { caseInsensitive: true });
  } catch (error) {
    if (error instanceof UnsafeRegexPatternError) return false;
    throw error;
  }
}

function preview(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((n) => n.toUpperCase()).join(', ');
  return names.length > 5 ? `${shown}, … ${names.length - 5} more` : shown;
}
