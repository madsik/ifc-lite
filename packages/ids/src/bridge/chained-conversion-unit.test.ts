/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property whose own Unit is a conversion-based unit defined over another
 * conversion-based unit is compared in SI through the whole chain (#ISSUE):
 * 10 in a foot of 12 inches, the inch 0.0254 m, is 3.048 m, not 120 m. The
 * same holds for a project unit read through `extractProjectUnits`: 100 in a
 * project square foot of 144 square inches is 9.290304 m².
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// Metre project; `#7` is the project area unit (square metre, or the chained square foot).
function ifc(projectArea: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#6=IFCUNITASSIGNMENT((#2,#${projectArea}));
#10=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#11=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.0254),#2);
#12=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'INCH',#11);
#13=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(12.),#12);
#14=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#13);
#15=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#2);
#16=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#15);
#20=IFCDIMENSIONALEXPONENTS(2,0,0,0,0,0,0);
#21=IFCMEASUREWITHUNIT(IFCAREAMEASURE(0.00064516),#3);
#22=IFCCONVERSIONBASEDUNIT(#20,.AREAUNIT.,'square inch',#21);
#23=IFCMEASUREWITHUNIT(IFCAREAMEASURE(144.),#22);
#7=IFCCONVERSIONBASEDUNIT(#20,.AREAUNIT.,'square foot',#23);
#100=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,'W',$,$,$,$,$,$);
#101=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Probe',$,(#102,#103,#104));
#102=IFCPROPERTYSINGLEVALUE('Span',$,IFCLENGTHMEASURE(10.),#14);
#103=IFCPROPERTYSINGLEVALUE('Plain span',$,IFCLENGTHMEASURE(10.),#16);
#104=IFCPROPERTYSINGLEVALUE('Floor',$,IFCAREAMEASURE(100.),$);
#105=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#100),#101);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

async function value(source: string, name: string) {
  return createDataAccessor(await parse(source)).getPropertySets(100)
    .find((p) => p.name === 'Probe')?.properties.find((p) => p.name === name)?.value;
}

function ids(name: string, dataType: string, value: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Chained unit</title></info>
  <specifications>
    <specification name="chained unit" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="${dataType}">
          <propertySet><simpleValue>Probe</simpleValue></propertySet>
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
    modelId: 'm1', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  return report.specificationResults[0].status;
}

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
const between = (lo: string, hi: string) =>
  `<xs:restriction base="xs:double"><xs:minInclusive value="${lo}"/><xs:maxInclusive value="${hi}"/></xs:restriction>`;

describe('IDS reads a conversion-based unit over another conversion-based unit in SI (#ISSUE)', () => {
  it('converts 10 in an own foot of 12 inches to 3.048 m', async () => {
    expect(Number(await value(ifc('3'), 'Span'))).toBeCloseTo(3.048, 12);
  });

  it('passes "Span between 3 and 3.1" and fails "Span = 120" end to end', async () => {
    expect(await status(ifc('3'), ids('Span', 'IFCLENGTHMEASURE', between('3', '3.1')))).toBe('pass');
    expect(await status(ifc('3'), ids('Span', 'IFCLENGTHMEASURE', sv('120')))).toBe('fail');
  });

  it('converts 100 in a project square foot of 144 square inches to 9.290304 m2', async () => {
    expect(Number(await value(ifc('7'), 'Floor'))).toBeCloseTo(9.290304, 9);
    expect(await status(ifc('7'), ids('Floor', 'IFCAREAMEASURE', between('9.29', '9.3')))).toBe('pass');
  });

  it('reads a foot over the metre, and a square metre project, as before (controls)', async () => {
    expect(Number(await value(ifc('3'), 'Plain span'))).toBeCloseTo(3.048, 12);
    expect(Number(await value(ifc('3'), 'Floor'))).toBe(100);
  });
});
