# 2000 TRACES — TouchDesigner Cinematic

This folder contains the saved, editable native project and all data required for its visual playback. Download or clone the repository and keep this whole folder together.

## Open and play

1. Open **[2000 Traces Cinematic.toe](<2000 Traces Cinematic.toe>)** in TouchDesigner. The verified version is **2023.12230**, with 1280×720 output under the development machine's NonCommercial key.
2. Select `/traces_cinematic` and open **Custom Parameters → Camera**.
3. Click **Pulse** on the **Start cinematic recording playback** row. The recording and camera journey last three minutes.
4. Open the viewer of `OUT_CINEMATIC` inside that component to see the final output.

**Playback → Play / Position** pauses or seeks. Turn **Camera → Follow recorded 3 minute camera path** off to use manual distance, azimuth, elevation and field of view. All shader/Python DATs and native operators remain editable.

**[2000 Traces Cinematic.tox](<2000 Traces Cinematic.tox>)** imports the component into another project. Set its **Data → Recorded data directory** to this folder's `recording/` directory. The `.toe` already uses the relative path `recording`.

## Recording and UDP

This scene plays the included recording. To capture a new one, run the web recording desk described in the [repository README](../../README.md#record-a-performance). A new recording must be exported with `npm run td:export` and the native network rebuilt for its own instance counts; changing only the data path does not import an arbitrary session.

Opening the artwork or starting visual playback does not send UDP. UDP replay requires the local server at `127.0.0.1:8787` and the original session JSONL in its archive. This folder includes exact artwork/event/gesture binaries, not that JSONL or upstream credentials. See the [UDP guide](../../docs/UDP-REPLAY.md).

## Included files and verification

- `.toe`: latest Desktop save, including the user's current visual/camera settings and the disabled previous Native network for comparison.
- `.tox`: previously validated standalone cinematic component with its original starting parameters. Use the `.toe` for the latest saved tuning.
- `recording/`: the one scene's 29 data files, 71,614,519 bytes; 578 participant lanes, 1,073,700 original events, 180 seconds. Seat/zone IDs, original X/Y, finger IDs and precise timestamps are preserved.
- [Cinematic preview.png](<Cinematic preview.png>): native output captured during validation.
- `checksums.sha256`: SHA-256 fingerprints of the two native files, preview and all recording files. These copies match the Desktop files at publication byte for byte.

From this folder on macOS or Linux, verify the package with:

```sh
shasum -a 256 -c checksums.sha256
```

The saved `.toe` was reopened successfully with 73 operators and no errors/warnings. The `.tox` was also loaded under another parent and produced an identical frozen output frame. Native GPU appearance and performance depend on the target machine; the automated repository tests do not launch TouchDesigner.

The published `.toe` is the later 6 September 2026, 10:16 Desktop save (70,802 bytes). Derivative's `toeexpand` confirmed its 73-node cinematic network, relative `recording` path, absence of temporary helpers, and unchanged embedded runtime/camera/plasma/environment/UDP source. The measured render/reopen results in the guide refer to the earlier starting-parameter save; no new GPU performance claim is made for the subsequent parameter tuning.

[Full cinematic guide](../../docs/TOUCHDESIGNER-CINEMATIC.md) · [Rendering research](../../docs/TOUCHDESIGNER-CINEMATIC-RESEARCH.md) · [Exact data validation](../../docs/TOUCHDESIGNER-DATA-VALIDATION.md)
