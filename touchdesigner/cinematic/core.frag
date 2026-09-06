// 2000 TRACES — native TouchDesigner cinematic plasma volume.
// Original shader; no raster artwork or externally authored shader is embedded.
// Linear HDR, premultiplied emission + transmission, with a second depth target.
// This is a bounded optical approximation, not a scientific Kerr solver.
uniform vec4 uCameraPos, uCameraRight, uCameraUp, uCameraForward;
uniform vec4 uCameraInfo; // tan(verticalFov / 2), aspect, near, far
uniform vec4 uViewport;   // width, height, inverseWidth, inverseHeight
uniform float uTime, uDuration, uOrbit, uTilt;
uniform float uActive, uActivity, uAnimation;
uniform float uMotionSpeed, uMotionTurn, uMotionCoherence;
uniform vec4 uAccretion;  // radiance, optical density, turbulence detail, thickness
uniform vec4 uRelativity; // curvature, Doppler beaming, temperature, diffuse corona
layout(location=0) out vec4 fragColor;
layout(location=1) out vec4 fragDepth;

const float HORIZON = 0.205;
const float INNER = 0.244;
const float OUTER = 0.645;
const float EXTENT = 0.92;
const int MAX_STEPS = 192;

vec3 artworkToWorld(vec3 p) {
    float a = uOrbit + 3.45575191895 * uTime / max(uDuration, 1.0);
    p.xy = mat2(cos(a), sin(a), -sin(a), cos(a)) * p.xy;
    a = 0.6981317008 + uTilt;
    p.yz = mat2(cos(a), sin(a), -sin(a), cos(a)) * p.yz;
    p.xy = mat2(0.9689124217, -0.2474039593,
                0.2474039593, 0.9689124217) * p.xy;
    return p;
}
mat3 artworkBasis() {
    return mat3(artworkToWorld(vec3(1,0,0)), artworkToWorld(vec3(0,1,0)),
                artworkToWorld(vec3(0,0,1)));
}
float normalizedDepth(vec3 localPoint, mat3 basis) {
    float z = dot(basis * localPoint - uCameraPos.xyz, uCameraForward.xyz);
    float n = uCameraInfo.z, f = uCameraInfo.w;
    if (z <= 0.000001) return 1.0;
    return clamp(f / (f-n) - (f*n) / ((f-n)*z), 0.0, 1.0);
}
vec2 raySphere(vec3 p, vec3 d, float radius) {
    float b=dot(p,d), q=b*b-dot(p,p)+radius*radius;
    if(q<0.0) return vec2(1e8,-1e8);
    q=sqrt(q); return vec2(-b-q,-b+q);
}
float hash2(vec2 p) {
    p=fract(p*vec2(127.13,311.79));
    p+=dot(p.yx+19.37,p+7.13);
    return fract((p.x+p.y)*p.x);
}
float noise2(vec2 p) {
    vec2 i=floor(p), f=fract(p);
    // Quintic reconstruction avoids visible grid-shaped derivatives.
    f=f*f*f*(f*(f*6.0-15.0)+10.0);
    return mix(mix(hash2(i),hash2(i+vec2(1,0)),f.x),
               mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),f.x),f.y);
}
vec3 noiseWithGradient(vec2 p) {
    vec2 i=floor(p),f=fract(p);
    vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
    vec2 du=30.0*f*f*(f-1.0)*(f-1.0);
    float a=hash2(i),b=hash2(i+vec2(1,0));
    float c=hash2(i+vec2(0,1)),d=hash2(i+vec2(1,1));
    return vec3(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),
                mix(b-a,d-c,u.y)*du.x,mix(c-a,d-b,u.x)*du.y);
}
float largestSingularValue(vec2 a,vec2 b) {
    float aa=dot(a,a),bb=dot(b,b),ab=dot(a,b);
    return sqrt(max(0.0,0.5*(aa+bb+sqrt((aa-bb)*(aa-bb)+4.0*ab*ab))));
}
float octaveWeight(float footprint,float frequency) {
    return 1.0-smoothstep(0.30,1.0,footprint*frequency);
}
vec3 thermalPalette(float temperature) {
    // Art-directed visible-light palette, linear RGB. Hot gas approaches ivory;
    // it does not saturate into a uniformly yellow annulus.
    float t=clamp(temperature,0.0,1.0);
    vec3 c=mix(vec3(0.028,0.045,0.07),vec3(0.22,0.10,0.033),smoothstep(0.03,0.40,t));
    c=mix(c,vec3(0.86,0.47,0.16),smoothstep(0.39,0.78,t));
    return mix(c,vec3(1.25,1.15,0.98),smoothstep(0.76,0.98,t));
}

// Returns source radiance and extinction per world unit. The material has real
// thickness: inclined views cross long, absorbing paths through its dust lanes.
vec4 plasma(vec3 p,vec3 ray,float footprint,out vec2 verticalProfile) {
    verticalProfile=vec2(0.01,0.0);
    float r=length(p.xy);
    if(r<INNER || r>OUTER) return vec4(0);
    float radial=(r-INNER)/(OUTER-INNER);
    float phase=uAnimation*(0.12+0.075*clamp(uMotionSpeed,0.0,1.0));
    phase*=1.0+0.13*clamp(uMotionTurn,-1.0,1.0);
    float shear=5.4+0.65*sin(phase*0.17);
    float angle=atan(p.y,p.x)-phase+log(r/INNER)*shear;
    vec2 orbit=vec2(cos(angle),sin(angle));
    // Fine, elongated matter avoids broad unbroken bands reading as solid
    // ribbons. Angular resolution is high enough to break every orbit into eddies.
    float orbitalRadius=8.6+radial*3.4;
    vec2 uv=orbit*orbitalRadius+vec2(radial*74.0,phase*0.075);
    vec2 orbitalTangent=vec2(-orbit.y,orbit.x);
    // Actual material-coordinate derivatives with respect to one world unit in
    // radial and tangential directions, including logarithmic shear.
    vec2 uvRadial=orbit*(3.4/(OUTER-INNER))
        +orbitalTangent*(orbitalRadius*shear/r)+vec2(74.0/(OUTER-INNER),0.0);
    vec2 uvTangent=orbitalTangent*(orbitalRadius/r);
    float baseFootprint=footprint*largestSingularValue(uvRadial,uvTangent);
    vec3 warpA=noiseWithGradient(uv*0.41+vec2(3.1,-6.7));
    vec3 warpB=noiseWithGradient(uv*0.57+11.8);
    float weightA=octaveWeight(baseFootprint,0.41),weightB=octaveWeight(baseFootprint,0.57);
    float warp=mix(0.5,warpA.x,weightA);
    float coherence=clamp(uMotionCoherence,0.0,1.0);
    float warpScale=1.15-coherence*0.22;
    vec2 gradientA=warpA.yz*(0.41*weightA),gradientB=warpB.yz*(0.57*weightB);
    mat2 warpJacobian=mat2(1.0+warpScale*gradientA.x,warpScale*gradientB.x,
                           warpScale*gradientA.y,1.0+warpScale*gradientB.y);
    uv+=vec2(warpA.x-0.5,warpB.x-0.5)*vec2(weightA,weightB)*warpScale;
    uvRadial=warpJacobian*uvRadial;
    uvTangent=warpJacobian*uvTangent;
    float broad=noise2(uv);
    float eddy=noise2(uv*2.37+vec2(8.1,-3.7));
    float fine=noise2(uv*6.13+vec2(-4.3,17.9));
    float micro=noise2(uv*13.3+vec2(23.8,9.3));
    // Footprint filtering is continuous in camera distance, including close fly-ins.
    float textureFootprint=footprint*largestSingularValue(uvRadial,uvTangent);
    broad=mix(0.5,broad,octaveWeight(textureFootprint,1.0));
    eddy=mix(0.5,eddy,octaveWeight(textureFootprint,2.37));
    fine=mix(0.5,fine,octaveWeight(textureFootprint,6.13));
    micro=mix(0.5,micro,octaveWeight(textureFootprint,13.3));
    float mass=broad*0.37+eddy*0.32+fine*0.21+micro*0.10;
    // Dense portions of advected eddies emit; do not extract narrow isocontours
    // of the noise. Such contours become a synthetic comb when highly lensed.
    float strands=smoothstep(0.59,0.83,eddy)*smoothstep(0.40,0.76,broad);
    strands*=0.55+fine*0.45;
    float detail=clamp(uAccretion.z,0.0,2.0);
    mass=mix(0.52,mass,min(detail,1.0));
    strands*=detail;

    float height=(0.0065+0.022*radial*radial)*max(0.3,uAccretion.w);
    // Low-amplitude corrugation moves with the gas, never with the screen.
    float warpZ=(warp-0.5)*height*0.30*min(detail,1.0);
    verticalProfile=vec2(max(height,footprint*0.45),warpZ);
    float edge=smoothstep(INNER,INNER+0.017,r)*(1.0-smoothstep(OUTER-0.13,OUTER,r));
    float gap=0.12+0.88*pow(smoothstep(0.23,0.72,mass),1.35);
    float extinction=edge*(0.17+mass*0.80+strands*0.45)*gap;
    extinction*=max(0.0,uAccretion.y)*30.0;
    // Keep the integrated optical mass stable when a distant slab is filtered.
    extinction*=height/verticalProfile.x;

    // A thin-disk-inspired heating profile rises smoothly beyond the inner edge,
    // then cools outward. Dense turbulent knots vary independently of the edge.
    float thermal=pow(INNER/r,0.75);
    float hotKnots=pow(smoothstep(0.57,0.83,eddy*0.60+mass*0.40),1.55);
    float temperature=thermal*0.70+hotKnots*0.35+(eddy-0.5)*0.065-0.075;
    temperature*=max(0.3,uRelativity.z);
    vec3 tangent=vec3(-p.y,p.x,0.0)/max(r,0.00001);
    float beta=0.36*sqrt(INNER/r)*clamp(uRelativity.y,0.0,1.4);
    float facing=dot(tangent,-ray);
    float doppler=sqrt(max(0.2,1.0-beta*beta))/max(0.35,1.0-beta*facing);
    // Redshift suppresses the innermost edge; the horizon is never emissive.
    float redshift=sqrt(max(0.12,1.0-HORIZON*0.65/r));
    float energy=pow(doppler,3.0)*redshift;
    vec3 color=thermalPalette(temperature*(0.92+0.08*doppler));
    float activity=sqrt(clamp(uActivity,0.0,1.0));
    float radiance=(0.17+mass*0.65+strands*1.6+hotKnots*3.1);
    radiance*=pow(thermal,1.55)*(1.0+activity*0.75);
    radiance*=energy*max(0.0,uAccretion.x)*1.15;
    color=mix(color,vec3(0.055,0.105,0.16),smoothstep(0.43,0.96,radial)*0.85);
    return vec4(color*radiance,extinction);
}

float erfApprox(float x) {
    // Standard polynomial approximation of the Gaussian antiderivative.
    float s=sign(x), t=1.0/(1.0+0.3275911*abs(x));
    float p=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t;
    return s*(1.0-p*exp(-x*x));
}
float gaussianMean(float z0,float z1,vec2 profile,float falloff) {
    float scale=sqrt(falloff)/profile.x;
    float a=(z0-profile.y)*scale, b=(z1-profile.y)*scale;
    if(abs(b-a)<0.003) { float middle=(a+b)*0.5; return exp(-middle*middle); }
    return clamp(0.88622692545*(erfApprox(b)-erfApprox(a))/(b-a),0.0,1.0);
}
float columnMean(float z0,float z1,vec2 profile) {
    return gaussianMean(z0,z1,profile,1.8)
        +0.055*clamp(uRelativity.w,0.0,2.0)*gaussianMean(z0,z1,profile,0.30);
}

// Propagate a screen-pixel ray differential through the same curved path. The
// local optical footprint grows around caustics instead of pretending every
// lensed pixel samples an unchanged camera cone.
vec3 bendDifferential(vec3 p,vec3 d,vec3 dp,vec3 dd,float curvature) {
    float r2=max(dot(p,p),0.000001), invR3=inversesqrt(r2)/r2;
    float pd=dot(p,d);
    vec3 q=p-d*pd;
    vec3 dq=dp-dd*pd-d*(dot(dp,d)+dot(p,dd));
    return -curvature*invR3*(dq-q*(3.0*dot(p,dp)/r2));
}
vec3 normalizeDifferential(vec3 unit,vec3 delta,float vectorLength) {
    return (delta-unit*dot(unit,delta))/max(0.00001,vectorLength);
}

void main() {
    fragColor=TDOutputSwizzle(vec4(0));
    fragDepth=TDOutputSwizzle(vec4(1));
    if(uActive<0.5) return;
    mat3 basis=artworkBasis();
    vec2 ndc=vUV.st*2.0-1.0;
    vec3 worldRaw=uCameraForward.xyz+uCameraRight.xyz*ndc.x*uCameraInfo.x*uCameraInfo.y
                           +uCameraUp.xyz*ndc.y*uCameraInfo.x;
    vec3 worldRay=normalize(worldRaw);
    vec3 origin=transpose(basis)*uCameraPos.xyz;
    vec3 direction=normalize(transpose(basis)*worldRay);
    vec2 interval=raySphere(origin,direction,EXTENT);
    if(interval.y<max(interval.x,0.0)) return;
    float travelled=max(0.0,interval.x)+0.00001;
    vec3 p=origin+direction*travelled;
    float pixelCone=2.0*uCameraInfo.x/max(1.0,uViewport.y);
    vec3 dRayX=transpose(basis)*normalizeDifferential(worldRay,uCameraRight.xyz*pixelCone,length(worldRaw));
    vec3 dRayY=transpose(basis)*normalizeDifferential(worldRay,uCameraUp.xyz*pixelCone,length(worldRaw));
    vec3 dPointX=dRayX*travelled, dPointY=dRayY*travelled;
    float curvature=0.108*clamp(uRelativity.x,0.0,1.45);
    vec3 radiance=vec3(0);
    float transmission=1.0, firstDepth=1.0;
    bool captured=false;
    for(int step=0;step<MAX_STEPS;step++) {
        float radius=length(p);
        if(radius<=HORIZON) {
            captured=true; firstDepth=min(firstDepth,normalizedDepth(p,basis)); break;
        }
        if(radius>EXTENT+0.0001 && dot(p,direction)>0.0) break;
        float ds=clamp((radius-HORIZON)*0.15,0.0032,0.062);
        float diskRadial=clamp((length(p.xy)-INNER)/(OUTER-INNER),0.0,1.0);
        float support=(0.0065+0.022*diskRadial*diskRadial)*max(0.3,uAccretion.w)*3.0;
        // Refine only near the emitting volume. The empty surrounding sphere
        // retains long steps; near passes resolve source matter between samples.
        if(abs(p.z)<support+abs(direction.z)*ds && length(p.xy)<OUTER+ds) {
            float sampleStep=clamp(pixelCone*max(travelled,0.1)*3.0,0.0055,0.012);
            ds=min(ds,sampleStep);
        }
        vec3 bend=-curvature*(p-direction*dot(p,direction))/max(radius*radius*radius,0.000001);
        vec3 bendX=bendDifferential(p,direction,dPointX,dRayX,curvature);
        vec3 bendY=bendDifferential(p,direction,dPointY,dRayY,curvature);
        vec3 middleRaw=direction+bend*ds*0.5;
        vec3 middle=normalize(middleRaw);
        vec3 middleX=normalizeDifferential(middle,dRayX+bendX*ds*0.5,length(middleRaw));
        vec3 middleY=normalizeDifferential(middle,dRayY+bendY*ds*0.5,length(middleRaw));
        vec2 hitInterval=raySphere(p,middle,HORIZON);
        bool hit=hitInterval.x>=0.0 && hitInterval.x<=ds;
        float segment=hit?hitInterval.x:ds;
        float footprint=max(length(dPointX+middleX*segment*0.5),length(dPointY+middleY*segment*0.5));
        footprint=clamp(footprint,pixelCone*0.01,0.045);
        // Analytic segment/slab clipping integrates even very thin and distant
        // disks. A hard minimum ray step therefore cannot skip the bright plane.
        float radial=clamp((length(p.xy)-INNER)/(OUTER-INNER),0.0,1.0);
        float halfHeight=(0.0065+0.022*radial*radial)*max(0.3,uAccretion.w)*2.7;
        halfHeight=max(halfHeight,footprint*1.15);
        float zStep=middle.z*segment, from=0.0, to=1.0;
        if(abs(zStep)>0.0000001) {
            vec2 slab=(vec2(-halfHeight,halfHeight)-p.z)/zStep;
            from=clamp(min(slab.x,slab.y),0.0,1.0);
            to=clamp(max(slab.x,slab.y),0.0,1.0);
        } else if(abs(p.z)>halfHeight) { to=0.0; }
        float path=max(0.0,to-from)*segment;
        if(path>0.0000001) {
            // Two horizontal material samples with an analytic Gaussian column
            // integral: a thin vertical density peak cannot fall between samples.
            vec3 begin=p+middle*(segment*from), end=p+middle*(segment*to);
            vec3 a=mix(begin,end,0.25), b=mix(begin,end,0.75);
            vec2 profileA,profileB;
            // Each source evaluation represents a finite part of the path, not
            // a dimensionless point. Filter material frequencies beyond that span.
            float materialFootprint=max(footprint,length(end.xy-begin.xy)*0.5);
            vec4 ma=plasma(a,middle,materialFootprint,profileA), mb=plasma(b,middle,materialFootprint,profileB);
            float zMiddle=(begin.z+end.z)*0.5;
            ma.a*=columnMean(begin.z,zMiddle,profileA);
            mb.a*=columnMean(zMiddle,end.z,profileB);
            float opticalDepth=(ma.a+mb.a)*path*0.5;
            float absorb=1.0-exp(-opticalDepth);
            vec3 source=(ma.rgb*ma.a+mb.rgb*mb.a)/max(0.00001,ma.a+mb.a);
            radiance+=transmission*source*absorb;
            transmission*=1.0-absorb;
            if(absorb>0.002) firstDepth=min(firstDepth,normalizedDepth((a+b)*0.5,basis));
        }
        if(hit) {
            captured=true; firstDepth=min(firstDepth,normalizedDepth(p+middle*segment,basis)); break;
        }
        vec3 nextRaw=direction+bend*ds;
        direction=normalize(nextRaw);
        dRayX=normalizeDifferential(direction,dRayX+bendX*ds,length(nextRaw));
        dRayY=normalizeDifferential(direction,dRayY+bendY*ds,length(nextRaw));
        dPointX+=middleX*ds; dPointY+=middleY*ds;
        p+=middle*ds; travelled+=ds;
        if(transmission<0.005) break;
    }
    float alpha=captured?1.0:1.0-transmission;
    if(alpha<0.00001 && dot(radiance,radiance)<0.000001) return;
    fragColor=TDOutputSwizzle(vec4(radiance,alpha));
    fragDepth=TDOutputSwizzle(vec4(vec3(firstDepth),1.0));
}
