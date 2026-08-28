// viz/src/layout.js
// Polar layout shared by rendering, picking and labels.
// One participant = one radial lane (zone -> seat order, from the manifest);
// time 0..durationMs = one full clockwise turn starting at 12 o'clock.
export const INNER_R = 0.3;
export const OUTER_R = 0.95;
export const ZONE_GAP_UNITS = 2;

export function buildLayout(manifest) {
  const { laneCount, zones, durationMs } = manifest;
  const totalUnits = laneCount + ZONE_GAP_UNITS * Math.max(0, zones.length - 1);
  const laneWidth = (OUTER_R - INNER_R) / totalUnits;
  const laneRadius = new Float32Array(laneCount);
  const zoneBands = [];
  let cursor = 0;
  for (const z of zones) {
    const r0 = INNER_R + cursor * laneWidth;
    for (let i = 0; i < z.laneCount; i++) {
      laneRadius[z.laneStart + i] = INNER_R + (cursor + 0.5) * laneWidth;
      cursor += 1;
    }
    zoneBands.push({ zone: z.zone, laneStart: z.laneStart, laneCount: z.laneCount, r0, r1: INNER_R + cursor * laneWidth });
    cursor += ZONE_GAP_UNITS;
  }

  const angleOf = (tMs) => Math.PI / 2 - (2 * Math.PI * tMs) / durationMs;

  // Nearest lane for a world-space point; null outside the disc or in a gap.
  const pickLane = (x, y) => {
    const r = Math.hypot(x, y);
    if (r < INNER_R - laneWidth || r > OUTER_R + laneWidth) return null;
    let lo = 0; let hi = laneCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (laneRadius[mid] < r) lo = mid + 1; else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(laneRadius[lo - 1] - r) < Math.abs(laneRadius[lo] - r)) best = lo - 1;
    return Math.abs(laneRadius[best] - r) <= laneWidth * 1.2 ? best : null;
  };

  return { laneWidth, laneRadius, zoneBands, angleOf, pickLane, durationMs };
}
