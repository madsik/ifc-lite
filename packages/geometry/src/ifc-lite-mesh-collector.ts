/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite Mesh Collector - extracts triangle data from IFC-Lite WASM
 * Replaces mesh-collector.ts - uses native Rust geometry processing (1.9x faster)
 */

import { createLogger } from '@ifc-lite/data';
import type { IfcAPI, MeshDataJs, InstancedGeometry, MeshCollection } from '@ifc-lite/wasm';
import type { MeshData } from './types.js';

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

  constructor(ifcApi: IfcAPI, content: string) {
    this.ifcApi = ifcApi;
    this.content = content;
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
        // #region agent log (debug)
        try {
          const activeJobId = (globalThis as any)?.__ifcChecker_activeModelJobId ?? null;
          const activeModelIndex = (globalThis as any)?.__ifcChecker_activeModelIndex ?? null;
          const r0 = rtc || { x: 0, y: 0, z: 0, hasRtc: false };
          // Convert RTC offset to viewer Y-up coordinates (same transform as positions):
          // IFC (x,y,z) -> WebGL (x, z, -y)
          const rtcYUp = { x: r0.x, y: r0.z, z: -r0.y, hasRtc: r0.hasRtc };
          fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: 'debug-session',
              runId: 'run1',
              hypothesisId: 'H5',
              location: 'ifc-lite-mesh-collector.ts:parseMeshesAsync:onRtcOffset',
              message: 'rtc offset reported by WASM',
              data: { activeJobId, activeModelIndex, rtc: r0, rtcYUp },
              timestamp: Date.now(),
            }),
          }).catch(() => {});
        } catch {
          // ignore
        }
        // #endregion
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
        try {
          // Read current RTC offset from API (available even if onRtcOffset isn't fired).
          const r0 = {
            x: Number((this.ifcApi as any).rtcOffsetX ?? 0),
            y: Number((this.ifcApi as any).rtcOffsetY ?? 0),
            z: Number((this.ifcApi as any).rtcOffsetZ ?? 0),
          };
          const hasRtc = Boolean((this.ifcApi as any)?.rtcOffset?.hasRtc ?? (r0.x !== 0 || r0.y !== 0 || r0.z !== 0));
          rtc = { ...r0, hasRtc };

          // Convert RTC offset to viewer Y-up coordinates (same transform as positions):
          // IFC (x,y,z) -> WebGL (x, z, -y)
          const rtcYUp = { x: r0.x, y: r0.z, z: -r0.y, hasRtc };

          const g: any = globalThis as any;
          const activeJobId = g?.__ifcChecker_activeModelJobId ?? null;
          const activeModelIndex = g?.__ifcChecker_activeModelIndex ?? null;

          // Establish common RTC origin from first model.
          if (!g.__ifcChecker_commonRtcYUp) {
            g.__ifcChecker_commonRtcYUp = rtcYUp;
            g.__ifcChecker_commonRtcJobId = activeJobId;
          }
          const common = g.__ifcChecker_commonRtcYUp || rtcYUp;
          translateYUp = {
            x: rtcYUp.x - common.x,
            y: rtcYUp.y - common.y,
            z: rtcYUp.z - common.z,
          };

          if (!rtcEntryLogged) {
            rtcEntryLogged = true;
            // #region agent log (debug)
            fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: 'debug-session',
                runId: 'run1',
                hypothesisId: 'H61',
                location: 'ifc-lite-mesh-collector.ts:onBatch',
                message: 'onBatch RTC read + translate computed (first batch for model)',
                data: { activeJobId, activeModelIndex, r0, hasRtc, rtcYUp, commonJobId: g.__ifcChecker_commonRtcJobId ?? null, translateYUp },
                timestamp: Date.now(),
              }),
            }).catch(() => {});
            // #endregion
          }

          if (!rtcLogged) {
            rtcLogged = true;
            // #region agent log (debug)
            fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: 'debug-session',
                runId: 'run1',
                hypothesisId: 'H6',
                location: 'ifc-lite-mesh-collector.ts:onBatch',
                message: 'rtc offsets + translation computed',
                data: { activeJobId, activeModelIndex, rtc, rtcYUp, common, translateYUp },
                timestamp: Date.now(),
              }),
            }).catch(() => {});
            // #endregion
          }
        } catch {
          // #region agent log (debug)
          try {
            const g: any = globalThis as any;
            fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: 'debug-session',
                runId: 'run1',
                hypothesisId: 'H62',
                location: 'ifc-lite-mesh-collector.ts:onBatch',
                message: 'RTC translation compute failed; translateYUp=null',
                data: { activeJobId: g?.__ifcChecker_activeModelJobId ?? null, activeModelIndex: g?.__ifcChecker_activeModelIndex ?? null },
                timestamp: Date.now(),
              }),
            }).catch(() => {});
          } catch {}
          // #endregion
          translateYUp = null;
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
