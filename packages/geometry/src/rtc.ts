/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from './types.js'

export const RTC_TRIGGER_THRESHOLD = 10_000 // 10km
export const RTC_MAX_REASONABLE = 10_000_000 // 10,000km

/**
 * Compute an RTC offset candidate (IFC coordinates, Z-up) from a translation vector.
 *
 * This is a policy/safety wrapper:
 * - Only enable RTC if any component exceeds 10km.
 * - Reject obviously corrupt values (>10,000km).
 *
 * Note: In the IFC-Lite WASM path, the candidate translation is provided by Rust
 * (`detect_rtc_offset_from_first_element`) and already follows the 10km rule.
 * We keep this wrapper so the TS side never propagates corrupt RTC values.
 */
export function computeRtcOffsetIfc(candidate: Vec3 | null | undefined): { hasRtc: boolean; rtcOffsetIfc: Vec3 } {
  const x = Number(candidate?.x ?? 0)
  const y = Number(candidate?.y ?? 0)
  const z = Number(candidate?.z ?? 0)
  const maxAbs = Math.max(Math.abs(x), Math.abs(y), Math.abs(z))

  // Corrupt or non-finite => no RTC
  if (!Number.isFinite(maxAbs) || maxAbs > RTC_MAX_REASONABLE) {
    return { hasRtc: false, rtcOffsetIfc: { x: 0, y: 0, z: 0 } }
  }

  // Under threshold => no RTC
  if (maxAbs <= RTC_TRIGGER_THRESHOLD) {
    return { hasRtc: false, rtcOffsetIfc: { x: 0, y: 0, z: 0 } }
  }

  return { hasRtc: true, rtcOffsetIfc: { x, y, z } }
}

