/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IfcConversionBasedUnit whose ConversionFactor names another
 * conversion-based (or a derived) unit as its UnitComponent is resolved
 * through that unit (#ISSUE), as the Rust resolver does since #3616: a foot of
 * 12 inches, the inch a conversion-based unit over the metre, is 0.3048 m, not
 * 12 m. Read through a parsed model and the public readers: a property's own
 * `Unit` (`extractPropertiesOnDemand`) and the project assignment
 * (`extractProjectUnits`, on the parsed-source path and with a native reader).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractProjectUnits, extractPropertiesOnDemand, extractQuantitiesOnDemand } from './index.js';
import { EntityExtractor } from './entity-extractor.js';
import type { MetadataReadView } from './effective-metadata-record.js';

// Metre project. Each property on wall #100 names one unit below as its own Unit.
const UNITS = `#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#11=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.0254),#2);
#12=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'INCH',#11);
#13=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(12.),#12);
#14=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#13);
#15=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(3.),#14);
#16=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'YARD',#15);
#17=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'span',#18);
#18=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(9.),#12);
#20=IFCSIUNIT(*,.LENGTHUNIT.,.DECI.,.METRE.);
#21=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#22=IFCDERIVEDUNITELEMENT(#20,3);
#23=IFCDERIVEDUNITELEMENT(#21,-1);
#24=IFCDERIVEDUNIT((#22,#23),.VOLUMETRICFLOWRATEUNIT.,$);
#25=IFCDIMENSIONALEXPONENTS(3,0,-1,0,0,0,0);
#26=IFCMEASUREWITHUNIT(IFCVOLUMETRICFLOWRATEMEASURE(0.5),#24);
#27=IFCCONVERSIONBASEDUNIT(#25,.VOLUMETRICFLOWRATEUNIT.,'half litre per second',#26);
#30=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'loop',#31);
#31=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(2.),#30);
#32=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'ping',#33);
#33=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(2.),#34);
#34=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'pong',#35);
#35=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(3.),#32);
#36=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'hand',#37);
#37=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(4.),#38);
#38=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'thumb',#39);
#39=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#99);
#40=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);
#41=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);
#42=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#41);
#43=IFCCONVERSIONBASEDUNIT(#40,.THERMODYNAMICTEMPERATUREUNIT.,'RANKINE',#42);
#44=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(1.),#43);
#45=IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#44,-459.67);
#46=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(1.),#45);
#47=IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit again',#46,0.5);
#48=IFCMONETARYUNIT('EUR');
#49=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#48);
#50=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'odd foot',#49);`;

const PROPS: Array<[name: string, measure: string, unit: number]> = [
  ['Inch', 'IFCLENGTHMEASURE', 12], ['Foot', 'IFCLENGTHMEASURE', 14], ['Yard', 'IFCLENGTHMEASURE', 16],
  ['Span', 'IFCLENGTHMEASURE', 17], ['Flow', 'IFCVOLUMETRICFLOWRATEMEASURE', 27], ['Loop', 'IFCLENGTHMEASURE', 30],
  ['Ping', 'IFCLENGTHMEASURE', 32], ['Hand', 'IFCLENGTHMEASURE', 36], ['Rankine', 'IFCTHERMODYNAMICTEMPERATUREMEASURE', 43],
  ['Fahrenheit', 'IFCTHERMODYNAMICTEMPERATUREMEASURE', 45], ['Fahrenheit again', 'IFCTHERMODYNAMICTEMPERATUREMEASURE', 47],
  ['Odd foot', 'IFCLENGTHMEASURE', 50],
];

function ifc(projectUnits = '#2', extra = ''): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#6=IFCUNITASSIGNMENT((${projectUnits}));
${UNITS}
${extra}
#100=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,'W',$,$,$,$,$,$);
#101=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Units',$,(${PROPS.map((_, i) => `#${200 + i}`).join(',')}));
#102=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#100),#101);
${PROPS.map(([name, measure, unit], i) => `#${200 + i}=IFCPROPERTYSINGLEVALUE('${name}',$,${measure}(1.),#${unit});`).join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(source: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
}

async function ownUnits(source = ifc()) {
  const set = extractPropertiesOnDemand(await parse(source), 100).find((s) => s.name === 'Units');
  return new Map((set?.properties ?? []).map((p) => [p.name, { unit: p.unit, siScale: p.unitSiScale, siOffset: p.unitSiOffset }]));
}

/** A native reader over the parsed store, as the current-model callers pass one. */
function nativeReader(store: Awaited<ReturnType<typeof parse>>) {
  const extractor = new EntityExtractor(store.source);
  return (id: number) => {
    const ref = store.entityIndex.byId.get(id);
    return ref ? extractor.extractEntity(ref) : null;
  };
}

describe('a conversion-based unit over another conversion-based unit (#ISSUE)', () => {
  it('resolves a foot of 12 inches, the inch over the metre, to 0.3048 m', async () => {
    const units = await ownUnits();
    expect(units.get('Inch')?.siScale).toBeCloseTo(0.0254, 15);
    expect(units.get('Foot')?.siScale).toBeCloseTo(0.3048, 15);
    expect(units.get('Foot')?.unit).toBe('ft');
  });

  it('resolves a chain of three, a yard of 3 feet of 12 inches, to 0.9144 m', async () => {
    expect((await ownUnits()).get('Yard')?.siScale).toBeCloseTo(0.9144, 15);
  });

  it('resolves a unit with a name outside the table by its chain, not by a name lookup', async () => {
    // 9 inches; `span` has no named factor to fall back to.
    expect((await ownUnits()).get('Span')?.siScale).toBeCloseTo(0.2286, 15);
  });

  it('resolves a conversion-based unit over a derived unit by the derived unit scale', async () => {
    // 0.5 dm³/s is 0.0005 m³/s; the derived unit's scale is 0.001, not 1.
    expect((await ownUnits()).get('Flow')?.siScale).toBeCloseTo(0.0005, 15);
  });

  it('resolves an offset unit over a conversion-based unit that has no offset', async () => {
    // A degree Fahrenheit of one Rankine (5/9 K) with offset -459.67: 68 °F is 293.15 K.
    const fahrenheit = (await ownUnits()).get('Fahrenheit');
    expect(fahrenheit?.siScale).toBeCloseTo(5 / 9, 12);
    expect(68 * (fahrenheit?.siScale ?? NaN) + (fahrenheit?.siOffset ?? NaN)).toBeCloseTo(293.15, 9);
  });

  it('leaves unresolved an offset unit over a unit with its own offset, as over a degree Celsius', async () => {
    expect((await ownUnits()).get('Fahrenheit again')).toEqual({ unit: '#47', siScale: undefined, siOffset: undefined });
  });

  it('leaves unresolved a unit whose factor names itself, or two that name each other, without a throw', async () => {
    const units = await ownUnits();
    expect(units.get('Loop')).toEqual({ unit: '#30', siScale: undefined, siOffset: undefined });
    expect(units.get('Ping')).toEqual({ unit: '#32', siScale: undefined, siOffset: undefined });
  });

  it('leaves unresolved a unit over a conversion-based unit whose own component dangles', async () => {
    expect((await ownUnits()).get('Hand')).toEqual({ unit: '#36', siScale: undefined, siOffset: undefined });
  });

  it('keeps a factor over a monetary unit at the factor value, as before and as in Rust', async () => {
    expect((await ownUnits()).get('Odd foot')?.siScale).toBeCloseTo(0.3048, 15);
  });

  it('bounds a long chain by the walk depth cap on the parsed-source path', async () => {
    // inch #12 is unit 1; links #300.. each are 1 of the one before. 16 units on a path resolve, 17 do not.
    const chain = (n: number) => Array.from({ length: n }, (_, i) => {
      const unit = 300 + 2 * i;
      const below = i === 0 ? 12 : unit - 2;
      return `#${unit}=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'link ${i}',#${unit + 1});\n#${unit + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#${below});`;
    }).join('\n');
    const read = async (n: number) => {
      const store = await parse(ifc('#2', `${chain(n)}\n#290=IFCPROPERTYSINGLEVALUE('Link',$,IFCLENGTHMEASURE(1.),#${300 + 2 * (n - 1)});\n#291=IFCPROPERTYSET('3Zc8rM1tJ5dP0nL4kQ2yS9',$,'Chain',$,(#290));\n#292=IFCRELDEFINESBYPROPERTIES('0Bd9sN2uK6fQ1oM5lR3zT0',$,$,$,(#100),#291);`));
      return extractPropertiesOnDemand(store, 100).find((s) => s.name === 'Chain')?.properties[0]?.unitSiScale;
    };
    expect(await read(15)).toBeCloseTo(0.0254, 15);
    expect(await read(16)).toBeUndefined();
  });
});

describe('the project unit assignment reads the same chain (#ISSUE)', () => {
  it('resolves a project length unit that is a foot of 12 inches', async () => {
    const store = await parse(ifc('#14'));
    expect(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('LENGTHUNIT')?.siScale).toBeCloseTo(0.3048, 15);
  });

  it('resolves it with a native reader too, where it threw before', async () => {
    const store = await parse(ifc('#14,#27'));
    const units = extractProjectUnits(store.source, store.entityIndex, undefined, nativeReader(store));
    expect(units.resolvedForUnitType('LENGTHUNIT')?.siScale).toBeCloseTo(0.3048, 15);
    expect(units.resolvedForUnitType('VOLUMETRICFLOWRATEUNIT')?.siScale).toBeCloseTo(0.0005, 15);
  });

  it('keeps a project foot over the metre as it was (control)', async () => {
    const store = await parse(ifc('#60', "#60=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#61);\n#61=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#2);"));
    expect(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'ft', siScale: 0.3048 });
  });
});

describe('a walk follows the component only where it is bounded (#ISSUE)', () => {
  // With a session view a property's or quantity's own Unit is read through the
  // view, on a walk with no depth cap, read budget or memo. There a component
  // that is not an IfcSIUnit stays unresolved, as before; following it let a
  // long chain overflow the stack and a fan-out take exponential time. Without
  // a view the parsed-source walk follows it within its budget (#7547).
  const view: MetadataReadView = {
    isDeleted: () => false, getNewEntities: () => [], getNewEntity: () => null,
    getPositionalMutationsForEntity: () => null, getAttributeMutationsForEntity: () => [], getMutationRevision: () => 1,
  };

  /** `n` conversion-based units from #1000, each 1 of the one below, the lowest 1 m. Returns the lines and the top unit. */
  const chain = (n: number): [string, number] => [Array.from({ length: n }, (_, i) => {
    const unit = 1000 + 2 * i;
    return `#${unit}=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'link ${i}',#${unit + 1});\n#${unit + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#${i === 0 ? 2 : unit - 2});`;
  }).join('\n'), 1000 + 2 * (n - 1)];

  /** `k` levels from #500000: a conversion-based unit over a derived unit whose two elements both name the next level's unit. */
  const fan = (k: number): [string, number] => [[...Array.from({ length: k }, (_, i) => {
    const b = 500000 + 10 * i;
    return [`#${b}=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'c${i}',#${b + 1});`, `#${b + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#${b + 2});`,
      `#${b + 2}=IFCDERIVEDUNIT((#${b + 3},#${b + 4}),.USERDEFINED.,'d${i}');`,
      `#${b + 3}=IFCDERIVEDUNITELEMENT(#${b + 10},1);`, `#${b + 4}=IFCDERIVEDUNITELEMENT(#${b + 10},1);`].join('\n');
  }), `#${500000 + 10 * k}=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'bottom',#${500001 + 10 * k});`,
  `#${500001 + 10 * k}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#2);`].join('\n'), 500000];

  const lazily = <T>(make: () => Promise<T>) => { let made: Promise<T> | undefined; return () => (made ??= make()); };
  const withProperty = ([lines, unit]: [string, number]) => parse(ifc('#2', `${lines}
#280=IFCPROPERTYSINGLEVALUE('Link',$,IFCLENGTHMEASURE(1.),#${unit});
#281=IFCPROPERTYSET('2Q1nV8mQz1Hw4l3yXgS0aB',$,'Chain',$,(#280));
#282=IFCRELDEFINESBYPROPERTIES('1kT5pW0rZ3Lb8n6yRcU2eD',$,$,$,(#100),#281);`));
  const longChain = lazily(() => withProperty(chain(20_000)));
  const fanOut = lazily(() => withProperty(fan(24)));
  const quantityChain = lazily(() => {
    const [lines, unit] = chain(300);
    return parse(ifc('#2', `${lines}
#283=IFCQUANTITYLENGTH('Len',$,#${unit},1.,$);
#284=IFCELEMENTQUANTITY('3Hf7qY2sA5Nd0p8uTeW4gF',$,'Qto_Chain',$,$,(#283));
#285=IFCRELDEFINESBYPROPERTIES('0Xj9rA4uC7Pf2r0wVgY6iH',$,$,$,(#100),#284);`));
  });
  const link = (store: Awaited<ReturnType<typeof parse>>, readView?: MetadataReadView) => {
    const p = extractPropertiesOnDemand(store, 100, readView).find((s) => s.name === 'Chain')?.properties[0];
    return { unit: p?.unit, siScale: p?.unitSiScale };
  };
  const quantities = (store: Awaited<ReturnType<typeof parse>>, readView?: MetadataReadView) => extractQuantitiesOnDemand(store, 100, readView)
    .flatMap((s) => s.quantities).map((q) => [q.name, q.value, q.explicitUnitSiScale, q.explicitUnitUnresolved]);

  it('with a view, returns a property whose own unit tops a chain of 20,000 units, unresolved as before', async () => {
    expect(link(await longChain(), view)).toEqual({ unit: '#40998', siScale: undefined });
  });

  it('with a view, returns a property whose own unit tops a fan-out of 24 levels, unresolved as before', async () => {
    expect(link(await fanOut(), view)).toEqual({ unit: '#500000', siScale: undefined });
  });

  it('with a view, returns the quantities of an element whose quantity unit tops a chain of 300 units', async () => {
    expect(quantities(await quantityChain(), view)).toEqual([['Len', 1, undefined, true]]);
  });

  it('without a view, refuses the same chains and fan-out at the walk bounds, so they stay unresolved', async () => {
    expect(link(await longChain())).toEqual({ unit: '#40998', siScale: undefined }); // the depth cap
    expect(link(await fanOut())).toEqual({ unit: '#500000', siScale: undefined }); // the read budget or the depth cap
    expect(quantities(await quantityChain())).toEqual([['Len', 1, undefined, true]]);
  });
});
