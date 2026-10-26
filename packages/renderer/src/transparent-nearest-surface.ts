/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Nearest see-through surface (`RenderOptions.transparentNearestSurface`).
 *
 * The transparent pass blends every translucent face it draws, back faces and
 * hidden ones included, in batch order rather than depth order, and writes no
 * depth. Where many translucent elements overlap (a model drawn see-through to
 * show the few opaque ones inside it), whatever batch comes last is painted
 * over what lies in front of it, and a closed element blends its far side over
 * its near one. The option draws instead, per pixel, only the translucent
 * surface nearest the camera, blended once over the opaque scene:
 *
 *   1. a depth-only pre-pass of the translucent batches (colour writes off,
 *      depth writes on), so the depth buffer holds the nearest translucent
 *      surface in front of the opaque scene;
 *   2. their colour pass, depth-tested `greater-equal` (reverse-Z) against
 *      that, writing no depth: only the fragments AT the nearest depth pass.
 *
 * The result no longer depends on batch order. Both stages run the transparent
 * pipeline's own vertex and fragment stages (section-plane and clip-box
 * discards included), so the depths they compute are the same. X-Ray ghosts
 * keep their faint whole shell: they are drawn first, as before, and are not
 * part of the pre-pass, so a ghost behind a nearest surface still shows
 * through it.
 */

/** The parts of a pipeline descriptor the derivation reads. */
export interface NearestSurfaceBase {
  fragment?: GPUFragmentState;
  depthStencil?: GPUDepthStencilState;
}

/** The two stages of the nearest-surface draw. */
export type NearestSurfaceStage = 'depth' | 'colour';

/**
 * A stage's pipeline descriptor, from the transparent pipeline's: the depth
 * pre-pass writes depth and no colour; the colour pass tests `greater-equal`
 * (reverse-Z: the pre-pass's own depth passes) and writes no depth.
 */
export function nearestSurfaceDescriptor<T extends NearestSurfaceBase>(base: T, stage: NearestSurfaceStage): T {
  if (!base.depthStencil) throw new Error('nearestSurfaceDescriptor: the transparent pipeline has no depth state.');
  if (stage === 'colour') {
    return { ...base, depthStencil: { ...base.depthStencil, depthWriteEnabled: false, depthCompare: 'greater-equal' } };
  }
  const fragment = base.fragment && {
    ...base.fragment,
    targets: [...base.fragment.targets].map((target) => target && { ...target, writeMask: 0 }),
  };
  return { ...base, ...(fragment && { fragment }), depthStencil: { ...base.depthStencil, depthWriteEnabled: true, depthCompare: 'greater' } };
}

/** One draw of the transparent pass: a batch and the pipeline kind it is drawn with. */
export interface TransparentDraw<B> {
  batch: B;
  /** 'plain': the transparent (or ghost) pipeline, as without the option. */
  kind: 'plain' | NearestSurfaceStage;
}

/**
 * The order of the transparent pass's draws. Without the option, every batch
 * once, plain, in the order given. With it: the ghosts plain first, then the
 * depth pre-pass of every batch whose nearest-surface pipelines are ready, then
 * their colour pass, then the batches whose pipelines are not built yet, plain
 * (depth-tested against the pre-pass, so never over a nearer surface).
 */
export function planTransparentDraws<B>(
  batches: readonly B[],
  nearestSurface: boolean,
  isGhost: (batch: B) => boolean,
  ready: (batch: B) => boolean,
): TransparentDraw<B>[] {
  if (!nearestSurface) return batches.map((batch) => ({ batch, kind: 'plain' }));
  const ghosts = batches.filter(isGhost);
  const rest = batches.filter((batch) => !isGhost(batch));
  const nearest = rest.filter(ready);
  const waiting = rest.filter((batch) => !ready(batch));
  return [
    ...ghosts.map((batch) => ({ batch, kind: 'plain' as const })),
    ...nearest.map((batch) => ({ batch, kind: 'depth' as const })),
    ...nearest.map((batch) => ({ batch, kind: 'colour' as const })),
    ...waiting.map((batch) => ({ batch, kind: 'plain' as const })),
  ];
}
