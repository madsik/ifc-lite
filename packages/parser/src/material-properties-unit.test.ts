/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property inside a material property set reports its own `Unit` the same
 * way a property in an ordinary property set does (#ISSUE): `unit`,
 * `unitSiScale` and, for a unit with an offset, `unitSiOffset`. Without them
 * a reader cannot tell 200 mm from 200 in the project unit.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractMaterialPropertiesForMaterialId, extractPropertiesOnDemand } from './index.js';
import type { MaterialPropertiesView } from './on-demand-extractors.js';

// Metre project. The material property set and the wall's ordinary property
// set hold the same seven declarations, so the two readers can be compared.
const PROPS = `#31=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCPOSITIVELENGTHMEASURE(200.),#9);
#32=IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(300.),$);
#33=IFCPROPERTYLISTVALUE('Offsets',$,(IFCLENGTHMEASURE(250.),IFCLENGTHMEASURE(500.)),#9);
#34=IFCPROPERTYBOUNDEDVALUE('Range',$,IFCLENGTHMEASURE(900.),IFCLENGTHMEASURE(100.),#9,$);
#35=IFCPROPERTYSINGLEVALUE('Odd',$,IFCLENGTHMEASURE(7.),#99);
#36=IFCPROPERTYSINGLEVALUE('Wrong Kind',$,IFCLENGTHMEASURE(7.),#10);
#37=IFCPROPERTYSINGLEVALUE('Melting',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),#43);`;
const LIST = '#31,#32,#33,#34,#35,#36,#37';

function ifc(schema: 'IFC4' | 'IFC2X3'): string {
  const material = schema === 'IFC2X3' ? `#20=IFCMATERIAL('Concrete');` : `#20=IFCMATERIAL('Concrete',$,$);`;
  const materialProps = schema === 'IFC2X3'
    ? `#30=IFCEXTENDEDMATERIALPROPERTIES(#20,(${LIST}),$,'Probe_Material');`
    : `#30=IFCMATERIALPROPERTIES('Probe_Material',$,(${LIST}),#20);`;
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
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCUNITASSIGNMENT((#2));
#9=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#40=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);
#41=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);
#42=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#41);
#43=IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#42,-459.67);
${material}
${materialProps}
${PROPS}
${wall}
#51=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Probe_Material',$,(${LIST}));
#52=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#50),#51);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(source: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
}

function materialProps(store: Awaited<ReturnType<typeof parse>>, view?: MaterialPropertiesView) {
  return extractMaterialPropertiesForMaterialId(store, 20, view)[0]?.psets[0]?.properties ?? [];
}

function unitFields(p: { name: string; unit?: string; unitSiScale?: number; unitSiOffset?: number }) {
  return { name: p.name, unit: p.unit, unitSiScale: p.unitSiScale, unitSiOffset: p.unitSiOffset };
}

describe('material property sets report a property own Unit (#ISSUE)', () => {
  for (const schema of ['IFC4', 'IFC2X3'] as const) {
    it(`reports a millimetre own unit on a material property (${schema})`, async () => {
      const thickness = materialProps(await parse(ifc(schema))).find((p) => p.name === 'Thickness');
      expect(thickness?.value).toBe(200);
      expect(thickness?.unit).toBe('mm');
      expect(thickness?.unitSiScale).toBeCloseTo(0.001, 15);
    });

    it(`gives every material property the unit fields its ordinary set twin gets (${schema})`, async () => {
      const store = await parse(ifc(schema));
      const ordinary = extractPropertiesOnDemand(store, 50).find((s) => s.name === 'Probe_Material')?.properties ?? [];
      const material = materialProps(store);
      expect(ordinary.map((p) => p.name)).toEqual(['Thickness', 'Width', 'Offsets', 'Range', 'Odd', 'Wrong Kind', 'Melting']);
      expect(material.map(unitFields)).toEqual(ordinary.map(unitFields));
    });
  }

  it('reports the offset of an own Fahrenheit unit', async () => {
    const melting = materialProps(await parse(ifc('IFC4'))).find((p) => p.name === 'Melting');
    expect(melting?.unitSiScale).toBeCloseTo(5 / 9, 12);
    expect(melting?.unitSiOffset).toBeCloseTo(255.3722222, 6);
  });

  it('reports an unresolvable own unit by its reference, with no scale', async () => {
    const props = materialProps(await parse(ifc('IFC4')));
    expect(unitFields(props.find((p) => p.name === 'Odd')!)).toEqual({ name: 'Odd', unit: '#99', unitSiScale: undefined, unitSiOffset: undefined });
    // An area unit on a length value names no unit this value can be in.
    expect(unitFields(props.find((p) => p.name === 'Wrong Kind')!)).toEqual({ name: 'Wrong Kind', unit: '#10', unitSiScale: undefined, unitSiOffset: undefined });
  });

  it('adds no unit key to a material property that declares no Unit', async () => {
    const width = materialProps(await parse(ifc('IFC4'))).find((p) => p.name === 'Width');
    expect(width).toEqual({ name: 'Width', type: 1, value: 300, dataType: 'IFCPOSITIVELENGTHMEASURE' });
  });

  it('reports the own unit of a session-created property that names a source unit', async () => {
    const store = await parse(ifc('IFC4'));
    const view: MaterialPropertiesView = {
      isDeleted: () => false,
      getNewEntities: () => [
        { expressId: 900, type: 'IFCMATERIALPROPERTIES', attributes: ['Live_Pset', null, [901], 20] },
        { expressId: 901, type: 'IFCPROPERTYSINGLEVALUE', attributes: ['Depth', null, ['IFCLENGTHMEASURE', 50], 9] },
      ],
      getNewEntity: (id) => id === 900
        ? { type: 'IFCMATERIALPROPERTIES', attributes: ['Live_Pset', null, [901], 20] }
        : id === 901 ? { type: 'IFCPROPERTYSINGLEVALUE', attributes: ['Depth', null, ['IFCLENGTHMEASURE', 50], 9] } : null,
      getPositionalMutationsForEntity: () => null,
      getAttributeMutationsForEntity: () => [],
    };
    const live = extractMaterialPropertiesForMaterialId(store, 20, view)[0]?.psets.find((s) => s.name === 'Live_Pset');
    expect(live?.properties.map(unitFields)).toEqual([{ name: 'Depth', unit: 'mm', unitSiScale: 0.001, unitSiOffset: undefined }]);
  });
});
