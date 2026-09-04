// Both views retain participant lanes through an invertible radial transform.
export const COSMIC_INNER_RADIUS = 0.3;
export const COSMIC_RADIUS_SPAN = 0.65;
export const COSMIC_TIME_SWEEP = 0.24;
export const COSMIC_TWIST = 1.22;
export const COSMIC_ROTATION = -0.46;
export const COSMIC_CORE_RADIUS = 0.035;

export function traceRadius(radius, morph = 1) {
  const mode = Math.max(0, Math.min(1, morph));
  const cosmic = radius < COSMIC_INNER_RADIUS
    ? radius * COSMIC_CORE_RADIUS / COSMIC_INNER_RADIUS
    : COSMIC_CORE_RADIUS + (radius - COSMIC_INNER_RADIUS) * (0.95 - COSMIC_CORE_RADIUS) / COSMIC_RADIUS_SPAN;
  return radius + (cosmic - radius) * mode;
}

// Inverse radial projection for participant picking. The screen angle is
// retained because layout.pickLane uses only distance from the artwork origin.
export function unprojectTracePoint(x, y, morph = 1) {
  const mode = Math.max(0, Math.min(1, morph));
  const radius = Math.hypot(x, y);
  if (radius === 0) return { x: 0, y: 0 };
  const pivot = COSMIC_INNER_RADIUS + (COSMIC_CORE_RADIUS - COSMIC_INNER_RADIUS) * mode;
  const innerScale = 1 + (COSMIC_CORE_RADIUS / COSMIC_INNER_RADIUS - 1) * mode;
  const outerScale = 1 + ((0.95 - COSMIC_CORE_RADIUS) / COSMIC_RADIUS_SPAN - 1) * mode;
  const original = radius < pivot ? radius / innerScale : COSMIC_INNER_RADIUS + (radius - pivot) / outerScale;
  return { x: x * original / radius, y: y * original / radius };
}

export function traceAngle(radius, time, duration, morph = 1) {
  const mode = Math.max(0, Math.min(1, morph));
  const sweep = 1 + (COSMIC_TIME_SWEEP - 1) * mode;
  return Math.PI / 2 - Math.PI * 2 * (time / Math.max(1, duration)) * sweep
    + mode * (Math.PI * 2 * COSMIC_TWIST * ((radius - COSMIC_INNER_RADIUS) / COSMIC_RADIUS_SPAN) + COSMIC_ROTATION);
}

export function projectTracePoint(radius, time, duration, morph = 1) {
  const angle = traceAngle(radius, time, duration, morph);
  const projectedRadius = traceRadius(radius, morph);
  return { x: Math.cos(angle) * projectedRadius, y: Math.sin(angle) * projectedRadius };
}

// Shared literals keep the GPU artwork and CPU playhead on the same curve.
export const TRACE_PROJECTION_GLSL = /* glsl */ `
  float traceRadius(float radius, float morph) {
    float cosmic = radius < ${COSMIC_INNER_RADIUS.toFixed(8)}
      ? radius * ${(COSMIC_CORE_RADIUS / COSMIC_INNER_RADIUS).toFixed(10)}
      : ${COSMIC_CORE_RADIUS.toFixed(8)} + (radius - ${COSMIC_INNER_RADIUS.toFixed(8)}) * ${((0.95 - COSMIC_CORE_RADIUS) / COSMIC_RADIUS_SPAN).toFixed(10)};
    return mix(radius, cosmic, morph);
  }
  float traceAngle(float radius, float time, float duration, float morph) {
    float sweep = mix(1.0, ${COSMIC_TIME_SWEEP.toFixed(8)}, morph);
    return 1.57079632679 - 6.28318530718 * time / max(1.0, duration) * sweep
      + morph * (6.28318530718 * ${COSMIC_TWIST.toFixed(8)} *
        ((radius - ${COSMIC_INNER_RADIUS.toFixed(8)}) / ${COSMIC_RADIUS_SPAN.toFixed(8)}) + ${COSMIC_ROTATION.toFixed(8)});
  }
`;
