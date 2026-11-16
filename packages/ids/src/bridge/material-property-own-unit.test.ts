/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property in a material property set (IfcMaterialProperties, IFC2X3
 * IfcExtendedMaterialProperties) that declares its OWN `Unit` is in that
 * unit, as for an ordinary property set (#7395), and IDS compares it in SI
 * (#ISSUE). 200 with its own millimetre unit in a metre project is 0.2 m,
 * not 200 m.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

const MATERIAL = 20;
const WALL = 50;

// `#2` is the project length unit. #31 to #35 sit in a material property set
// and, as the control, in the wall's ordinary property set.
function ifc(schema: 'IFC4' | 'IFC2X3', projectLength = '$'): string {
  const material = schema === 'IFC2X3' ? `#20=IFCMATERIAL('Concrete');` : `#20=IFCMATERIAL('Concrete',$,$);`;
  const materialProps = schema === 'IFC2X3'
    ? `#30=IFCEXTENDEDMATERIALPROPERTIES(#20,(#31,#32,#33,#34,#35),$,'Probe_Material');`
    : `#30=IFCMATERIALPROPERTIES('Probe_Material',$,(#31,#32,#33,#34,#35),#20);`;
  const wall = schema === 'IFC2X3'
    ? `#50=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,'W',$,$,$,$,$);`
    : `#50=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,'W',$,$,$,$,$,$);`;
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${projectLength},.METRE.);
#6=IFCUNITASSIGNMENT((#2));
#9=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
${material}
${materialProps}
#31=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCPOSITIVELENGTHMEASURE(200.),#9);
#32=IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(300.),$);
#33=IFCPROPERTYLISTVALUE('Offsets',$,(IFCLENGTHMEASURE(250.),IFCLENGTHMEASURE(500.)),#9);
#34=IFCPROPERTYSINGLEVALUE('Odd',$,IFCLENGTHMEASURE(7.),#99);
#35=IFCPROPERTYSINGLEVALUE('Melting',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),#43);
#40=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);
#41=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);
#42=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#41);
#43=IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#42,-459.67);
${wall}
#51=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Probe_Material',$,(#31,#32,#33,#34,#35));
#52=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#50),#51);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

async function prop(source: string, expressId: number, name: string) {
  return createDataAccessor(await parse(source))
    .getPropertySets(expressId)
    .find((p) => p.name === 'Probe_Material')
    ?.properties.find((p) => p.name === name);
}

function ids(entity: string, name: string, value: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Material property own unit</title></info>
  <specifications>
    <specification name="own unit" ifcVersion="IFC2X3 IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>${entity}</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCPOSITIVELENGTHMEASURE">
          <propertySet><simpleValue>Probe_Material</simpleValue></propertySet>
          <baseName><simpleValue>${name}</simpleValue></baseName>
          <value>${value}</value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>
`;
}

async function status(source: string, idsXml: string) {
  const store = await parse(source);
  const report = await validateIDS(parseIDS(idsXml), createDataAccessor(store), {
    modelId: 'm1',
    schemaVersion: store.schemaVersion,
    entityCount: store.entityCount,
  });
  const result = report.specificationResults[0];
  return { status: result.status, applicable: result.applicableCount };
}

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
const atMost = (v: string) => `<xs:restriction base="xs:double"><xs:maxInclusive value="${v}"/></xs:restriction>`;

describe('IDS bridge honours a material property own Unit (#ISSUE)', () => {
  for (const schema of ['IFC4', 'IFC2X3'] as const) {
    it(`converts a material property with its own millimetre unit to metres (${schema})`, async () => {
      expect((await prop(ifc(schema), MATERIAL, 'Thickness'))?.value).toBeCloseTo(0.2, 12);
    });

    it(`passes "Thickness = 0.2" and "at most 1", and fails "= 200", end to end (${schema})`, async () => {
      expect(await status(ifc(schema), ids('IFCMATERIAL', 'Thickness', sv('0.2')))).toEqual({ status: 'pass', applicable: 1 });
      expect(await status(ifc(schema), ids('IFCMATERIAL', 'Thickness', atMost('1')))).toEqual({ status: 'pass', applicable: 1 });
      expect(await status(ifc(schema), ids('IFCMATERIAL', 'Thickness', sv('200')))).toEqual({ status: 'fail', applicable: 1 });
    });
  }

  it('converts list members with their own millimetre unit to metres', async () => {
    const values = (await prop(ifc('IFC4'), MATERIAL, 'Offsets'))?.values?.map(Number);
    expect(values?.[0]).toBeCloseTo(0.25, 12);
    expect(values?.[1]).toBeCloseTo(0.5, 12);
  });

  it('converts 68 in an own Fahrenheit unit to 293.15 K', async () => {
    expect(Number((await prop(ifc('IFC4'), MATERIAL, 'Melting'))?.value)).toBeCloseTo(293.15, 9);
  });

  it('reads a material property the same as its ordinary property set twin', async () => {
    for (const projectLength of ['$', '.MILLI.']) {
      for (const name of ['Thickness', 'Width', 'Offsets', 'Odd', 'Melting']) {
        const source = ifc('IFC4', projectLength);
        const material = await prop(source, MATERIAL, name);
        const ordinary = await prop(source, WALL, name);
        expect(ordinary).toBeDefined();
        expect({ projectLength, ...material }).toEqual({ projectLength, ...ordinary });
      }
    }
  });

  it('still applies the project unit to a material property without its own unit', async () => {
    expect((await prop(ifc('IFC4'), MATERIAL, 'Width'))?.value).toBe(300);
    expect((await prop(ifc('IFC4', '.MILLI.'), MATERIAL, 'Width'))?.value).toBeCloseTo(0.3, 12);
  });

  it('does not scale a value whose own unit cannot be resolved by the project factor', async () => {
    expect((await prop(ifc('IFC4', '.MILLI.'), MATERIAL, 'Odd'))?.value).toBe(7);
  });
});
