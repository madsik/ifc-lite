/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #ISSUE, a follow-up to #7543: an IFCBOOLEAN or IFCLOGICAL member of an
 * `IfcPropertyListValue` or `IfcPropertyEnumeratedValue` reached the facets
 * as its STEP token (`.T.`, `.F.`; the server's data model writes `T`, `F`),
 * so `true`, `false`, `1` and `0` matched none of them. The same boolean in
 * an `IfcPropertySingleValue` matched. A list or enumeration whose members
 * share a boolean type now holds the booleans they name.
 *
 * The expected rows are IfcTester's: ifctester 0.8.3 on IfcOpenShell 0.8.4
 * (`ids.open(..., validate=True)`) on the same IFC and IDS text, under all
 * three schemas.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore, type PropertySet } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { checkPropertyFacet } from './property-facet.js';
import type { IDSPropertyFacet, IDSSimpleValue, IDSValidationReport } from '../types.js';

const gid = (n: number) => String(n).padStart(22, '0');

const ifcWith = (schema: string, properties: string[]) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=${schema === 'IFC2X3' ? `IFCWALL('${gid(10)}',$,'W',$,$,$,$,$)` : `IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$)`};
${properties.map((p, i) => `#${11 + i}=${p};`).join('\n')}
#40=IFCPROPERTYSET('${gid(40)}',$,'Probe_Set',$,(${properties.map((_, i) => `#${11 + i}`).join(',')}));
#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#10),#40);
ENDSEC;
END-ISO-10303-21;
`;

const PROPERTIES = [
  "IFCPROPERTYLISTVALUE('Flags',$,(IFCBOOLEAN(.T.),IFCBOOLEAN(.F.)),$)",
  "IFCPROPERTYLISTVALUE('OnlyTrue',$,(IFCBOOLEAN(.T.)),$)",
  "IFCPROPERTYENUMERATEDVALUE('Choice',$,(IFCBOOLEAN(.T.)),$)",
  "IFCPROPERTYLISTVALUE('Logicals',$,(IFCLOGICAL(.T.),IFCLOGICAL(.U.)),$)",
  "IFCPROPERTYLISTVALUE('LogicalF',$,(IFCLOGICAL(.F.)),$)",
  "IFCPROPERTYLISTVALUE('LogicalU',$,(IFCLOGICAL(.U.)),$)",
  "IFCPROPERTYSINGLEVALUE('Single',$,IFCBOOLEAN(.T.),$)",
];

async function parse(ifcText: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifcText);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
}

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
const list = (...v: string[]) =>
  `<xs:restriction base="xs:boolean">${v.map((x) => `<xs:enumeration value="${x}"/>`).join('')}</xs:restriction>`;
const wall = `<entity><name>${sv('IFCWALL')}</name></entity>`;
const prop = (dataType: string, name: string, value: string, cardinality = '') =>
  `<property${dataType ? ` dataType="${dataType}"` : ''}${cardinality ? ` cardinality="${cardinality}"` : ''}><propertySet>${sv('Probe_Set')}</propertySet><baseName>${sv(name)}</baseName>${value ? `<value>${value}</value>` : ''}</property>`;
const named = `<attribute><name>${sv('Name')}</name><value>${sv('Required')}</value></attribute>`;
const spec = (name: string, applicability: string, requirements: string) => `
    <specification name="${name}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability>
      <requirements>${requirements}</requirements>
    </specification>`;

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#ISSUE</title></info>
  <specifications>${[
    spec('Single = true (control)', wall, prop('IFCBOOLEAN', 'Single', sv('true'))),
    spec('Flags = true', wall, prop('IFCBOOLEAN', 'Flags', sv('true'))),
    spec('Flags = false', wall, prop('IFCBOOLEAN', 'Flags', sv('false'))),
    spec('Flags = 1', wall, prop('IFCBOOLEAN', 'Flags', sv('1'))),
    spec('Flags = 0', wall, prop('IFCBOOLEAN', 'Flags', sv('0'))),
    spec('OnlyTrue = false', wall, prop('IFCBOOLEAN', 'OnlyTrue', sv('false'))),
    spec('OnlyTrue = 0', wall, prop('IFCBOOLEAN', 'OnlyTrue', sv('0'))),
    spec('Choice = true', wall, prop('IFCBOOLEAN', 'Choice', sv('true'))),
    spec('Flags in {true}', wall, prop('IFCBOOLEAN', 'Flags', list('true'))),
    spec('OnlyTrue in {false, 0}', wall, prop('IFCBOOLEAN', 'OnlyTrue', list('false', '0'))),
    spec('Flags = true prohibited', wall, prop('', 'Flags', sv('true'), 'prohibited')),
    spec('Logicals = true', wall, prop('IFCLOGICAL', 'Logicals', sv('true'))),
    spec('LogicalF = false', wall, prop('IFCLOGICAL', 'LogicalF', sv('false'))),
    spec('LogicalF = 0', wall, prop('IFCLOGICAL', 'LogicalF', sv('0'))),
    spec('LogicalU = true', wall, prop('IFCLOGICAL', 'LogicalU', sv('true'))),
    spec('LogicalU exists', wall, prop('IFCLOGICAL', 'LogicalU', '')),
    spec('Flags = true selects the wall', wall + prop('IFCBOOLEAN', 'Flags', sv('true')), named),
  ].join('')}
  </specifications>
</ids>`;

const verdict = (r: IDSValidationReport['specificationResults'][number]) =>
  `${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}`;

describe('list and enumerated booleans on a parsed wall (#ISSUE)', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3_ADD2'])('%s: every row gives IfcTester\'s answer', async (schema) => {
    const store = await parse(ifcWith(schema, PROPERTIES));
    const report = await validateIDS(parseIDS(IDS), createDataAccessor(store), {
      modelId: 'list-boolean-members', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
    });
    expect(Object.fromEntries(report.specificationResults.map((r) => [r.specification.name, verdict(r)]))).toEqual({
      'Single = true (control)': 'pass, applicable 1, failed 0',
      'Flags = true': 'pass, applicable 1, failed 0',
      'Flags = false': 'pass, applicable 1, failed 0',
      'Flags = 1': 'pass, applicable 1, failed 0',
      'Flags = 0': 'pass, applicable 1, failed 0',
      'OnlyTrue = false': 'fail, applicable 1, failed 1',
      'OnlyTrue = 0': 'fail, applicable 1, failed 1',
      'Choice = true': 'pass, applicable 1, failed 0',
      'Flags in {true}': 'pass, applicable 1, failed 0',
      'OnlyTrue in {false, 0}': 'fail, applicable 1, failed 1',
      // The wall holds Flags = true, so the prohibition must fail it; on main
      // `true` matched no member and the prohibition passed the wall.
      'Flags = true prohibited': 'fail, applicable 1, failed 1',
      // IFCLOGICAL `.T.` and `.F.` are booleans too. `.U.` names none: it
      // matches no boolean literal, and the property still has a value.
      'Logicals = true': 'pass, applicable 1, failed 0',
      'LogicalF = false': 'pass, applicable 1, failed 0',
      'LogicalF = 0': 'pass, applicable 1, failed 0',
      'LogicalU = true': 'fail, applicable 1, failed 1',
      'LogicalU exists': 'pass, applicable 1, failed 0',
      // The wall is named W, so once selected it must fail; on main the
      // applicability selected nothing and the specification passed.
      'Flags = true selects the wall': 'fail, applicable 1, failed 1',
    });
  });

  it('a one-member list answers every value shape as the single value does', async () => {
    // OnlyTrue is the list (IFCBOOLEAN(.T.)), Single is IFCBOOLEAN(.T.). The
    // shapes include literals outside the xs:boolean lexical space and the
    // STEP token itself: none of them may tell the two apart. IfcTester gives
    // the list the single value's answer in every row too.
    const restriction = (base: string, facets: Array<[string, string]>) =>
      `<xs:restriction base="${base}">${facets.map(([f, v]) => `<xs:${f} value="${v}"/>`).join('')}</xs:restriction>`;
    const shapes: Array<[string, string]> = [
      ['true', sv('true')], ['false', sv('false')], ['1', sv('1')], ['0', sv('0')],
      ['TRUE', sv('TRUE')], ['.T.', sv('.T.')], ['T', sv('T')],
      ['pattern t.*', restriction('xs:string', [['pattern', 't.*']])],
      ['pattern \\.T\\.', restriction('xs:string', [['pattern', '\\.T\\.']])],
      ['enumeration .T.', restriction('xs:string', [['enumeration', '.T.']])],
      ['enumeration true, 0', restriction('xs:boolean', [['enumeration', 'true'], ['enumeration', '0']])],
      ['enumeration 1', restriction('xs:boolean', [['enumeration', '1']])],
    ];
    const ids = IDS.replace(/<specifications>[\s\S]*<\/specifications>/, `<specifications>${shapes.flatMap(([shape, value]) => [
      spec(`Single: ${shape}`, wall, prop('IFCBOOLEAN', 'Single', value)),
      spec(`OnlyTrue: ${shape}`, wall, prop('IFCBOOLEAN', 'OnlyTrue', value)),
    ]).join('')}</specifications>`);
    const store = await parse(ifcWith('IFC4', PROPERTIES));
    const report = await validateIDS(parseIDS(ids), createDataAccessor(store), {
      modelId: 'list-boolean-members', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
    });
    const status = new Map(report.specificationResults.map((r) => [r.specification.name, r.status]));
    const answers = (prefix: string) => Object.fromEntries(shapes.map(([shape]) => [shape, status.get(`${prefix}: ${shape}`)]));
    expect(new Set(Object.values(answers('Single')))).toEqual(new Set(['pass', 'fail']));
    expect(answers('OnlyTrue')).toEqual(answers('Single'));
  });

  it('createDataAccessor holds the members as booleans and shows them as true and false', async () => {
    const store = await parse(ifcWith('IFC4', PROPERTIES));
    const props = createDataAccessor(store).getPropertySets(10).flatMap((s) => s.properties);
    const byName = (name: string) => props.find((p) => p.name === name);
    expect(byName('Flags')).toMatchObject({ value: 'true, false', values: [true, false], dataType: 'IFCBOOLEAN' });
    expect(byName('Choice')).toMatchObject({ value: 'true', values: [true], dataType: 'IFCBOOLEAN' });
    expect(byName('Logicals')).toMatchObject({ value: 'true, .U.', values: [true, '.U.'], dataType: 'IFCLOGICAL' });
    expect(byName('Single')).toMatchObject({ value: true, dataType: 'IFCBOOLEAN' });
  });
});

describe('a list of booleans on a server-parsed store (#ISSUE)', () => {
  // The server's data model writes a list member's STEP token without its
  // dots (`member_list` in rust/processing/src/data_model/property_value.rs),
  // and the viewer hands the candidates to the bridge as they arrive.
  function serverStore(): IfcDataStore {
    const psets = [{
      name: 'Probe_Set',
      globalId: '',
      properties: [
        { name: 'Flags', type: 0, value: 'T, F', values: ['T', 'F'], dataType: 'IFCBOOLEAN' },
        { name: 'OnlyTrue', type: 0, value: 'T', values: ['T'], dataType: 'IFCBOOLEAN' },
      ],
    }] as unknown as PropertySet[];
    return {
      schemaVersion: 'IFC4',
      source: new Uint8Array(),
      entities: {
        getTypeName: (id: number) => (id === 10 ? 'IfcWall' : undefined),
        getByType: () => [10],
        getName: () => undefined,
        getGlobalId: () => undefined,
        getDescription: () => undefined,
        getObjectType: () => undefined,
      },
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: { getRelated: () => [] },
      properties: { getForEntity: (id: number) => (id === 10 ? psets : []) },
      quantities: { getForEntity: () => [] },
    } as unknown as IfcDataStore;
  }
  const simple = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });
  const facet = (baseName: string, value: string): IDSPropertyFacet => ({
    type: 'property', propertySet: simple('Probe_Set'), baseName: simple(baseName), dataType: simple('IFCBOOLEAN'), value: simple(value),
  });

  it('matches true, false, 1 and 0 against T and F', () => {
    const accessor = createDataAccessor(serverStore());
    for (const value of ['true', 'false', '1', '0']) {
      expect(checkPropertyFacet(facet('Flags', value), 10, accessor).passed, value).toBe(true);
    }
    expect(checkPropertyFacet(facet('OnlyTrue', 'false'), 10, accessor).passed).toBe(false);
    expect(checkPropertyFacet(facet('OnlyTrue', '0'), 10, accessor).passed).toBe(false);
  });
});

describe('members that are not booleans keep their text (#ISSUE)', () => {
  it('a list of labels that read .T. and T stays a list of labels', async () => {
    const store = await parse(ifcWith('IFC4', ["IFCPROPERTYLISTVALUE('Codes',$,(IFCLABEL('.T.'),IFCLABEL('T')),$)"]));
    const accessor = createDataAccessor(store);
    const codes = accessor.getPropertySets(10).flatMap((s) => s.properties).find((p) => p.name === 'Codes');
    expect(codes).toMatchObject({ value: '.T., T', values: ['.T.', 'T'], dataType: 'IFCLABEL' });
    const facet = (value: string): IDSPropertyFacet => ({
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Probe_Set' },
      baseName: { type: 'simpleValue', value: 'Codes' },
      value: { type: 'simpleValue', value },
    });
    expect(checkPropertyFacet(facet('true'), 10, accessor).passed).toBe(false);
    expect(checkPropertyFacet(facet('T'), 10, accessor).passed).toBe(true);
    expect(checkPropertyFacet(facet('.T.'), 10, accessor).passed).toBe(true);
  });
});
