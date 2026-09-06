# Native field layers and optics

`node touchdesigner/cinematic/generate-field.mjs` derives ten editable native shaders in `field/` from `touchdesigner/shaders/{dust,atmosphere,filament,stars,clouds}.{vert,frag}`. `--check` verifies generated output without writing it and exits nonzero on a stale file. Source contract changes fail with a specific error instead of silently dropping source behavior.

Original instance textures, positions, event IDs, visibility times, lane selection and motion inputs are retained. Changes affect projection footprints, category radiance and composition only. Dust and stars optionally gain a circular foreground defocus footprint with inverse-area radiance compensation; this does not move source positions. It is a bounded optical approximation, not a physical thin-lens integrator.

## Required bindings

Each field GLSL MAT needs its original texture samplers plus **`sCoreDepth`**, pointing to the current camera's native core depth output, normalized near=0/far=1 with no hit=1. This is the core shader's depth Render Select TOP, not a sparse star depth pass. It must have the same camera and output extent as the field render.

Keep the core's normalized-depth output **32-bit float at its source**. At near=0.008 and camera depth near 3, 16-bit float depth quantization can exceed the 0.065-unit layer transition width; converting an already quantized depth to 32-bit in Render Select does not restore it. Field color buffers may use 16-bit float. The shader explicitly fetches the nearest core-depth texel so a no-hit value is not linearly blended into a fictitious distant surface. Core and field may have different texture resolutions but must have the same aspect/projection; the field MAT's `uViewport` is always the actual field render size.

All field MATs use the existing `uCameraPos`, `uCameraForward`, `uCameraInfo=(tan(fov/2),aspect,near,far)` and `uViewport=(width,height,1/width,1/height)` bindings. Vertex shaders retain `uCameraRight` and `uCameraUp` from the source camera contract.

| Uniform | Components | Initial value |
| --- | --- | --- |
| `uFieldLook` | dust gain, recorded gas gain, filament gain, decorative stars gain | `(0.7,0.55,0.18,1.1)` |
| `uLensOptics` | focus distance in artwork units, aperture 0..1, background lens strength, reserved | `(camera distance,0.2,1,0)` |

Atmosphere and decorative cloud MATs both use gas gain. Gain changes linear RGB only. Dust/stars vertex shaders use focus distance and aperture; the composite uses lens strength. All missing uniform values default to zero in GLSL, so these must be set explicitly.

## Render and composition

Use a single HDR Render TOP with **`numcolorbufs=2`**, transparent black clear and **`allowbufblending=True`**. All field MATs require RGB blending **Source Alpha + One**, **`postmultalpha=False`**, no depth writes; no scene depth buffer should reject one transparent instance behind another.

- Color buffer **0**: additive background radiance.
- Color buffer **1**: additive foreground radiance, obtained with Render Select TOP **`index=1`**.

The fragment's true interpolated camera-space depth is compared with core depth at `gl_FragCoord.xy/uViewport.xy`. Where the core depth is absent, the black-hole center depth is used. A fixed 0.065 artwork-unit smooth transition allocates each fragment between the two targets. Each target receives its own straight RGB and weighted source alpha, so normal additive blending conserves the original summed contribution at the split. This removes the old sparse-depth binary screen branch. It remains a layered approximation for volumes intersecting the core.

Wire `composite.frag` inputs in this exact order: **0 background**, **1 foreground**, **2 premultiplied core emission/coverage**. Its camera uniforms must match the Render TOP. It continuously warps only the background, then computes `foreground + core.rgb + warpedBackground * (1-core.a)`. Output is linear HDR and still needs the downstream bloom/tonemap/display transform. The radial background warp is an artistic lensing approximation; it is not a Schwarzschild/Kerr geodesic solution.

## Native verification

Compile both MAT stages on TD2023 GLSL430. Confirm both targets accumulate multiple overlapping particles; foreground must not be only the last drawn instance. Inspect the core-depth alignment at an oblique camera angle, then approach through the foreground. The black-hole outline must not inherit sparse star holes. Set lens strength to zero: the sum of the two field targets should reproduce the source field with category gains, including at the soft depth boundary. Set aperture zero to recover the source projection footprint. Defocus should enlarge a near star without raising integrated radiance or producing a diagonal streak. Leave the source event/X/Y identity checks unchanged.
