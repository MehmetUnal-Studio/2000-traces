# Distant title

`title_stars`, `title_of`, and `title_year` are native editable Text TOPs.
They reproduce the reference's restrained cream lettering and italic gold
“of”; they do not incorporate the screenshot's interface, logos, or photograph.
The spelling is **Stars of The Year**, matching the supplied event artwork.

`title_lettering` combines their transparent premultiplied images. The
`cinematic_title` GLSL TOP samples that texture on a distant plane behind the
artwork. **Titlefollow / Keep title facing the camera** is enabled by default:
the plane follows the camera's orientation while retaining its spatial depth,
so orbiting keeps the title behind the scene and dolly changes its projected
size. Turning Titlefollow off uses the fixed world-space azimuth/elevation
anchor; that plane can leave the frame as the camera goes around the artwork.

The **Title** custom page adjusts visibility, opacity, size, distance, vertical
position and anchor azimuth/elevation. Defaults are enabled, camera-facing,
opacity **0.12**, width **10**, distance **8**, vertical lift **2**, anchor
azimuth **15°** and elevation **12°**. The anchor angles apply when Titlefollow
is off. These settings give a large, quiet title behind the upper portion of
the artwork. The title is decorative and is never derived from a participant's
recorded coordinates.

The main words use **Arial** in the verified TouchDesigner 2025.33230 build;
this avoids the unsupported-character-map error encountered with the system's
Helvetica Neue font. Helvetica Neue/Helvetica remain fallback choices on other
systems. The italic “of” uses Baskerville with Times fallbacks. Each Text TOP
remains independently editable; no font binaries are bundled.

## Integration

Load `title_layer.py` into a Text DAT called `title_builder`, then after the
existing `subpixel_antialias` TOP is created:

```python
title = title_builder.module.build_title(
    base, antialias, core, glsl_top, parameter, textTOP, compositeTOP)
out.inputConnectors[0].connect(title)
```

The helper's GLSL title uniforms are direct parameter expressions. Only the
camera uniforms use the existing cinematic runtime. No change is needed to
runtime transport, the plasma shader, environment shader, lens or grade.

The title branch must stay **after SMAA and the final grade**. It never feeds
HDR composition, gravitational lensing, bloom or glare. Existing scene RGB is
never reduced or multiplied by the title. Core opacity hides it behind the
horizon and dense plasma. A display luminance mask gives bright starlight
priority and reduces title visibility in luminous nebulosity. This is an
intentional restrained display composition, not an emissive material or
physical volumetric text renderer.

Validation in the actual TD build should compare title enabled/disabled at a
frozen clock: horizon and bright star pixels remain identical, the bloom TOP
does not change, and the zero-opacity/disabled result matches the original
scene. Review a wide pose, a low orbit, and a near approach; title type must
not be reversed when viewed from the back (the shader rejects that side).

Native parameter reference: [Derivative Text TOP documentation](https://derivative.ca/UserGuide/Text_TOP/SOP_Unicode_Language_Abbreviations).
