/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #ISSUE: the words for a bounds restriction said less than the check
 * enforces. The expected value had no words for xs:length, xs:minLength and
 * xs:maxLength ("any value") and dropped every facet after a min and max
 * pair; the mismatch reason called a too long text "not a valid number" and
 * kept a 1e-6 tolerance on inclusive bounds that the matcher does not apply,
 * so a value just past one got an empty reason; the translated description
 * named only the first bound, and said "any value" for lengths, digit
 * counts and a facet that cannot be read, which rejects every value.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { formatConstraint, getConstraintMismatchReason, matchConstraint } from '../constraints/index.js';
import { parseIDS } from '../parser/xml-parser.js';
import { createTranslationService } from '../translation/index.js';
import type { IDSConstraint, IDSValidationReport, SupportedLocale } from '../types.js';
import { validateIDS } from './validator.js';

const gid = (n: number) => String(n).padStart(22, '0');
const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=IFCWALL('${gid(10)}',$,'W-123',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('ABCD'),$);
#12=IFCPROPERTYSINGLEVALUE('Ratio',$,IFCREAL(5.25),$);
#20=IFCPROPERTYSET('${gid(20)}',$,'Probe_Set',$,(#11,#12));
#21=IFCRELDEFINESBYPROPERTIES('${gid(21)}',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
`;

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
const restriction = (base: string, facets: Array<[string, string | number]>) =>
  `<xs:restriction base="${base}">${facets.map(([f, v]) => `<xs:${f} value="${v}"/>`).join('')}</xs:restriction>`;
const prop = (name: string, value: string) =>
  `<property><propertySet>${sv('Probe_Set')}</propertySet><baseName>${sv(name)}</baseName><value>${value}</value></property>`;
const attr = (name: string, value: string) => `<attribute><name>${sv(name)}</name><value>${value}</value></attribute>`;

/** The wall fails every row: W-123 is 5 characters, ABCD 4, and 5.25 has 3 digits, 2 after the point. */
const ROWS: Array<[string, string]> = [
  ['Name maxLength 3', attr('Name', restriction('xs:string', [['maxLength', 3]]))],
  ['Code maxLength 3', prop('Code', restriction('xs:string', [['maxLength', 3]]))],
  ['Code minLength 5', prop('Code', restriction('xs:string', [['minLength', 5]]))],
  ['Code length 2', prop('Code', restriction('xs:string', [['length', 2]]))],
  ['Ratio 0 to 10, fractionDigits 1', prop('Ratio', restriction('xs:decimal', [['minInclusive', 0], ['maxInclusive', 10], ['fractionDigits', 1]]))],
  ['Ratio totalDigits 2', prop('Ratio', restriction('xs:decimal', [['totalDigits', 2]]))],
  ['Ratio over 0 and under 5', prop('Ratio', restriction('xs:double', [['minExclusive', 0], ['maxExclusive', 5]]))],
  ['Ratio at least 0 and under 5', prop('Ratio', restriction('xs:double', [['minInclusive', 0], ['maxExclusive', 5]]))],
  ['Ratio over 6 and at most 10', prop('Ratio', restriction('xs:double', [['minExclusive', 6], ['maxInclusive', 10]]))],
  ['Code maxLength three', prop('Code', restriction('xs:string', [['maxLength', 'three']]))],
  ['Ratio 0 to 5 (control)', prop('Ratio', restriction('xs:double', [['minInclusive', 0], ['maxInclusive', 5]]))],
];

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#ISSUE</title></info>
  <specifications>${ROWS.map(([name, requirement]) => `
    <specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name>${sv('IFCWALL')}</name></entity></applicability>
      <requirements>${requirement}</requirements>
    </specification>`).join('')}
  </specifications>
</ids>`;

async function run(locale?: SupportedLocale): Promise<IDSValidationReport> {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
  return validateIDS(parseIDS(IDS), createDataAccessor(store), {
    modelId: 'bounds-description', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  }, locale ? { translator: createTranslationService(locale) } : undefined);
}

/** One field of each specification's first requirement result, by name. */
function byRow(report: IDSValidationReport, field: 'expectedValue' | 'failureReason' | 'checkedDescription') {
  return Object.fromEntries(report.specificationResults.map((s) => {
    expect(s.status, s.specification.name).toBe('fail');
    return [s.specification.name, s.entityResults[0]?.requirementResults[0]?.[field]];
  }));
}

describe('a bounds restriction is described by every facet it checks (#ISSUE)', () => {
  it('expectedValue names the lengths and keeps every facet after a min and max pair', async () => {
    const shown = byRow(await run(), 'expectedValue');
    // Its exact text predates this change; it must still name the facet.
    expect(shown['Code maxLength three']).toContain('xs:maxLength="three"');
    delete shown['Code maxLength three'];
    expect(shown).toEqual({
      'Name maxLength 3': '<= 3 characters',
      'Code maxLength 3': '<= 3 characters',
      'Code minLength 5': '>= 5 characters',
      'Code length 2': 'exactly 2 characters',
      'Ratio 0 to 10, fractionDigits 1': 'between 0 and 10 and <= 1 fraction digits',
      'Ratio totalDigits 2': '<= 2 total digits',
      'Ratio over 0 and under 5': '> 0 and < 5',
      'Ratio at least 0 and under 5': '>= 0 and < 5',
      'Ratio over 6 and at most 10': '<= 10 and > 6',
      'Ratio 0 to 5 (control)': 'between 0 and 5',
    });
  });

  it('failureReason carries the same words', async () => {
    const reasons = byRow(await run(), 'failureReason');
    expect(reasons['Name maxLength 3']).toBe('Attribute "Name" value "W-123" does not match expected <= 3 characters');
    expect(reasons['Code length 2']).toBe('Property "Probe_Set.Code" value ABCD is out of bounds exactly 2 characters');
    expect(Object.values(reasons).filter((r) => r?.includes('any value'))).toEqual([]);
  });

  it('getConstraintMismatchReason names the length the text breaks', () => {
    const maxLength3: IDSConstraint = { type: 'bounds', maxLength: 3 };
    expect(matchConstraint(maxLength3, 'W-123')).toBe(false);
    expect(getConstraintMismatchReason(maxLength3, 'W-123')).toBe('"W-123" (5 characters) must have at most 3 characters');
    expect(getConstraintMismatchReason({ type: 'bounds', minLength: 5 }, 'ABCD')).toBe('"ABCD" (4 characters) must have at least 5 characters');
    expect(getConstraintMismatchReason({ type: 'bounds', length: 2 }, 'ABCD')).toBe('"ABCD" (4 characters) must have exactly 2 characters');
    // A number is measured by its text, as the matcher measures it.
    expect(getConstraintMismatchReason({ type: 'bounds', maxLength: 3 }, 5.25)).toBe('"5.25" (4 characters) must have at most 3 characters');
    // Controls: the numeric facets read as before.
    expect(getConstraintMismatchReason({ type: 'bounds', minExclusive: 0, maxExclusive: 5 }, 5.25)).toBe('5.25 must be < 5');
    expect(getConstraintMismatchReason({ type: 'bounds', fractionDigits: 1 }, 5.25)).toBe('5.25 must have at most 1 fraction digits');
  });

  it('a value just past an inclusive bound gets a reason (buildingSMART tolerance cases)', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '__corpus__', 'buildingsmart-ids', 'tolerance');
    const cases: Array<[string, number, string]> = [
      ['fail-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive', -0.0000001, '-1e-7 must be >= 0'],
      ['fail-comparison_tolerance_for_floating_point_range_lower_than_zero_inclusive', 0.00000001, '1e-8 must be <= 0'],
    ];
    for (const [name, value, reason] of cases) {
      const bytes = readFileSync(join(root, `${name}.ifc`));
      const store = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
      const doc = parseIDS(readFileSync(join(root, `${name}.ids`), 'utf8'));
      const report = await validateIDS(doc, createDataAccessor(store), {
        modelId: name, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
      });
      expect(report.specificationResults[0]!.status, name).toBe('fail');
      const facet = doc.specifications[0]!.requirements[0]!.facet;
      if (facet.type !== 'property' || !facet.value) throw new Error(`${name}: expected a property value requirement`);
      expect(matchConstraint(facet.value, value), name).toBe(false);
      expect(getConstraintMismatchReason(facet.value, value), name).toBe(reason);
    }
  });

  it('the translated description names every facet (English and German)', async () => {
    // An attribute reads its value through the "must equal" template, whose
    // wording this change leaves alone; the bounds words are what it fills in.
    const en = byRow(await run('en'), 'checkedDescription');
    const de = byRow(await run('de'), 'checkedDescription');
    expect(en['Name maxLength 3']).toContain('at most 3 characters long');
    expect(de['Name maxLength 3']).toContain('höchstens 3 Zeichen lang');
    delete en['Name maxLength 3'];
    delete de['Name maxLength 3'];
    expect(en).toEqual({
      'Code maxLength 3': 'Property "Probe_Set.Code" must be at most 3 characters long',
      'Code minLength 5': 'Property "Probe_Set.Code" must be at least 5 characters long',
      'Code length 2': 'Property "Probe_Set.Code" must be exactly 2 characters long',
      'Ratio 0 to 10, fractionDigits 1': 'Property "Probe_Set.Ratio" must be between 0 and 10 and given to at most 1 decimal places',
      'Ratio totalDigits 2': 'Property "Probe_Set.Ratio" must be at most 2 digits long',
      'Ratio over 0 and under 5': 'Property "Probe_Set.Ratio" must be greater than 0 and less than 5',
      'Ratio at least 0 and under 5': 'Property "Probe_Set.Ratio" must be at least 0 and less than 5',
      'Ratio over 6 and at most 10': 'Property "Probe_Set.Ratio" must be greater than 6 and at most 10',
      'Code maxLength three': 'Property "Probe_Set.Code" must be within a restriction that cannot be read (xs:maxLength="three")',
      'Ratio 0 to 5 (control)': 'Property "Probe_Set.Ratio" must be between 0 and 5',
    });
    expect(de).toEqual({
      'Code maxLength 3': 'Eigenschaft "Probe_Set.Code" muss höchstens 3 Zeichen lang sein',
      'Code minLength 5': 'Eigenschaft "Probe_Set.Code" muss mindestens 5 Zeichen lang sein',
      'Code length 2': 'Eigenschaft "Probe_Set.Code" muss genau 2 Zeichen lang sein',
      'Ratio 0 to 10, fractionDigits 1': 'Eigenschaft "Probe_Set.Ratio" muss zwischen 0 und 10 und mit höchstens 1 Nachkommastellen angegeben sein',
      'Ratio totalDigits 2': 'Eigenschaft "Probe_Set.Ratio" muss höchstens 2-stellig sein',
      'Ratio over 0 and under 5': 'Eigenschaft "Probe_Set.Ratio" muss größer als 0 und kleiner als 5 sein',
      'Ratio at least 0 and under 5': 'Eigenschaft "Probe_Set.Ratio" muss mindestens 0 und kleiner als 5 sein',
      'Ratio over 6 and at most 10': 'Eigenschaft "Probe_Set.Ratio" muss größer als 6 und höchstens 10 sein',
      'Code maxLength three': 'Eigenschaft "Probe_Set.Code" muss innerhalb einer nicht lesbaren Einschränkung (xs:maxLength="three") sein',
      'Ratio 0 to 5 (control)': 'Eigenschaft "Probe_Set.Ratio" muss zwischen 0 und 5 sein',
    });
  });

  it('every locale has words for each facet', () => {
    const shapes: Record<string, IDSConstraint> = {
      lengths: { type: 'bounds', minLength: 2, maxLength: 8 },
      exactLength: { type: 'bounds', length: 4 },
      digits: { type: 'bounds', totalDigits: 5, fractionDigits: 2 },
      exclusivePair: { type: 'bounds', minExclusive: 0, maxExclusive: 1 },
      unreadable: { type: 'bounds', unparseableFacets: [{ facet: 'maxLength', rawValue: 'three' }] },
    };
    const locales: SupportedLocale[] = ['en', 'de', 'fr', 'it', 'ru'];
    const described = Object.fromEntries(locales.map((locale) => {
      const t = createTranslationService(locale);
      return [locale, Object.fromEntries(Object.entries(shapes).map(([k, c]) => [k, t.describeConstraint(c)]))];
    }));
    expect(described).toEqual({
      en: {
        lengths: 'at least 2 characters long and at most 8 characters long',
        exactLength: 'exactly 4 characters long',
        digits: 'at most 5 digits long and given to at most 2 decimal places',
        exclusivePair: 'greater than 0 and less than 1',
        unreadable: 'within a restriction that cannot be read (xs:maxLength="three")',
      },
      de: {
        lengths: 'mindestens 2 Zeichen lang und höchstens 8 Zeichen lang',
        exactLength: 'genau 4 Zeichen lang',
        digits: 'höchstens 5-stellig und mit höchstens 2 Nachkommastellen angegeben',
        exclusivePair: 'größer als 0 und kleiner als 1',
        unreadable: 'innerhalb einer nicht lesbaren Einschränkung (xs:maxLength="three")',
      },
      fr: {
        lengths: "d'une longueur d'au moins 2 caractères et d'une longueur d'au plus 8 caractères",
        exactLength: "d'une longueur de 4 caractères exactement",
        digits: "d'au plus 5 chiffres et d'au plus 2 décimales",
        exclusivePair: 'supérieur à 0 et inférieur à 1',
        unreadable: 'dans une restriction illisible (xs:maxLength="three")',
      },
      it: {
        lengths: 'di almeno 2 caratteri e di al massimo 8 caratteri',
        exactLength: 'di esattamente 4 caratteri',
        digits: 'di al massimo 5 cifre e di al massimo 2 cifre decimali',
        exclusivePair: 'maggiore di 0 e minore di 1',
        unreadable: 'entro una restrizione illeggibile (xs:maxLength="three")',
      },
      ru: {
        lengths: 'длиной не менее 2 симв. и длиной не более 8 симв.',
        exactLength: 'длиной ровно 4 симв.',
        digits: 'не более 5 цифр и не более 2 знаков после запятой',
        exclusivePair: 'больше, чем 0 и меньше 1',
        unreadable: 'в пределах нечитаемого ограничения (xs:maxLength="three")',
      },
    });
    // The English expected value, for the same shapes.
    expect(Object.fromEntries(Object.entries(shapes).filter(([k]) => k !== 'unreadable').map(([k, c]) => [k, formatConstraint(c)]))).toEqual({
      lengths: '>= 2 characters and <= 8 characters',
      exactLength: 'exactly 4 characters',
      digits: '<= 5 total digits and <= 2 fraction digits',
      exclusivePair: '> 0 and < 1',
    });
  });
});
