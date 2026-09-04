import { TRACE_PROJECTION_GLSL } from './cosmic-projection.js';

// Replay, isolation and view changes only update uniforms. Every gesture
// keeps its time and participant lane; buffers are not rewritten per frame.
export const DISC_VERTEX = /* glsl */ `
  attribute float aR;
  attribute float aT;
  attribute float aLane;
  attribute float aKind;
  attribute float aLine;
  uniform float uDuration;
  uniform float uTime;
  uniform float uReplaying;
  uniform float uSelLane;
  uniform float uPointScale;
  uniform float uPointMax;
  uniform float uLaneBoost;
  uniform float uDensity;
  uniform float uMorph;
  uniform vec3 uLineColors[10];
  varying float vAlpha;
  varying float vBeacon;
  varying vec3 vColor;
  ${TRACE_PROJECTION_GLSL}

  void main() {
    float angle = traceAngle(aR, aT, uDuration, uMorph);
    vec2 p = vec2(cos(angle), sin(angle)) * traceRadius(aR, uMorph);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
    float visible = step(aT, uTime);
    float fresh = 1.0 + 2.1 * uReplaying * (1.0 - smoothstep(0.0, 850.0, uTime - aT));
    float isSel = uSelLane < -0.5 ? 0.0 : (1.0 - step(0.5, abs(aLane - uSelLane)));
    float others = uSelLane < -0.5 ? 1.0 : 0.022;
    float gain = clamp(uPointScale / 700.0, 0.65, 2.4) * uLaneBoost;

    // A bounded proportion of real notes becomes a bright core. The hash
    // is a pure function of the recorded event, never animation time.
    float hash = fract(sin(aLane * 73.137 + aT * 0.01731 + aR * 127.1) * 913.713);
    vBeacon = step(1.0 - max(0.008, 0.030 * uDensity), hash) * aKind;
    float brightness = mix(0.42, 1.35, hash);
    float baseAlpha = mix(0.20, 0.68, aKind) * gain * uDensity * brightness;
    baseAlpha += vBeacon * 0.62;
    float selAlpha = mix(0.26, 0.80, aKind);
    vAlpha = visible * fresh * mix(baseAlpha * others, selAlpha, isSel);
    vec3 dust = vec3(0.30, 0.55, 0.72);
    vec3 note = uLineColors[int(clamp(aLine, 0.0, 9.0))];
    vColor = mix(dust, note, 0.24 + aKind * 0.76);
    vColor = mix(vColor, vec3(0.94, 0.98, 1.0), vBeacon * 0.9);
    float worldSize = mix(0.009, 0.014, aKind) * mix(0.65, 1.2, hash);
    worldSize += vBeacon * 0.040;
    gl_PointSize = clamp(uPointScale * worldSize * (1.0 + isSel * 0.6), 1.0, uPointMax);
  }
`;

export const POINT_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying float vBeacon;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5 || vAlpha <= 0.0) discard;
    float core = exp(-d * d * 120.0);
    float halo = exp(-d * d * 23.0) * mix(0.14, 0.29, vBeacon);
    float falloff = (core + halo) * (1.0 - smoothstep(0.38, 0.5, d));
    // AdditiveBlending multiplies by alpha; RGB must not be premultiplied.
    gl_FragColor = vec4(vColor, min(1.0, vAlpha * falloff));
  }
`;

export const LINE_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, min(0.22, vAlpha * 0.15));
  }
`;
