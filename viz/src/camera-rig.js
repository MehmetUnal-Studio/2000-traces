// Pure camera navigation math. Distance is a world-space camera dolly; FOV
// stays fixed, so approaching foreground and background produces parallax.
export const CAMERA_LIMITS = Object.freeze({ fov: 45, minDistance: .36, maxDistance: 18, coreClearance: .26, pitch: Math.PI * .46, dampingMs: 145 });
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const copy = (pose) => ({ distance: pose.distance, yaw: pose.yaw, pitch: pose.pitch, target: { ...pose.target } });

export function cameraBasis({ yaw, pitch }) {
  const sy = Math.sin(yaw); const cy = Math.cos(yaw); const sp = Math.sin(pitch); const cp = Math.cos(pitch);
  return { backward: { x: sy * cp, y: sp, z: cy * cp }, right: { x: cy, y: 0, z: -sy }, up: { x: -sy * sp, y: cp, z: -cy * sp } };
}

export function cameraPosition(pose) {
  const direction = cameraBasis(pose).backward;
  return { x: pose.target.x + direction.x * pose.distance, y: pose.target.y + direction.y * pose.distance, z: pose.target.z + direction.z * pose.distance };
}

// Stop a dolly ray at the near side of the central sphere, including after a
// pan. Merely clamping distance to a movable target could enter the core.
export function safeDollyDistance(pose, requested, clearance = CAMERA_LIMITS.coreClearance) {
  const direction = cameraBasis(pose).backward;
  const p = pose.target;
  const along = p.x * direction.x + p.y * direction.y + p.z * direction.z;
  const perpendicular2 = p.x * p.x + p.y * p.y + p.z * p.z - along * along;
  const discriminant = clearance * clearance - perpendicular2;
  if (discriminant <= 0) return requested;
  return Math.max(requested, -along + Math.sqrt(discriminant) + .008);
}

export function fittedCameraPose({ width, height, presentation = false, extent = 1.1, fov = CAMERA_LIMITS.fov }) {
  const w = Math.max(1, width); const h = Math.max(1, height);
  const aspect = w / h; const halfFov = fov * Math.PI / 360;
  const chrome = presentation ? 70 : w < 700 ? 260 : 190;
  const verticalFill = clamp((h - chrome) / h, .35, .93);
  const horizontalFill = presentation ? .9 : .87;
  const angle = Math.min(Math.atan(Math.tan(halfFov) * verticalFill), Math.atan(Math.tan(halfFov) * aspect * horizontalFill));
  const distance = clamp(extent / Math.sin(angle), CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
  const visibleHeight = 2 * distance * Math.tan(halfFov);
  return { distance, yaw: 0, pitch: 0, target: { x: 0, y: presentation ? 0 : w < 700 ? -visibleHeight * .085 : -.018, z: 0 } };
}

export function createCameraRig(initial = fittedCameraPose({ width: 1440, height: 900 })) {
  let current = copy(initial); let desired = copy(initial); let journey = null;
  const normalize = (pose) => {
    pose.yaw = finite(pose.yaw, 0);
    pose.pitch = clamp(finite(pose.pitch, 0), -CAMERA_LIMITS.pitch, CAMERA_LIMITS.pitch);
    pose.target = { x: finite(pose.target?.x, 0), y: finite(pose.target?.y, 0), z: finite(pose.target?.z, 0) };
    const length = Math.hypot(pose.target.x, pose.target.y, pose.target.z);
    if (length > 3) for (const axis of ['x', 'y', 'z']) pose.target[axis] *= 3 / length;
    pose.distance = clamp(safeDollyDistance(pose, clamp(finite(pose.distance, 4), CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance)), CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
    return pose;
  };
  normalize(current); normalize(desired);
  const set = (pose, { immediate = false } = {}) => {
    journey = null;
    desired = normalize({ ...desired, ...pose, target: { ...desired.target, ...pose.target } });
    if (immediate) current = copy(desired);
  };
  const damp = (a, b, alpha) => Math.abs(a - b) < .00001 ? b : a + (b - a) * alpha;
  return {
    get state() { return copy(current); },
    get desired() { return copy(desired); },
    get position() { return cameraPosition(current); },
    get journeyActive() { return journey !== null; },
    startJourney({ reducedMotion = false } = {}) {
      desired = copy(current);
      journey = { from: copy(current), elapsed: 0, duration: reducedMotion ? 350 : 12000, yaw: reducedMotion ? 0 : .18 };
    },
    stopJourney() { journey = null; desired = copy(current); },
    set,
    setDistance(distance, options) { set({ distance }, options); },
    approach(factor) { if (Number.isFinite(factor) && factor > 0) set({ distance: desired.distance / factor }); },
    orbit(yawDelta, pitchDelta) { set({ yaw: desired.yaw + finite(yawDelta, 0), pitch: desired.pitch + finite(pitchDelta, 0) }); },
    pan(dx, dy, viewportHeight) {
      if (!(viewportHeight > 0)) return;
      const scale = 2 * desired.distance * Math.tan(CAMERA_LIMITS.fov * Math.PI / 360) / viewportHeight;
      const { right, up } = cameraBasis(desired);
      const target = { ...desired.target };
      for (const axis of ['x', 'y', 'z']) target[axis] += (-finite(dx, 0) * right[axis] + finite(dy, 0) * up[axis]) * scale;
      set({ target });
    },
    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return false;
      if (journey) {
        journey.elapsed = Math.min(journey.duration, journey.elapsed + dt);
        const progress = journey.elapsed / journey.duration;
        const ease = .5 - .5 * Math.cos(Math.PI * progress);
        const from = journey.from;
        current = normalize({ distance: Math.exp(Math.log(from.distance) + (Math.log(.65) - Math.log(from.distance)) * ease),
          yaw: from.yaw + journey.yaw * ease, pitch: from.pitch,
          target: { x: from.target.x * (1 - ease), y: from.target.y * (1 - ease), z: from.target.z * (1 - ease) } });
        desired = copy(current);
        if (progress === 1) journey = null;
        return true;
      }
      const alpha = -Math.expm1(-Math.min(dt, 1000) / CAMERA_LIMITS.dampingMs);
      const next = { distance: Math.exp(damp(Math.log(current.distance), Math.log(desired.distance), alpha)),
        yaw: damp(current.yaw, desired.yaw, alpha), pitch: damp(current.pitch, desired.pitch, alpha), target: {} };
      for (const axis of ['x', 'y', 'z']) next.target[axis] = damp(current.target[axis], desired.target[axis], alpha);
      normalize(next);
      const changed = ['distance', 'yaw', 'pitch'].some((key) => Math.abs(next[key] - current[key]) > 1e-10)
        || ['x', 'y', 'z'].some((key) => Math.abs(next.target[key] - current.target[key]) > 1e-10);
      current = next;
      return changed;
    },
  };
}
