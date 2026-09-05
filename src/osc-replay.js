// Venue Engine 2.5.1 wire contract: /u float32, /v float32, /on int32.
// An onset is one atomic [u, v, on=1] group. Releases use on=0, not /off.
// Reference: installed Engine src/index.js pktToOscMessage and src/osc.js.
export const OSC_MAX_BYTES = 8192;
export const DEFAULT_UDP_DESTINATION = Object.freeze({ host: '127.0.0.1', port: 6061 });

function oscString(value) {
  const length = Buffer.byteLength(value, 'ascii') + 1;
  const buffer = Buffer.alloc(Math.ceil(length / 4) * 4);
  buffer.write(value, 'ascii');
  return buffer;
}

export function oscMessage(address, type, value) {
  if (!/^\/cs\/[A-Z]\/\d{1,3}\/finger\d{1,3}\/(u|v|on)$/.test(address)) throw new Error('Invalid replay OSC address');
  if (type !== 'f' && type !== 'i') throw new Error('Invalid replay OSC type');
  if (!Number.isFinite(value) || type === 'f' && !Number.isFinite(Math.fround(value))) throw new Error('Invalid replay OSC value');
  const data = Buffer.alloc(4);
  if (type === 'f') data.writeFloatBE(value); else data.writeInt32BE(value);
  return Buffer.concat([oscString(address), oscString(`,${type}`), data]);
}

export function oscBundles(groups, maxBytes = OSC_MAX_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > OSC_MAX_BYTES) throw new RangeError('Invalid OSC bundle limit');
  const bundles = []; let parts = []; let bytes = 16;
  const flush = () => {
    if (!parts.length) return;
    const header = Buffer.alloc(16); header.write('#bundle\0', 'ascii'); header.writeUInt32BE(1, 12);
    bundles.push(Buffer.concat([header, ...parts], bytes)); parts = []; bytes = 16;
  };
  for (const group of groups) {
    const size = group.reduce((sum, message) => sum + message.length + 4, 0);
    if (size + 16 > maxBytes) throw new RangeError('OSC event exceeds bundle limit');
    if (bytes + size > maxBytes) flush();
    for (const message of group) {
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(message.length);
      parts.push(prefix, message); bytes += message.length + 4;
    }
  }
  flush(); return bundles;
}

export function validateDestination(destination = DEFAULT_UDP_DESTINATION) {
  // This workstation's verified route is local. A port remains editable for a
  // dedicated local receiver without silently sending recorded input off-host.
  if (destination?.host !== '127.0.0.1') throw new Error('Replay destination must be 127.0.0.1');
  if (!Number.isInteger(destination.port) || destination.port < 1024 || destination.port > 65535) throw new Error('Invalid replay UDP port');
  return { host: destination.host, port: destination.port };
}

export const voiceKey = (event) => `${event.z}.${event.s}.${event.f}`;
export const seatKey = (event) => `${event.z}.${event.s}.`;
export const hasXY = (event) => Number.isFinite(event.x) && Number.isFinite(event.y) && event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1;
export const addressable = (event) => Number.isInteger(event.z) && event.z >= 0 && event.z <= 25 && Number.isInteger(event.s) && event.s >= 0 && event.s <= 255 && Number.isInteger(event.f) && event.f >= 0 && event.f <= 255;

export function eventOscGroup(event) {
  if (!addressable(event)) return null;
  const base = `/cs/${String.fromCharCode(event.z + 65)}/${event.s}/finger${event.f}`;
  if (event.k === 2) return [oscMessage(`${base}/on`, 'i', 0)];
  if (event.k !== 1 && event.k !== 3 || !hasXY(event)) return null;
  const messages = [oscMessage(`${base}/u`, 'f', event.x), oscMessage(`${base}/v`, 'f', event.y)];
  if (event.k === 1) messages.push(oscMessage(`${base}/on`, 'i', 1));
  return messages;
}
