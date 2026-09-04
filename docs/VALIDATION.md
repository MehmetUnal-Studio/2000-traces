# Observatory interface validation

Local acceptance performed on 2026-09-05, Node 22.14.0 / macOS.

## Automated checks

`npm run check` runs the Node regression suite and Vite production build.
Additional coverage includes deterministic demo data, malformed manifests and
binary lengths, cancelled pack loading, inverse projection and participant picking
at extreme gesture values, safe text-only zone labels, and recorder panel assets
and status metadata. CI runs the same command on Node 22 and 24.

## Browser checks

The Codex browser was used for these local checks:

- Demo loads with its explicit simulation label and 2,000 / 48,000 counters.
- Desktop 1440 × 900 and mobile 390 × 844 layouts inspected.
- Galaxy/record switch, replay, pause, speed, timeline, final state, and stage mode.
- A visible star selects participant E39 and shows its actual demo events.
- Library search and the existing 1,300-participant / 2,037,830-event pack load.
- 4096 × 4096 export completes the PNG encoding and download initiation path.
- With the recorder stopped, existing packs still open; operator controls disable
  and explicitly identify their last-known state. Recorder restored afterward.
- Operator ARM → ARMED → DISARM → IDLE, without starting a take.

No new venue recording was started. These checks validate the local viewer and
control interface; they do not establish live-stream or musical-output acceptance.
The browser download notification was checked; the destination file was not
independently inspected. Production build output was checked to exclude local packs.

## Repeat

Run `npm run panel` and `npm run viz` in separate terminals, then open
`http://127.0.0.1:5174/?demo=1`. Use a saved pack from the library for dense-data
testing. Test recording only with the intended source or an isolated fixture.
