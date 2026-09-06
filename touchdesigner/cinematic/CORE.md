# Native cinematic accretion volume

`core.frag` is an original, separately editable GLSL TOP material. It keeps the current two-buffer and camera contract; it is not generated from the browser implementation. Its disk is a volume with extinction and emission along curved rays. The visible rear arc is an image of that volume along bent rays, rather than an independently drawn ring or screen-space ornament.

Use `glsl430`, two RGBA16F or RGBA32F color buffers, and Render Select TOP buffer 1 for normalized depth. Buffer 0 stores linear HDR **premultiplied** radiance and opacity. Do not premultiply again. Bind all existing camera, recording, animation and motion uniforms exactly as before.

| New uniform | Components | Starting value |
| --- | --- | --- |
| `uAccretion` | radiance, optical density, turbulence detail, volume thickness | `(1.2, 1.0, 1.0, 1.0)` |
| `uRelativity` | curvature, beaming, temperature, diffuse corona | `(1.0, 0.8, 1.0, 0.6)` |

These uniforms must be supplied: an unbound GLSL uniform is zero and would suppress the material. Good adjustment ranges are radiance 0–2, optical density 0–2, detail 0–1.5, thickness 0.5–1.8, curvature 0.6–1.2, beaming 0–1.0, temperature 0.7–1.2 and corona 0–1.2. Curvature changes should also be reflected in the background-lensing compositor if it exposes a corresponding control.

The new material uses a continuously advecting, corrugated disk with flared thickness; turbulent bright filaments and cool gaps share one emission/absorption volume. Quintic interpolated noise and camera footprint filtering keep detail from becoming a sparkling grid. Beer–Lambert attenuation creates dense darker lanes and long grazing paths. The central sphere remains nonemissive. More audience activity raises plasma radiance without enlarging the horizon or overlaying a yellow stroke. Motion speed changes advection, and signed turning changes the speed modestly.

The palette deliberately runs from cool outer gas through copper to hot ivory. A Doppler-inspired factor depends on the actual disk tangent and viewing ray; its asymmetry therefore changes correctly when the camera crosses the disk. Near-edge emission is reduced using a gravitational-redshift-inspired factor. These are artistic optical approximations; neither the thermal palette nor the bent-ray integration is a scientific Kerr or GRMHD solution.

The integrator uses at most 192 midpoint curved-ray steps. It rejects rays outside a bounded sphere and refines steps only near the material; empty space retains long steps. Two horizontal material samples use an analytic Gaussian column integral for vertical extinction, protecting a distant thin disk from disappearing between march steps. Screen-pixel ray differentials travel through the same bend field to estimate the actual lensed footprint near caustics. Source bandwidth is also limited by the finite path represented by each sample. Footprint broadening preserves integrated optical mass. Start at 960×540 or 1280×720; evaluate native GPU cook time before promising a frame rate. The shader itself is deterministic for fixed camera, data and animation time. No temporal random jitter or history accumulation is needed.

Review the final composite from face-on, 30–60 degree oblique, near edge-on and close approaches. Check that the shadow remains round for this non-spinning model, foreground gas crosses in front of it, the far-side image rises around it, and the approaching side is brighter. Keep final bloom below the point where the ivory filaments become a continuous white outline. A reduced-resolution core should be upsampled before final bloom and grading; record the actual core/output resolutions and timings.

Primary references informing the original implementation:

- [NASA Goddard: Black Hole Accretion Disk Visualization](https://svs.gsfc.nasa.gov/13326): viewing-angle dependent lensing, sheared turbulent knots, Doppler asymmetry and images of the disk near the shadow.
- [Derivative: Write a GLSL TOP](https://docs.derivative.ca/Write_a_GLSL_TOP): native multiple color buffers and cross-platform `TDOutputSwizzle`.
- [Derivative: GLSL TOP](https://docs.derivative.ca/GLSL_TOP): native GLSL versions and HDR floating-point targets.

No reference images, NASA movies or third-party shader source are embedded in this material.

Native image review found the first material pass too bright and too dominated by peach ribbon shapes. The revised material lowers midtone radiance, uses finer and more broken turbulent filaments, darkens cool and copper gas, narrows the hot knots and reduces vertical corrugation. Final peak brightness should come from small regions and accumulated optical paths; it should not turn the entire disk into a broad luminous solid surface.

A near-camera diagnostic with Detail set to zero removed the remaining comb pattern, isolating it to material variation rather than establishing ray-budget exhaustion. Removing the narrow noise-isocontour extractor alone did not remove the native artifact. The sampling correction therefore replaces the heuristic material frequency estimate with the local UV Jacobian, including radial scaling, logarithmic shear and analytic domain-warp gradients. Octaves attenuate before their source footprint crosses one grid cell; both the pixel and the full integration span constrain that footprint. Sparse dense eddies supply temperature variation instead of extracted contour lines. Final acceptance still requires native captures after the source is reloaded.
