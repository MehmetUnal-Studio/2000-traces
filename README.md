# 2000 TRACES

A collective memory of a performance. Audience gestures become individual traces in a shared, explorable universe.

2000 TRACES records a bounded audience-event stream, preserves it as JSONL, and turns each session into a deterministic Three.js artwork. The viewer provides a luminous constellation view and a record-style view, participant isolation, playback, an archive, and 4K PNG export. The separate operator desk keeps recording controls and session health visible.

## Explore locally

Requires **Node.js 22.12+** and npm. No account or live-stream credentials are needed for the example.

```sh
npm ci
npm run viz
```

Open [the example universe](http://127.0.0.1:5174/?demo=1). It uses a deterministic, synthetic 90-second session with 2,000 participants; it does not start a recording or write session files. The default viewer opens the example when no saved packs exist.

The visual language uses a near-black field, quiet typography, ice-blue light, and warm amber detail. Participant identity and recorded timing remain attached to the artwork as its presentation changes.

## Record a performance

Configure `CS_EVENTS_URL` and either `CS_EVENTS_TOKEN` or `CS_EVENTS_AUTH` in your local environment or a gitignored `.env`. Keep credentials on the recording machine. See [the operator guide](docs/OPERATOR.md) for configuration, state transitions, and recovery.

Run these in separate terminals:

```sh
npm run panel
```

```sh
npm run viz
```

Open [the recording desk](http://127.0.0.1:8787/). Add an optional session label, choose **ARM · Hazırla**, then **Kaydı başlat**. A recording lasts up to its configured window, normally 90 seconds. The desk shows server-confirmed state, elapsed time, participant/event counts, and persistent error messages. Reloading a page does not restart or stop a recording. Opening the panel alone does not connect to the upstream stream.

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
| `viz/src/` | Three.js rendering, layout, demo generation and pack loading |
| `test/` | Recorder, transport, server, pack and viewer regression coverage |

The data path is **upstream/file → recorder → JSONL → visual pack → viewer**. During recording, the local server also rebroadcasts compact events to the viewer. Playback and visual exports do not alter the raw take.

## Data and validation

- `.env`, `sessions/`, raw `captures/*.raw`, `viz/public/packs/`, and `dist-viz/` are excluded from Git. Review additions before publishing; ignored local data is still present on disk.
- Included fixtures and the example universe support offline development. They do not establish venue readiness or prove a real performance capture.
- CI runs the Node suite and production build on Node 22 and 24. Browser/GPU appearance and the venue stream still need hands-on acceptance on the target machine.
- For operating limits and recovery, see [docs/OPERATOR.md](docs/OPERATOR.md). Historical handoff and implementation plans live under `docs/`; the running source defines current behavior.
