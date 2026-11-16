/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In IFC2X3 the IDS occurrence/type mapping table lets an entity facet name an
 * IFC4 class (`IFCSENSOR`) that matches an occurrence class
 * (`IFCDISTRIBUTIONCONTROLELEMENT`) typed by its type object. The validator
 * matches both names on such an element, through a simple value, an
 * enumeration or a pattern. The audit must apply the same table (#ISSUE): it
 * must not call an entity requirement impossible that such an element meets,
 * and must check a classification, material, partOf or property set against
 * the class the name selects. Two mapping names, or a class above the
 * occurrence class, still never meet, and IFC4 is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { auditIDSDocument } from './index.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from '../bridge/index.js';

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
/** `~P` is the pattern P, `A B` an enumeration, anything else a simple value. */
const name = (n: string) => n.startsWith('~')
  ? `<xs:restriction base="xs:string"><xs:pattern value="${n.slice(1)}"/></xs:restriction>`
  : n.includes(' ')
    ? `<xs:restriction base="xs:string">${n.split(' ').map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`
    : sv(n);
const entity = (n: string) => `<entity><name>${name(n)}</name></entity>`;

function ids(applicability: string, requirement: string, ifcVersion = 'IFC2X3'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Mapping names</title></info>
  <specifications>
    <specification name="s" ifcVersion="${ifcVersion}">
      <applicability maxOccurs="unbounded">${applicability}</applicability>
      <requirements>${requirement}</requirements>
    </specification>
  </specifications>
</ids>
`;
}

async function codes(applicability: string, requirement: string, code: string, ifcVersion = 'IFC2X3') {
  const report = await auditIDSDocument(ids(applicability, requirement, ifcVersion));
  return report.issues.filter((i) => i.code === code).map((i) => i.detail?.version);
}

const impossible = (applicable: string, required: string, ifcVersion = 'IFC2X3') =>
  codes(entity(applicable), entity(required), 'E_IFC_ENTITY_IMPOSSIBLE', ifcVersion);

describe('audit: a mapping name meets its IFC2X3 occurrence class (#ISSUE)', () => {
  it.each([
    ['IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR'],
    ['IFCSENSOR', 'IFCDISTRIBUTIONCONTROLELEMENT'],
    ['IFCFLOWTERMINAL', 'IFCAIRTERMINAL'],
    ['IFCAIRTERMINAL', 'IFCFLOWTERMINAL'],
    ['IFCDISTRIBUTIONCONTROLELEMENT', 'IFCSENSOR IFCACTUATOR'],
    ['IFCSENSOR IFCWALL', 'IFCDISTRIBUTIONCONTROLELEMENT'],
    ['IFCDISTRIBUTIONCONTROLELEMENT', '~IFCSENSOR.*'],
    ['~IFCSENSOR.*', 'IFCDISTRIBUTIONCONTROLELEMENT'],
    ['~IFCSENS.*', 'IFCSENSOR'],
    ['IFCDISTRIBUTIONCONTROLELEMENT', '~IFCSENSOR|IFCACTUATOR'],
  ])('applicability %s, requirement %s: no E_IFC_ENTITY_IMPOSSIBLE', async (applicable, required) => {
    expect(await impossible(applicable, required)).toEqual([]);
  });

  it.each([
    ['IFCSENSOR', 'IFCACTUATOR', 'two mapping names of one occurrence class'],
    ['~IFCSENSOR.*', 'IFCACTUATOR', 'a pattern for one mapping name and another'],
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
    expect(await impossible('IFCDISTRIBUTIONCONTROLELEMENT', '~IFCSENSOR.*', 'IFC4')).toEqual(['IFC4']);
  });
});

const CLASSIFICATION = `<classification><system>${sv('Uniclass')}</system></classification>`;
const MATERIAL = '<material/>';
const partOf = (relation: string, whole: string) => `<partOf relation="${relation}">${entity(whole)}</partOf>`;
const property = (set: string, baseName: string) => `<property><propertySet>${sv(set)}</propertySet><baseName>${sv(baseName)}</baseName></property>`;
const CONTAINED = partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY');
const OCCURRENCE_SET = property('Pset_ManufacturerTypeInformation', 'Manufacturer');
const TYPE_SET = property('Pset_SensorTypeTemperatureSensor', 'TemperatureSensorRange');

describe('audit: a mapping name selects its IFC2X3 occurrence class for the other checks (#ISSUE)', () => {
  it.each([
    ['IFCSENSOR', CLASSIFICATION, 'a classification', 'E_IFC_PARTOF_ENTITY'],
    ['IFCSENSOR', MATERIAL, 'a material', 'E_IFC_PARTOF_ENTITY'],
    ['IFCSENSOR', CONTAINED, 'a partOf whose member is an IfcProduct', 'E_IFC_PARTOF_ENTITY'],
    ['IFCSENSOR', OCCURRENCE_SET, 'a property set of IfcElement', 'E_IFC_PROP_NOT_IN_PSET'],
    ['IFCSENSOR', TYPE_SET, 'a property set of the type object', 'E_IFC_PROP_NOT_IN_PSET'],
    ['IFCAIRTERMINAL', property('Pset_AirTerminalTypeCommon', 'FlowPattern'), 'a property set of the type object', 'E_IFC_PROP_NOT_IN_PSET'],
  ])('applicability %s with %s (%s): no %s', async (applicable, requirement, _what, code) => {
    expect(await codes(entity(applicable), requirement, code)).toEqual([]);
  });

  it.each([
    ['IFCSENSOR', partOf('IFCRELVOIDSELEMENT', 'IFCWALL'), 'a partOf whose member is an opening', 'E_IFC_PARTOF_ENTITY'],
    ['IFCSENSOR', property('Pset_WallCommon', 'IsExternal'), 'a property set of IfcWall', 'E_IFC_PROP_NOT_IN_PSET'],
    ['IFCCARTESIANPOINT', CLASSIFICATION, 'a class outside IfcRoot (control)', 'E_IFC_PARTOF_ENTITY'],
  ])('applicability %s with %s (%s): still %s', async (applicable, requirement, _what, code) => {
    expect(await codes(entity(applicable), requirement, code)).toEqual(['IFC2X3']);
  });

  it('reads the attribute check as before: a mapping name has no attributes to check', async () => {
    const report = await auditIDSDocument(ids(entity('IFCSENSOR'), `<attribute><name>${sv('Name')}</name></attribute>`));
    expect(report.issues).toEqual([]);
  });
});

// An IFC2X3 model: one control element typed as a sensor, one as an actuator.
// The sensor is classified, has a material, is contained in a storey and carries
// Pset_ManufacturerTypeInformation; its type carries Pset_SensorTypeTemperatureSensor.
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
#20=IFCSENSORTYPE('0Bd9sN2uK6fQ1oM5lR3zT0',$,'ST',$,$,(#60),$,$,$,.TEMPERATURESENSOR.);
#21=IFCACTUATORTYPE('1xdwj8qGXK4hzoNbvMdXJW',$,'AT',$,$,$,$,$,$,.ELECTRICACTUATOR.);
#30=IFCRELDEFINESBYTYPE('0aF8zX9mT1Hx2V3cP4kL5n',$,$,$,(#10),#20);
#31=IFCRELDEFINESBYTYPE('16MocU_IDOF8_x3Iqllz0d',$,$,$,(#11),#21);
#40=IFCCLASSIFICATION('x','1',$,'Uniclass');
#41=IFCCLASSIFICATIONREFERENCE($,'Pr_60','Sensors',#40);
#42=IFCRELASSOCIATESCLASSIFICATION('1hqIFTRjfV6AWq_bMtnZw1',$,$,$,(#10),#41);
#50=IFCMATERIAL('Steel');
#51=IFCRELASSOCIATESMATERIAL('1hqIFTRjfV6AWq_bMtnZw2',$,$,$,(#10),#50);
#55=IFCBUILDINGSTOREY('1hqIFTRjfV6AWq_bMtnZw3',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#56=IFCRELCONTAINEDINSPATIALSTRUCTURE('1hqIFTRjfV6AWq_bMtnZw4',$,$,$,(#10),#55);
#60=IFCPROPERTYSET('1hqIFTRjfV6AWq_bMtnZw5',$,'Pset_SensorTypeTemperatureSensor',$,(#61));
#61=IFCPROPERTYSINGLEVALUE('TemperatureSensorRange',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(373.),$);
#62=IFCPROPERTYSET('1hqIFTRjfV6AWq_bMtnZw6',$,'Pset_ManufacturerTypeInformation',$,(#63));
#63=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('M'),$);
#64=IFCRELDEFINESBYPROPERTIES('1hqIFTRjfV6AWq_bMtnZw7',$,$,$,(#10),#62);
ENDSEC;
END-ISO-10303-21;
`;

async function validate(applicability: string, requirement: string) {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
  const report = await validateIDS(parseIDS(ids(applicability, requirement)), createDataAccessor(store), {
    modelId: 'm', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  const r = report.specificationResults[0];
  return { applicable: r.applicableCount, passed: r.passedCount, failed: r.failedCount };
}

describe('the validator agrees: what the audit now accepts can pass (#ISSUE)', () => {
  it('a control element requirement IFCSENSOR passes the sensor and fails the actuator', async () => {
    expect(await validate(entity('IFCDISTRIBUTIONCONTROLELEMENT'), entity('IFCSENSOR'))).toEqual({ applicable: 2, passed: 1, failed: 1 });
  });

  it('a sensor requirement IFCDISTRIBUTIONCONTROLELEMENT passes every sensor', async () => {
    expect(await validate(entity('IFCSENSOR'), entity('IFCDISTRIBUTIONCONTROLELEMENT'))).toEqual({ applicable: 1, passed: 1, failed: 0 });
  });

  it('a sensor requirement IFCACTUATOR fails every sensor, as the audit says', async () => {
    expect(await validate(entity('IFCSENSOR'), entity('IFCACTUATOR'))).toEqual({ applicable: 1, passed: 0, failed: 1 });
  });

  // As an applicability, IFCSENSOR.* and IFCSENS.* also select the IfcSensorType
  // object by its own class name; it fails the requirement, the sensor passes.
  it.each([
    ['IFCDISTRIBUTIONCONTROLELEMENT', '~IFCSENSOR.*', { applicable: 2, passed: 1, failed: 1 }],
    ['~IFCSENSOR.*', 'IFCDISTRIBUTIONCONTROLELEMENT', { applicable: 2, passed: 1, failed: 1 }],
    ['~IFCSENS.*', 'IFCSENSOR', { applicable: 2, passed: 1, failed: 1 }],
    ['IFCDISTRIBUTIONCONTROLELEMENT', '~IFCSENSOR|IFCACTUATOR', { applicable: 2, passed: 2, failed: 0 }],
  ])('applicability %s, requirement %s: as the audit now says, it can pass', async (applicable, required, result) => {
    expect(await validate(entity(applicable), entity(required))).toEqual(result);
  });

  it.each([
    ['a classification', CLASSIFICATION],
    ['a material', MATERIAL],
    ['a partOf its storey', CONTAINED],
    ['a property of its own set', OCCURRENCE_SET],
    ['a property of its type', TYPE_SET],
  ])('a sensor requirement of %s passes the sensor', async (_what, requirement) => {
    expect(await validate(entity('IFCSENSOR'), requirement)).toEqual({ applicable: 1, passed: 1, failed: 0 });
  });
});
