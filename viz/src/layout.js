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
    // 0.6 lane widths: reaches just past a lane's own groove without
    // swallowing the 2-laneWidth zone gaps (contract: null in a gap)
    return Math.abs(laneRadius[best] - r) <= laneWidth * 0.6 ? best : null;
  };

  return { laneWidth, laneRadius, zoneBands, angleOf, pickLane, durationMs };
}

// Build a layout for a live roster: the connected participants in zone->seat
// order, plus a spare band for anyone who joins after recording started.
// laneMeta[lane] = { zone, seat, pid } for every occupied lane (spare lanes
// fill in as laneOf assigns them; unassigned spares stay null).
export function rosterLayout(roster, durationMs, build = buildLayout, spareLanes = 64) {
  const sorted = [...roster].sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.s - b.s));
  const zones = [];
  sorted.forEach((p, i) => {
    if (!zones.length || zones[zones.length - 1].zone !== p.z) {
      zones.push({ zone: p.z, laneStart: i, laneCount: 0 });
    }
    zones[zones.length - 1].laneCount += 1;
  });
  zones.push({ zone: '·', laneStart: sorted.length, laneCount: spareLanes });
  const laneCount = sorted.length + spareLanes;
  const layout = build({ laneCount, zones, durationMs });

  const laneMeta = new Array(laneCount).fill(null);
  sorted.forEach((p, i) => { laneMeta[i] = { zone: p.z, seat: p.s, pid: `${p.z}${p.s}` }; });

  const laneByKey = new Map(sorted.map((p, i) => [`${p.z}${p.s}`, i]));
  let nextSpare = sorted.length;
  const laneOf = (z, s) => {
    const key = `${z}${s}`;
    let lane = laneByKey.get(key);
    if (lane !== undefined) return lane;
    if (nextSpare >= laneCount) return null; // overflow: recorder still has it
    lane = nextSpare++;
    laneByKey.set(key, lane);
    laneMeta[lane] = { zone: z, seat: s, pid: key };
    return lane;
  };
  return { layout, laneOf, laneCount, laneMeta };
}
