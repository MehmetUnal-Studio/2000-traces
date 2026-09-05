// All materials output linear light. Exposure and display conversion belong
// to the single final scene pass; ink uses the same data geometry.
export const ATLAS_TRANSFORM = /* glsl */ `
  uniform float uTilt;
  vec3 atlasTilt(vec3 p) {
    float c = cos(uTilt), s = sin(uTilt);
    return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  }
`;

export const TILE_VERTEX = /* glsl */ `
  attribute vec4 aCell; // r0, r1, clockwise angle0, angle1
  attribute vec4 aData; // normalized activity, musical line, complete time, row
  attribute vec4 aMeta; // first lane, exclusive last lane, column, material kind
  uniform float uTime;
  uniform float uSelLane;
  uniform float uSelRow;
  uniform float uSelColumn;
  uniform float uHoverRow;
  uniform float uHoverColumn;
  uniform float uHoverLane;
  uniform vec3 uPalette[10];
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vEnergy;
  varying float vVisible;
  varying float vFocus;
  varying float vOther;
  varying float vStyle;
  ${ATLAS_TRANSFORM}
  void main() {
    float angle = mix(aCell.z, aCell.w, position.x);
    float radius = mix(aCell.x, aCell.y, position.y);
    float height = aMeta.w < 0.5 ? 0.004 + aData.x * 0.016 : 0.003 + aData.x * 0.006;
    vec3 p = vec3(cos(angle) * radius, sin(angle) * radius, position.z * height);
    vec3 radial = vec3(cos(angle), sin(angle), 0.0);
    vec3 tangent = vec3(sin(angle), -cos(angle), 0.0);
    vNormal = normalize(atlasTilt(tangent * normal.x + radial * normal.y + vec3(0.0, 0.0, normal.z)));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atlasTilt(p), 1.0);
    vUv = position.xy;
    vColor = (aData.y < -0.5 || aData.y > 9.5) ? vec3(0.24, 0.34, 0.37) : uPalette[int(clamp(aData.y, 0.0, 9.0))];
    vEnergy = aData.x;
    vVisible = step(aData.z, uTime + 0.01);
    vStyle = aMeta.w;
    float laneSelected = step(aMeta.x, uSelLane) * (1.0 - step(aMeta.y, uSelLane));
    float cellSelected = (1.0 - step(0.5, abs(aData.w - uSelRow))) * (1.0 - step(0.5, abs(aMeta.z - uSelColumn))) * (1.0 - step(0.5, aMeta.w));
    float cellHover = (1.0 - step(0.5, abs(aData.w - uHoverRow))) * (1.0 - step(0.5, abs(aMeta.z - uHoverColumn))) * (1.0 - step(0.5, aMeta.w));
    float laneHover = step(aMeta.x, uHoverLane) * (1.0 - step(aMeta.y, uHoverLane)) * step(0.5, aMeta.w);
    vFocus = max(max(laneSelected, cellSelected), max(cellHover, laneHover) * 0.65);
    float anySelection = max(step(-0.5, uSelLane), step(-0.5, uSelRow));
    vOther = mix(1.0, 0.32, anySelection * (1.0 - max(laneSelected, cellSelected)));
  }
`;

export const TILE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uInk;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vEnergy;
  varying float vVisible;
  varying float vFocus;
  varying float vOther;
  varying float vStyle;
  void main() {
    if (vVisible < 0.5) discard;
    float top = smoothstep(0.45, 0.92, vNormal.z);
    float edge = 1.0 - smoothstep(0.015, 0.13, min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y)));
    float lip = (1.0 - smoothstep(0.01, 0.075, vUv.y)) * 0.45 + smoothstep(0.94, 1.0, vUv.x) * 0.18;
    float light = 0.40 + 0.60 * max(0.0, dot(normalize(vNormal), normalize(vec3(-0.3, 0.55, 1.0))));
    float etch = smoothstep(0.91, 1.0, fract(vUv.x * 3.0 + vUv.y * 0.14));
    vec3 luminous = vColor * (0.055 + pow(vEnergy, 2.2) * 1.65) * light;
    luminous *= 1.0 - edge * 0.26;
    luminous += vColor * lip * (0.2 + vEnergy * 0.42) * top;
    float edgeWidth = max(0.026, fwidth(vUv.y)*0.55);
    float hotEdge = (1.0-smoothstep(0.0,edgeWidth,vUv.y))*pow(vEnergy,3.0)*top;
    luminous += mix(vColor,vec3(0.48,0.68,0.68),0.4)*hotEdge*(0.5+2.5*pow(vEnergy,4.0));
    luminous += vec3(0.65, 0.88, 0.92) * edge * vFocus * 1.5;
    luminous += vColor * vFocus * 0.30;
    if (vStyle > 0.5) {
      vec3 silver = vec3(0.16,0.22,0.24)*(0.40+vEnergy*0.85);
      float tip = smoothstep(0.78,0.97,vUv.y);
      luminous = mix(silver, vColor*(0.80+vEnergy*1.6),tip)*light;
      luminous += vec3(0.45,0.7,0.72)*edge*vFocus*1.5;
    }
    luminous *= vOther;
    float graphite = mix(0.40, 0.045, vEnergy) + etch * 0.07 + edge * 0.09;
    vec3 ink = vec3(graphite * 0.88, graphite * 0.89, graphite * 0.84);
    ink = mix(vec3(0.74, 0.72, 0.65), ink, vOther);
    ink *= 1.0 - vFocus * 0.55;
    gl_FragColor = vec4(mix(luminous, ink, uInk), 1.0);
  }
`;

export const THREAD_VERTEX = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute float aTime;
  attribute float aLane;
  attribute float aLine;
  attribute float aWeight;
  uniform float uTime;
  uniform float uSelLane;
  uniform float uPointScale;
  uniform float uWorldWidth;
  uniform vec3 uPalette[10];
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  ${ATLAS_TRANSFORM}
  void main() {
    vec3 start = atlasTilt(aStart);
    vec3 end = atlasTilt(aEnd);
    vec2 delta = end.xy - start.xy;
    vec2 perpendicular = vec2(-delta.y, delta.x) / max(length(delta), 0.0000001);
    // Expand subpixel strokes for raster coverage, conserving their world-
    // space line energy with vCoverage. The extra width is only AA padding.
    float expandedWidth = max(uWorldWidth, 1.5 / max(uPointScale, 1.0));
    vec3 p = mix(start, end, position.x);
    p.xy += perpendicular * position.y * expandedWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vAcross = position.y * 2.0;
    vCoverage = uWorldWidth / expandedWidth;
    float selected = 1.0 - step(0.5, abs(aLane-uSelLane));
    float isolation = uSelLane < -0.5 ? 1.0 : mix(0.045, 7.0, selected);
    vColor = (aLine < -0.5 || aLine > 9.5) ? vec3(0.22, 0.38, 0.43) : uPalette[int(clamp(aLine,0.0,9.0))];
    vAlpha = step(aTime, uTime + 0.01) * aWeight * isolation;
  }
`;

export const THREAD_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uInk;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  void main() {
    vec3 color = mix(vColor, vec3(0.04, 0.045, 0.04), uInk);
    float aa = max(fwidth(vAcross) * 0.5, 0.0001);
    float coverage = 1.0 - smoothstep(1.0-aa, 1.0+aa, abs(vAcross));
    gl_FragColor = vec4(color, min(0.90, vAlpha * mix(1.0, 2.0, uInk)) * vCoverage * coverage);
  }
`;

export const ANNOTATION_VERTEX = /* glsl */ `
  varying vec2 vUv;
  ${ATLAS_TRANSFORM}
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atlasTilt(position), 1.0);
  }
`;
export const ANNOTATION_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uMap;
  uniform float uInk;
  varying vec2 vUv;
  void main() {
    float alpha = texture2D(uMap, vUv).a;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(mix(vec3(0.32, 0.48, 0.51), vec3(0.10, 0.105, 0.09), uInk), alpha);
  }
`;
