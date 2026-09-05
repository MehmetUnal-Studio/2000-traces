# 2000 TRACES

A collective memory of a performance. Audience gestures become a circular, explorable data artwork.

2000 TRACES records a bounded audience-event stream, preserves it as JSONL, and turns each session into an explorable Three.js / GLSL artwork. **Nebula** is the single visual language for both live recording and archived playback: phone X/Y gestures wind around a dark core, with blue and amber filaments, three-dimensional depth and orbital movement. The corona responds to the recent note/movement rate. The viewer supports inspection, participant isolation, playback, an archive and 4K PNG export. The separate operator desk keeps recording controls and session health visible.

## Explore locally

Requires **Node.js 22.12+** and npm. No account or live-stream credentials are needed for the example.

```sh
npm ci
npm run viz
```

Open [the entrance](http://127.0.0.1:5174/) for **Stars of The Year / Senenin Yıldızları**: a procedural starfield and glowing planetary horizon, with actions to enter the artwork, start recording or explore the archive. **Başlangıç** returns to this entrance without stopping a recording. If the server is already recording, the bare viewer address joins that session directly.

[The direct example link](http://127.0.0.1:5174/?demo=1) bypasses the entrance. It uses a deterministic, synthetic **90-second** session with 2,000 participants; it does not start a recording or write session files. This example and historical takes retain their own duration. **New recordings default to 180 seconds (3 minutes).**

In Nebula, X bends an orbit and Y changes its radius and depth. Known fingers create paths through their actual recorded coordinates; gaps and releases break those paths. The X/Y inspector replays the source independently of the bounded GPU sample. New packs preserve full JavaScript-number precision, timestamps, missing values and finger identity in `gestures.bin`; legacy 16-bit packs remain readable. Raw JSONL can be repacked to recover fields the older visual binary omitted. Read [how to explore and interpret the artwork](docs/ARTWORK.md) for mappings, controls and limits, and [the X/Y acceptance report](docs/XY-VALIDATION.md) for the earlier synthetic live test.

Use `?pack=<local-pack-name>` to open a saved artwork directly. Its selection is retained in the page URL; these URLs refer to files on the same local installation. Drag to pan, use the wheel or two fingers to zoom, and use **Shift + drag** or **Eseri oku → Bakış / eğim** to inspect the depth. These view controls also work during live recording.

Flow intensity is causal: recent note/move events increase it, silence produces an approximately one-second exponential decay, and seeking samples the corresponding recorded history. Status messages do not add activity. The live view and archive share the same scale. Blue/amber material and the reactive corona are artistic lighting, not acoustic-energy measurements or a physical black-hole simulation; optional orbit motion does not imply incoming data.

## Record a performance

Configure `CS_EVENTS_URL` and either `CS_EVENTS_TOKEN` or `CS_EVENTS_AUTH` in your local environment or a gitignored `.env`. Keep credentials on the recording machine. See [the operator guide](docs/OPERATOR.md) for configuration, state transitions, and recovery.

Run these in separate terminals:

```sh
npm run panel
```

```sh
npm run viz
```

Open [the recording desk](http://127.0.0.1:8787/). Add an optional session label, choose **ARM · Hazırla**, then **Kaydı başlat**. A recording lasts up to its configured window, normally 180 seconds (3 minutes). The desk shows server-confirmed state, elapsed time, participant/event counts, and persistent error messages. Reloading a page does not restart or stop a recording. Opening the panel alone does not connect to the upstream stream.

Completed raw takes appear in `sessions/`; automatic visual packs appear in `viz/public/packs/`. A pack failure leaves the raw JSONL available for a retry. The recording server binds only to `127.0.0.1`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run viz` | Local viewer at `127.0.0.1:5174` |
| `npm run panel` | Local recorder and operator desk at `127.0.0.1:8787` |
| `npm run record:file -- captures/fixture-small.sse.txt` | Record the bundled fixture without upstream access; prints the output path |
| `npm run viz:pack -- sessions/<take>.jsonl viz/public/packs/<name>` | Build a viewer pack from a raw take |
| `npm test` | Node regression suite using fixtures and local test servers |
| `npm run build` | Build the viewer into `dist-viz/` |
| `npm run preview` | Preview the built viewer; use the URL printed by Vite |
| `npm run check` | Run the tests and production build |

`dist-viz/` contains the application and its synthetic example, **not local recording packs**. The local Vite development and preview servers serve `/packs/` directly from `viz/public/packs/`, so newly recorded sessions become available without restarting the viewer. A portable copy of `dist-viz/` contains no private session archive; serving recordings elsewhere requires a separate, deliberate setup.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/server.js` | Loopback control API, session lifecycle, live rebroadcast, library operations |
| `src/recorder.js`, `src/session.js` | Normalization, recording window, statistics, JSONL lifecycle |
| `src/sources/` | File fixtures and authenticated upstream SSE |
| `src/viz-pack.js`, `src/library.js` | Binary packs, manifest/index generation, inexpensive archive metadata |
| `ui/` | Recording desk: accessible controls, server status, JSONL archive |
| `viz/src/main.js`, `viz/src/hud.js` | Viewer coordination, playback, library, live view and interface |
| `viz/src/cover.js` | Stars of The Year entrance, procedural wallpaper, focus and keyboard isolation |
| `viz/src/nebula.js`, `viz/src/nebula-shaders.js` | Bounded gesture cloud, accretion filaments, depth, orbital motion and picking |
| `viz/src/live-nebula.js` | Incremental live geometry using the same Nebula materials and coordinate mapping |
| `viz/src/gesture-replay.js` | Original X/Y access, per-finger seek/loop state and gap-aware trails |
| `viz/src/flow-energy.js` | Shared causal note/movement rate and activity response for live and archive |
| `viz/src/` | Three.js rendering, materials, layout, demo generation and pack loading |
| `test/` | Recorder, transport, server, pack and viewer regression coverage |

The data path is **upstream/file → recorder → JSONL → visual pack → viewer**. During recording, the local server also rebroadcasts compact events to the viewer. Playback and visual exports do not alter the raw take.

## Data and validation

- `.env`, `sessions/`, raw `captures/*.raw`, `viz/public/packs/`, and `dist-viz/` are excluded from Git. Review additions before publishing; ignored local data is still present on disk.
- Included fixtures and the example artwork support offline development. They do not establish venue readiness or prove a real performance capture.
- CI runs the Node suite and production build on Node 22 and 24. Browser/GPU appearance and the venue stream still need hands-on acceptance on the target machine.
- For operating limits and recovery, see [docs/OPERATOR.md](docs/OPERATOR.md). Historical handoff and implementation plans live under `docs/`; the running source defines current behavior.

Creative context for the entrance: Yıldız Holding's [Senenin Yıldızları announcement, 10 April 2025](https://www.medyamerkezi.yildizholding.com.tr/tr/basin-bultenleri/senenin-yildizlari-17nci-kez-odullendirildi). The procedural cover does not assign a year or edition number to the current experience.
