/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In IFC2X3 the IDS occurrence/type mapping table lets an entity facet name an
 * IFC4 class (`IFCSENSOR`) that matches an occurrence class
 * (`IFCDISTRIBUTIONCONTROLELEMENT`) typed by its type object. The validator
 * matches both names on such an element, so an applicability naming one and
 * a requirement naming the other can pass. The audit must not call that
 * requirement impossible (#ISSUE). Two mapping names, or a class above the
 * occurrence class, still never meet.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { auditIDSDocument } from './index.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from '../bridge/index.js';

const name = (n: string) => n.includes(' ')
  ? `<xs:restriction base="xs:string">${n.split(' ').map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`
  : `<simpleValue>${n}</simpleValue>`;

function ids(applicable: string, required: string, ifcVersion = 'IFC2X3'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Mapping names</title></info>
  <specifications>
    <specification name="s" ifcVersion="${ifcVersion}">
      <applicability maxOccurs="unbounded"><entity><name>${name(applicable)}</name></entity></applicability>
      <requirements><entity><name>${name(required)}</name></entity></requirements>
    </specification>
  </specifications>
</ids>
`;
}

async function impossible(applicable: string, required: string, ifcVersion = 'IFC2X3') {
  const report = await auditIDSDocument(ids(applicable, required, ifcVersion));
  return report.issues.filter((i) => i.code === 'E_IFC_ENTITY_IMPOSSIBLE').map((i) => i.detail?.version);
}

describe('audit: a mapping name meets its IFC2X3 occurrence class (#ISSUE)', () => {
  it.each([
    ['IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR'],
    ['IFCSENSOR', 'IFCDISTRIBUTIONCONTROLELEMENT'],
    ['IFCFLOWTERMINAL', 'IFCAIRTERMINAL'],
    ['IFCAIRTERMINAL', 'IFCFLOWTERMINAL'],
    ['IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR IFCACTUATOR'],
    ['IFCSENSOR IFCWALL', 'IFCDISTRIBUTIONCONTROLELEMENT'],
  ])('applicability %s, requirement %s: no E_IFC_ENTITY_IMPOSSIBLE', async (applicable, required) => {
    expect(await impossible(applicable, required)).toEqual([]);
  });

  it.each([
    ['IFCSENSOR', 'IFCACTUATOR', 'two mapping names of one occurrence class'],
    ['IFCSENSOR', 'IFCDISTRIBUTIONELEMENT', 'the parent of the occurrence class'],
    ['IFCSENSOR', 'IFCFLOWTERMINAL', 'another occurrence class'],
    ['IFCDISTRIBUTIONCONTROLELEMENT', 'IFCAIRTERMINAL', 'a mapping name of another occurrence class'],
    ['IFCWALL', 'IFCSLAB', 'two plain classes (control)'],
  ])('applicability %s, requirement %s (%s): still E_IFC_ENTITY_IMPOSSIBLE', async (applicable, required) => {
    expect(await impossible(applicable, required)).toEqual(['IFC2X3']);
  });

  it('keeps the error in IFC4, which has the class itself and no mapping', async () => {
    expect(await impossible('IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR', 'IFC4')).toEqual(['IFC4']);
    expect(await impossible('IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR', 'IFC2X3 IFC4')).toEqual(['IFC4']);
  });
});

// An IFC2X3 model: one control element typed as a sensor, one as an actuator.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,'P',$,$,$,$,$,$);
#10=IFCDISTRIBUTIONCONTROLELEMENT('2nJrDaLQfJ1QPhdJR0o97J',$,'S',$,$,$,$,$,$);
#11=IFCDISTRIBUTIONCONTROLELEMENT('3Zc8rM1tJ5dP0nL4kQ2yS9',$,'A',$,$,$,$,$,$);
#20=IFCSENSORTYPE('0Bd9sN2uK6fQ1oM5lR3zT0',$,'ST',$,$,$,$,$,$,.TEMPERATURESENSOR.);
#21=IFCACTUATORTYPE('1xdwj8qGXK4hzoNbvMdXJW',$,'AT',$,$,$,$,$,$,.ELECTRICACTUATOR.);
#30=IFCRELDEFINESBYTYPE('0aF8zX9mT1Hx2V3cP4kL5n',$,$,$,(#10),#20);
#31=IFCRELDEFINESBYTYPE('16MocU_IDOF8_x3Iqllz0d',$,$,$,(#11),#21);
ENDSEC;
END-ISO-10303-21;
`;

async function validate(applicable: string, required: string) {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
  const report = await validateIDS(parseIDS(ids(applicable, required)), createDataAccessor(store), {
    modelId: 'm', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  const r = report.specificationResults[0];
  return { applicable: r.applicableCount, passed: r.passedCount, failed: r.failedCount };
}

describe('the validator agrees: such a requirement can pass (#ISSUE)', () => {
  it('a control element requirement IFCSENSOR passes the sensor and fails the actuator', async () => {
    expect(await validate('IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR')).toEqual({ applicable: 2, passed: 1, failed: 1 });
  });

  it('a sensor requirement IFCDISTRIBUTIONCONTROLELEMENT passes every sensor', async () => {
    expect(await validate('IFCSENSOR', 'IFCDISTRIBUTIONCONTROLELEMENT')).toEqual({ applicable: 1, passed: 1, failed: 0 });
  });

  it('a sensor requirement IFCACTUATOR fails every sensor, as the audit says', async () => {
    expect(await validate('IFCSENSOR', 'IFCACTUATOR')).toEqual({ applicable: 1, passed: 0, failed: 1 });
  });
});
