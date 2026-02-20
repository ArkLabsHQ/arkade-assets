// tools/arkade-assets-codec.ts
// Encoding and decoding helpers for Arkade Asset V1 OP_RETURN payloads and scriptPubKey.

// --- Universal Buffer/Array Utilities ---

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even number of characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice().reverse();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ----------------- TYPE DEFINITIONS -----------------

export interface ConfigType {
  u16LE: boolean;
  u64LE: boolean;
  txidLE: boolean;
  varuint: 'compactsize';
  usePresenceByte: boolean;
}

export interface AssetId {
  txidHex: string;
  gidx: number;
}

export interface AssetRefById {
  txidHex: string;
  gidx: number;
}

export interface AssetRefByGroup {
  gidx: number;
  txidHex?: undefined; // Discriminating property
}

export type AssetRef = AssetRefById | AssetRefByGroup;

export type MetadataMap = { [key: string]: string };

export interface AssetInputLocal {
  type: 'LOCAL';
  i: number;
  amt: string | bigint;
}

export interface AssetInputIntent {
  type: 'INTENT';
  txid: string;  // hex, 32 bytes - intent transaction id
  o: number;     // output index in intent transaction
  amt: string | bigint;
}

export type AssetInput = AssetInputLocal | AssetInputIntent;

export interface AssetOutputLocal {
  type: 'LOCAL';
  o: number;
  amt: string | bigint;
}

export type AssetOutput = AssetOutputLocal;

export interface Issuance {
  controlAsset?: AssetRef;
  metadata?: MetadataMap;
  immutable?: boolean;
}

export interface Group {
  assetId?: AssetId;
  issuance?: Issuance;      // Genesis only
  metadata?: MetadataMap;     // Update only
  inputs: AssetInput[];
  outputs: AssetOutput[];
}

export interface Packet {
  groups?: Group[];
}

// ----------------- CONFIG -----------------

export const Config: ConfigType = {
  u16LE: true,   // Little-endian for u16 fields (matches Bitcoin style)
  u64LE: true,
  txidLE: false,
  varuint: 'compactsize',
  usePresenceByte: true,
};

// ----------------- UTILS -----------------

export function hexToBuf(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('hex must be string');
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2) throw new Error('hex length must be even');
  return hexToBytes(hex);
}

export function bufToHex(buf: Uint8Array): string {
  return bytesToHex(buf);
}

function writeU16(v: number, le: boolean): Uint8Array {
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, v, le);
  return arr;
}

function encodeVarString(s: string): Uint8Array {
  const strBytes = textEncoder.encode(s);
  return concatBytes(encodeVarUint(strBytes.length), strBytes);
}

function decodeVarString(buf: Uint8Array, off: number): { str: string; next: number } {
  const vLen = decodeVarUint(buf, off);
  let cursor = off + vLen.size;
  const str = textDecoder.decode(buf.slice(cursor, cursor + Number(vLen.value)));
  cursor += vLen.value;
  return { str, next: cursor };
}

function writeU64(n: number | bigint, le = true): Uint8Array {
  let x = typeof n === 'bigint' ? n : BigInt(n);
  if (x < 0n) throw new Error('u64 must be >= 0');
  const arr = new Uint8Array(8);
  const view = new DataView(arr.buffer);
  if (le) {
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, Number(x & 0xffn));
      x >>= 8n;
    }
  } else {
    for (let i = 7; i >= 0; i--) {
      view.setUint8(i, Number(x & 0xffn));
      x >>= 8n;
    }
  }
  return arr;
}

function readU16(view: DataView, off: number, le: boolean): number {
  return view.getUint16(off, le);
}

function readU64(view: DataView, off: number, le = true): bigint {
  let x = 0n;
  if (le) {
    for (let i = 7; i >= 0; i--) {
      x = (x << 8n) | BigInt(view.getUint8(off + i));
    }
  } else {
    for (let i = 0; i < 8; i++) {
      x = (x << 8n) | BigInt(view.getUint8(off + i));
    }
  }
  return x;
}

function encodeCompactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return concatBytes(new Uint8Array([0xfd]), writeU16(n, true));
  if (n <= 0xffffffff) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return concatBytes(new Uint8Array([0xfe]), b);
  }
  return concatBytes(new Uint8Array([0xff]), writeU64(n, true));
}

function encodeCompactSizeBigInt(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('Amount must be >= 0');
  if (n < 0xfdn) return new Uint8Array([Number(n)]);
  if (n <= 0xffffn) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    new DataView(buf.buffer).setUint16(1, Number(n), true);
    return buf;
  }
  if (n <= 0xffffffffn) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    new DataView(buf.buffer).setUint32(1, Number(n), true);
    return buf;
  }
  const buf = new Uint8Array(9);
  buf[0] = 0xff;
  new DataView(buf.buffer).setBigUint64(1, n, true);
  return buf;
}

function decodeCompactSize(buf: Uint8Array, off: number): { value: number; size: number } {
  if (off >= buf.length) throw new Error('decodeCompactSize OOB');
  const ch = buf[off];
  if (ch < 0xfd) return { value: ch, size: 1 };
  if (ch === 0xfd) {
    if (off + 3 > buf.length) throw new Error('compactsize 0xfd OOB');
    return { value: new DataView(buf.buffer, buf.byteOffset + off + 1, 2).getUint16(0, true), size: 3 };
  }
  if (ch === 0xfe) {
    if (off + 5 > buf.length) throw new Error('compactsize 0xfe OOB');
    return { value: new DataView(buf.buffer, buf.byteOffset + off + 1, 4).getUint32(0, true), size: 5 };
  }
  if (off + 9 > buf.length) throw new Error('compactsize 0xff OOB');
  const v = readU64(new DataView(buf.buffer, buf.byteOffset + off + 1, 8), 0, true);
  if (v > Number.MAX_SAFE_INTEGER) throw new Error('compactsize 0xff value too large for Number');
  return { value: Number(v), size: 9 };
}

function decodeCompactSizeBigInt(buf: Uint8Array, off: number): { value: bigint; size: number } {
  if (off >= buf.length) throw new Error('decodeCompactSizeBigInt OOB');
  const ch = buf[off];
  if (ch < 0xfd) return { value: BigInt(ch), size: 1 };
  if (ch === 0xfd) {
    if (off + 3 > buf.length) throw new Error('decodeCompactSizeBigInt 0xfd OOB');
    const val = new DataView(buf.buffer, buf.byteOffset + off + 1, 2).getUint16(0, true);
    return { value: BigInt(val), size: 3 };
  }
  if (ch === 0xfe) {
    if (off + 5 > buf.length) throw new Error('decodeCompactSizeBigInt 0xfe OOB');
    const val = new DataView(buf.buffer, buf.byteOffset + off + 1, 4).getUint32(0, true);
    return { value: BigInt(val), size: 5 };
  }
  if (off + 9 > buf.length) throw new Error('decodeCompactSizeBigInt 0xff OOB');
  const val = new DataView(buf.buffer, buf.byteOffset + off + 1, 8).getBigUint64(0, true);
  return { value: val, size: 9 };
}

function encodeVarUint(n: number): Uint8Array {
  return encodeCompactSize(n);
}

function decodeVarUint(buf: Uint8Array, off: number): { value: number; size: number } {
  return decodeCompactSize(buf, off);
}

function encodeTlv(type: number, value: Uint8Array): Uint8Array {
  if (type > 255 || type < 0) throw new Error('TLV type must be a byte');
  return concatBytes(
    new Uint8Array([type]),
    encodeCompactSize(value.length),
    value
  );
}

function encodePushData(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len <= 75) return concatBytes(new Uint8Array([len]), data);
  if (len <= 0xff) return concatBytes(new Uint8Array([0x4c, len]), data);
  if (len <= 0xffff) {
    const l = new Uint8Array(2);
    new DataView(l.buffer).setUint16(0, len, true);
    return concatBytes(new Uint8Array([0x4d]), l, data);
  }
  const l4 = new Uint8Array(4);
  new DataView(l4.buffer).setUint32(0, len, true);
  return concatBytes(new Uint8Array([0x4e]), l4, data);
}

function decodePushData(script: Uint8Array, off: number): { data: Uint8Array; size: number } {
  if (off >= script.length) throw new Error('decodePushData OOB');
  const op = script[off++];
  let len = 0, size = 1;
  if (op <= 75) {
    len = op;
  } else if (op === 0x4c) {
    if (off + 1 > script.length) throw new Error('OP_PUSHDATA1 OOB');
    len = script[off];
    size = 2;
    off++;
  } else if (op === 0x4d) {
    if (off + 2 > script.length) throw new Error('OP_PUSHDATA2 OOB');
    len = new DataView(script.buffer, script.byteOffset + off, 2).getUint16(0, true);
    size = 3;
    off += 2;
  } else if (op === 0x4e) {
    if (off + 4 > script.length) throw new Error('OP_PUSHDATA4 OOB');
    len = new DataView(script.buffer, script.byteOffset + off, 4).getUint32(0, true);
    size = 5;
    off += 4;
  } else {
    throw new Error('Unsupported pushdata opcode: ' + op);
  }
  const start = off;
  const end = off + len;
  if (end > script.length) throw new Error('pushdata length OOB');
  return { data: script.slice(start, end), size: size + len };
}

// ---------------- ENCODING ----------------

export function encodeAssetId({ txidHex, gidx }: AssetId): Uint8Array {
  let tx = hexToBytes(txidHex);
  if (tx.length !== 32) throw new Error('txid must be 32 bytes');
  if (Config.txidLE) tx = new Uint8Array(reverseBytes(tx));
  const g = writeU16(gidx, Config.u16LE);
  return concatBytes(tx, g);
}

export function encodeAssetRef(ref: AssetRef): Uint8Array {
  if (typeof ref.txidHex === 'string') {
    return concatBytes(new Uint8Array([0x01]), encodeAssetId(ref as AssetRefById));
  }
  if (ref.txidHex === undefined) {
    return concatBytes(new Uint8Array([0x02]), writeU16(ref.gidx, Config.u16LE));
  }
  throw new Error('Unrecognized control ref shape; expected {txidHex,gidx} or {gidx}');
}

export function encodeMetadataMap(map: MetadataMap): Uint8Array {
  const keys = Object.keys(map);
  const bufs: Uint8Array[] = [encodeVarUint(keys.length)];
  for (const key of keys) {
    bufs.push(encodeVarString(key));
    bufs.push(encodeVarString(map[key]));
  }
  return concatBytes(...bufs);
}

function encodeAssetInput(input: AssetInput): Uint8Array {
  if (input.type === 'LOCAL') {
    // Format: type(1) + index(2, LE) + varint(amt)
    const typeBuf = new Uint8Array([0x01]);
    const indexBuf = writeU16(input.i, Config.u16LE);
    const amtBuf = encodeCompactSizeBigInt(BigInt(input.amt));
    return concatBytes(typeBuf, indexBuf, amtBuf);
  } else if (input.type === 'INTENT') {
    // Format: type(1) + txid(32) + o(2, LE) + varint(amt)
    const typeBuf = new Uint8Array([0x02]);
    const txidBuf = hexToBytes(input.txid);
    const indexBuf = writeU16(input.o, Config.u16LE);
    const amtBuf = encodeCompactSizeBigInt(BigInt(input.amt));
    return concatBytes(typeBuf, txidBuf, indexBuf, amtBuf);
  }
  throw new Error(`Unknown input type: ${(input as any).type}`);
}

function encodeAssetOutput(output: AssetOutput): Uint8Array {
  // Only LOCAL outputs now - format: type(1) + index(2, LE) + varint(amt)
  const typeBuf = new Uint8Array([0x01]);
  const indexBuf = writeU16(output.o, Config.u16LE);
  const amtBuf = encodeCompactSizeBigInt(BigInt(output.amt));
  return concatBytes(typeBuf, indexBuf, amtBuf);
}

export function encodeIssuance(issuance: Issuance): Uint8Array {
  const byteList: Uint8Array[] = [];
  let presence = 0;
  if (issuance.controlAsset) presence |= 1;
  if (issuance.metadata) presence |= 2;
  if (issuance.immutable) presence |= 4;
  byteList.push(new Uint8Array([presence]));
  if (issuance.controlAsset) byteList.push(encodeAssetRef(issuance.controlAsset));
  if (issuance.metadata) byteList.push(encodeMetadataMap(issuance.metadata));
  return concatBytes(...byteList);
}

export function encodeGroup(group: Group): Uint8Array {
  const byteList: Uint8Array[] = [];
  if (Config.usePresenceByte) {
    let presence = 0;
    if (group.assetId) presence |= 1;
    if (group.issuance) presence |= 2;
    if (group.metadata) presence |= 4;
    byteList.push(new Uint8Array([presence]));
    if (group.assetId) byteList.push(encodeAssetId(group.assetId));
    if (group.issuance) byteList.push(encodeIssuance(group.issuance));
    if (group.metadata) byteList.push(encodeMetadataMap(group.metadata));
  } else {
    throw new Error('Implement your canonical TLV tagging here.');
  }

  // Input/output counts as separate varints
  byteList.push(encodeVarUint(group.inputs.length));
  byteList.push(encodeVarUint(group.outputs.length));

  for (const inp of group.inputs) byteList.push(encodeAssetInput(inp));
  for (const out of group.outputs) byteList.push(encodeAssetOutput(out));
  return concatBytes(...byteList);
}

export function encodePacket(packet: Packet): Uint8Array {
  const groups = packet.groups || [];
  const groupParts: Uint8Array[] = [encodeVarUint(groups.length)];
  for (const g of groups) groupParts.push(encodeGroup(g));
  return concatBytes(...groupParts);
}

export function buildOpReturnPayload(packet: Packet): Uint8Array {
  const magic = hexToBytes('41524b'); // "ARK"
  const assetPayload = encodePacket(packet);
  // Type 0x00 is self-delimiting (no length field)
  return concatBytes(magic, new Uint8Array([0x00]), assetPayload);
}

export function buildOpReturnScript(packet: Packet): Uint8Array {
  const fullPayload = buildOpReturnPayload(packet);
  const opReturn = new Uint8Array([0x6a]);
  const push = encodePushData(fullPayload);
  return concatBytes(opReturn, push);
}

function decodeTlvStream(buf: Uint8Array, off: number): { records: { type: number, value: Uint8Array }[], next: number } {
  let cursor = off;
  const records: { type: number, value: Uint8Array }[] = [];
  while (cursor < buf.length) {
    const type = buf[cursor];
    cursor += 1;
    if (type <= 0x3f) {
      // Self-delimiting: rest of buffer is the payload
      const value = buf.slice(cursor);
      cursor = buf.length;
      records.push({ type, value });
    } else {
      // 0x40-0xFF: length-prefixed
      const lenResult = decodeCompactSize(buf, cursor);
      cursor += lenResult.size;
      const value = buf.slice(cursor, cursor + lenResult.value);
      cursor += lenResult.value;
      records.push({ type, value });
    }
  }
  return { records, next: cursor };
}

// ---------------- DECODING ----------------

export function decodeMetadataMap(buf: Uint8Array, off: number): { map: MetadataMap; next: number } {
  const vCount = decodeVarUint(buf, off);
  let cursor = off + vCount.size;
  const map: MetadataMap = {};
  for (let i = 0; i < vCount.value; i++) {
    const rKey = decodeVarString(buf, cursor);
    cursor = rKey.next;
    const rVal = decodeVarString(buf, cursor);
    cursor = rVal.next;
    map[rKey.str] = rVal.str;
  }
  return { map, next: cursor };
}

export function decodeAssetId(buf: Uint8Array, off: number): { assetid: AssetId; next: number } {
  if (off + 34 > buf.length) throw new Error('decodeAssetId OOB');
  let tx = buf.slice(off, off + 32);
  if (Config.txidLE) tx = new Uint8Array(reverseBytes(tx));
  const view = new DataView(buf.buffer, buf.byteOffset + off + 32, 2);
  const gidx = view.getUint16(0, Config.u16LE);
  return { assetid: { txidHex: bytesToHex(tx), gidx }, next: off + 34 };
}

export function decodeAssetRef(buf: Uint8Array, off: number): { ref: AssetRef; next: number } {
  if (off >= buf.length) throw new Error('decodeAssetRef OOB');
  const tag = buf[off];
  if (tag === 0x01) {
    const { assetid, next } = decodeAssetId(buf, off + 1);
    return { ref: { ...assetid }, next };
  } else if (tag === 0x02) {
    if (off + 3 > buf.length) throw new Error('decodeAssetRef BY_GROUP OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off + 1, 2);
    const gidx = view.getUint16(0, Config.u16LE);
    return { ref: { gidx }, next: off + 3 };
  }
  throw new Error('Unknown AssetRef tag: ' + tag);
}

function decodeAssetInput(buf: Uint8Array, off: number): { input: AssetInput; next: number } {
  if (off >= buf.length) throw new Error('decodeAssetInput OOB');
  const inputType = buf[off];
  if (inputType === 0x01) { // LOCAL
    if (off + 3 > buf.length) throw new Error('decodeAssetInput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 3);
    const i = view.getUint16(1, Config.u16LE);
    const amtResult = decodeCompactSizeBigInt(buf, off + 3);
    return { input: { type: 'LOCAL', i, amt: amtResult.value.toString() }, next: off + 3 + amtResult.size };
  } else if (inputType === 0x02) { // INTENT
    // Format: type(1) + txid(32) + o(2, LE) + varint(amt)
    if (off + 35 > buf.length) throw new Error('decodeAssetInput INTENT OOB');
    const txid = bytesToHex(buf.slice(off + 1, off + 33));
    const view = new DataView(buf.buffer, buf.byteOffset + off + 33, 2);
    const o = view.getUint16(0, Config.u16LE);
    const amtResult = decodeCompactSizeBigInt(buf, off + 35);
    return { input: { type: 'INTENT', txid, o, amt: amtResult.value.toString() }, next: off + 35 + amtResult.size };
  }
  throw new Error(`Unknown input type: ${inputType}`);
}

function decodeAssetOutput(buf: Uint8Array, off: number): { output: AssetOutput; next: number } {
  // Only LOCAL outputs - format: type(1) + index(2, LE) + varint(amt)
  // Note: We still read the type byte for forward compatibility
  if (off >= buf.length) throw new Error('decodeAssetOutput OOB');
  const outputType = buf[off];
  if (outputType === 0x01) { // LOCAL
    if (off + 3 > buf.length) throw new Error('decodeAssetOutput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 3);
    const o = view.getUint16(1, Config.u16LE);
    const amtResult = decodeCompactSizeBigInt(buf, off + 3);
    return { output: { type: 'LOCAL', o, amt: amtResult.value.toString() }, next: off + 3 + amtResult.size };
  }
  throw new Error(`Unknown output type: ${outputType}`);
}

export function decodeIssuance(buf: Uint8Array, off: number): { issuance: Issuance; next: number } {
    if (off >= buf.length) throw new Error('decodeIssuance OOB');
    let cursor = off;
    const presence = buf[cursor++];
    const issuance: Issuance = {};
    if (presence & 1) { const r = decodeAssetRef(buf, cursor); issuance.controlAsset = r.ref; cursor = r.next; }
    if (presence & 2) { const r = decodeMetadataMap(buf, cursor); issuance.metadata = r.map; cursor = r.next; }
    if (presence & 4) { issuance.immutable = true; }
    return { issuance, next: cursor };
}

export function decodeGroup(buf: Uint8Array, off: number): { group: Group; next: number } {
  if (!Config.usePresenceByte) throw new Error('Implement TLV tagging decode.');
  if (off >= buf.length) throw new Error('decodeGroup OOB');
  let cursor = off;
  const presence = buf[cursor++];
  const group: Group = { inputs: [], outputs: [] };
  if (presence & 1) { const r = decodeAssetId(buf, cursor); group.assetId = r.assetid; cursor = r.next; }
  if (presence & 2) { const r = decodeIssuance(buf, cursor); group.issuance = r.issuance; cursor = r.next; }
  if (presence & 4) { const r = decodeMetadataMap(buf, cursor); group.metadata = r.map; cursor = r.next; }

  // Decode input/output counts as separate varints
  const vinCount = decodeVarUint(buf, cursor);
  cursor += vinCount.size;
  const inCount = vinCount.value;
  const voutCount = decodeVarUint(buf, cursor);
  cursor += voutCount.size;
  const outCount = voutCount.value;

  for (let k = 0; k < inCount; k++) { const r = decodeAssetInput(buf, cursor); group.inputs.push(r.input); cursor = r.next; }
  for (let k = 0; k < outCount; k++) { const r = decodeAssetOutput(buf, cursor); group.outputs.push(r.output); cursor = r.next; }

  return { group, next: cursor };
}

export function decodePacket(buf: Uint8Array, off = 0): { groups: Group[]; next: number } {
  const vGroups = decodeVarUint(buf, off);
  let cursor = off + vGroups.size;
  const groups: Group[] = [];
  for (let i = 0; i < vGroups.value; i++) {
    const r = decodeGroup(buf, cursor);
    groups.push(r.group);
    cursor = r.next;
  }
  return { groups, next: cursor };
}

export function parseOpReturnScript(buf: Uint8Array): Packet | null {
  if (buf.length < 2 || buf[0] !== 0x6a) return null;

  try {
    const { data } = decodePushData(buf, 1);
    const magic = hexToBytes('41524b'); // "ARK"

    if (data.length < magic.length || !bytesEqual(data.slice(0, magic.length), magic)) {
      return null; // Not an ARK packet
    }

    const { records } = decodeTlvStream(data, magic.length);
    const assetRecord = records.find(r => r.type === 0x00);

    if (!assetRecord) {
      // This is an ARK packet but contains no asset data (e.g., for another protocol using the same magic).
      // For our purposes, it's like there's no packet.
      return { groups: [] };
    }

    const { groups } = decodePacket(assetRecord.value, 0);
    return { groups };

  } catch (e) {
    // Decoding error, treat as not a valid packet.
    console.error('Error parsing OP_RETURN script:', e);
    return null;
  }
}

// ----------------- MERKLE TREE (BIP-341-aligned) -----------------

/**
 * SHA256 primitive. Uses @noble/hashes if available, otherwise Node.js crypto.
 */
let sha256Sync: (data: Uint8Array) => Uint8Array;

try {
  const { sha256 } = require('@noble/hashes/sha256');
  sha256Sync = sha256;
} catch {
  try {
    const crypto = require('crypto');
    sha256Sync = (data: Uint8Array): Uint8Array => {
      const hash = crypto.createHash('sha256');
      hash.update(data);
      return new Uint8Array(hash.digest());
    };
  } catch {
    sha256Sync = (_: Uint8Array): Uint8Array => {
      throw new Error('No SHA256 implementation available. Install @noble/hashes or use Node.js.');
    };
  }
}

/**
 * Tagged hash as defined by BIP-341:
 *   tagged_hash(tag, msg) = SHA256(SHA256(tag) || SHA256(tag) || msg)
 *
 * Domain-separates different uses of SHA256 so that leaf hashes, branch hashes,
 * and tweaks can never collide across contexts.
 */
const tagHashCache = new Map<string, Uint8Array>();

export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  let tagHash = tagHashCache.get(tag);
  if (!tagHash) {
    tagHash = sha256Sync(textEncoder.encode(tag));
    tagHashCache.set(tag, tagHash);
  }
  return sha256Sync(concatBytes(tagHash, tagHash, msg));
}

/** Leaf version for Arkade metadata key-value entries. */
export const ARK_LEAF_VERSION = 0x00;

/**
 * Computes the leaf hash for a single metadata key-value pair.
 * Follows the Taproot leaf pattern with an Arkade-specific tag:
 *
 *   leaf = tagged_hash("ArkadeAssetLeaf", leaf_version || varuint(len(key)) || key || varuint(len(value)) || value)
 *
 * - "ArkadeAssetLeaf" tag provides domain separation from TapLeaf and other tree types
 * - leaf_version (1 byte, currently 0x00) allows future metadata encoding changes
 */
export function computeMetadataLeafHash(key: string, value: string): Uint8Array {
  const keyBytes = textEncoder.encode(key);
  const valueBytes = textEncoder.encode(value);
  const data = concatBytes(
    new Uint8Array([ARK_LEAF_VERSION]),
    encodeVarUint(keyBytes.length),
    keyBytes,
    encodeVarUint(valueBytes.length),
    valueBytes
  );
  return taggedHash('ArkadeAssetLeaf', data);
}

/**
 * Computes a branch hash following the BIP-341 construction pattern:
 *
 *   branch = tagged_hash("ArkadeAssetBranch", min(a, b) || max(a, b))
 *
 * Children are lexicographically sorted so that proofs don't need direction bits.
 * Uses "ArkadeAssetBranch" for domain separation from Taproot's "TapBranch". The
 * generalized OP_MERKLEPATHVERIFY opcode accepts the branch tag as a parameter,
 * so both Taproot and Arkade trees are supported without hardcoding tags.
 */
export function computeBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  // Lexicographic comparison — smaller hash comes first
  let first = a, second = b;
  for (let i = 0; i < 32; i++) {
    if (a[i] < b[i]) break;
    if (a[i] > b[i]) { first = b; second = a; break; }
  }
  return taggedHash('ArkadeAssetBranch', concatBytes(first, second));
}

/**
 * Computes the Merkle root of a metadata map.
 * Keys are sorted lexicographically before hashing.
 *
 * Tree construction:
 * - Leaves: tagged_hash("ArkadeAssetLeaf", version || encoded_entry)
 * - Branches: tagged_hash("ArkadeAssetBranch", sorted(left, right))
 * - Odd leaf at any level: promoted to next level (unpaired)
 */
export function computeMetadataMerkleRoot(metadata: MetadataMap): Uint8Array {
  const keys = Object.keys(metadata).sort();

  if (keys.length === 0) {
    return taggedHash('ArkadeAssetLeaf', new Uint8Array([ARK_LEAF_VERSION]));
  }

  // Compute leaf hashes
  let nodes = keys.map(key => computeMetadataLeafHash(key, metadata[key]));

  // Build tree bottom-up using ArkadeAssetBranch for internal nodes
  while (nodes.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 < nodes.length) {
        nextLevel.push(computeBranchHash(nodes[i], nodes[i + 1]));
      } else {
        // Odd node — promote to next level
        nextLevel.push(nodes[i]);
      }
    }
    nodes = nextLevel;
  }

  return nodes[0];
}

/**
 * Computes the Merkle root and returns it as a hex string.
 */
export function computeMetadataMerkleRootHex(metadata: MetadataMap): string {
  return bytesToHex(computeMetadataMerkleRoot(metadata));
}

/**
 * Computes a Merkle inclusion proof for a specific key in a metadata map.
 * Returns the list of 32-byte sibling hashes from leaf to root.
 * Returns null if the key is not present in the metadata.
 *
 * To verify: start with computeMetadataLeafHash(key, value), then for each
 * sibling in the proof, call computeBranchHash(current, sibling). The final
 * result should equal the Merkle root.
 */
export function computeMetadataMerkleProof(metadata: MetadataMap, targetKey: string): Uint8Array[] | null {
  const keys = Object.keys(metadata).sort();
  const targetIndex = keys.indexOf(targetKey);
  if (targetIndex === -1) return null;

  // Compute all leaf hashes
  let nodes = keys.map(key => computeMetadataLeafHash(key, metadata[key]));

  const proof: Uint8Array[] = [];
  let idx = targetIndex;

  // Walk up the tree, collecting siblings
  while (nodes.length > 1) {
    const nextLevel: Uint8Array[] = [];
    let nextIdx = -1;

    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 < nodes.length) {
        // Paired node — record sibling if this pair contains our target
        if (i === idx) {
          proof.push(nodes[i + 1]);
          nextIdx = nextLevel.length;
        } else if (i + 1 === idx) {
          proof.push(nodes[i]);
          nextIdx = nextLevel.length;
        }
        nextLevel.push(computeBranchHash(nodes[i], nodes[i + 1]));
      } else {
        // Odd node — promoted, no sibling
        if (i === idx) {
          nextIdx = nextLevel.length;
        }
        nextLevel.push(nodes[i]);
      }
    }

    nodes = nextLevel;
    idx = nextIdx;
  }

  return proof;
}

/**
 * Verifies a Merkle inclusion proof against an expected root.
 * This is the algorithm a generalized OP_MERKLEPATHVERIFY would execute.
 *
 * Uses tagged_hash("ArkadeAssetBranch", sorted(a, b)) at every level.
 * The caller precomputes the leaf hash.
 */
export function verifyMerkleProof(leafHash: Uint8Array, proof: Uint8Array[], expectedRoot: Uint8Array): boolean {
  let current = leafHash;
  for (const sibling of proof) {
    current = computeBranchHash(current, sibling);
  }
  return bytesEqual(current, expectedRoot);
}

