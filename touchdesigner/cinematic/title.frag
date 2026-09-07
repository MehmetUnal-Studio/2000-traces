// Distant, non-emissive display title. Apply AFTER all scene optics and SMAA.
// 0 = final display-encoded scene; 1 = premultiplied native Text TOP composition;
// 2 = plasma volume RGBA (alpha contains horizon / volume occlusion).
// This branch must never feed the HDR lens, bloom, glare, or exposure stages.
layout(location=0) out vec4 fragColor;
uniform vec4 uCameraPos, uCameraRight, uCameraUp, uCameraForward;
uniform vec4 uCameraInfo; // tan(verticalFov/2), aspect, near, far
uniform vec4 uTitleNormal; // fixed world plane normal XYZ, enabled
uniform vec4 uTitleRight, uTitleUp; // fixed world plane tangent basis
uniform vec4 uTitleShape; // world width, depth behind origin, vertical lift, opacity

void main() {
    vec2 uv=vUV.st;
    vec4 scene=texture(sTD2DInputs[0],uv);
    if(uTitleNormal.w<0.5 || uTitleShape.w<=0.0) {
        fragColor=TDOutputSwizzle(scene);
        return;
    }
    vec2 ndc=uv*2.0-1.0;
    vec3 ray=normalize(uCameraForward.xyz
        +uCameraRight.xyz*ndc.x*uCameraInfo.x*uCameraInfo.y
        +uCameraUp.xyz*ndc.y*uCameraInfo.x);
    vec3 normal=normalize(uTitleNormal.xyz);
    float facing=-dot(ray,normal);
    if(facing<0.035) {
        fragColor=TDOutputSwizzle(scene);
        return;
    }
    vec3 center=-normal*uTitleShape.y+uTitleUp.xyz*uTitleShape.z;
    float distance=dot(center-uCameraPos.xyz,normal)/dot(ray,normal);
    vec3 relative=uCameraPos.xyz+ray*distance-center;
    // All three editable Text TOPs are 1280 x 512. Preserve their proportions.
    vec2 titleUV=vec2(dot(relative,uTitleRight.xyz),dot(relative,uTitleUp.xyz))
        /vec2(uTitleShape.x,uTitleShape.x*0.4)+0.5;
    if(distance<=0.0 || any(lessThan(titleUV,vec2(0.0)))
                      || any(greaterThan(titleUV,vec2(1.0)))) {
        fragColor=TDOutputSwizzle(scene);
        return;
    }
    vec4 lettering=texture(sTD2DInputs[1],titleUV);
    float coreOpacity=clamp(texture(sTD2DInputs[2],uv).a,0.0,1.0);
    // Add only in dark negative space. The horizon and dense plasma fully
    // occlude the type; bright stars, their halos and nebula light take priority.
    // No scene color is multiplied, tinted, replaced or used as a light input.
    float scenePeak=max(scene.r,max(scene.g,scene.b));
    float starlightProtection=1.0-smoothstep(0.018,0.12,scenePeak);
    float visibility=(1.0-coreOpacity)*starlightProtection
        *smoothstep(0.035,0.24,facing)*clamp(uTitleShape.w,0.0,0.65);
    vec3 result=scene.rgb+lettering.rgb*visibility;
    fragColor=TDOutputSwizzle(vec4(min(result,vec3(1.0)),scene.a));
}
