/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How an IDS entity name meets an IFC class.
 *
 * IDS 1.0 names an IFC class in upper case (`IFCWALL`): buildingSMART's
 * `entity/invalid-entities_must_be_specified_as_uppercase_strings`, and the
 * audit's `E_IFC_ENTITY_CASE`. A pattern or an enumeration is therefore
 * matched against the upper-case class name, case-sensitively, as IfcTester
 * does (`inst.is_a().upper()`). So `IFCDISTRIBUTION.*ELEMENT` selects
 * `IfcDistributionChamberElement`, and `IfcDistribution.*Element` or an
 * enumeration listing `IfcWall` selects nothing (#ISSUE).
 *
 * A simple value is the facet's own concern: the entity facet rejects a
 * simple value that is not upper case, and an upper-case one meets the
 * upper-case class exactly, as before.
 */

import type { IDSConstraint } from '../types.js';
import { matchConstraint } from '../constraints/index.js';

/** Does an IDS entity name constraint select this IFC class (any spelling of it)? */
export function matchesEntityName(name: IDSConstraint, ifcClass: string): boolean {
  return matchConstraint(name, ifcClass.toUpperCase());
}
