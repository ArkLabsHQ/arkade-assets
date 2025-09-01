// tools/arkass-codec.ts
// Encoding and decoding helpers for ArkAssetV1 OP_RETURN payloads and scriptPubKey.

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

export interface AssetInputTeleport {
  type: 'TELEPORT';
  commitment: string;
  amt: string | bigint;
}

export type AssetInput = AssetInputLocal | AssetInputTeleport;

export interface AssetOutputLocal {
  type: 'LOCAL';
  o: number;
  amt: string | bigint;
}

export interface AssetOutputTeleport {
  type: 'TELEPORT';
  commitment: string;
  amt: string | bigint;
}

export type AssetOutput = AssetOutputLocal | AssetOutputTeleport;

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

export interface Fungible {
  commitment: string;
  amt: bigint;
}

export interface Nft {
  commitment: string;
  amt: bigint;
}

// ----------------- CONFIG -----------------

export const Config: ConfigType = {
  u16LE: true,
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

function encodeVarUint(n: number): Uint8Array {
  return encodeCompactSize(n);
}

function decodeVarUint(buf: Uint8Array, off: number): { value: number; size: number } {
  return decodeCompactSize(buf, off);
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
    const buf = new Uint8Array(11);
    buf[0] = 0x01;
    new DataView(buf.buffer).setUint16(1, input.i, true);
    new DataView(buf.buffer).setBigUint64(3, BigInt(input.amt), true);
    return buf;
  } else if (input.type === 'TELEPORT') {
    const buf = new Uint8Array(41);
    buf[0] = 0x02;
    buf.set(hexToBytes(input.commitment), 1);
    new DataView(buf.buffer).setBigUint64(33, BigInt(input.amt), true);
    return buf;
  }
  throw new Error(`Unknown input type: ${(input as any).type}`);
}

function encodeAssetOutput(output: AssetOutput): Uint8Array {
  if (output.type === 'LOCAL') {
    const buf = new Uint8Array(11);
    buf[0] = 0x01;
    new DataView(buf.buffer).setUint16(1, output.o, true);
    new DataView(buf.buffer).setBigUint64(3, BigInt(output.amt), true);
    return buf;
  } else if (output.type === 'TELEPORT') {
    const buf = new Uint8Array(41);
    buf[0] = 0x02;
    buf.set(hexToBytes(output.commitment), 1);
    new DataView(buf.buffer).setBigUint64(33, BigInt(output.amt), true);
    return buf;
  }
  throw new Error(`Unknown output type: ${(output as any).type}`);
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
  byteList.push(encodeVarUint(group.inputs.length));
  for (const inp of group.inputs) byteList.push(encodeAssetInput(inp));
  byteList.push(encodeVarUint(group.outputs.length));
  for (const out of group.outputs) byteList.push(encodeAssetOutput(out));
  return concatBytes(...byteList);
}

export function encodePacket(packet: Packet): Uint8Array {
  const groups = packet.groups || [];
  const groupParts: Uint8Array[] = [encodeVarUint(groups.length)];
  for (const g of groups) groupParts.push(encodeGroup(g));
  return concatBytes(...groupParts);
}

export function buildArkassPayload(payload: Packet): Uint8Array {
  const magic = new TextEncoder().encode('ARKASS');
  const body = encodePacket(payload);
  return concatBytes(magic, body);
}

export function buildOpReturnScript(payload: Packet): Uint8Array {
  const fullPayload = buildArkassPayload(payload);
  const opReturn = new Uint8Array([0x6a]);
  const push = encodePushData(fullPayload);
  return concatBytes(opReturn, push);
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

export function decodeFungible(buf: Uint8Array, off: number): { fungible: Fungible; next: number } {
  if (off + 41 > buf.length) throw new Error('decodeFungible OOB');
  const commitment = bytesToHex(buf.slice(off + 1, off + 33));
  const view = new DataView(buf.buffer, buf.byteOffset + off);
  const amt = view.getBigUint64(33, Config.u64LE);
  return { fungible: { commitment, amt }, next: off + 41 };
}

export function decodeNft(buf: Uint8Array, off: number): { nft: Nft; next: number } {
  if (off + 41 > buf.length) throw new Error('decodeNft OOB');
  const commitment = bytesToHex(buf.slice(off + 1, off + 33));
  const view = new DataView(buf.buffer, buf.byteOffset + off);
  const amt = view.getBigUint64(33, Config.u64LE);
  return { nft: { commitment, amt }, next: off + 41 };
}

function decodeAssetInput(buf: Uint8Array, off: number): { input: AssetInput; next: number } {
  if (off >= buf.length) throw new Error('decodeAssetInput OOB');
  const inputType = buf[off];
  if (inputType === 0x01) { // LOCAL
    if (off + 11 > buf.length) throw new Error('decodeAssetInput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 11);
    const i = view.getUint16(1, Config.u16LE);
    const amt = view.getBigUint64(3, Config.u64LE);
    return { input: { type: 'LOCAL', i, amt: amt.toString() }, next: off + 11 };
  } else if (inputType === 0x02) { // TELEPORT
    if (off + 41 > buf.length) throw new Error('decodeAssetInput TELEPORT OOB');
    const commitment = bytesToHex(buf.slice(off + 1, off + 33));
    const view = new DataView(buf.buffer, buf.byteOffset + off);
    const amt = view.getBigUint64(33, Config.u64LE);
    return { input: { type: 'TELEPORT', commitment, amt: amt.toString() }, next: off + 41 };
  }
  throw new Error(`Unknown input type: ${inputType}`);
}

function decodeAssetOutput(buf: Uint8Array, off: number): { output: AssetOutput; next: number } {
  if (off >= buf.length) throw new Error('decodeAssetOutput OOB');
  const outputType = buf[off];
  if (outputType === 0x01) { // LOCAL
    if (off + 11 > buf.length) throw new Error('decodeAssetOutput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 11);
    const o = view.getUint16(1, Config.u16LE);
    const amt = view.getBigUint64(3, Config.u64LE);
    return { output: { type: 'LOCAL', o, amt: amt.toString() }, next: off + 11 };
  } else if (outputType === 0x02) { // TELEPORT
    if (off + 41 > buf.length) throw new Error('decodeAssetOutput TELEPORT OOB');
    const commitment = bytesToHex(buf.slice(off + 1, off + 33));
    const view = new DataView(buf.buffer, buf.byteOffset + off);
    const amt = view.getBigUint64(33, Config.u64LE);
    return { output: { type: 'TELEPORT', commitment, amt: amt.toString() }, next: off + 41 };
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

  const vin = decodeVarUint(buf, cursor);
  cursor += vin.size;
  for (let k = 0; k < vin.value; k++) { const r = decodeAssetInput(buf, cursor); group.inputs.push(r.input); cursor = r.next; }

  const vout = decodeVarUint(buf, cursor);
  cursor += vout.size;
  for (let k = 0; k < vout.value; k++) { const r = decodeAssetOutput(buf, cursor); group.outputs.push(r.output); cursor = r.next; }

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

export function parseArkassPayload(payload: Uint8Array): Packet {
  const magic = new TextEncoder().encode('ARKASS');
  if (payload.length < magic.length) throw new Error('payload too short');
    if (!bytesEqual(payload.slice(0, magic.length), magic)) throw new Error('magic mismatch');
  let cursor = magic.length;
  const { groups } = decodePacket(payload, cursor);
  return { groups };
}

export function parseOpReturnScript(buf: Uint8Array): Packet {
  if (buf.length < 2) throw new Error('script too short');
  if (buf[0] !== 0x6a) throw new Error('not an OP_RETURN script');
  const { data } = decodePushData(buf, 1);
  return parseArkassPayload(data);
}
