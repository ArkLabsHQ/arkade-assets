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

export interface TeleportWitness {
  paymentScript: string;  // hex
  nonce: string;          // hex
}

export interface AssetInputTeleport {
  type: 'TELEPORT';
  amt: string | bigint;
  witness: TeleportWitness;  // Required - commitment derived as sha256(paymentScript || nonce)
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

/**
 * Encodes a TeleportWitness in length-prefixed format:
 * varint(script_len) || payment_script || varint(nonce_len) || nonce
 */
export function encodeTeleportWitness(witness: TeleportWitness): Uint8Array {
  const scriptBytes = hexToBytes(witness.paymentScript);
  const nonceBytes = hexToBytes(witness.nonce);

  if (nonceBytes.length > 32) {
    throw new Error('Teleport nonce must be at most 32 bytes');
  }

  return concatBytes(
    encodeVarUint(scriptBytes.length),
    scriptBytes,
    encodeVarUint(nonceBytes.length),
    nonceBytes
  );
}

/**
 * Decodes a TeleportWitness from length-prefixed format.
 */
export function decodeTeleportWitness(buf: Uint8Array, off: number): { witness: TeleportWitness; next: number } {
  let cursor = off;

  // Decode script length and script
  const scriptLen = decodeVarUint(buf, cursor);
  cursor += scriptLen.size;
  const scriptBytes = buf.slice(cursor, cursor + scriptLen.value);
  cursor += scriptLen.value;

  // Decode nonce length and nonce
  const nonceLen = decodeVarUint(buf, cursor);
  cursor += nonceLen.size;
  const nonceBytes = buf.slice(cursor, cursor + nonceLen.value);
  cursor += nonceLen.value;

  return {
    witness: {
      paymentScript: bytesToHex(scriptBytes),
      nonce: bytesToHex(nonceBytes)
    },
    next: cursor
  };
}

function encodeAssetInput(input: AssetInput): Uint8Array {
  if (input.type === 'LOCAL') {
    // Format: type(1) + index(2) + varint(amt) - variable length
    const typeBuf = new Uint8Array([0x01]);
    const indexBuf = writeU16(input.i, true);
    const amtBuf = encodeCompactSizeBigInt(BigInt(input.amt));
    return concatBytes(typeBuf, indexBuf, amtBuf);
  } else if (input.type === 'TELEPORT') {
    // Format: type(1) + varint(amt) + witness(variable)
    // Commitment is derived from witness as sha256(paymentScript || nonce)
    const typeBuf = new Uint8Array([0x02]);
    const amtBuf = encodeCompactSizeBigInt(BigInt(input.amt));
    const witnessBuf = encodeTeleportWitness(input.witness);
    return concatBytes(typeBuf, amtBuf, witnessBuf);
  }
  throw new Error(`Unknown input type: ${(input as any).type}`);
}

function encodeAssetOutput(output: AssetOutput): Uint8Array {
  if (output.type === 'LOCAL') {
    // Format: type(1) + index(2) + varint(amt) - variable length
    const typeBuf = new Uint8Array([0x01]);
    const indexBuf = writeU16(output.o, true);
    const amtBuf = encodeCompactSizeBigInt(BigInt(output.amt));
    return concatBytes(typeBuf, indexBuf, amtBuf);
  } else if (output.type === 'TELEPORT') {
    // Format: type(1) + commitment(32) + varint(amt) - variable length
    const typeBuf = new Uint8Array([0x02]);
    const commitmentBuf = hexToBytes(output.commitment);
    const amtBuf = encodeCompactSizeBigInt(BigInt(output.amt));
    return concatBytes(typeBuf, commitmentBuf, amtBuf);
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

  // Packed counts encoding
  const inCount = group.inputs.length;
  const outCount = group.outputs.length;
  const packed = (inCount << 4) | outCount;
  if (inCount <= 15 && outCount <= 15 && packed !== 0xff) {
    // Pack into single byte: high nibble = inputs, low nibble = outputs
    // Note: 0xFF is reserved as escape byte, so (15, 15) uses escape format
    byteList.push(new Uint8Array([packed]));
  } else {
    // Escape byte + two varints
    byteList.push(new Uint8Array([0xff]));
    byteList.push(encodeVarUint(inCount));
    byteList.push(encodeVarUint(outCount));
  }

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
    if (off + 3 > buf.length) throw new Error('decodeAssetInput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 3);
    const i = view.getUint16(1, Config.u16LE);
    const amtResult = decodeCompactSizeBigInt(buf, off + 3);
    return { input: { type: 'LOCAL', i, amt: amtResult.value.toString() }, next: off + 3 + amtResult.size };
  } else if (inputType === 0x02) { // TELEPORT
    const amtResult = decodeCompactSizeBigInt(buf, off + 1);
    const { witness, next } = decodeTeleportWitness(buf, off + 1 + amtResult.size);
    return { input: { type: 'TELEPORT', amt: amtResult.value.toString(), witness }, next };
  }
  throw new Error(`Unknown input type: ${inputType}`);
}

function decodeAssetOutput(buf: Uint8Array, off: number): { output: AssetOutput; next: number } {
  if (off >= buf.length) throw new Error('decodeAssetOutput OOB');
  const outputType = buf[off];
  if (outputType === 0x01) { // LOCAL
    if (off + 3 > buf.length) throw new Error('decodeAssetOutput LOCAL OOB');
    const view = new DataView(buf.buffer, buf.byteOffset + off, 3);
    const o = view.getUint16(1, Config.u16LE);
    const amtResult = decodeCompactSizeBigInt(buf, off + 3);
    return { output: { type: 'LOCAL', o, amt: amtResult.value.toString() }, next: off + 3 + amtResult.size };
  } else if (outputType === 0x02) { // TELEPORT
    if (off + 33 > buf.length) throw new Error('decodeAssetOutput TELEPORT OOB');
    const commitment = bytesToHex(buf.slice(off + 1, off + 33));
    const amtResult = decodeCompactSizeBigInt(buf, off + 33);
    return { output: { type: 'TELEPORT', commitment, amt: amtResult.value.toString() }, next: off + 33 + amtResult.size };
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

  // Decode packed counts
  if (cursor >= buf.length) throw new Error('decodeGroup counts OOB');
  let inCount: number, outCount: number;
  const countsByte = buf[cursor];
  if (countsByte === 0xff) {
    // Escape: two separate varints
    cursor += 1;
    const vinCount = decodeVarUint(buf, cursor);
    cursor += vinCount.size;
    inCount = vinCount.value;
    const voutCount = decodeVarUint(buf, cursor);
    cursor += voutCount.size;
    outCount = voutCount.value;
  } else {
    // Packed: high nibble = inputs, low nibble = outputs
    inCount = (countsByte >> 4) & 0x0f;
    outCount = countsByte & 0x0f;
    cursor += 1;
  }

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

// ----------------- METADATA MERKLE HASH -----------------

/**
 * Computes a SHA256 hash using the Web Crypto API (browser) or Node.js crypto.
 * For synchronous use in Node.js, we use a simple implementation.
 */
let sha256Sync: (data: Uint8Array) => Uint8Array;

// Try to use @noble/hashes if available, otherwise fall back to a simple implementation
try {
  // Dynamic import for @noble/hashes
  const { sha256 } = require('@noble/hashes/sha256');
  sha256Sync = sha256;
} catch {
  // Fallback: use Node.js crypto if available
  try {
    const crypto = require('crypto');
    sha256Sync = (data: Uint8Array): Uint8Array => {
      const hash = crypto.createHash('sha256');
      hash.update(data);
      return new Uint8Array(hash.digest());
    };
  } catch {
    // No crypto available - will throw at runtime if used
    sha256Sync = (_: Uint8Array): Uint8Array => {
      throw new Error('No SHA256 implementation available. Install @noble/hashes or use Node.js.');
    };
  }
}

/**
 * Computes the leaf hash for a single metadata key-value pair.
 * leaf = sha256(varuint(len(key)) || key || varuint(len(value)) || value)
 */
export function computeMetadataLeafHash(key: string, value: string): Uint8Array {
  const keyBytes = textEncoder.encode(key);
  const valueBytes = textEncoder.encode(value);
  const data = concatBytes(
    encodeVarUint(keyBytes.length),
    keyBytes,
    encodeVarUint(valueBytes.length),
    valueBytes
  );
  return sha256Sync(data);
}

/**
 * Computes the Merkle root of a metadata map.
 * Keys are sorted lexicographically before hashing.
 * Returns a 32-byte hash.
 */
export function computeMetadataMerkleRoot(metadata: MetadataMap): Uint8Array {
  const keys = Object.keys(metadata).sort();

  if (keys.length === 0) {
    // Empty metadata - return hash of empty string
    return sha256Sync(new Uint8Array(0));
  }

  // Compute leaf hashes
  let leaves = keys.map(key => computeMetadataLeafHash(key, metadata[key]));

  // Build Merkle tree
  while (leaves.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < leaves.length; i += 2) {
      if (i + 1 < leaves.length) {
        // Hash pair
        nextLevel.push(sha256Sync(concatBytes(leaves[i], leaves[i + 1])));
      } else {
        // Odd leaf - promote to next level
        nextLevel.push(leaves[i]);
      }
    }
    leaves = nextLevel;
  }

  return leaves[0];
}

/**
 * Computes the Merkle root and returns it as a hex string.
 */
export function computeMetadataMerkleRootHex(metadata: MetadataMap): string {
  return bytesToHex(computeMetadataMerkleRoot(metadata));
}

// ----------------- TELEPORT COMMITMENT -----------------

/**
 * Computes a teleport commitment hash.
 * commitment = sha256(payment_script || nonce)
 * @param paymentScript - The payment script as bytes
 * @param nonce - Nonce (up to 32 bytes)
 */
export function computeTeleportCommitment(paymentScript: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length > 32) {
    throw new Error('Teleport nonce must be at most 32 bytes');
  }
  return sha256Sync(concatBytes(paymentScript, nonce));
}

/**
 * Computes a teleport commitment and returns it as a hex string.
 */
export function computeTeleportCommitmentHex(paymentScript: Uint8Array, nonce: Uint8Array): string {
  return bytesToHex(computeTeleportCommitment(paymentScript, nonce));
}

/**
 * Verifies a teleport commitment against the provided preimage.
 */
export function verifyTeleportCommitment(
  commitment: Uint8Array,
  paymentScript: Uint8Array,
  nonce: Uint8Array
): boolean {
  const computed = computeTeleportCommitment(paymentScript, nonce);
  return bytesEqual(commitment, computed);
}

/**
 * Gets the commitment hash from a TeleportWitness.
 * commitment = sha256(paymentScript || nonce)
 */
export function getWitnessCommitment(witness: TeleportWitness): string {
  const scriptBytes = hexToBytes(witness.paymentScript);
  const nonceBytes = hexToBytes(witness.nonce);
  return computeTeleportCommitmentHex(scriptBytes, nonceBytes);
}

/**
 * Gets the commitment hash from a TELEPORT input.
 */
export function getTeleportInputCommitment(input: AssetInputTeleport): string {
  return getWitnessCommitment(input.witness);
}
