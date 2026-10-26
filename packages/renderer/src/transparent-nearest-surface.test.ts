/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Nearest see-through surface: the two stages' pipeline state, and the order
 * of the transparent pass's draws, tested without a device.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { nearestSurfaceDescriptor, planTransparentDraws } from './transparent-nearest-surface.js';

// The transparent pipeline's state as pipeline.ts builds it: two colour targets
// (the colour, blended, and the object-id lane), reverse-Z, no depth writes.
const BASE = {
  layout: 'auto' as const,
  fragment: {
    module: {} as GPUShaderModule,
    entryPoint: 'fs_main',
    targets: [
      { format: 'bgra8unorm' as GPUTextureFormat, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } as GPUBlendState },
      { format: 'rgba8unorm' as GPUTextureFormat },
    ],
  },
  depthStencil: { format: 'depth24plus-stencil8' as GPUTextureFormat, depthWriteEnabled: false, depthCompare: 'greater' as GPUCompareFunction },
};

describe('nearestSurfaceDescriptor', () => {
  it('pre-pass: writes depth, no colour on either target, the same test as the opaque pass', () => {
    const d = nearestSurfaceDescriptor(BASE, 'depth');
    assert.strictEqual(d.depthStencil.depthWriteEnabled, true);
    assert.strictEqual(d.depthStencil.depthCompare, 'greater');
    assert.deepStrictEqual([...d.fragment.targets].map((t) => t?.writeMask), [0, 0]);
    // The same fragment stage, so section and clip discards cut the pre-pass alike.
    assert.strictEqual(d.fragment.module, BASE.fragment.module);
    assert.strictEqual(d.fragment.entryPoint, 'fs_main');
    assert.strictEqual(d.depthStencil.format, BASE.depthStencil.format);
  });

  it('colour pass: blends as the transparent pipeline, only at the nearest depth, writing none', () => {
    const d = nearestSurfaceDescriptor(BASE, 'colour');
    assert.strictEqual(d.depthStencil.depthWriteEnabled, false);
    assert.strictEqual(d.depthStencil.depthCompare, 'greater-equal');
    assert.deepStrictEqual(d.fragment, BASE.fragment);
  });

  it('leaves the transparent pipeline its own state', () => {
    nearestSurfaceDescriptor(BASE, 'depth');
    nearestSurfaceDescriptor(BASE, 'colour');
    assert.strictEqual(BASE.depthStencil.depthWriteEnabled, false);
    assert.strictEqual(BASE.depthStencil.depthCompare, 'greater');
    assert.strictEqual(BASE.fragment.targets.every((t) => !('writeMask' in t)), true);
  });
});

describe('planTransparentDraws', () => {
  const order = (draws: { batch: string; kind: string }[]) => draws.map((d) => `${d.kind}:${d.batch}`);
  const ghost = (b: string) => b.startsWith('g');

  it('without the option, every batch once, plain, in the order given', () => {
    assert.deepStrictEqual(order(planTransparentDraws(['a', 'g1', 'b'], false, ghost, () => true)), ['plain:a', 'plain:g1', 'plain:b']);
  });

  it('with it: ghosts first, then every pre-pass, then every colour pass', () => {
    assert.deepStrictEqual(order(planTransparentDraws(['a', 'g1', 'b'], true, ghost, () => true)), ['plain:g1', 'depth:a', 'depth:b', 'colour:a', 'colour:b']);
  });

  it('draws a batch whose pipelines are not built yet plain, after the nearest surfaces', () => {
    assert.deepStrictEqual(order(planTransparentDraws(['a', 'b'], true, ghost, (b) => b !== 'b')), ['depth:a', 'colour:a', 'plain:b']);
  });
});
