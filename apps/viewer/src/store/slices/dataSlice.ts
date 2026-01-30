/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data state slice (IFC data and geometry)
 */

import type { StateCreator } from 'zustand';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, CoordinateInfo } from '@ifc-lite/geometry';
import type { Lod0Json, Lod1MetaJson } from '@ifc-lite/export';
import { DATA_DEFAULTS } from '../constants.js';

export type ViewerGeometryMode = 'lod0' | 'lod1';

export interface DataSlice {
  // State
  ifcDataStore: IfcDataStore | null;
  geometryResult: GeometryResult | null;
  pendingColorUpdates: Map<number, [number, number, number, number]> | null;

  // LOD artifact state (optional)
  lod0Preview: Lod0Json | null;
  lod1Glb: Uint8Array | null;
  lod1Meta: Lod1MetaJson | null;
  geometryMode: ViewerGeometryMode;
  /** If true, user explicitly picked a mode (no auto-switch) */
  geometryModeLocked: boolean;

  // Actions
  setIfcDataStore: (result: IfcDataStore | null) => void;
  setGeometryResult: (result: GeometryResult | null) => void;
  appendGeometryBatch: (meshes: GeometryResult['meshes'], coordinateInfo?: CoordinateInfo) => void;
  updateMeshColors: (updates: Map<number, [number, number, number, number]>) => void;
  clearPendingColorUpdates: () => void;
  updateCoordinateInfo: (coordinateInfo: CoordinateInfo) => void;

  // LOD artifact actions
  setLod0Preview: (lod0: Lod0Json | null) => void;
  setLod1Artifacts: (result: { glb?: Uint8Array | null; meta?: Lod1MetaJson | null }) => void;
  setGeometryMode: (mode: ViewerGeometryMode, locked?: boolean) => void;
}

const getDefaultCoordinateInfo = (): CoordinateInfo => ({
  // Create fresh copies to avoid shared object references
  originShift: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  originalBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  shiftedBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  hasLargeCoordinates: DATA_DEFAULTS.HAS_LARGE_COORDINATES,
});

export const createDataSlice: StateCreator<DataSlice, [], [], DataSlice> = (set) => ({
  // Initial state
  ifcDataStore: null,
  geometryResult: null,
  pendingColorUpdates: null,

  lod0Preview: null,
  lod1Glb: null,
  lod1Meta: null,
  geometryMode: 'lod0',
  geometryModeLocked: false,

  // Actions
  setIfcDataStore: (ifcDataStore) => set({ ifcDataStore }),

  setGeometryResult: (geometryResult) => set({ geometryResult }),

  appendGeometryBatch: (meshes, coordinateInfo) => set((state) => {
    if (!state.geometryResult) {
      const totalTriangles = meshes.reduce((sum, m) => sum + (m.indices.length / 3), 0);
      const totalVertices = meshes.reduce((sum, m) => sum + (m.positions.length / 3), 0);
      return {
        geometryResult: {
          meshes,
          totalTriangles,
          totalVertices,
          coordinateInfo: coordinateInfo || getDefaultCoordinateInfo(),
        },
      };
    }
    const allMeshes = [...state.geometryResult.meshes, ...meshes];
    const totalTriangles = allMeshes.reduce((sum, m) => sum + (m.indices.length / 3), 0);
    const totalVertices = allMeshes.reduce((sum, m) => sum + (m.positions.length / 3), 0);
    return {
      geometryResult: {
        ...state.geometryResult,
        meshes: allMeshes,
        totalTriangles,
        totalVertices,
        coordinateInfo: coordinateInfo || state.geometryResult.coordinateInfo,
      },
    };
  }),

  updateMeshColors: (updates) => set((state) => {
    if (!state.geometryResult) return {};
    // Clone the Map to prevent external mutation of pendingColorUpdates
    const clonedUpdates = new Map(updates);
    const updatedMeshes = state.geometryResult.meshes.map(mesh => {
      const newColor = clonedUpdates.get(mesh.expressId);
      if (newColor) {
        return { ...mesh, color: newColor };
      }
      return mesh;
    });
    return {
      geometryResult: {
        ...state.geometryResult,
        meshes: updatedMeshes,
      },
      pendingColorUpdates: clonedUpdates,
    };
  }),

  clearPendingColorUpdates: () => set({ pendingColorUpdates: null }),

  updateCoordinateInfo: (coordinateInfo) => set((state) => {
    if (!state.geometryResult) return {};
    return {
      geometryResult: {
        ...state.geometryResult,
        coordinateInfo,
      },
    };
  }),

  setLod0Preview: (lod0Preview) => set({ lod0Preview }),

  setLod1Artifacts: ({ glb, meta }) => set((state) => ({
    lod1Glb: glb !== undefined ? glb : state.lod1Glb,
    lod1Meta: meta !== undefined ? meta : state.lod1Meta,
  })),

  setGeometryMode: (geometryMode, locked = true) => set({
    geometryMode,
    geometryModeLocked: locked,
  }),
});
