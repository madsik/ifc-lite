/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate IFC-Lite geometry artifacts:
 * - lod0_preview.json  (placement-based bboxes)
 * - lod1.glb           (mesh; may be fallback boxes)
 * - lod1.meta.json     (status + mapping)
 *
 * Usage:
 *   node scripts/generate-lod-artifacts.mjs path/to/model.ifc --out out/dir
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Import from built package output (buildable + stable Node ESM).
// Ensure you ran: `npx -y pnpm@latest --filter @ifc-lite/export build`
import { generateLod0, generateLod1 } from '../packages/export/dist/index.js';

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!args.input && !a.startsWith('--')) {
      args.input = a;
      continue;
    }
    if (a === '--out') {
      args.out = argv[i + 1];
      i++;
      continue;
    }
  }
  return args;
}

const { input, out } = parseArgs(process.argv);
if (!input) {
  console.error('Missing input IFC path.\nUsage: node scripts/generate-lod-artifacts.mjs model.ifc --out outDir');
  process.exit(2);
}

const inputAbs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
const outDir = out
  ? (path.isAbsolute(out) ? out : path.resolve(process.cwd(), out))
  : path.join(path.dirname(inputAbs), `${path.basename(inputAbs, path.extname(inputAbs))}.lod`);

await mkdir(outDir, { recursive: true });

// LOD0 is mandatory
const lod0 = await generateLod0(inputAbs);
await writeFile(path.join(outDir, 'lod0_preview.json'), JSON.stringify(lod0, null, 2), 'utf8');

// LOD1 is mandatory (ok or degraded + fallback)
const { glb, meta } = await generateLod1(inputAbs);
await writeFile(path.join(outDir, 'lod1.glb'), glb);
await writeFile(path.join(outDir, 'lod1.meta.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log(`Wrote artifacts to: ${outDir}`);
console.log(`- lod0_preview.json (${lod0.elements.length} elements)`);
console.log(`- lod1.glb (${glb.byteLength} bytes)`);
console.log(`- lod1.meta.json (status=${meta.status}${meta.fallback ? `, fallback=${meta.fallback}` : ''})`);

