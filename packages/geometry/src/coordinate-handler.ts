/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate Handler - handles large coordinate systems by shifting to origin
 * 
 * AEC models often use real-world coordinates (UTM, survey coordinates) with
 * values like X: 500,000m, Y: 5,000,000m. This causes float precision issues.
 * 
 * Solution: Shift model to local origin (centroid) while preserving original
 * coordinates for export/queries.
 */

import type { MeshData } from './types.js';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface AABB {
    min: Vec3;
    max: Vec3;
}

export interface CoordinateInfo {
    originShift: Vec3;
    originalBounds: AABB;
    shiftedBounds: AABB;
    /** True if model had large coordinates requiring RTC shift. NOT the same as proper georeferencing via IfcMapConversion. */
    hasLargeCoordinates: boolean;
}

export class CoordinateHandler {
    private originShift: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly THRESHOLD = 10000; // 10km - threshold for large coordinates
    // Maximum reasonable coordinate - 10,000 km covers any georeferenced building on Earth
    // Values beyond this are garbage/corrupted data (safety net)
    private readonly MAX_REASONABLE_COORD = 1e7;

    // For incremental processing
    private accumulatedBounds: AABB | null = null;
    private shiftCalculated: boolean = false;

    // WASM RTC detection - if WASM already applied RTC, skip TypeScript shift
    private wasmRtcDetected: boolean = false;
    // Threshold for "normal" coordinates when WASM RTC is active (10km = reasonable campus/site size)
    private readonly NORMAL_COORD_THRESHOLD = 10000;
    // Active threshold for coordinate validation (set based on wasmRtcDetected)
    private activeThreshold: number = 1e7;

    /**
     * Check if a coordinate value is reasonable (not corrupted garbage)
     */
    private isReasonableValue(value: number): boolean {
        return Number.isFinite(value) && Math.abs(value) < this.MAX_REASONABLE_COORD;
    }

    /**
     * Calculate bounding box from all meshes (filtering out corrupted values)
     * @param meshes - Meshes to calculate bounds from
     * @param maxCoord - Optional max coordinate threshold (default: MAX_REASONABLE_COORD)
     */
    calculateBounds(meshes: MeshData[], maxCoord?: number): AABB {
        const bounds: AABB = {
            min: { x: Infinity, y: Infinity, z: Infinity },
            max: { x: -Infinity, y: -Infinity, z: -Infinity },
        };

        const threshold = maxCoord ?? this.MAX_REASONABLE_COORD;
        let validVertexCount = 0;
        let corruptedVertexCount = 0;

        for (const mesh of meshes) {
            const positions = mesh.positions;
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i];
                const y = positions[i + 1];
                const z = positions[i + 2];

                // Only include values within threshold (filter out outliers/garbage)
                const coordsFinite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
                const withinThreshold = coordsFinite &&
                    Math.abs(x) < threshold && Math.abs(y) < threshold && Math.abs(z) < threshold;

                if (withinThreshold) {
                    bounds.min.x = Math.min(bounds.min.x, x);
                    bounds.min.y = Math.min(bounds.min.y, y);
                    bounds.min.z = Math.min(bounds.min.z, z);
                    bounds.max.x = Math.max(bounds.max.x, x);
                    bounds.max.y = Math.max(bounds.max.y, y);
                    bounds.max.z = Math.max(bounds.max.z, z);
                    validVertexCount++;
                } else {
                    corruptedVertexCount++;
                }
            }
        }

        if (corruptedVertexCount > 0) {
            console.log(`[CoordinateHandler] Filtered ${corruptedVertexCount} corrupted vertices, kept ${validVertexCount} valid`);
        }

        return bounds;
    }

    /**
     * Check if coordinate shift is needed
     */
    needsShift(bounds: AABB): boolean {
        const maxCoord = Math.max(
            Math.abs(bounds.min.x), Math.abs(bounds.max.x),
            Math.abs(bounds.min.y), Math.abs(bounds.max.y),
            Math.abs(bounds.min.z), Math.abs(bounds.max.z)
        );

        return maxCoord > this.THRESHOLD;
    }

    /**
     * Calculate centroid (center point) from bounds
     */
    calculateCentroid(bounds: AABB): Vec3 {
        return {
            x: (bounds.min.x + bounds.max.x) / 2,
            y: (bounds.min.y + bounds.max.y) / 2,
            z: (bounds.min.z + bounds.max.z) / 2,
        };
    }

    /**
     * Shift positions in-place by subtracting origin shift
     * Corrupted values are set to 0 (center of shifted coordinate system)
     * @param positions - Position array to modify
     * @param shift - Origin shift to subtract
     * @param threshold - Optional threshold for valid coordinates (defaults to MAX_REASONABLE_COORD)
     */
    shiftPositions(positions: Float32Array, shift: Vec3, threshold?: number): void {
        const maxCoord = threshold ?? this.MAX_REASONABLE_COORD;
        let clampedVertexCount = 0;
        let worst: { x: number; y: number; z: number; maxAbs: number } | null = null;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];

            // For corrupted/outlier values, set to center (0) in shifted space
            const coordsValid = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
                Math.abs(x) < maxCoord && Math.abs(y) < maxCoord && Math.abs(z) < maxCoord;

            if (coordsValid) {
                positions[i] = x - shift.x;
                positions[i + 1] = y - shift.y;
                positions[i + 2] = z - shift.z;
            } else {
                // Corrupted/outlier vertex - set to origin to avoid visual artifacts
                clampedVertexCount++;
                const maxAbs = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
                if (!worst || maxAbs > worst.maxAbs) {
                    worst = { x, y, z, maxAbs };
                }
                positions[i] = 0;
                positions[i + 1] = 0;
                positions[i + 2] = 0;
            }
        }

        // #region agent log (debug)
        ;(() => {
            if (clampedVertexCount <= 0) return;
            const g: any = globalThis as any;
            g.__ifcChecker_coordClampLogCount = (g.__ifcChecker_coordClampLogCount || 0) + 1;
            const n = g.__ifcChecker_coordClampLogCount;
            if (n <= 20) {
                fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: 'debug-session',
                        runId: 'run1',
                        hypothesisId: 'H202',
                        location: 'coordinate-handler.ts:shiftPositions',
                        message: 'clamped outlier/corrupted vertices',
                        data: {
                            n,
                            clampedVertexCount,
                            maxCoord,
                            shift,
                            worst,
                        },
                        timestamp: Date.now(),
                    }),
                }).catch(() => { });
            }
        })();
        // #endregion
    }

    /**
     * Shift bounds by subtracting origin shift
     */
    shiftBounds(bounds: AABB, shift: Vec3): AABB {
        return {
            min: {
                x: bounds.min.x - shift.x,
                y: bounds.min.y - shift.y,
                z: bounds.min.z - shift.z,
            },
            max: {
                x: bounds.max.x - shift.x,
                y: bounds.max.y - shift.y,
                z: bounds.max.z - shift.z,
            },
        };
    }

    /**
     * Process meshes: detect large coordinates and shift if needed
     */
    processMeshes(meshes: MeshData[]): CoordinateInfo {
        const emptyResult: CoordinateInfo = {
            originShift: { x: 0, y: 0, z: 0 },
            originalBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            shiftedBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            hasLargeCoordinates: false,
        };

        if (meshes.length === 0) {
            return emptyResult;
        }

        // Calculate original bounds (filtering corrupted values)
        const originalBounds = this.calculateBounds(meshes);

        // Check if we got valid bounds
        const hasValidBounds =
            originalBounds.min.x !== Infinity && originalBounds.max.x !== -Infinity;

        if (!hasValidBounds) {
            console.warn('[CoordinateHandler] No valid coordinates found in geometry');
            return emptyResult;
        }

        const size = {
            x: originalBounds.max.x - originalBounds.min.x,
            y: originalBounds.max.y - originalBounds.min.y,
            z: originalBounds.max.z - originalBounds.min.z,
        };
        const maxSize = Math.max(size.x, size.y, size.z);

        console.log('[CoordinateHandler] Original bounds:', {
            min: originalBounds.min,
            max: originalBounds.max,
            size,
            maxSize: maxSize.toFixed(2) + 'm',
        });

        // Check if shift is needed (>10km from origin)
        const needsShift = this.needsShift(originalBounds);

        if (!needsShift) {
            // No shift needed - just clean up corrupted values in-place
            console.log('[CoordinateHandler] Coordinates within normal range, no shift needed');
            // Still shift by 0 to clean up corrupted vertices
            const zeroShift = { x: 0, y: 0, z: 0 };
            for (const mesh of meshes) {
                this.shiftPositions(mesh.positions, zeroShift);
            }
            return {
                originShift: zeroShift,
                originalBounds,
                shiftedBounds: originalBounds,
                hasLargeCoordinates: false,
            };
        }

        // Calculate centroid as origin shift
        const centroid = this.calculateCentroid(originalBounds);
        this.originShift = centroid;

        console.log('[CoordinateHandler] Large coordinates detected, shifting to origin:', {
            centroid,
            maxCoord: Math.max(
                Math.abs(originalBounds.min.x), Math.abs(originalBounds.max.x),
                Math.abs(originalBounds.min.y), Math.abs(originalBounds.max.y),
                Math.abs(originalBounds.min.z), Math.abs(originalBounds.max.z)
            ).toFixed(2) + 'm',
        });

        // Shift all mesh positions
        for (const mesh of meshes) {
            this.shiftPositions(mesh.positions, centroid);
        }

        // Calculate shifted bounds
        const shiftedBounds = this.shiftBounds(originalBounds, centroid);

        console.log('[CoordinateHandler] Shifted bounds:', {
            min: shiftedBounds.min,
            max: shiftedBounds.max,
            maxSize: maxSize.toFixed(2) + 'm',
        });

        return {
            originShift: centroid,
            originalBounds,
            shiftedBounds,
            hasLargeCoordinates: true,
        };
    }

    /**
     * Convert local (shifted) coordinates back to world coordinates
     */
    toWorldCoordinates(localPos: Vec3): Vec3 {
        return {
            x: localPos.x + this.originShift.x,
            y: localPos.y + this.originShift.y,
            z: localPos.z + this.originShift.z,
        };
    }

    /**
     * Convert world coordinates to local (shifted) coordinates
     */
    toLocalCoordinates(worldPos: Vec3): Vec3 {
        return {
            x: worldPos.x - this.originShift.x,
            y: worldPos.y - this.originShift.y,
            z: worldPos.z - this.originShift.z,
        };
    }

    /**
     * Get current origin shift
     */
    getOriginShift(): Vec3 {
        return { ...this.originShift };
    }

    /**
     * Process meshes incrementally for streaming
     * Accumulates bounds and applies shift once calculated
     *
     * IMPORTANT: Detects if WASM already applied RTC offset by checking if
     * majority of meshes have small coordinates. If so, skips TypeScript shift.
     */
    processMeshesIncremental(batch: MeshData[]): void {
        // If WASM RTC was detected, use stricter threshold to exclude outliers
        // Store in instance variable so shiftPositions uses the same threshold
        this.activeThreshold = this.wasmRtcDetected ? this.NORMAL_COORD_THRESHOLD : this.MAX_REASONABLE_COORD;

        // #region agent log (debug)
        ;(() => {
            // Sample raw positions BEFORE any filtering, to detect "leaked" world-scale vertices.
            let rawMaxAbs = 0;
            let sampled = 0;
            for (const mesh of batch) {
                const p = mesh.positions;
                const limit = Math.min(p.length, 3000);
                for (let i = 0; i + 2 < limit; i += 3) {
                    const x = p[i];
                    const y = p[i + 1];
                    const z = p[i + 2];
                    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
                    if (Number.isFinite(m) && m > rawMaxAbs)
                        rawMaxAbs = m;
                }
                sampled += Math.floor(limit / 3);
                if (sampled >= 5000)
                    break;
            }
            if (rawMaxAbs > 20000) {
                const g = globalThis as any;
                g.__ifcChecker_coordRawMaxAbsLogCount = (g.__ifcChecker_coordRawMaxAbsLogCount || 0) + 1;
                const n = g.__ifcChecker_coordRawMaxAbsLogCount;
                if (n <= 40) {
                    fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sessionId: 'debug-session',
                            runId: 'run1',
                            hypothesisId: 'H203',
                            location: 'coordinate-handler.ts:processMeshesIncremental',
                            message: 'raw vertex magnitude indicates world-scale coords',
                            data: {
                                n,
                                rawMaxAbs,
                                wasmRtcDetectedAtEntry: this.wasmRtcDetected,
                                activeThresholdAtEntry: this.activeThreshold,
                                shiftCalculated: this.shiftCalculated,
                                originShift: this.originShift,
                                batchMeshCount: batch.length,
                            },
                            timestamp: Date.now(),
                        }),
                    }).catch(() => { });
                }
            }
        })();
        // #endregion

        const batchBounds = this.calculateBounds(batch, this.activeThreshold);

        // #region agent log (debug)
        ;(() => {
            const batchMaxAbs = Math.max(
                Math.abs(batchBounds.min.x), Math.abs(batchBounds.max.x),
                Math.abs(batchBounds.min.y), Math.abs(batchBounds.max.y),
                Math.abs(batchBounds.min.z), Math.abs(batchBounds.max.z),
            );
            // Only log when bounds look "world scale" but we are not shifting (suspected leak path)
            if (batchMaxAbs > 20000) {
                const g: any = globalThis as any;
                g.__ifcChecker_coordBatchMaxAbsLogCount = (g.__ifcChecker_coordBatchMaxAbsLogCount || 0) + 1;
                const n = g.__ifcChecker_coordBatchMaxAbsLogCount;
                if (n <= 40) {
                    fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sessionId: 'debug-session',
                            runId: 'run1',
                            hypothesisId: 'H201',
                            location: 'coordinate-handler.ts:processMeshesIncremental',
                            message: 'batch bounds exceed world-scale threshold',
                            data: {
                                n,
                                batchMaxAbs,
                                wasmRtcDetected: this.wasmRtcDetected,
                                activeThreshold: this.activeThreshold,
                                shiftCalculated: this.shiftCalculated,
                                originShift: this.originShift,
                                batchBounds,
                                batchMeshCount: batch.length,
                            },
                            timestamp: Date.now(),
                        }),
                    }).catch(() => { });
                }
            }
        })();
        // #endregion

        if (this.accumulatedBounds === null) {
            this.accumulatedBounds = batchBounds;
        } else {
            // Expand accumulated bounds
            this.accumulatedBounds.min.x = Math.min(this.accumulatedBounds.min.x, batchBounds.min.x);
            this.accumulatedBounds.min.y = Math.min(this.accumulatedBounds.min.y, batchBounds.min.y);
            this.accumulatedBounds.min.z = Math.min(this.accumulatedBounds.min.z, batchBounds.min.z);
            this.accumulatedBounds.max.x = Math.max(this.accumulatedBounds.max.x, batchBounds.max.x);
            this.accumulatedBounds.max.y = Math.max(this.accumulatedBounds.max.y, batchBounds.max.y);
            this.accumulatedBounds.max.z = Math.max(this.accumulatedBounds.max.z, batchBounds.max.z);
        }

        // Calculate shift on first batch if needed
        if (!this.shiftCalculated && this.accumulatedBounds) {
            const hasValidBounds =
                this.accumulatedBounds.min.x !== Infinity &&
                this.accumulatedBounds.max.x !== -Infinity;

            if (hasValidBounds) {
                const size = {
                    x: this.accumulatedBounds.max.x - this.accumulatedBounds.min.x,
                    y: this.accumulatedBounds.max.y - this.accumulatedBounds.min.y,
                    z: this.accumulatedBounds.max.z - this.accumulatedBounds.min.z,
                };
                const maxSize = Math.max(size.x, size.y, size.z);
                const centroid = this.calculateCentroid(this.accumulatedBounds);
                const distanceFromOrigin = Math.sqrt(
                    centroid.x ** 2 + centroid.y ** 2 + centroid.z ** 2
                );

                // DETECT IF WASM ALREADY APPLIED RTC
                // If majority of meshes have small coordinates, WASM already shifted them
                let smallCoordCount = 0;
                let largeCoordCount = 0;
                const SMALL_COORD_THRESHOLD = 10000; // 10km - reasonable campus/site size

                for (const mesh of batch) {
                    const positions = mesh.positions;
                    if (positions.length >= 3) {
                        // Check first vertex of each mesh
                        const x = Math.abs(positions[0]);
                        const y = Math.abs(positions[1]);
                        const z = Math.abs(positions[2]);
                        const maxCoord = Math.max(x, y, z);
                        if (maxCoord < SMALL_COORD_THRESHOLD) {
                            smallCoordCount++;
                        } else {
                            largeCoordCount++;
                        }
                    }
                }

                // If >50% have small coords, WASM RTC was likely applied
                const totalMeshes = smallCoordCount + largeCoordCount;
                const wasmRtcLikelyApplied = totalMeshes > 0 && (smallCoordCount / totalMeshes) > 0.5;

                if (wasmRtcLikelyApplied) {
                    this.wasmRtcDetected = true;
                    // IMPORTANT: we must tighten the activeThreshold for THIS batch as well,
                    // otherwise shiftPositions() will treat leaked world-scale vertices as "valid"
                    // (since MAX_REASONABLE_COORD is 1e7) and they can slip through into the viewer.
                    this.activeThreshold = this.NORMAL_COORD_THRESHOLD;
                    // Recalculate bounds excluding outliers (use stricter threshold)
                    this.accumulatedBounds = this.calculateBounds(batch, this.NORMAL_COORD_THRESHOLD);
                    // #region agent log (debug)
                    ;(() => {
                        const g = globalThis as any;
                        g.__ifcChecker_coordWasmRtcLogCount = (g.__ifcChecker_coordWasmRtcLogCount || 0) + 1;
                        const n = g.__ifcChecker_coordWasmRtcLogCount;
                        if (n <= 20) {
                            fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    sessionId: 'debug-session',
                                    runId: 'run1',
                                    hypothesisId: 'H204',
                                    location: 'coordinate-handler.ts:processMeshesIncremental',
                                    message: 'WASM RTC detected on first batch',
                                    data: {
                                        n,
                                        smallCoordCount,
                                        largeCoordCount,
                                        totalMeshes,
                                        wasmRtcLikelyApplied,
                                        activeThresholdStill: this.activeThreshold,
                                        normalCoordThreshold: this.NORMAL_COORD_THRESHOLD,
                                    },
                                    timestamp: Date.now(),
                                }),
                            }).catch(() => { });
                        }
                    })();
                    // #endregion
                }

                // Check if shift is needed (>10km from origin) AND WASM didn't already apply RTC
                if ((distanceFromOrigin > this.THRESHOLD || maxSize > this.THRESHOLD) && !wasmRtcLikelyApplied) {
                    this.originShift = centroid;
                    console.log('[CoordinateHandler] Large coordinates detected, shifting to origin:', {
                        distanceFromOrigin: distanceFromOrigin.toFixed(2) + 'm',
                        maxSize: maxSize.toFixed(2) + 'm',
                        shift: this.originShift,
                    });
                } else if (wasmRtcLikelyApplied) {
                    // Log that we're skipping because WASM already applied RTC
                    console.log('[CoordinateHandler] Skipping shift - WASM RTC already applied:', {
                        smallCoordCount,
                        largeCoordCount,
                        wasmRtcDetected: true,
                    });
                    // #region agent log (debug)
                    ;(() => {
                        const g: any = globalThis as any;
                        g.__ifcChecker_coordSkipCount = (g.__ifcChecker_coordSkipCount || 0) + 1;
                        const n = g.__ifcChecker_coordSkipCount;
                        if (n <= 10) {
                            fetch('http://127.0.0.1:7243/ingest/0c33703e-a3cc-4523-b6f9-7493b9ad5593', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    sessionId: 'debug-session',
                                    runId: 'run1',
                                    hypothesisId: 'H3',
                                    location: 'coordinate-handler.ts:processMeshesIncremental',
                                    message: 'skip shift (WASM RTC already applied)',
                                    data: { n, smallCoordCount, largeCoordCount, wasmRtcDetected: true, shiftCalculated: this.shiftCalculated },
                                    timestamp: Date.now(),
                                }),
                            }).catch(() => { });
                        }
                    })();
                    // #endregion
                }
            }
            this.shiftCalculated = true;
        }

        // Apply shift to this batch (only if we determined shift is needed AND WASM didn't already apply)
        // Use the same threshold for vertex cleanup as was used for bounds calculation
        if (this.originShift.x !== 0 || this.originShift.y !== 0 || this.originShift.z !== 0) {
            for (const mesh of batch) {
                this.shiftPositions(mesh.positions, this.originShift, this.activeThreshold);
            }
        } else {
            // IMPORTANT: Even when we skip shifting (originShift = 0), we must still clean outlier/corrupted vertices.
            // Otherwise a small number of "world coordinate" vertices can slip through and break federation in the viewer,
            // while bounds calculations ignore them due to the strict activeThreshold.
            const zeroShift = { x: 0, y: 0, z: 0 };
            for (const mesh of batch) {
                this.shiftPositions(mesh.positions, zeroShift, this.activeThreshold);
            }
        }
    }

    /**
     * Get current coordinate info (for incremental updates)
     */
    getCurrentCoordinateInfo(): CoordinateInfo | null {
        if (!this.accumulatedBounds) {
            return null;
        }

        const hasValidBounds =
            this.accumulatedBounds.min.x !== Infinity &&
            this.accumulatedBounds.max.x !== -Infinity;

        if (!hasValidBounds) {
            return null;
        }

        const shiftedBounds = this.shiftBounds(this.accumulatedBounds, this.originShift);
        const hasLargeCoordinates =
            this.originShift.x !== 0 ||
            this.originShift.y !== 0 ||
            this.originShift.z !== 0;

        return {
            originShift: { ...this.originShift },
            originalBounds: { ...this.accumulatedBounds },
            shiftedBounds,
            hasLargeCoordinates,
        };
    }

    /**
     * Get final coordinate info after incremental processing
     */
    getFinalCoordinateInfo(): CoordinateInfo {
        const current = this.getCurrentCoordinateInfo();
        if (current) {
            return current;
        }

        // Fallback to zero bounds if no valid bounds found
        return {
            originShift: { x: 0, y: 0, z: 0 },
            originalBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            shiftedBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            hasLargeCoordinates: false,
        };
    }

    /**
     * Reset incremental state (for new file)
     */
    reset(): void {
        this.accumulatedBounds = null;
        this.shiftCalculated = false;
        this.originShift = { x: 0, y: 0, z: 0 };
        this.wasmRtcDetected = false;
        this.activeThreshold = this.MAX_REASONABLE_COORD;
    }
}
