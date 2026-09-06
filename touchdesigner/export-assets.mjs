// Portable, lossless source pack plus native-renderer GPU attributes. Geometry
// is obtained from the existing renderer; this exporter does not reimplement
// the artwork mapping, event sampling, finger pairing, or motion analysis.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateManifest } from '../viz/src/pack-loader.js';
import { buildNebula, NEBULA_LIMITS } from '../viz/src/nebula.js';
import { createNebulaSpace } from '../viz/src/nebula-space.js';

const TEXTURE_WIDTH = 512;
const TIMELINE_HZ = 60;
const view = (buffer) => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

export function readLocalPack(packDirectory) {
  const directory = resolve(packDirectory);
  const manifest = validateManifest(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  const read = (name, bytes) => {
    const buffer = readFileSync(join(directory, name));
    if (buffer.byteLength !== bytes) throw new Error(`${name}: expected ${bytes} bytes, received ${buffer.byteLength}`);
    return view(buffer);
  };
  return { name: basename(directory), manifest,
    events: read('events.bin', manifest.eventCount * 12),
    strokes: read('strokes.bin', manifest.strokeCount * 16),
    gestures: manifest.gestures ? read('gestures.bin', manifest.eventCount * 32) : null };
}

export function exportAssets(packDirectory, outputDirectory) {
  const sourceDirectory = resolve(packDirectory), output = resolve(outputDirectory);
  const relationship = relative(sourceDirectory, output);
  if (!relationship || (!relationship.startsWith(`..${sep}`) && relationship !== '..' && !relationship.startsWith(sep))) {
    throw new Error('Export directory must be outside the source pack');
  }
  const pack = readLocalPack(sourceDirectory);
  const artwork = buildNebula(pack, {});
  const space = createNebulaSpace(); // Same fixed decorative seed as main.js.
  try {
    mkdirSync(output, { recursive: true });
    const layout = {
      formatVersion: 1,
      source: { pack: pack.name, sessionId: pack.manifest.sessionId, rawDirectory: 'raw', files: {} },
      durationMs: pack.manifest.durationMs,
      laneCount: pack.manifest.laneCount,
      eventCount: pack.manifest.eventCount,
      exactGestures: Boolean(pack.gestures),
      textureEncoding: 'Row-major RGBA Float32 little-endian; zero padding; row 0 contains record 0. Do not flip vertically.',
      groups: {},
    };

    const writeIndices = (groupName, name, array, components) => {
      const file = `${groupName}/${name}.u32.bin`;
      const buffer = Buffer.alloc(array.length * 4);
      array.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
      writeFileSync(join(output, file), buffer);
      return { file, dtype: 'uint32-le', components, count: array.length / components, bytes: buffer.length };
    };

    const group = (name, count, attributes, recordedData) => {
      const width = TEXTURE_WIDTH, height = Math.max(1, Math.ceil(count / width));
      mkdirSync(join(output, name), { recursive: true });
      const result = { count, width, height, recordedData, attributes: {} };
      for (const [attributeName, { array, itemSize, homogeneous = false }] of Object.entries(attributes)) {
        if (array.length !== count * itemSize || itemSize < 1 || itemSize > 4) throw new Error(`Invalid ${name}/${attributeName} attribute`);
        const file = `${name}/${attributeName}.bin`;
        const buffer = Buffer.alloc(width * height * 16);
        for (let i = 0; i < count; i++) {
          for (let channel = 0; channel < itemSize; channel++) buffer.writeFloatLE(array[i * itemSize + channel], (i * 4 + channel) * 4);
          if (homogeneous && itemSize === 3) buffer.writeFloatLE(1, (i * 4 + 3) * 4);
        }
        writeFileSync(join(output, file), buffer);
        result.attributes[attributeName] = { file, dtype: 'float32-le', components: 4, sourceComponents: itemSize, bytes: buffer.length };
      }
      layout.groups[name] = result;
      return result;
    };
    const attribute = (geometry, name, homogeneous = false) => {
      const value = geometry.getAttribute(name);
      return { array: value.array, itemSize: value.itemSize, homogeneous };
    };
    const geometry = (root, name) => {
      const result = root.getObjectByName(name)?.geometry;
      if (!result) throw new Error(`Source geometry missing: ${name}`);
      return result;
    };

    const dust = geometry(artwork.group, 'nebula-actual-event-starlight');
    const dustGroup = group('dust', dust.getAttribute('position').count, {
      position: attribute(dust, 'position', true), data: attribute(dust, 'aData'),
      size: attribute(dust, 'aSize'), motion: attribute(dust, 'aMotion'),
    }, true);
    dustGroup.sourceIndices = writeIndices('dust', 'source-indices', artwork.sampledIndices, 1);

    const halos = geometry(artwork.group, 'nebula-event-atmosphere');
    const haloGroup = group('halos', halos.getAttribute('aCenter').count, {
      position: attribute(halos, 'aCenter', true), data: attribute(halos, 'aData'),
      size: attribute(halos, 'aSize'), motion: attribute(halos, 'aMotion'),
    }, true);
    const haloStride = Math.max(1, Math.ceil(artwork.sampledIndices.length / NEBULA_LIMITS.halos));
    const haloSources = Uint32Array.from({ length: haloGroup.count }, (_, i) => artwork.sampledIndices[i * haloStride]);
    haloGroup.sourceIndices = writeIndices('halos', 'source-indices', haloSources, 1);

    const filaments = geometry(artwork.group, 'nebula-recorded-finger-filaments');
    const filamentGroup = group('filaments', filaments.getAttribute('aStart').count, {
      start: attribute(filaments, 'aStart', true), end: attribute(filaments, 'aEnd', true),
      data: attribute(filaments, 'aData'), motion: attribute(filaments, 'aMotion'),
    }, true);
    filamentGroup.sourcePairs = writeIndices('filaments', 'source-pairs', artwork.segmentPairs, 2);

    const stars = geometry(space.group, 'decorative-stars-four-depth-strata');
    group('stars', stars.getAttribute('position').count, {
      position: attribute(stars, 'position', true), color: attribute(stars, 'aColor'), size: attribute(stars, 'aSize'),
    }, false);
    const clouds = geometry(space.group, 'decorative-distant-clouds');
    group('clouds', clouds.getAttribute('aCenter').count, {
      position: attribute(clouds, 'aCenter', true), size: attribute(clouds, 'aSize'), data: attribute(clouds, 'aSeed'),
    }, false);

    // Every envelope sample is evaluated causally by the canonical source.
    // Native playback uses floor(timeMs * hz / 1000), never a future frame.
    // The final row is exactly durationMs, including fractional frame endings.
    const intervals = Math.ceil(layout.durationMs * TIMELINE_HZ / 1000), count = intervals + 1;
    const flow = new Float32Array(count * 4), motion = new Float32Array(count * 4);
    const exactTimes = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const time = i === intervals ? layout.durationMs : i * 1000 / TIMELINE_HZ;
      const measured = artwork.motionAt(time);
      exactTimes[i] = time;
      flow.set([time, artwork.activityAt(time), 0, 0], i * 4);
      motion.set([measured.speed01, measured.turn01, measured.coherence, measured.energy], i * 4);
    }
    const timeline = group('timeline', count, { flow: { array: flow, itemSize: 4 }, motion: { array: motion, itemSize: 4 } }, true);
    const timeBuffer = Buffer.alloc(count * 8);
    exactTimes.forEach((time, i) => timeBuffer.writeDoubleLE(time, i * 8));
    writeFileSync(join(output, 'timeline/times.f64.bin'), timeBuffer);
    layout.timeline = { group: 'timeline', hz: TIMELINE_HZ, count, exactTimes: 'timeline/times.f64.bin',
      lookup: 'Use upper_bound(exactTimes, timeMs)-1 (hold the latest causal sample). At durationMs select count-1.',
      maxEnvelopeLagMs: 1000 / TIMELINE_HZ, durationMs: layout.durationMs,
      animationClock: 'Separate free-running seconds; replay time is milliseconds. Never derive recorded X/Y from either clock.' };
    timeline.channels = { flow: ['timeMs', 'activity', 'reserved', 'reserved'], motion: ['speed01', 'turn01', 'coherence', 'energy'] };

    mkdirSync(join(output, 'raw'), { recursive: true });
    for (const name of ['manifest.json', 'events.bin', 'strokes.bin', ...(pack.gestures ? ['gestures.bin'] : [])]) {
      const source = join(sourceDirectory, name), file = `raw/${name}`;
      copyFileSync(source, join(output, file));
      const bytes = readFileSync(source);
      layout.source.files[name] = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    writeFileSync(join(output, 'layout.json'), `${JSON.stringify(layout, null, 2)}\n`);
    return layout;
  } finally { artwork.dispose(); space.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node touchdesigner/export-assets.mjs <source-pack-directory> <output-directory>');
    process.exitCode = 1;
  } else {
    try {
      const layout = exportAssets(input, output);
      console.log(JSON.stringify({ output: resolve(output), session: layout.source.sessionId,
        durationMs: layout.durationMs, points: layout.groups.dust.count,
        filaments: layout.groups.filaments.count, exactGestures: layout.exactGestures }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
