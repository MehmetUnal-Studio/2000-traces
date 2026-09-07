# 2000 TRACES — TouchDesigner Cinematic

This folder contains the editable native project and the data required for its visual playback. Download or clone the repository and keep this whole folder together. [Türkçe kullanım kılavuzu](KULLANIM.md)

## Open and play

1. Open **[2000 Traces Cinematic.toe](<2000 Traces Cinematic.toe>)** in **TouchDesigner 2025.33230**, the verified runtime version.
2. The interactive cinema window opens automatically when **Playback → Open cinema when project loads** is enabled. To reopen it, select `/traces_cinematic` and pulse **Custom Parameters → Playback → Open interactive cinema**.
3. Click **OYNAT** or press **Space** with the scene focused. The included recording lasts three minutes. The bottom timeline seeks through its recorded data.
4. Drag with the left button to orbit, Shift-drag or middle-drag to pan, and use the wheel or a vertical right-button drag to dolly. **F** or **Kadrajı sıfırla** restores the wide framing. Manual navigation takes over smoothly from the cinematic camera.

Use **KAMERA: SİNEMA / KAMERA: SERBEST** to switch between the recorded camera journey and manual navigation. The original **Camera → Start cinematic recording playback** pulse also starts the recording and camera journey. Shader/Python DATs, Text TOPs and native operators remain editable.

The interactive window displays the `VIEWPORT` Container through `WINDOW_CINEMATIC`. **`OUT_CINEMATIC` remains a clean TOP output**, suitable for a separate display or downstream processing. A raw TOP viewer does not provide the interactive camera controls or seat inspector.

**[2000 Traces Cinematic.tox](<2000 Traces Cinematic.tox>)** imports the same component into another project. Set **Data → Recorded data directory** to this folder's `recording/` directory. The `.toe` uses the relative path `recording`.

## Seats and background title

Choose a seat from **Koltuk seç**, or click its visible trace. The inspector shows that seat's original X/Y samples, finger ID, recording time and recent movement trail. **SOLO: AÇIK** isolates its recorded traces; **SOLO: KAPALI** keeps all participants visible while the inspector follows the selected seat. Decorative stars and the black hole remain visible in either mode. **Seçimi kaldır** returns to the complete recording.

Click picking uses the source geometry before lens distortion, so a click very close to the gravitationally distorted core may select a neighboring trace. The seat menu provides an exact choice. Inspection reads the original event data without modifying it.

The **Title** custom page controls the editable **Stars of The Year** lettering. It is placed behind the scene, after grade and antialiasing, with core occlusion and bright-star protection. It does not feed the lighting, bloom or lensing passes. The default camera-facing plane keeps the title behind the artwork during orbiting; opacity, size, depth and vertical position remain adjustable.

## Recording and UDP

This scene plays the included recording. To capture a new one, run the web recording desk described in the [repository README](../../README.md#record-a-performance). A new recording must be exported with `npm run td:export` and the native network rebuilt for its own instance counts; changing only the data path does not import an arbitrary session.

Opening the artwork, navigating, selecting a seat or starting visual playback does not send UDP. UDP replay requires the local server at `127.0.0.1:8787` and the original session JSONL in its archive. This folder includes exact artwork/event/gesture binaries, not that JSONL or upstream credentials. See the [UDP guide](../../docs/UDP-REPLAY.md).

## Included files and verification

- `.toe` and `.tox`: enhanced interactive cinema project/component. The repository retains its canonical **2000 Traces Cinematic** filenames; the corresponding Desktop delivery is named **2000 Traces Interactive**.
- `recording/`: the unchanged scene data: 29 files, 71,614,519 bytes; 578 participant lanes, 1,073,700 original events, 180 seconds. Seat/zone IDs, original X/Y, finger IDs and precise timestamps are preserved.
- [Cinematic preview.png](<Cinematic preview.png>): native output preview.
- `checksums.sha256`: SHA-256 fingerprints of the native files, preview and recording files.

From this folder on macOS or Linux, verify the package with:

```sh
shasum -a 256 -c checksums.sha256
```

The enhanced live network was verified in TouchDesigner **2025.33230** with **108 direct children** under `/traces_cinematic` and **no reported errors or warnings**. The Python suite completed successfully (**87 cases**, with four NumPy-dependent cases skipped in the external Python environment); all **16 selection tests**, including those four, passed inside TouchDesigner's Python. The final `.toe` was saved and reopened, and its interactive cinema window opened automatically with rendered output. Derivative's `toeexpand` confirmed the matching embedded sources in both delivered files and the absence of temporary development helpers. See [interactive validation](INTERACTIVE-VALIDATION.md) for the measured title protection and verification boundaries. No sustained frame-rate or target-machine performance claim is made.

[Navigation implementation](../cinematic/NAVIGATION.md) · [Selection implementation](../cinematic/SELECTION.md) · [Background title](../cinematic/TITLE.md) · [Full cinematic guide](../../docs/TOUCHDESIGNER-CINEMATIC.md) · [Exact data validation](../../docs/TOUCHDESIGNER-DATA-VALIDATION.md)
