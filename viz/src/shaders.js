// viz/src/shaders.js
// One shader family for grains (points) and strokes (line segments): polar
// position is computed on the GPU from (radius, time), so replay, selection
// and zoom are pure uniform changes — no geometry rewrites at runtime.

export const DISC_VERTEX = /* glsl */ `
  attribute float aR;      // final lane radius incl. gesture displacement + grain
  attribute float aT;      // event time, session-relative ms
  attribute float aLane;   // dense lane index (participant)
  attribute float aKind;   // 0 = motion grain, 1 = note mark
  attribute float aLine;   // musical line 0..9

  uniform float uDuration;
  uniform float uTime;        // replay clock; = uDuration in final state
  uniform float uReplaying;   // 1 while the record is still being written
  uniform float uSelLane;     // -1 none, else isolated lane
  uniform float uPointScale;  // device-pixels per world unit
  uniform vec3 uLineColors[10];

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float angle = 1.5707963 - 6.2831853 * aT / uDuration;
    vec2 p = vec2(cos(angle), sin(angle)) * aR;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);

    float visible = step(aT, uTime);
    // freshly-written events glow while recording/replaying, then settle
    float fresh = 1.0 + 2.4 * uReplaying * (1.0 - smoothstep(0.0, 700.0, uTime - aT));
    float isSel = uSelLane < -0.5 ? 0.0 : (1.0 - step(0.5, abs(aLane - uSelLane)));
    float others = uSelLane < -0.5 ? 1.0 : 0.035;

    // exposure: dense overview stays engraved-grey, zooming in reveals grains;
    // an isolated lane is exempt — its full trace must always read clearly
    float gain = clamp(uPointScale / 700.0, 0.55, 3.5);
    float baseAlpha = (aKind > 0.5 ? 0.34 : 0.05) * gain * others;
    float selAlpha = aKind > 0.5 ? 0.95 : 0.55;
    vAlpha = visible * fresh * mix(baseAlpha, selAlpha, isSel);

    vec3 grain = vec3(0.78, 0.80, 0.85);
    vec3 note = uLineColors[int(clamp(aLine, 0.0, 9.0))];
    vColor = mix(grain, note, aKind);

    float px = uPointScale * (aKind > 0.5 ? 0.0135 : 0.0075) * (1.0 + isSel);
    gl_PointSize = clamp(px, 1.0, 8.0);
  }
`;

export const POINT_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float soft = smoothstep(0.5, 0.12, d);
    gl_FragColor = vec4(vColor, 1.0) * (vAlpha * soft);
  }
`;

export const LINE_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0) * vAlpha;
  }
`;
