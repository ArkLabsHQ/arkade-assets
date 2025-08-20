// tools/arkass-codec.js
// Encoding and decoding helpers for ArkAssetV1 OP_RETURN payloads and scriptPubKey.
// Assumptions (tweak in Config to match your canonical TLV):
// - Varuint: Bitcoin CompactSize
// - Integers: u16/u64 little-endian; txid kept as given (no reverse) by default
// - Group optional fields: 1-byte presence bitfield: bit0=AssetId, bit1=ControlAsset, bit2=Metadata

const Config = {
  u16LE: true,
  u64LE: true,
  txidLE: false, // false = keep 32-byte txid as given (hex order)
  varuint: 'compactsize',
  usePresenceByte: true,
};

// ---------------- Utils ----------------
function hexToBuf(hex) {
  if (typeof hex !== 'string') throw new Error('hex must be string');
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2) throw new Error('hex length must be even');
  return Buffer.from(hex, 'hex');
}

function bufToHex(buf) { return buf.toString('hex'); }

function reverse(buf) { const b = Buffer.from(buf); b.reverse(); return b; }

function writeU16(n, le = true) {
  const b = Buffer.alloc(2);
  if (le) b.writeUInt16LE(n); else b.writeUInt16BE(n);
  return b;
}

function encodeVarString(s) {
  const sBuf = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarUint(sBuf.length), sBuf]);
}

function decodeVarString(buf, off) {
  const vLen = decodeVarUint(buf, off); let cursor = off + vLen.size;
  const sBuf = buf.slice(cursor, cursor + vLen.value);
  cursor += vLen.value;
  return { str: sBuf.toString('utf8'), next: cursor };
}

function writeU64(n, le = true) {
  let x = typeof n === 'bigint' ? n : BigInt(n);
  if (x < 0n) throw new Error('u64 must be >= 0');
  const b = Buffer.alloc(8);
  if (le) { for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } }
  else { for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } }
  return b;
}

function readU16(buf, off, le = true) {
  if (off + 2 > buf.length) throw new Error('readU16 OOB');
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function readU64(buf, off, le = true) {
  if (off + 8 > buf.length) throw new Error('readU64 OOB');
  let x = 0n;
  if (le) { for (let i = 7; i >= 0; i--) { x = (x << 8n) | BigInt(buf[off + i]); } }
  else { for (let i = 0; i < 8; i++) { x = (x << 8n) | BigInt(buf[off + i]); } }
  return x;
}

function encodeCompactSize(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), writeU16(n, true)]);
  if (n <= 0xffffffff) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return Buffer.concat([Buffer.from([0xfe]), b]); }
  return Buffer.concat([Buffer.from([0xff]), writeU64(n, true)]);
}

function decodeCompactSize(buf, off) {
  if (off >= buf.length) throw new Error('decodeCompactSize OOB');
  const ch = buf[off];
  if (ch < 0xfd) return { value: ch, size: 1 };
  if (ch === 0xfd) { if (off + 3 > buf.length) throw new Error('compactsize 0xfd OOB'); return { value: buf.readUInt16LE(off + 1), size: 3 }; }
  if (ch === 0xfe) { if (off + 5 > buf.length) throw new Error('compactsize 0xfe OOB'); return { value: buf.readUInt32LE(off + 1), size: 5 }; }
  if (off + 9 > buf.length) throw new Error('compactsize 0xff OOB');
  const v = readU64(buf, off + 1, true);
  if (v > Number.MAX_SAFE_INTEGER) throw new Error('compactsize 0xff value too large for Number');
  return { value: Number(v), size: 9 };
}

function encodeVarUint(n) { return encodeCompactSize(n); }
function decodeVarUint(buf, off) { return decodeCompactSize(buf, off); }

// Script pushdata encoding/decoding
function encodePushData(data) {
  const len = data.length;
  if (len <= 75) return Buffer.concat([Buffer.from([len]), data]);
  if (len <= 0xff) return Buffer.concat([Buffer.from([0x4c, len]), data]); // OP_PUSHDATA1
  if (len <= 0xffff) { const l = Buffer.alloc(2); l.writeUInt16LE(len); return Buffer.concat([Buffer.from([0x4d]), l, data]); }
  const l4 = Buffer.alloc(4); l4.writeUInt32LE(len); return Buffer.concat([Buffer.from([0x4e]), l4, data]);
}

function decodePushData(script, off) {
  if (off >= script.length) throw new Error('decodePushData OOB');
  const op = script[off++];
  let len = 0, size = 1;
  if (op <= 75) { len = op; }
  else if (op === 0x4c) { if (off + 1 > script.length) throw new Error('OP_PUSHDATA1 OOB'); len = script[off]; size = 2; off++; }
  else if (op === 0x4d) { if (off + 2 > script.length) throw new Error('OP_PUSHDATA2 OOB'); len = script.readUInt16LE(off); size = 3; off += 2; }
  else if (op === 0x4e) { if (off + 4 > script.length) throw new Error('OP_PUSHDATA4 OOB'); len = script.readUInt32LE(off); size = 5; off += 4; }
  else { throw new Error('Unsupported pushdata opcode: ' + op); }
  const start = off;
  const end = off + len;
  if (end > script.length) throw new Error('pushdata length OOB');
  return { data: script.slice(start, end), size: size + len };
}

// ---------------- Encoding ----------------
function encodeAssetId({ txidHex, gidx }) {
  let tx = hexToBuf(txidHex);
  if (tx.length !== 32) throw new Error('txid must be 32 bytes');
  if (Config.txidLE) tx = reverse(tx);
  const g = writeU16(gidx, Config.u16LE);
  return Buffer.concat([tx, g]);
}

// Control ref shapes (KISS):
// 1) { txidHex, gidx }          -> BY_ID
// 2) { gidx } (no txidHex)      -> BY_GROUP
function encodeAssetRef(c) {
  if (!c) throw new Error('control ref missing');
  if (typeof c.txidHex === 'string' && typeof c.gidx === 'number') {
    return Buffer.concat([Buffer.from([0x01]), encodeAssetId({ txidHex: c.txidHex, gidx: c.gidx })]);
  }
  if (typeof c.gidx === 'number' && (c.txidHex === undefined || c.txidHex === null)) {
    return Buffer.concat([Buffer.from([0x02]), writeU16(c.gidx, Config.u16LE)]);
  }
  throw new Error('Unrecognized control ref shape; expected {txidHex,gidx} or {gidx}');
}

function encodeMetadataMap(map) {
  const keys = Object.keys(map);
  const parts = [encodeVarUint(keys.length)];
  for (const key of keys) {
    parts.push(encodeVarString(key));
    parts.push(encodeVarString(map[key]));
  }
  return Buffer.concat(parts);
}

function encodeAssetInput({ type, i, amt, commitment }) {
  if (type === 'LOCAL') {
    const inputBuf = Buffer.alloc(11);
    inputBuf[0] = 0x01; // LOCAL type
    inputBuf.writeUInt16LE(i, 1);
    inputBuf.writeBigUInt64LE(BigInt(amt), 3);
    return inputBuf;
  } else if (type === 'TELEPORT') {
    const inputBuf = Buffer.alloc(41);
    inputBuf[0] = 0x02; // TELEPORT type
    Buffer.from(commitment, 'hex').copy(inputBuf, 1);
    inputBuf.writeBigUInt64LE(BigInt(amt), 33);
    return inputBuf;
  } else {
    throw new Error(`Unknown input type: ${type}`);
  }
}

function encodeAssetOutput({ type, o, amt, commitment }) {
  if (type === 'LOCAL') {
    const outputBuf = Buffer.alloc(11);
    outputBuf[0] = 0x01; // LOCAL type
    outputBuf.writeUInt16LE(o, 1);
    outputBuf.writeBigUInt64LE(BigInt(amt), 3);
    return outputBuf;
  } else if (type === 'TELEPORT') {
    const outputBuf = Buffer.alloc(41);
    outputBuf[0] = 0x02; // TELEPORT type
    Buffer.from(commitment, 'hex').copy(outputBuf, 1);
    outputBuf.writeBigUInt64LE(BigInt(amt), 33);
    return outputBuf;
  } else {
    throw new Error(`Unknown output type: ${type}`);
  }
}

function encodeGroup(group) {
  const parts = [];
  if (Config.usePresenceByte) {
    let presence = 0;
    if (group.assetId) presence |= 1;
    if (group.control) presence |= 2;
    if (group.metadata) presence |= 4; // bit 2 for metadata
    parts.push(Buffer.from([presence]));
    if (group.assetId) parts.push(encodeAssetId(group.assetId));
    if (group.control) parts.push(encodeAssetRef(group.control));
    if (group.metadata) parts.push(encodeMetadataMap(group.metadata));
  } else {
    throw new Error('Implement your canonical TLV tagging here.');
  }
  parts.push(encodeVarUint(group.inputs.length));
  for (const inp of group.inputs) parts.push(encodeAssetInput(inp));
  parts.push(encodeVarUint(group.outputs.length));
  for (const out of group.outputs) parts.push(encodeAssetOutput(out));
  return Buffer.concat(parts);
}

function encodePacket({ groups = [], updates = [] }) {
  const groupParts = [encodeVarUint(groups.length)];
  for (const g of groups) groupParts.push(encodeGroup(g));

  const updateParts = [encodeVarUint(updates.length)];
  for (const u of updates) {
    updateParts.push(encodeAssetRef(u.assetRef));
    updateParts.push(encodeMetadataMap(u.metadata));
  }

  return Buffer.concat([...groupParts, ...updateParts]);
}

function buildArkassPayload(payload) {
  const magic = Buffer.from('ARKASS', 'ascii');
  const body = encodePacket(payload);
  return Buffer.concat([magic, body]);
}

function buildOpReturnScript(payload) {
  const fullPayload = buildArkassPayload(payload);
  const opReturn = Buffer.from([0x6a]); // OP_RETURN
  const push = encodePushData(fullPayload);
  return Buffer.concat([opReturn, push]);
}

// ---------------- Decoding ----------------
function decodeMetadataMap(buf, off) {
  const vCount = decodeVarUint(buf, off); let cursor = off + vCount.size;
  const map = {};
  for (let i = 0; i < vCount.value; i++) {
    const rKey = decodeVarString(buf, cursor); cursor = rKey.next;
    const rVal = decodeVarString(buf, cursor); cursor = rVal.next;
    map[rKey.str] = rVal.str;
  }
  return { map, next: cursor };
}

function decodeAssetId(buf, off) {
  if (off + 34 > buf.length) throw new Error('decodeAssetId OOB');
  let tx = buf.slice(off, off + 32);
  if (Config.txidLE) tx = reverse(tx);
  const gidx = readU16(buf, off + 32, Config.u16LE);
  return { assetid: { txidHex: bufToHex(tx), gidx }, next: off + 34 };
}

function decodeAssetRef(buf, off) {
  if (off >= buf.length) throw new Error('decodeAssetRef OOB');
  const tag = buf[off];
  if (tag === 0x01) {
    const { assetid, next } = decodeAssetId(buf, off + 1);
    return { ref: { kind: 'BY_ID', assetid }, next };
  } else if (tag === 0x02) {
    const gidx = readU16(buf, off + 1, Config.u16LE);
    return { ref: { kind: 'BY_GROUP', gidx }, next: off + 3 };
  }
  throw new Error('Unknown AssetRef tag: ' + tag);
}

function decodeAssetInput(buf, off) {
  const inputType = buf[off++];
  if (inputType === 0x01) { // LOCAL
    const i = buf.readUInt16LE(off);
    off += 2;
    const amt = buf.readBigUInt64LE(off);
    off += 8;
    return { input: { type: 'LOCAL', i, amt: amt.toString() }, next: off };
  } else if (inputType === 0x02) { // TELEPORT
    const commitment = buf.slice(off, off + 32).toString('hex');
    off += 32;
    const amt = buf.readBigUInt64LE(off);
    off += 8;
    return { input: { type: 'TELEPORT', commitment, amt: amt.toString() }, next: off };
  } else {
    throw new Error(`Unknown input type: ${inputType}`);
  }
}

function decodeAssetOutput(buf, off) {
  const outputType = buf[off++];
  if (outputType === 0x01) { // LOCAL
    const o = buf.readUInt16LE(off);
    off += 2;
    const amt = buf.readBigUInt64LE(off);
    off += 8;
    return { output: { type: 'LOCAL', o, amt: amt.toString() }, next: off };
  } else if (outputType === 0x02) { // TELEPORT
    const commitment = buf.slice(off, off + 32).toString('hex');
    off += 32;
    const amt = buf.readBigUInt64LE(off);
    off += 8;
    return { output: { type: 'TELEPORT', commitment, amt: amt.toString() }, next: off };
  } else {
    throw new Error(`Unknown output type: ${outputType}`);
  }
}

function decodeGroup(buf, off) {
  if (!Config.usePresenceByte) throw new Error('Implement TLV tagging decode.');
  if (off >= buf.length) throw new Error('decodeGroup OOB');
  let cursor = off;
  const presence = buf[cursor++];
  let assetId = undefined;
  let control = undefined;
  let metadata = undefined;
  if (presence & 1) { const r = decodeAssetId(buf, cursor); assetId = r.assetid; cursor = r.next; }
  if (presence & 2) { const r = decodeAssetRef(buf, cursor); control = r.ref; cursor = r.next; }
  if (presence & 4) { const r = decodeMetadataMap(buf, cursor); metadata = r.map; cursor = r.next; }

  const vin = decodeVarUint(buf, cursor); cursor += vin.size;
  const inputs = [];
  for (let k = 0; k < vin.value; k++) { const r = decodeAssetInput(buf, cursor); inputs.push(r.input); cursor = r.next; }

  const vout = decodeVarUint(buf, cursor); cursor += vout.size;
  const outputs = [];
  for (let k = 0; k < vout.value; k++) { const r = decodeAssetOutput(buf, cursor); outputs.push(r.output); cursor = r.next; }

  return { group: { assetId, control, metadata, inputs, outputs }, next: cursor };
}

function decodePacket(buf, off = 0) {
  // Decode Groups
  const vGroups = decodeVarUint(buf, off); let cursor = off + vGroups.size;
  const groups = [];
  for (let i = 0; i < vGroups.value; i++) {
    const r = decodeGroup(buf, cursor); groups.push(r.group); cursor = r.next;
  }

  // Decode Metadata Updates
  const vUpdates = decodeVarUint(buf, cursor); cursor += vUpdates.size;
  const updates = [];
  for (let i = 0; i < vUpdates.value; i++) {
    const rRef = decodeAssetRef(buf, cursor); cursor = rRef.next;
    const rMap = decodeMetadataMap(buf, cursor); cursor = rMap.next;
    updates.push({ assetRef: rRef.ref, metadata: rMap.map });
  }

  return { groups, updates, next: cursor };
}

function parseArkassPayload(payload) {
  const magic = Buffer.from('ARKASS', 'ascii');
  if (payload.length < magic.length) throw new Error('payload too short');
  if (!payload.slice(0, magic.length).equals(magic)) throw new Error('magic mismatch');
  let cursor = magic.length;

  const { groups, updates } = decodePacket(payload, cursor);
  return { magic: 'ARKASS', groups, updates };
}

function parseOpReturnScript(script) {
  if (!Buffer.isBuffer(script)) throw new Error('script must be Buffer');
  if (script.length < 2) throw new Error('script too short');
  if (script[0] !== 0x6a) throw new Error('not an OP_RETURN script');
  const { data } = decodePushData(script, 1);
  return parseArkassPayload(data);
}

module.exports = {
  Config,
  // encode
  encodeAssetId,
  encodeAssetRef,
  encodeGroup,
  encodePacket,
  encodeMetadataMap,
  buildArkassPayload,
  buildOpReturnScript,
  // decode
  decodeAssetId,
  decodeAssetRef,
  decodeGroup,
  decodePacket,
  decodeMetadataMap,
  parseArkassPayload,
  parseOpReturnScript,
  // utils
  hexToBuf,
  bufToHex,
};
