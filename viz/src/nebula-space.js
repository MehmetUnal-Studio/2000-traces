// Decorative spatial context, never recorded participant data. These distant
// strata stay fixed in world space while the camera moves through the artwork.
import * as THREE from 'three';
import { mulberry32 } from './prng.js';

const STAR_VERTEX=/* glsl */ `
  attribute vec3 aColor;
  attribute vec2 aSize;
  uniform float uViewportHeight;
  varying vec3 vColor;
  varying float vEnergy;
  void main() {
    vec4 view=modelViewMatrix*vec4(position,1.0);
    gl_Position=projectionMatrix*view;
    float scale=0.5*uViewportHeight*projectionMatrix[1][1];
    if(projectionMatrix[3][3]<0.5)scale/=max(0.001,-view.z);
    float diameter=aSize.x*scale;
    gl_PointSize=clamp(diameter,1.2,8.0);
    vEnergy=aSize.y*min(1.0,diameter*diameter/(gl_PointSize*gl_PointSize));
    vColor=aColor;
  }
`;
const STAR_FRAGMENT=/* glsl */ `
  precision highp float;
  uniform float uDepthPass;
  varying vec3 vColor;
  varying float vEnergy;
  void main() {
    vec2 p=gl_PointCoord*2.0-1.0;
    float r2=dot(p,p);
    if(r2>1.0)discard;
    float profile=exp(-r2*6.0)*(1.0-smoothstep(0.65,1.0,r2));
    if(uDepthPass>0.5) {
      if(r2>0.12 || vEnergy*profile<0.03)discard;
      gl_FragColor=vec4(0.0);return;
    }
    gl_FragColor=vec4(vColor,profile*vEnergy);
  }
`;
const CLOUD_VERTEX=/* glsl */ `
  attribute vec3 aCenter;
  attribute float aSize;
  attribute float aSeed;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vec4 view=modelViewMatrix*vec4(aCenter,1.0);
    view.xy+=position.xy*aSize;
    gl_Position=projectionMatrix*view;
    vUv=uv;vSeed=aSeed;
  }
`;
const CLOUD_FRAGMENT=/* glsl */ `
  precision highp float;
  uniform float uDepthPass;
  varying vec2 vUv;
  varying float vSeed;
  float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p) {
    vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+1.0),f.x),f.y);
  }
  void main() {
    if(uDepthPass>0.5)discard;
    vec2 p=vUv*2.0-1.0;
    float envelope=exp(-dot(p,p)*4.0)*(1.0-smoothstep(0.55,1.0,length(p)));
    float cloud=noise(p*4.0+vSeed)*0.65+noise(p*11.0-vSeed)*0.35;
    gl_FragColor=vec4(vec3(0.07,0.15,0.27),envelope*cloud*0.023);
  }
`;

export function createNebulaSpace({seed=2000,starCount=2400}={}) {
  const random=mulberry32(seed);
  const group=new THREE.Group();group.name='nebula-decorative-space';
  group.userData.recordedData=false;
  const uniforms={uViewportHeight:{value:1000},uDepthPass:{value:0}};
  const positions=new Float32Array(starCount*3),colors=new Float32Array(starCount*3),sizes=new Float32Array(starCount*2);
  const shell=(radius)=>{
    const y=random()*2-1,angle=random()*Math.PI*2,horizontal=Math.sqrt(1-y*y);
    return [Math.cos(angle)*horizontal*radius,y*radius,Math.sin(angle)*horizontal*radius];
  };
  for(let index=0;index<starCount;index++) {
    const stratum=index%4,radius=[4.8,9,17,29][stratum]*(0.9+random()*0.2);
    positions.set(shell(radius),index*3);
    const warm=random()<0.09;
    colors.set(warm?[0.70,0.43,0.23]:[0.37,0.54,0.69],index*3);
    const bright=random()<0.025;
    sizes.set([(0.006+random()*0.006+stratum*0.003)*(bright?1.8:1),bright?0.95:0.18+random()*0.30],index*2);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('aColor',new THREE.BufferAttribute(colors,3));
  geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,2));
  const stars=new THREE.Points(geometry,new THREE.ShaderMaterial({uniforms,vertexShader:STAR_VERTEX,fragmentShader:STAR_FRAGMENT,
    transparent:true,depthTest:true,depthWrite:false,blending:THREE.AdditiveBlending}));
  stars.name='decorative-stars-four-depth-strata';stars.renderOrder=-5;stars.frustumCulled=false;group.add(stars);
  const cloudCount=18,centers=new Float32Array(cloudCount*3),cloudSizes=new Float32Array(cloudCount),seeds=new Float32Array(cloudCount);
  for(let i=0;i<cloudCount;i++) {centers.set(shell(13+random()*13),i*3);cloudSizes[i]=3.5+random()*4;seeds[i]=random()*100;}
  const quad=new THREE.PlaneGeometry(1,1),cloudGeometry=new THREE.InstancedBufferGeometry();
  cloudGeometry.index=quad.index;
  for(const [name,attribute]of Object.entries(quad.attributes))cloudGeometry.setAttribute(name,attribute);
  cloudGeometry.setAttribute('aCenter',new THREE.InstancedBufferAttribute(centers,3));
  cloudGeometry.setAttribute('aSize',new THREE.InstancedBufferAttribute(cloudSizes,1));
  cloudGeometry.setAttribute('aSeed',new THREE.InstancedBufferAttribute(seeds,1));
  cloudGeometry.instanceCount=cloudCount;
  const clouds=new THREE.Mesh(cloudGeometry,new THREE.ShaderMaterial({uniforms,vertexShader:CLOUD_VERTEX,fragmentShader:CLOUD_FRAGMENT,
    transparent:true,depthTest:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,forceSinglePass:true}));
  clouds.name='decorative-distant-clouds';clouds.renderOrder=-6;clouds.frustumCulled=false;group.add(clouds);
  const viewport=new THREE.Vector4();
  stars.onBeforeRender=(renderer)=>{renderer.getCurrentViewport(viewport);uniforms.uViewportHeight.value=Math.max(1,viewport.w);};
  group.traverse((object)=>{object.layers.set(0);object.userData.recordedData=false;});
  let disposed=false;
  return {group,uniforms,dispose(){if(disposed)return;disposed=true;group.traverse((object)=>{object.geometry?.dispose();object.material?.dispose();});}};
}
