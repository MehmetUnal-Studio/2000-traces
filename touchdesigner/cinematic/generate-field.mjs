#!/usr/bin/env node
// Native cinematic field adapters. Source event geometry/times stay unchanged.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const source = new URL('../shaders/', import.meta.url);
const output = new URL('./field/', import.meta.url);
const check = process.argv.includes('--check');
const kinds = ['dust', 'atmosphere', 'filament', 'stars', 'clouds'];
const files = new Map();

function once(text, from, to) {
  if (!text.includes(from) || text.indexOf(from) !== text.lastIndexOf(from)) {
    throw new Error('Cinematic field source contract changed: ' + from.slice(0, 120));
  }
  return text.replace(from, to);
}

const split = /* glsl */`
layout(location=0) out vec4 fragBackground;
layout(location=1) out vec4 fragForeground;
uniform sampler2D sCoreDepth;
uniform vec4 uCameraPos, uCameraForward, uCameraInfo, uViewport;
uniform vec4 uFieldLook; // dust, recorded gas, filaments, decorative stars
in float vViewDepth;

float fieldDistanceAt(float normalizedDepth) {
  float n=uCameraInfo.z, f=uCameraInfo.w;
  return n*f/max(f-normalizedDepth*(f-n),0.000001);
}
void writeField(vec4 radiance, float gain) {
  vec2 uv=gl_FragCoord.xy*uViewport.zw;
  // Normalized depth must not interpolate a valid surface with far/no-hit=1.
  // Enforce nearest sampling even if the MAT's sampler filter is changed.
  ivec2 size=textureSize(sCoreDepth,0);
  ivec2 texel=clamp(ivec2(floor(uv*vec2(size))),ivec2(0),size-ivec2(1));
  float rawDepth=texelFetch(sCoreDepth,texel,0).r;
  float centerDepth=dot(-uCameraPos.xyz,uCameraForward.xyz);
  float coreDepth=(rawDepth>=0.0 && rawDepth<0.999999)
    ? fieldDistanceAt(rawDepth) : centerDepth;
  // Every fragment contributes continuously to both additive layers. No
  // sparse nearest-star depth may promote an entire accumulated field pixel.
  float band=0.065;
  float foreground=1.0-smoothstep(coreDepth-band,coreDepth+band,vViewDepth);
  vec3 color=max(radiance.rgb,vec3(0.0))*max(gain,0.0);
  float alpha=max(radiance.a,0.0);
  // RGB is straight here. Both MRTs MUST blend Source Alpha + One, with
  // postmultalpha=False and Render TOP allowbufblending=True.
  fragBackground=TDOutputSwizzle(vec4(color,alpha*(1.0-foreground)));
  fragForeground=TDOutputSwizzle(vec4(color,alpha*foreground));
}
`;

const optics = /* glsl */`
uniform vec4 uLensOptics; // focus distance, aperture 0..1, lens strength, reserved
float fieldDefocusDiameter(float depth) {
  float focus=max(uLensOptics.x,0.15);
  float nearWeight=1.0-smoothstep(focus*0.95,focus*1.05,depth);
  // A bounded circular projection PSF. World/source positions stay exact.
  // Scale the footprint with output height so lens character is consistent.
  float diameter=9.0*clamp(uLensOptics.y,0.0,1.0)
    *abs(depth-focus)/max(depth,0.15)*uViewport.y/720.0;
  return min(diameter,18.0*uViewport.y/720.0)*nearWeight;
}
`;

for (const kind of kinds) {
  const vertexSource=await readFile(new URL(kind+'.vert', source),'utf8');
  const fragmentSource=await readFile(new URL(kind+'.frag', source),'utf8');
  let vertex=vertexSource.replace(/^\/\/ Generated[^\n]*\n\/\/ Native[^\n]*\n/,'');
  let fragment=fragmentSource.replace(/^\/\/ Generated[^\n]*\n\/\/ Native[^\n]*\n/,'');
  vertex=once(vertex,'void main() {','out float vViewDepth;\n'+(kind==='dust'||kind==='stars'?optics:'')+'\nvoid main() {');
  const view = kind==='filament' ? 'p' : kind==='stars'||kind==='clouds' ? 'view' : 'viewPosition';
  const projection=`gl_Position=TDWorldToProj(vec4(tdViewToWorld(${view}${view==='p'?'':'.xyz'}),1.0));`;
  vertex=once(vertex,projection,`vViewDepth=-${view}.z;\n    ${projection}`);
  if (kind==='dust') {
    vertex=once(vertex,'float rasterSize = clamp(diameter, 1.5, uPointMax);',`float sharpSize = clamp(diameter, 1.5, uPointMax);
    float coc=fieldDefocusDiameter(-viewPosition.z);
    float rasterSize=sqrt(sharpSize*sharpSize+coc*coc);`);
    vertex=once(vertex,'float coverage = min(1.0, diameter*diameter/(rasterSize*rasterSize));',`float coverage = min(1.0, diameter*diameter/(sharpSize*sharpSize))
      *(sharpSize*sharpSize)/(rasterSize*rasterSize);`);
  } else if (kind==='stars') {
    vertex=once(vertex,'float pointSize=clamp(diameter,1.2,8.0);',`float sharpSize=clamp(diameter,1.2,8.0);
    float coc=fieldDefocusDiameter(-view.z);
    float pointSize=sqrt(sharpSize*sharpSize+coc*coc);`);
    vertex=once(vertex,'vEnergy=aSize.y*min(1.0,diameter*diameter/(pointSize*pointSize));',`vEnergy=aSize.y*min(1.0,diameter*diameter/(sharpSize*sharpSize))
      *(sharpSize*sharpSize)/(pointSize*pointSize);`);
  }
  fragment=once(fragment,'layout(location=0) out vec4 fragColor;',split);
  fragment=fragment.replace(/\s*uniform float uDepthPass;/g,'');
  if (kind==='dust') fragment=once(fragment,`if(uDepthPass>0.5) {
      if(uAtmosphere>0.5 || r2>0.16 || vAlpha*envelope<0.03) discard;
      fragColor=TDOutputSwizzle(vec4(vec3(gl_FragCoord.z),1.0)); return;
    }`,'');
  else if (kind==='stars') fragment=once(fragment,`if(uDepthPass>0.5) {
      if(r2>0.12 || vEnergy*profile<0.03)discard;
      fragColor=TDOutputSwizzle(vec4(vec3(gl_FragCoord.z),1.0)); return;
    }`,'');
  else if (kind==='filament') fragment=once(fragment,`if(uDepthPass>0.5) {
      if(vAlpha<0.02 || abs(vAcross)>0.30) discard;
      fragColor=TDOutputSwizzle(vec4(vec3(gl_FragCoord.z),1.0)); return;
    }`,'');
  else if (kind==='atmosphere') fragment=once(fragment,'if(uDepthPass>0.5||vAlpha<0.00001) discard;','if(vAlpha<0.00001) discard;');
  else if (kind==='clouds') fragment=once(fragment,'if(uDepthPass>0.5)discard;','');
  const gain={dust:'uFieldLook.x',atmosphere:'uFieldLook.y',filament:'uFieldLook.z',stars:'uFieldLook.w',clouds:'uFieldLook.y'}[kind];
  const assignments=[...fragment.matchAll(/fragColor=TDOutputSwizzle\(([^;]+)\);/g)];
  if(assignments.length!==1)throw new Error(kind+': expected one final field color assignment');
  fragment=fragment.replace(/fragColor=TDOutputSwizzle\(([^;]+)\);/,`writeField($1,${gain});`);
  for(const [extension,body] of [['vert',vertex],['frag',fragment]]) {
    if(/uDepthPass|\bfragColor\b/.test(body))throw new Error(kind+'.'+extension+': stale depth/single-target contract');
    if((body.match(/\{/g)||[]).length!==(body.match(/\}/g)||[]).length)throw new Error('Unbalanced '+kind+'.'+extension);
    const hash=createHash('sha256').update(vertexSource+'\n'+fragmentSource).digest('hex').slice(0,16);
    files.set(kind+'.'+extension,`// Generated by touchdesigner/cinematic/generate-field.mjs; source ${hash}.\n// Native GLSL 4.30; exact source geometry/time with layered HDR optics.\n${body.replace(/[ \t]+$/gm, '').trim()}\n`);
  }
}

await mkdir(output,{recursive:true});
let changed=0;
for(const [name,body] of files) {
  const path=new URL(name,output);
  if(await readFile(path,'utf8').catch(()=>null)===body)continue;
  changed++;
  if(check)console.error('Out of date: '+fileURLToPath(path));
  else await writeFile(path,body);
}
if(check&&changed)process.exitCode=1;
else console.log(`${check?'Verified':'Generated'} ${files.size} cinematic field shaders (${changed} changed).`);
