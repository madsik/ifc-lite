/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite Mesh Collector - extracts triangle data from IFC-Lite WASM
 * Replaces mesh-collector.ts - uses native Rust geometry processing (1.9x faster)
 */

import { createLogger } from '@ifc-lite/data';
import type { IfcAPI, MeshDataJs, InstancedGeometry, MeshCollection } from '@ifc-lite/wasm';
import type { MeshData, RtcFrameInfo } from './types.js';
import { computeRtcOffsetIfc } from './rtc.js';

const log = createLogger('MeshCollector');

export interface StreamingProgress {
  percent: number;
  processed: number;
  total: number;
  phase: 'simple' | 'simple_complete' | 'complex';
}

export interface StreamingBatchEvent {
  type: 'batch';
  meshes: MeshData[];
  progress: StreamingProgress;
}

export interface StreamingCompleteEvent {
  type: 'complete';
  stats: {
    totalMeshes: number;
    totalVertices: number;
    totalTriangles: number;
  };
}

export interface StreamingColorUpdateEvent {
  type: 'colorUpdate';
  updates: Map<number, [number, number, number, number]>;
}

export type StreamingEvent = StreamingBatchEvent | StreamingCompleteEvent | StreamingColorUpdateEvent;

export class IfcLiteMeshCollector {
  private ifcApi: IfcAPI;
  private content: string;
  private lastRtcFrameInfo: RtcFrameInfo | null = null;
  private jsRtcComputed: boolean = false;
  private jsRtc: { hasRtc: boolean; rtcOffsetIfc: { x: number; y: number; z: number } } | null = null;

  constructor(ifcApi: IfcAPI, content: string) {
    this.ifcApi = ifcApi;
    this.content = content;
  }

  /**
   * Latest RTC frame info computed for the current streaming batch.
   * Useful for diagnostics and for higher-level federation logic.
   */
  getLastRtcFrameInfo(): RtcFrameInfo | null {
    return this.lastRtcFrameInfo;
  }

  private sampleMaxAbsSpreadIfc(coords: Float32Array, samples: number = 256): number {
    if (!coords || typeof coords.length !== 'number' || coords.length < 3) return 0;
    const n = Math.max(1, Math.floor(samples));
    const last = coords.length - 3;
    let maxAbs = 0;
    for (let i = 0; i < n; i += 1) {
      const t = n === 1 ? 0 : i / (n - 1);
      const idx = Math.floor((t * last) / 3) * 3;
      const x = coords[idx];
      const y = coords[idx + 1];
      const z = coords[idx + 2];
      const a = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
    }
    return maxAbs;
  }

  private sampleBoundsSpreadIfc(meshes: MeshDataJs[], maxMeshes: number = 4, samplesPerMesh: number = 256): { min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number } } | null {
    const mn = { x: Infinity, y: Infinity, z: Infinity };
    const mx = { x: -Infinity, y: -Infinity, z: -Infinity };
    let saw = false;
    const mlim = Math.min(Math.max(0, Math.floor(maxMeshes)), meshes.length);
    for (let mi = 0; mi < mlim; mi += 1) {
      const p = meshes[mi]?.positions as Float32Array | undefined;
      if (!p || typeof p.length !== 'number' || p.length < 3) continue;
      const n = Math.max(1, Math.floor(samplesPerMesh));
      const last = p.length - 3;
      for (let i = 0; i < n; i += 1) {
        const t = n === 1 ? 0 : i / (n - 1);
        const idx = Math.floor((t * last) / 3) * 3;
        const x = p[idx];
        const y = p[idx + 1];
        const z = p[idx + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        mn.x = Math.min(mn.x, x); mn.y = Math.min(mn.y, y); mn.z = Math.min(mn.z, z);
        mx.x = Math.max(mx.x, x); mx.y = Math.max(mx.y, y); mx.z = Math.max(mx.z, z);
        saw = true;
      }
    }
    if (!saw) return null;
    return { min: mn, max: mx };
  }

  private detectJsRtcOffsetIfc(meshes: MeshDataJs[]): { hasRtc: boolean; rtcOffsetIfc: { x: number; y: number; z: number } } {
    // Compute once per IFC content / collector instance.
    if (this.jsRtcComputed && this.jsRtc) return this.jsRtc;
    this.jsRtcComputed = true;

    try {
      const b = this.sampleBoundsSpreadIfc(meshes, 4, 256);
      if (!b) {
        this.jsRtc = { hasRtc: false, rtcOffsetIfc: { x: 0, y: 0, z: 0 } };
        return this.jsRtc;
      }
      const cand = {
        x: (Number(b.min.x) + Number(b.max.x)) / 2,
        y: (Number(b.min.y) + Number(b.max.y)) / 2,
        z: (Number(b.min.z) + Number(b.max.z)) / 2,
      };
      const js = computeRtcOffsetIfc(cand);
      this.jsRtc = { hasRtc: Boolean(js.hasRtc), rtcOffsetIfc: { x: Number(js.rtcOffsetIfc.x), y: Number(js.rtcOffsetIfc.y), z: Number(js.rtcOffsetIfc.z) } };
      return this.jsRtc;
    } catch {
      this.jsRtc = { hasRtc: false, rtcOffsetIfc: { x: 0, y: 0, z: 0 } };
      return this.jsRtc;
    }
  }

  /**
   * Convert IFC Z-up coordinates to WebGL Y-up coordinates
   * IFC uses Z-up (Z points up), WebGL uses Y-up (Y points up)
   * Transformation: swap Y and Z, then negate new Z to maintain right-handedness
   */
  private convertZUpToYUp(coords: Float32Array, translate?: { x: number; y: number; z: number } | null): void {
    const tx = translate?.x ?? 0;
    const ty = translate?.y ?? 0;
    const tz = translate?.z ?? 0;
    for (let i = 0; i < coords.length; i += 3) {
      const y = coords[i + 1];
      const z = coords[i + 2];
      // Swap Y and Z: Z-up → Y-up
      coords[i] = coords[i] + tx;          // X unchanged, plus translation
      coords[i + 1] = z + ty;              // New Y = old Z (vertical), plus translation
      coords[i + 2] = (-y) + tz;           // New Z = -old Y (depth), plus translation
    }
  }

  /**
   * Reverse triangle winding order to correct for handedness flip.
   * The Z-up to Y-up conversion includes a reflection (Z negation),
   * which flips the handedness. This reverses winding to compensate,
   * ensuring triangles face the correct direction after transformation.
   */
  private reverseWindingOrder(indices: Uint32Array): void {
    // Calculate last valid triangle index to avoid out-of-bounds access
    const remainder = indices.length % 3;
    const end = indices.length - remainder;

    // Warn if indices array has trailing non-triangle entries
    if (remainder !== 0) {
      console.warn(`[reverseWindingOrder] Index buffer has ${remainder} trailing entries (not divisible by 3)`);
    }

    for (let i = 0; i < end; i += 3) {
      // Swap second and third vertex of each triangle
      const temp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = temp;
    }
  }

  /**
   * Collect all meshes from IFC-Lite
   * Much faster than web-ifc (~1.9x speedup)
   */
  collectMeshes(): MeshData[] {
    let collection: MeshCollection;
    try {
      collection = this.ifcApi.parseMeshes(this.content);
    } catch (error) {
      log.error('WASM mesh parsing failed', error, { operation: 'collectMeshes' });
      throw error;
    }

    const meshes: MeshData[] = [];
    let failedMeshes = 0;

    // Convert MeshCollection to MeshData[]
    for (let i = 0; i < collection.length; i++) {
      let mesh: ReturnType<typeof collection.get> | null = null;
      try {
        mesh = collection.get(i);
        if (!mesh) {
          failedMeshes++;
          continue;
        }

        // Get color array [r, g, b, a]
        const colorArray = mesh.color;
        const color: [number, number, number, number] = [
          colorArray[0],
          colorArray[1],
          colorArray[2],
          colorArray[3],
        ];

        // Capture arrays once (WASM creates new copies on each access)
        const positions = mesh.positions;
        const normals = mesh.normals;
        const indices = mesh.indices;

        // Convert IFC Z-up to WebGL Y-up (modify captured arrays)
        this.convertZUpToYUp(positions);
        this.convertZUpToYUp(normals);

        // Reverse winding order to compensate for handedness flip from Y negation
        // Without this, triangles face the wrong way and get backface-culled
        this.reverseWindingOrder(indices);

        meshes.push({
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions,
          normals,
          indices,
          color,
        });

        // Free the individual mesh to avoid memory leaks
        mesh.free();
        mesh = null; // Mark as freed
      } catch (error) {
        failedMeshes++;
        log.caught(`Failed to process mesh ${i}`, error, { operation: 'collectMeshes' });
        // Ensure mesh is freed even on error
        if (mesh) {
          try {
            mesh.free();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
    }

    // Free the collection
    collection.free();

    if (failedMeshes > 0) {
      log.warn(`Skipped ${failedMeshes} meshes due to errors`, { operation: 'collectMeshes' });
    }

    log.debug(`Collected ${meshes.length} meshes`, { operation: 'collectMeshes' });
    return meshes;
  }

  /**
   * Collect meshes incrementally, yielding batches for progressive rendering
   * Uses fast-first-frame streaming: simple geometry (walls, slabs) first
   * @param batchSize Number of meshes per batch (default: 25 for faster first frame)
   */
  async *collectMeshesStreaming(batchSize: number = 25): AsyncGenerator<MeshData[] | StreamingColorUpdateEvent> {
    // Queue to hold batches produced by async callback
    const batchQueue: (MeshData[] | StreamingColorUpdateEvent)[] = [];
    let resolveWaiting: (() => void) | null = null;
    let isComplete = false;
    let processingError: Error | null = null;
    // Map to store color updates for pending batches
    const colorUpdates = new Map<number, [number, number, number, number]>();
    let totalMeshesProcessed = 0;
    let failedMeshCount = 0;
    let rtc: { x: number; y: number; z: number; hasRtc: boolean } | null = null;
    let rtcLogged = false;
    let rtcEntryLogged = false;

    // Start async processing
    // NOTE: WASM now automatically defers style building for faster first frame
    const processingPromise = this.ifcApi.parseMeshesAsync(this.content, {
      batchSize,
      onRtcOffset: (r: any) => {
        try {
          rtc = {
            x: Number(r?.x ?? 0),
            y: Number(r?.y ?? 0),
            z: Number(r?.z ?? 0),
            hasRtc: Boolean(r?.hasRtc ?? false),
          };
        } catch {
          rtc = null;
        }
      },
      onColorUpdate: (updates: Map<number, [number, number, number, number]>) => {
        // Store color updates
        for (const [expressId, color] of updates) {
          colorUpdates.set(expressId, color);
        }
        // Emit color update event
        batchQueue.push({
          type: 'colorUpdate',
          updates: new Map(updates),
        });
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onBatch: (meshes: MeshDataJs[], _progress: StreamingProgress) => {
        // Compute RTC alignment delta (per-model) to federate models into a common local frame.
        // We keep coordinates near the first model's local origin to avoid huge float values.
        let translateYUp: { x: number; y: number; z: number } | null = null;
        let rtcSource: 'wasm' | 'js' | 'none' = 'none';
        let m0Spread = 0;
        let mBatchSpread = 0;
        try {
          // Read current RTC offset from API (available even if onRtcOffset isn't fired).
          const r0raw = {
            x: Number((this.ifcApi as any).rtcOffsetX ?? 0),
            y: Number((this.ifcApi as any).rtcOffsetY ?? 0),
            z: Number((this.ifcApi as any).rtcOffsetZ ?? 0),
          };
          const wasmHasRtc = Boolean((this.ifcApi as any)?.rtcOffset?.hasRtc ?? (r0raw.x !== 0 || r0raw.y !== 0 || r0raw.z !== 0));
          let out = wasmHasRtc ? computeRtcOffsetIfc(r0raw) : { hasRtc: false, rtcOffsetIfc: { x: 0, y: 0, z: 0 } };
          rtcSource = out.hasRtc ? 'wasm' : 'none';

          // JS fallback: if WASM didn't report RTC, detect from actual IFC-coordinate vertex magnitudes.
          // This fixes datasets where WASM doesn't surface rtcOffset but geometry is clearly world-scale.
          if (!out.hasRtc) {
            // Spread-sample a few meshes in the batch. Some datasets have "small" first meshes
            // but later meshes contain the world-scale coordinates (if we only look at meshes[0], RTC can be missed).
            const maxMeshes = Math.min(4, Array.isArray(meshes) ? meshes.length : 0);
            for (let mi = 0; mi < maxMeshes; mi++) {
              const pm = meshes && meshes.length > mi ? (meshes[mi]?.positions as Float32Array | undefined) : undefined;
              const s = pm && pm.length >= 3 ? this.sampleMaxAbsSpreadIfc(pm, 256) : 0;
              if (mi === 0) m0Spread = s;
              mBatchSpread = Math.max(mBatchSpread, s);
            }

            if (mBatchSpread > 10_000) {
              const js = this.detectJsRtcOffsetIfc(meshes);
              if (js.hasRtc) {
                out = { hasRtc: true, rtcOffsetIfc: js.rtcOffsetIfc };
                rtcSource = 'js';
              }
            }
          }

          const r0 = out.rtcOffsetIfc;
          const hasRtc = Boolean(out.hasRtc);
          rtc = { ...r0, hasRtc };

          // Convert RTC offset to viewer Y-up coordinates (same transform as positions):
          // IFC (x,y,z) -> WebGL (x, z, -y)
          const rtcYUp = { x: r0.x, y: r0.z, z: -r0.y, hasRtc };

          const g: any = globalThis as any;
          const activeJobId = g?.__ifcChecker_activeModelJobId ?? null;
          const activeModelIndex = g?.__ifcChecker_activeModelIndex ?? null;

          // Establish a common RTC origin for federated loads.
          //
          // IMPORTANT:
          // - Only RTC-enabled models should participate in the common-RTC frame.
          // - If the first model has no RTC but a later model does, upgrade the common origin to the first RTC-enabled model.
          //   (Otherwise we'd keep commonRtc at 0 and start emitting world-scale vertices for large-coordinate models.)
          const existingCommon = g.__ifcChecker_commonRtcYUp ?? null;
          const existingCommonHasRtc = Boolean(existingCommon?.hasRtc);
          if (!existingCommon || (!existingCommonHasRtc && hasRtc)) {
            g.__ifcChecker_commonRtcYUp = rtcYUp;
            g.__ifcChecker_commonRtcJobId = activeJobId;
          }
          const common = g.__ifcChecker_commonRtcYUp || rtcYUp;
          const commonHasRtc = Boolean(common?.hasRtc);

          // Only apply common-RTC translation when BOTH:
          // - the federation common frame is RTC-enabled, and
          // - this model is RTC-enabled (its vertices are emitted as world - rtcOffset).
          //
          // If we translate a non-RTC model by (-commonRtc), we can scatter otherwise-correct local models.
          translateYUp =
            commonHasRtc && hasRtc
              ? {
                  x: rtcYUp.x - common.x,
                  y: rtcYUp.y - common.y,
                  z: rtcYUp.z - common.z,
                }
              : null;

          // Expose RTC frame info for this batch (IFC + Y-up + common + delta).
          this.lastRtcFrameInfo = {
            hasRtc,
            source: rtcSource,
            modelRtcIfc: { x: r0.x, y: r0.y, z: r0.z },
            modelRtcYUp: { x: rtcYUp.x, y: rtcYUp.y, z: rtcYUp.z },
            commonRtcYUp: common ? { x: Number(common.x), y: Number(common.y), z: Number(common.z), hasRtc: Boolean(common?.hasRtc) } : null,
            translateYUp: translateYUp ? { x: Number(translateYUp.x), y: Number(translateYUp.y), z: Number(translateYUp.z) } : null,
          };
        } catch {
          translateYUp = null;
          this.lastRtcFrameInfo = null;
        }

        // Convert WASM meshes to MeshData[]
        const convertedBatch: MeshData[] = [];

        for (const mesh of meshes) {
          try {
            // Use updated color if available, otherwise use mesh color
            const expressId = mesh.expressId;
            const color: [number, number, number, number] = colorUpdates.get(expressId) ?? [
              mesh.color[0],
              mesh.color[1],
              mesh.color[2],
              mesh.color[3],
            ];

            // Capture arrays once
            const positions = mesh.positions;
            const normals = mesh.normals;
            const indices = mesh.indices;

            // If RTC came from JS fallback (WASM did not apply it), subtract RTC in IFC coords BEFORE axis conversion.
            // This keeps the shift consistent for the whole mesh (never per-vertex thresholding).
            if (rtcSource === 'js' && rtc?.hasRtc) {
              const ox = Number(rtc.x ?? 0);
              const oy = Number(rtc.y ?? 0);
              const oz = Number(rtc.z ?? 0);
              if (ox !== 0 || oy !== 0 || oz !== 0) {
                for (let i = 0; i < positions.length; i += 3) {
                  positions[i] = positions[i] - ox;
                  positions[i + 1] = positions[i + 1] - oy;
                  positions[i + 2] = positions[i + 2] - oz;
                }
              }
            }

            // Convert IFC Z-up to WebGL Y-up, and translate into common RTC frame.
            // Translation applies to positions only, not normals.
            this.convertZUpToYUp(positions, translateYUp);
            this.convertZUpToYUp(normals, null);

            // Reverse winding order to compensate for handedness flip from Y negation
            this.reverseWindingOrder(indices);

            convertedBatch.push({
              expressId,
              ifcType: mesh.ifcType,
              positions,
              normals,
              indices,
              color,
            });

            // Free the mesh to avoid memory leaks
            mesh.free();
            totalMeshesProcessed++;
          } catch (error) {
            failedMeshCount++;
            log.caught(`Failed to process mesh #${mesh.expressId}`, error, {
              operation: 'collectMeshesStreaming',
              entityId: mesh.expressId,
            });
            try {
              mesh.free();
            } catch {
              // Ignore free errors
            }
          }
        }

        // Add batch to queue
        if (convertedBatch.length > 0) {
          batchQueue.push(convertedBatch);
        }

        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onComplete: (stats: { totalMeshes: number; totalVertices: number; totalTriangles: number }) => {
        isComplete = true;
        log.debug(`Streaming complete: ${stats.totalMeshes} meshes, ${stats.totalVertices} vertices, ${stats.totalTriangles} triangles`, {
          operation: 'collectMeshesStreaming',
        });
        if (failedMeshCount > 0) {
          log.warn(`Skipped ${failedMeshCount} meshes due to errors`, { operation: 'collectMeshesStreaming' });
        }
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
    }).catch((error) => {
      processingError = error instanceof Error ? error : new Error(String(error));
      log.error('WASM streaming parsing failed', processingError, { operation: 'collectMeshesStreaming' });
      isComplete = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    });

    // Yield batches as they become available
    while (true) {
      // Yield any queued batches
      while (batchQueue.length > 0) {
        yield batchQueue.shift()!;
      }

      // Check for errors
      if (processingError) {
        throw processingError;
      }

      // Check if we're done
      if (isComplete && batchQueue.length === 0) {
        break;
      }

      // Wait for more batches
      await new Promise<void>((resolve) => {
        resolveWaiting = resolve;
      });
    }

    // Ensure processing is complete
    await processingPromise;
  }

  /**
   * Collect meshes with dynamic batch sizing (ramp-up approach)
   * Accumulates meshes from WASM and yields them in dynamically-sized batches
   * @param getBatchSize Function that returns batch size for current batch number
   */
  async *collectMeshesStreamingDynamic(
    getBatchSize: () => number
  ): AsyncGenerator<MeshData[]> {
    let batchNumber = 0;
    let accumulatedMeshes: MeshData[] = [];
    let currentBatchSize = getBatchSize();

    // Use larger WASM batches to reduce callback overhead
    // First frame responsiveness comes from WASM's internal simple/complex ordering
    // For huge files (>100MB), use 500 to minimize callbacks (20x fewer than 25)
    const wasmBatchSize = 500; // Larger batches = fewer callbacks = faster

    for await (const item of this.collectMeshesStreaming(wasmBatchSize)) {
      // Skip color update events in dynamic batching
      if (item && typeof item === 'object' && 'type' in item && (item as StreamingColorUpdateEvent).type === 'colorUpdate') {
        continue;
      }
      const wasmBatch = item as MeshData[];
      accumulatedMeshes.push(...wasmBatch);

      // Yield when we've accumulated enough for current dynamic batch size
      while (accumulatedMeshes.length >= currentBatchSize) {
        const batchToYield = accumulatedMeshes.splice(0, currentBatchSize);
        yield batchToYield;
        
        // Update batch size for next batch
        batchNumber++;
        currentBatchSize = getBatchSize();
      }
    }

    // Yield remaining meshes
    if (accumulatedMeshes.length > 0) {
      yield accumulatedMeshes;
    }
  }

  /**
   * Collect instanced geometry incrementally, yielding batches for progressive rendering
   * Groups identical geometries by hash (before transformation) for GPU instancing
   * Uses fast-first-frame streaming: simple geometry (walls, slabs) first
   * @param batchSize Number of unique geometries per batch (default: 25)
   */
  async *collectInstancedGeometryStreaming(batchSize: number = 25): AsyncGenerator<InstancedGeometry[]> {
    // Queue to hold batches produced by async callback
    const batchQueue: InstancedGeometry[][] = [];
    let resolveWaiting: (() => void) | null = null;
    let isComplete = false;

    // Start async processing
    const processingPromise = this.ifcApi.parseMeshesInstancedAsync(this.content, {
      batchSize,
      onBatch: (geometries: InstancedGeometry[], _progress: StreamingProgress) => {
        // NOTE: Do NOT convert Z-up to Y-up here for instanced geometry!
        // Instance transforms position geometry in world space.
        // If we convert local positions but not transforms, geometry breaks.
        // The viewer handles coordinate system in the camera/shader.
        // Add batch directly to queue without modification
        batchQueue.push(geometries);

        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onComplete: (_stats: { totalGeometries: number; totalInstances: number }) => {
        isComplete = true;
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
    });

    // Yield batches as they become available
    while (true) {
      // Yield any queued batches
      while (batchQueue.length > 0) {
        yield batchQueue.shift()!;
      }

      // Check if we're done
      if (isComplete && batchQueue.length === 0) {
        break;
      }

      // Wait for more batches
      await new Promise<void>((resolve) => {
        resolveWaiting = resolve;
      });
    }

    // Ensure processing is complete
    await processingPromise;
  }
}
