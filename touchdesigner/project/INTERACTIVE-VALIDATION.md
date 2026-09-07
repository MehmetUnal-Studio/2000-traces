# Interactive cinema validation — 7 September 2026

Native runtime: TouchDesigner **2025.33230**, macOS. This records local verification; it does not assert a target-machine frame rate or physical display acceptance.

- Native camera orbit, wheel dolly, timeline, seat list and solo/X-Y inspector were exercised in the interactive Container. The inspector's numeric values and graph update during replay and seeking.
- The network contains **108 direct children** under `/traces_cinematic`. Native recursive errors and warnings were empty at final save. The saved `.toe` was subsequently reloaded and its automatic interactive window visibly rendered the scene. The reopened Textport contained no new messages beyond the runtime banner.
- The external suite completed **87 Python cases** successfully, with four NumPy cases skipped by that interpreter. All **16 selection tests** passed in TouchDesigner's NumPy environment, including exact timestamps, causal samples, finger separation, horizon occlusion, camera parallax and strict solo selection. The final native run repeated the 16 tests after replacing BLAS matrix/vector calls with explicit three-component contractions.
- Three picks against the real 230,000-point recorded field completed with strict NumPy floating-point reporting and no captured warnings. The source positions were finite, within approximately −1.136 to +1.133 world units.
- Native title check at a frozen frame: zero opacity matched the prior scene with **0 maximum pixel difference**. The upstream scene remained identical with the title enabled. **16,916 bright pixels** also had **0 maximum RGB difference**; the title changed 17,755 quieter pixels. The title follows grade/SMAA and never enters bloom, glare or lensing.
- Both `.toe` and `.tox` were expanded using Derivative's `toeexpand`. Thirteen embedded Python/shader source files matched the repository exactly, after their native DAT serialization header. Both contained 108 direct children and no `/traces_import_tools` helper. The `.toe` retained the relative `recording` asset path.
- Desktop and repository `.toe` copies match byte for byte. Final sizes: **107,010 bytes** (`.toe`), **74,270 bytes** (`.tox`). All 29 recording-file checksums are unchanged. Run the package checksum command in the README to verify the distributed files.
- UDP was **OFF** throughout verification; visual playback and selection did not initiate sending.

Picking approximates the visible source position before gravitational lens distortion. Use the seat menu for an exact selection close to the distorted rim. The `.tox` was saved and structurally inspected in this pass; a separate import-and-render comparison of this enhanced `.tox` in another host project was not performed.
