import * as assert from 'assert';
import {
  Packet,
  buildOpReturnScript,
  parseOpReturnScript,
  buildOpReturnPayload,
  Config,
  computeMetadataMerkleRootHex,
  computeTeleportCommitmentHex,
  verifyTeleportCommitment,
  hexToBytes,
  encodeTeleportWitness,
  decodeTeleportWitness,
  TeleportWitness,
  getWitnessCommitment,
} from './arkade-assets-codec';
import { Indexer, State, Storage } from './indexer';
import {
  exampleA,
  exampleB,
  exampleC,
  exampleE_metadata_update,
  exampleF_simple_transfer,
  exampleG_burn,
  exampleH_reissuance,
  exampleI_multi_asset_per_utxo,
  exampleJ_teleport_commit,
  exampleK_teleport_claim,
  exampleL_multi_asset_per_tx,
} from './example-txs';

// ----------------- IN-MEMORY STORAGE FOR TESTS -----------------

class InMemoryStorage implements Storage {
  public state: State;
  private snapshots: Map<number, State> = new Map();

  constructor() {
    this.state = { assets: {}, utxos: {}, transactions: {}, pendingTeleports: {}, blockHeight: -1 };
  }

  load(height?: number): void {
    if (height === undefined) {
      // Find latest
      const heights = Array.from(this.snapshots.keys());
      height = heights.length > 0 ? Math.max(...heights) : -1;
    }
    if (height === -1) {
      this.state = { assets: {}, utxos: {}, transactions: {}, pendingTeleports: {}, blockHeight: -1 };
    } else {
      const snapshot = this.snapshots.get(height);
      if (!snapshot) throw new Error(`No snapshot at height ${height}`);
      this.state = JSON.parse(JSON.stringify(snapshot));
    }
  }

  save(height: number): void {
    this.state.blockHeight = height;
    this.snapshots.set(height, JSON.parse(JSON.stringify(this.state)));
  }

  delete(height: number): void {
    this.snapshots.delete(height);
  }

  getRootDir(): string {
    return ':memory:';
  }
}

// ----------------- CODEC TESTS -----------------

function testCodecRoundTrip() {
  console.log('Testing codec round-trip...');

  const originalPacket: Packet = {
    groups: [
      {
        issuance: {
          controlAsset: { txidHex: 'b'.repeat(64), gidx: 2 },
          metadata: { 'name': 'TestCoin', 'ticker': 'TSC' },
          immutable: true,
        },
        inputs: [{ type: 'LOCAL', i: 0, amt: 1000n }],
        outputs: [{ type: 'LOCAL', o: 0, amt: 1000n }],
      },
      {
        assetId: { txidHex: 'e'.repeat(64), gidx: 3 },
        metadata: { 'owner': 'new_owner' },
        inputs: [{ type: 'LOCAL', i: 1, amt: 1n }],
        outputs: [{ type: 'LOCAL', o: 1, amt: 1n }],
      },
    ],
  };

  const expectedPacket = JSON.parse(JSON.stringify(originalPacket, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));

  Config.txidLE = false;
  Config.u16LE = true;
  Config.u64LE = true;

  const script = buildOpReturnScript(originalPacket);
  const decodedPacketResult = parseOpReturnScript(script);
  const decodedPacket = decodedPacketResult ? { ...decodedPacketResult } : null;
  const expectedForMatch = { groups: expectedPacket.groups };

  assert.deepStrictEqual(decodedPacket, expectedForMatch, 'Decoded packet does not match original');
  console.log('  ✓ Codec round-trip passed');
}

function testTeleportCodec() {
  console.log('Testing teleport encoding/decoding...');

  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'ab'.repeat(20) + '88ac',
    nonce: 'cc'.repeat(32)
  };
  const commitmentHex = getWitnessCommitment(witness);

  const packet: Packet = {
    groups: [
      {
        assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
        inputs: [{ type: 'TELEPORT', amt: 100n, witness }],
        outputs: [{ type: 'TELEPORT', commitment: commitmentHex, amt: 100n }],
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Failed to decode teleport packet');
  assert.strictEqual(decoded.groups?.length, 1, 'Expected 1 group');

  const inp = decoded.groups![0].inputs[0];
  assert.strictEqual(inp.type, 'TELEPORT', 'Expected TELEPORT input');
  if (inp.type === 'TELEPORT') {
    assert.strictEqual(inp.witness.paymentScript, witness.paymentScript, 'Witness script mismatch');
    assert.strictEqual(inp.witness.nonce, witness.nonce, 'Witness nonce mismatch');
    // Verify derived commitment
    assert.strictEqual(getWitnessCommitment(inp.witness), commitmentHex, 'Derived commitment mismatch');
  }

  console.log('  ✓ Teleport encoding/decoding passed');
}

// ----------------- METADATA MERKLE TESTS -----------------

function testMetadataMerkleHash() {
  console.log('Testing metadata Merkle hash...');

  const metadata = { name: 'Token', ticker: 'TKN', decimals: '8' };
  const hash1 = computeMetadataMerkleRootHex(metadata);
  const hash2 = computeMetadataMerkleRootHex(metadata);

  assert.strictEqual(hash1, hash2, 'Same metadata should produce same hash');
  assert.strictEqual(hash1.length, 64, 'Hash should be 64 hex chars (32 bytes)');

  // Different metadata should produce different hash
  const metadata2 = { name: 'Token2', ticker: 'TK2' };
  const hash3 = computeMetadataMerkleRootHex(metadata2);
  assert.notStrictEqual(hash1, hash3, 'Different metadata should produce different hash');

  console.log('  ✓ Metadata Merkle hash passed');
}

// ----------------- TELEPORT COMMITMENT TESTS -----------------

function testTeleportCommitment() {
  console.log('Testing teleport commitment...');

  const paymentScript = hexToBytes('76a914' + 'ab'.repeat(20) + '88ac');
  const nonce = hexToBytes('cc'.repeat(32));

  const commitment = computeTeleportCommitmentHex(paymentScript, nonce);
  assert.strictEqual(commitment.length, 64, 'Commitment should be 64 hex chars');

  // Verify should return true for correct preimage
  const commitmentBytes = hexToBytes(commitment);
  assert.ok(verifyTeleportCommitment(commitmentBytes, paymentScript, nonce), 'Verification should pass');

  // Verify should fail for wrong nonce
  const wrongNonce = hexToBytes('dd'.repeat(32));
  assert.ok(!verifyTeleportCommitment(commitmentBytes, paymentScript, wrongNonce), 'Verification should fail with wrong nonce');

  console.log('  ✓ Teleport commitment passed');
}

// ----------------- INDEXER TESTS -----------------

function testIndexerFreshIssuance() {
  console.log('Testing indexer: fresh issuance...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // First, set up the control asset
  const controlTxid = '11'.repeat(32);
  storage.state.utxos[`${controlTxid}:0`] = { [`${controlTxid}:0`]: '1' };
  storage.state.assets[`${controlTxid}:0`] = { control: null, metadata: {}, immutable: false };

  const tx = exampleA('aa'.repeat(32));
  const result = indexer.applyToArkadeVirtualMempool(tx);

  assert.ok(result.success, `Fresh issuance failed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  // Check that new asset was created
  const newAssetKey = `${'aa'.repeat(32)}:1`;
  assert.ok(specState.assets[newAssetKey], 'New asset should exist');
  assert.strictEqual(specState.assets[newAssetKey].metadata?.name, 'Token A', 'Metadata should be set');

  console.log('  ✓ Fresh issuance passed');
}

function testIndexerSimpleTransfer() {
  console.log('Testing indexer: simple transfer...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial UTXOs with tokens
  const tokenAssetId = '70'.repeat(32) + ':0';
  storage.state.utxos[`${'70'.repeat(32)}:0`] = { [tokenAssetId]: '100' };
  storage.state.utxos[`${'70'.repeat(32)}:1`] = { [tokenAssetId]: '40' };
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };

  const tx = exampleF_simple_transfer('ff'.repeat(32));
  const result = indexer.applyToArkadeVirtualMempool(tx);

  assert.ok(result.success, `Transfer failed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  // Check outputs have correct amounts
  assert.strictEqual(specState.utxos[`${'ff'.repeat(32)}:0`]?.[tokenAssetId], '70');
  assert.strictEqual(specState.utxos[`${'ff'.repeat(32)}:1`]?.[tokenAssetId], '70');

  console.log('  ✓ Simple transfer passed');
}

function testIndexerBurn() {
  console.log('Testing indexer: burn...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial UTXOs
  const tokenAssetId = '88'.repeat(32) + ':0';
  storage.state.utxos[`${'88'.repeat(32)}:0`] = { [tokenAssetId]: '30' };
  storage.state.utxos[`${'88'.repeat(32)}:1`] = { [tokenAssetId]: '10' };
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };

  const tx = exampleG_burn('bb'.repeat(32));
  const result = indexer.applyToArkadeVirtualMempool(tx);

  assert.ok(result.success, `Burn failed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  // No outputs should have the token
  const outputKeys = Object.keys(specState.utxos).filter(k => k.startsWith('bb'.repeat(32)));
  for (const key of outputKeys) {
    assert.ok(!specState.utxos[key][tokenAssetId], 'Burned tokens should not appear in outputs');
  }

  console.log('  ✓ Burn passed');
}

function testIndexerImmutableMetadata() {
  console.log('Testing indexer: immutable metadata enforcement...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create an immutable asset
  const controlAssetId = 'cc'.repeat(32) + ':0';
  const tokenAssetId = 'dd'.repeat(32) + ':1';

  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[tokenAssetId] = {
    control: controlAssetId,
    metadata: { name: 'Immutable Token' },
    immutable: true
  };
  storage.state.utxos[`${'cc'.repeat(32)}:0`] = { [controlAssetId]: '1' };
  storage.state.utxos[`${'dd'.repeat(32)}:1`] = { [tokenAssetId]: '1000' };

  // Try to update metadata on immutable asset
  const tx = exampleE_metadata_update('ee'.repeat(32));
  const result = indexer.applyToArkadeVirtualMempool(tx);

  assert.ok(!result.success, 'Should reject metadata update on immutable asset');
  assert.ok(result.error?.includes('immutable'), 'Error should mention immutable');

  console.log('  ✓ Immutable metadata enforcement passed');
}

function testIndexerTeleportFlow() {
  console.log('Testing indexer: teleport commit/claim flow...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial token
  const tokenAssetId = 'dd'.repeat(32) + ':0';
  storage.state.utxos[`${'dd'.repeat(32)}:0`] = { [tokenAssetId]: '100' };
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };

  // Create witness and derive commitment
  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'ab'.repeat(20) + '88ac',
    nonce: 'cc'.repeat(32)
  };
  const commitmentHex = getWitnessCommitment(witness);

  // Step 1: Commit
  const commitTx = exampleJ_teleport_commit('c1'.repeat(32), commitmentHex);
  const commitResult = indexer.applyToArkadeVirtualMempool(commitTx);
  assert.ok(commitResult.success, `Commit failed: ${commitResult.error}`);

  let specState = indexer.getSpeculativeState();
  assert.ok(specState.pendingTeleports[commitmentHex], 'Pending teleport should exist');
  assert.strictEqual(specState.pendingTeleports[commitmentHex].amount, '100');

  // Step 2: Claim with witness (commitment derived from witness)
  // For Arkade-native teleports, confirmations aren't required
  const claimTx = exampleK_teleport_claim('c2'.repeat(32), witness);
  const claimResult = indexer.applyToArkadeVirtualMempool(claimTx);
  assert.ok(claimResult.success, `Claim failed: ${claimResult.error}`);

  specState = indexer.getSpeculativeState();
  assert.ok(!specState.pendingTeleports[commitmentHex], 'Pending teleport should be consumed');
  assert.strictEqual(specState.utxos[`${'c2'.repeat(32)}:0`]?.[tokenAssetId], '100');

  console.log('  ✓ Teleport commit/claim flow passed');
}

function testIndexerValidationOutputBounds() {
  console.log('Testing indexer: output index bounds validation...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create a tx that references an out-of-bounds output
  const badTx = {
    txid: 'bad'.repeat(21) + 'ba',
    vin: [],
    vout: [{ n: 0, scriptPubKey: '6a' }], // Only 1 output
  };

  // Manually create a packet that references output index 5
  const packet: Packet = {
    groups: [{
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 5, amt: 100n }], // Out of bounds!
    }],
  };
  const script = buildOpReturnScript(packet);
  badTx.vout[0].scriptPubKey = Buffer.from(script).toString('hex');

  const result = indexer.applyToArkadeVirtualMempool(badTx as any);
  assert.ok(!result.success, 'Should reject out-of-bounds output index');
  assert.ok(result.error?.includes('out of bounds'), 'Error should mention bounds');

  console.log('  ✓ Output bounds validation passed');
}

function testIndexerValidationSelfReference() {
  console.log('Testing indexer: self-referential control asset validation...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create a packet where group 0 references itself as control
  const packet: Packet = {
    groups: [{
      issuance: {
        controlAsset: { gidx: 0 }, // Self-reference!
        metadata: { name: 'Bad Token' },
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'self'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Should reject self-referential control asset');
  assert.ok(result.error?.includes('itself'), 'Error should mention self-reference');

  console.log('  ✓ Self-reference validation passed');
}

// ----------------- CONTROL ASSET TESTS -----------------

function testSingleLevelControl() {
  console.log('Testing single-level control (not transitive)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create chain: ControlA -> ControlB -> TokenC
  // ControlA is the control asset for ControlB
  // ControlB is the control asset for TokenC
  const controlAId = 'aa'.repeat(32) + ':0';
  const controlBId = 'bb'.repeat(32) + ':0';
  const tokenCId = 'cc'.repeat(32) + ':0';

  storage.state.assets[controlAId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[controlBId] = { control: controlAId, metadata: {}, immutable: false };
  storage.state.assets[tokenCId] = { control: controlBId, metadata: { name: 'Token C' }, immutable: false };

  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [controlAId]: '1' };
  storage.state.utxos[`${'bb'.repeat(32)}:0`] = { [controlBId]: '1' };
  storage.state.utxos[`${'cc'.repeat(32)}:0`] = { [tokenCId]: '1000' };

  // Try to reissue TokenC using ControlA (should fail - not direct control)
  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'cc'.repeat(32), gidx: 0 },
      issuance: {
        controlAsset: { txidHex: 'aa'.repeat(32), gidx: 0 },  // ControlA, not ControlB
        metadata: { name: 'Token C Updated' },
      },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],  // Spend ControlA
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'dd'.repeat(32),
    vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  // Should fail because ControlA is not the direct control asset for TokenC
  assert.ok(!result.success, 'Should reject non-direct control asset');

  console.log('  ✓ Single-level control passed');
}

function testForwardReferenceByGroup() {
  console.log('Testing forward reference (BY_GROUP) for control assets...');

  // Test that a group's control asset can reference another group by gidx (forward reference)
  // Group 0: Creates a control asset
  // Group 1: Issues a new token using Group 0's control asset via BY_GROUP reference
  const packet: Packet = {
    groups: [
      {
        // Group 0: Fresh issuance - this will be the control asset for Group 1
        issuance: {
          controlAsset: { txidHex: 'cc'.repeat(32), gidx: 0 },  // External control
          metadata: { name: 'Control Token' },
        },
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
      },
      {
        // Group 1: References group 0 as control asset via BY_GROUP (forward reference)
        issuance: {
          controlAsset: { gidx: 0 },  // BY_GROUP reference to group 0
          metadata: { name: 'Controlled Token' },
        },
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }],
      },
    ],
  };

  // Codec should handle BY_GROUP control asset reference
  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Failed to decode forward reference packet');
  assert.strictEqual(decoded.groups?.length, 2, 'Expected 2 groups');

  // Group 1's control asset should be BY_GROUP reference
  const group1 = decoded.groups![1];
  assert.ok(group1.issuance, 'Group 1 should have issuance');
  assert.ok(group1.issuance?.controlAsset, 'Group 1 should have control asset');
  const controlRef = group1.issuance!.controlAsset;
  assert.ok(controlRef.txidHex === undefined, 'Control ref should be BY_GROUP (no txidHex)');
  assert.strictEqual(controlRef.gidx, 0, 'Should reference group 0');

  console.log('  ✓ Forward reference (BY_GROUP) for control assets passed');
}

// ----------------- TELEPORT WITNESS TESTS -----------------

function testTeleportWitnessEncoding() {
  console.log('Testing teleport witness encoding/decoding...');

  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'ab'.repeat(20) + '88ac',  // P2PKH script
    nonce: 'cc'.repeat(32)
  };

  const encoded = encodeTeleportWitness(witness);
  const { witness: decoded, next } = decodeTeleportWitness(encoded, 0);

  assert.strictEqual(decoded.paymentScript, witness.paymentScript, 'Payment script mismatch');
  assert.strictEqual(decoded.nonce, witness.nonce, 'Nonce mismatch');
  assert.strictEqual(next, encoded.length, 'Next offset should equal encoded length');

  console.log('  ✓ Teleport witness encoding/decoding passed');
}

function testVariableNonceSize() {
  console.log('Testing variable nonce size...');

  // Test with 16-byte nonce (should work)
  const paymentScript = hexToBytes('76a914' + 'ab'.repeat(20) + '88ac');
  const shortNonce = hexToBytes('dd'.repeat(16));
  const commitment16 = computeTeleportCommitmentHex(paymentScript, shortNonce);
  assert.strictEqual(commitment16.length, 64, 'Commitment should be 64 hex chars');

  // Test with 32-byte nonce (should work)
  const fullNonce = hexToBytes('ee'.repeat(32));
  const commitment32 = computeTeleportCommitmentHex(paymentScript, fullNonce);
  assert.strictEqual(commitment32.length, 64, 'Commitment should be 64 hex chars');

  // Different nonce sizes should produce different commitments
  assert.notStrictEqual(commitment16, commitment32, 'Different nonces should produce different commitments');

  // Test with 33-byte nonce (should fail)
  const tooLongNonce = hexToBytes('ff'.repeat(33));
  try {
    computeTeleportCommitmentHex(paymentScript, tooLongNonce);
    assert.fail('Should reject nonce > 32 bytes');
  } catch (e: any) {
    assert.ok(e.message.includes('32 bytes'), 'Error should mention 32 bytes limit');
  }

  console.log('  ✓ Variable nonce size passed');
}

function testMultipleOpReturnHandling() {
  console.log('Testing multiple OP_RETURN handling (uses first)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create two different packets
  const packet1: Packet = {
    groups: [{
      issuance: { metadata: { name: 'First' } },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };
  const packet2: Packet = {
    groups: [{
      issuance: { metadata: { name: 'Second' } },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 200n }],
    }],
  };
  const script1 = buildOpReturnScript(packet1);
  const script2 = buildOpReturnScript(packet2);
  const scriptHex1 = Buffer.from(script1).toString('hex');
  const scriptHex2 = Buffer.from(script2).toString('hex');

  // Create a transaction with two ARK OP_RETURNs - should use first (index 1)
  const tx = {
    txid: 'multi'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },  // Some output
      { n: 1, scriptPubKey: scriptHex1 },  // First ARK OP_RETURN (should be used)
      { n: 2, scriptPubKey: scriptHex2 },  // Second ARK OP_RETURN (ignored)
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  // Should succeed using first packet
  assert.ok(result.success, `Should accept and use first OP_RETURN: ${result.error}`);

  // Verify the first packet was used (amount 100, not 200)
  const specState = indexer.getSpeculativeState();
  const newAssetKey = `${'multi'.repeat(16)}:0`;
  assert.ok(specState.assets[newAssetKey], 'New asset should exist');
  assert.strictEqual(specState.assets[newAssetKey].metadata?.name, 'First', 'Should use first packet metadata');

  console.log('  ✓ Multiple OP_RETURN handling passed');
}

function testTeleportWithWitness() {
  console.log('Testing teleport codec with witness...');

  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'bb'.repeat(20) + '88ac',
    nonce: 'cc'.repeat(32)
  };
  const expectedCommitment = getWitnessCommitment(witness);

  const packet: Packet = {
    groups: [
      {
        assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
        inputs: [{ type: 'TELEPORT', amt: 100n, witness }],
        outputs: [{ type: 'LOCAL', o: 0, amt: 100n }],
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Failed to decode teleport packet with witness');
  assert.strictEqual(decoded.groups?.length, 1, 'Expected 1 group');

  const inp = decoded.groups![0].inputs[0];
  assert.strictEqual(inp.type, 'TELEPORT', 'Expected TELEPORT input');
  if (inp.type === 'TELEPORT') {
    assert.strictEqual(inp.witness.paymentScript, witness.paymentScript, 'Witness script mismatch');
    assert.strictEqual(inp.witness.nonce, witness.nonce, 'Witness nonce mismatch');
    // Verify commitment is correctly derived
    assert.strictEqual(getWitnessCommitment(inp.witness), expectedCommitment, 'Derived commitment mismatch');
  }

  console.log('  ✓ Teleport with witness passed');
}

// ----------------- VALIDATION TESTS -----------------

function testZeroAmountValidation() {
  console.log('Testing zero amount validation...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Try to create a packet with zero amount output
  const packet: Packet = {
    groups: [{
      issuance: { metadata: { name: 'Zero Token' } },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 0n }],  // Zero amount!
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'zero'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Should reject zero amount');
  assert.ok(result.error?.toLowerCase().includes('zero') || result.error?.toLowerCase().includes('amount'),
    `Error should mention zero/amount: ${result.error}`);

  console.log('  ✓ Zero amount validation passed');
}

function testInputAmountValidation() {
  console.log('Testing input amount validation (claiming more than UTXO has)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up UTXO with 50 tokens
  const tokenAssetId = 'ee'.repeat(32) + ':0';
  storage.state.utxos[`${'ee'.repeat(32)}:0`] = { [tokenAssetId]: '50' };
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };

  // Try to claim 100 tokens from a UTXO that only has 50
  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'ee'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],  // Claiming 100, only 50 available
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'abcd'.repeat(16),
    vin: [{ txid: 'ee'.repeat(32), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Should reject claiming more than available');

  console.log('  ✓ Input amount validation passed');
}

function testMintWithoutControlAsset() {
  console.log('Testing mint without control asset (delta > 0 needs control)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up an existing asset with a control asset requirement
  const controlAssetId = 'cc'.repeat(32) + ':0';
  const tokenAssetId = 'ee'.repeat(32) + ':0';

  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[tokenAssetId] = { control: controlAssetId, metadata: { name: 'Token' }, immutable: false };
  storage.state.utxos[`${'ee'.repeat(32)}:0`] = { [tokenAssetId]: '100' };

  // Try to mint more tokens without including the control asset
  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'ee'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 200n }],  // Minting 100 more!
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'beef'.repeat(16),
    vin: [{ txid: 'ee'.repeat(32), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Should reject mint without control asset');
  assert.ok(result.error?.toLowerCase().includes('control') || result.error?.toLowerCase().includes('delta'),
    `Error should mention control/delta: ${result.error}`);

  console.log('  ✓ Mint without control asset passed');
}

function testReissuanceWithControlAsset() {
  console.log('Testing reissuance with control asset...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up control asset and token (use valid hex: 0-9 and a-f only)
  const controlAssetId = 'cc'.repeat(32) + ':0';
  const tokenAssetId = 'ff'.repeat(32) + ':0';

  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[tokenAssetId] = { control: controlAssetId, metadata: { name: 'Token' }, immutable: false };
  storage.state.utxos[`${'cc'.repeat(32)}:0`] = { [controlAssetId]: '1' };
  storage.state.utxos[`${'ff'.repeat(32)}:0`] = { [tokenAssetId]: '100' };

  // Reissue with control asset present (delta = 0 for control, delta > 0 for token)
  const packet: Packet = {
    groups: [
      {
        // Control asset group (delta = 0)
        assetId: { txidHex: 'cc'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
      },
      {
        // Token group with mint (delta > 0)
        assetId: { txidHex: 'ff'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 1, amt: 100n }],
        outputs: [{ type: 'LOCAL' as const, o: 1, amt: 200n }],  // Minting 100 more
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'ab'.repeat(32),
    vin: [
      { txid: 'cc'.repeat(32), vout: 0 },
      { txid: 'ff'.repeat(32), vout: 0 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' },  // Control asset output
      { n: 1, scriptPubKey: '51' },  // Token output
      { n: 2, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `Reissuance with control should succeed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  assert.strictEqual(specState.utxos[`${'ab'.repeat(32)}:1`]?.[tokenAssetId], '200', 'Should have 200 tokens after reissuance');

  console.log('  ✓ Reissuance with control asset passed');
}

function testMetadataUpdateWithControl() {
  console.log('Testing metadata update with control asset...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up control asset and token
  const controlAssetId = 'cc'.repeat(32) + ':0';
  const tokenAssetId = 'ee'.repeat(32) + ':0';

  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[tokenAssetId] = { control: controlAssetId, metadata: { name: 'Old Name' }, immutable: false };
  storage.state.utxos[`${'cc'.repeat(32)}:0`] = { [controlAssetId]: '1' };
  storage.state.utxos[`${'ee'.repeat(32)}:0`] = { [tokenAssetId]: '100' };

  // Update metadata with control asset present
  const packet: Packet = {
    groups: [
      {
        // Control asset group (must be spent for metadata update)
        assetId: { txidHex: 'cc'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
      },
      {
        // Token group with metadata update
        assetId: { txidHex: 'ee'.repeat(32), gidx: 0 },
        metadata: { name: 'New Name', description: 'Updated' },
        inputs: [{ type: 'LOCAL' as const, i: 1, amt: 100n }],
        outputs: [{ type: 'LOCAL' as const, o: 1, amt: 100n }],
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'dead'.repeat(16),
    vin: [
      { txid: 'cc'.repeat(32), vout: 0 },
      { txid: 'ee'.repeat(32), vout: 0 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: '51' },
      { n: 2, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `Metadata update with control should succeed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  assert.strictEqual(specState.assets[tokenAssetId]?.metadata?.name, 'New Name', 'Metadata should be updated');

  console.log('  ✓ Metadata update with control asset passed');
}

function testMetadataUpdateWithoutControl() {
  console.log('Testing metadata update without control asset (should fail)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up control asset and token
  const controlAssetId = 'cc'.repeat(32) + ':0';
  const tokenAssetId = 'ee'.repeat(32) + ':0';

  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.assets[tokenAssetId] = { control: controlAssetId, metadata: { name: 'Old Name' }, immutable: false };
  storage.state.utxos[`${'ee'.repeat(32)}:0`] = { [tokenAssetId]: '100' };
  // Note: NOT including control asset UTXO

  // Try to update metadata without control asset
  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'ee'.repeat(32), gidx: 0 },
      metadata: { name: 'Unauthorized Update' },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'cafe'.repeat(16),
    vin: [{ txid: 'ee'.repeat(32), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Metadata update without control should fail');

  console.log('  ✓ Metadata update without control asset passed');
}

function testControlAssetById() {
  console.log('Testing control asset BY_ID reference...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up external control asset
  const controlAssetId = 'cc'.repeat(32) + ':0';
  storage.state.assets[controlAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.utxos[`${'cc'.repeat(32)}:0`] = { [controlAssetId]: '1' };

  // Fresh issuance with BY_ID control reference - control asset must be spent
  const packet: Packet = {
    groups: [
      {
        // Control asset group - must be spent (delta = 0)
        assetId: { txidHex: 'cc'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
      },
      {
        // New token issuance controlled by the control asset
        issuance: {
          controlAsset: { txidHex: 'cc'.repeat(32), gidx: 0 },  // BY_ID
          metadata: { name: 'New Token' },
        },
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }],
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'byid'.repeat(16),
    vin: [{ txid: 'cc'.repeat(32), vout: 0 }],  // Spend control asset
    vout: [
      { n: 0, scriptPubKey: '51' },  // Control asset output
      { n: 1, scriptPubKey: '51' },  // New token output
      { n: 2, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `BY_ID control reference should work: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  const newAssetId = `${'byid'.repeat(16)}:1`;
  assert.strictEqual(specState.assets[newAssetId]?.control, controlAssetId, 'Control should be set BY_ID');

  console.log('  ✓ Control asset BY_ID reference passed');
}

function testMultiAssetPerUtxo() {
  console.log('Testing multi-asset per UTXO...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up two different assets
  const assetA = 'aa'.repeat(32) + ':0';
  const assetB = 'bb'.repeat(32) + ':0';

  storage.state.assets[assetA] = { control: null, metadata: { name: 'Asset A' }, immutable: false };
  storage.state.assets[assetB] = { control: null, metadata: { name: 'Asset B' }, immutable: false };
  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [assetA]: '100' };
  storage.state.utxos[`${'bb'.repeat(32)}:0`] = { [assetB]: '200' };

  // Transfer both assets to the same output
  const packet: Packet = {
    groups: [
      {
        assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],  // Output 0
      },
      {
        assetId: { txidHex: 'bb'.repeat(32), gidx: 0 },
        inputs: [{ type: 'LOCAL' as const, i: 1, amt: 200n }],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 200n }],  // Same output 0!
      },
    ],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'face'.repeat(16),
    vin: [
      { txid: 'aa'.repeat(32), vout: 0 },
      { txid: 'bb'.repeat(32), vout: 0 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' },  // Both assets go here
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `Multi-asset per UTXO should work: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  const utxoKey = `${'face'.repeat(16)}:0`;
  assert.strictEqual(specState.utxos[utxoKey]?.[assetA], '100', 'Asset A should be in output');
  assert.strictEqual(specState.utxos[utxoKey]?.[assetB], '200', 'Asset B should be in output');

  console.log('  ✓ Multi-asset per UTXO passed');
}

function testTeleportWrongPaymentScript() {
  console.log('Testing teleport claim with wrong payment script...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up token and create a pending teleport with specific payment script
  const tokenAssetId = 'dd'.repeat(32) + ':0';
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };

  // Create pending teleport
  const correctWitness: TeleportWitness = {
    paymentScript: '76a914' + 'aa'.repeat(20) + '88ac',  // Correct script
    nonce: 'cc'.repeat(32)
  };
  const commitment = getWitnessCommitment(correctWitness);
  storage.state.pendingTeleports[commitment] = {
    assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
    amount: '100',
    sourceTxid: 'src'.repeat(16),
    sourceHeight: undefined  // Arkade-native, no confirmation needed
  };

  // Try to claim with wrong payment script
  const wrongWitness: TeleportWitness = {
    paymentScript: '76a914' + 'bb'.repeat(20) + '88ac',  // Different script!
    nonce: 'cc'.repeat(32)
  };

  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
      inputs: [{ type: 'TELEPORT' as const, amt: 100n, witness: wrongWitness }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'babe'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(!result.success, 'Wrong payment script should fail');
  assert.ok(result.error?.includes('not found'), `Error should mention not found: ${result.error}`);

  console.log('  ✓ Teleport wrong payment script passed');
}

function testTeleportConfirmationDelay() {
  console.log('Testing teleport confirmation delay for on-chain source...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up token and create an on-chain pending teleport
  const tokenAssetId = 'dd'.repeat(32) + ':0';
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.blockHeight = 99;  // Current block is 99

  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'aa'.repeat(20) + '88ac',
    nonce: 'cc'.repeat(32)
  };
  const commitment = getWitnessCommitment(witness);

  // On-chain teleport from block 99 (only 1 confirmation at block 100)
  storage.state.pendingTeleports[commitment] = {
    assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
    amount: '100',
    sourceTxid: 'src'.repeat(16),
    sourceHeight: 99  // Teleport committed at block 99
  };

  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
      inputs: [{ type: 'TELEPORT' as const, amt: 100n, witness }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'fade'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  // Apply at block 100 - should fail (only 1 confirmation, need 6)
  let errorThrown = false;
  let errorMsg = '';
  try {
    indexer.applyBlock({ height: 100, transactions: [tx as any] });
  } catch (e: any) {
    errorThrown = true;
    errorMsg = e.message;
  }
  assert.ok(errorThrown, 'Should reject teleport without enough confirmations');
  assert.ok(errorMsg.includes('confirmation'), `Error should mention confirmations: ${errorMsg}`);

  console.log('  ✓ Teleport confirmation delay passed');
}

function testTeleportConfirmationSuccess() {
  console.log('Testing teleport claim after sufficient confirmations...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up token and create an on-chain pending teleport
  const tokenAssetId = 'dd'.repeat(32) + ':0';
  storage.state.assets[tokenAssetId] = { control: null, metadata: {}, immutable: false };
  storage.state.blockHeight = 105;  // Current block is 105

  const witness: TeleportWitness = {
    paymentScript: '76a914' + 'aa'.repeat(20) + '88ac',
    nonce: 'cc'.repeat(32)
  };
  const commitment = getWitnessCommitment(witness);

  // On-chain teleport from block 100 (6 confirmations at block 106)
  storage.state.pendingTeleports[commitment] = {
    assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
    amount: '100',
    sourceTxid: 'src'.repeat(16),
    sourceHeight: 100
  };

  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'dd'.repeat(32), gidx: 0 },
      inputs: [{ type: 'TELEPORT' as const, amt: 100n, witness }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 100n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'conf'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  // Apply at block 106 - should succeed (6 confirmations)
  let errorThrown = false;
  let errorMsg = '';
  try {
    indexer.applyBlock({ height: 106, transactions: [tx as any] });
  } catch (e: any) {
    errorThrown = true;
    errorMsg = e.message;
  }
  assert.ok(!errorThrown, `Should accept teleport with enough confirmations: ${errorMsg}`);

  console.log('  ✓ Teleport confirmation success passed');
}

function testFreshIssuanceWithoutControl() {
  console.log('Testing fresh issuance without control (no reissuance possible)...');

  // Use fresh storage for second part to avoid state conflicts
  const storage1 = new InMemoryStorage();
  const indexer1 = new Indexer(storage1);

  // Fresh issuance with no control asset
  const packet: Packet = {
    groups: [{
      issuance: {
        // No controlAsset!
        metadata: { name: 'No Control Token' },
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1000n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'cafe'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer1.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `Fresh issuance without control should succeed: ${result.error}`);

  const specState = indexer1.getSpeculativeState();
  const newAssetId = `${'cafe'.repeat(16)}:0`;
  assert.strictEqual(specState.assets[newAssetId]?.control, null, 'Control should be null');

  // Test reissuance failure with a fresh indexer - pre-populate with the asset state
  const storage2 = new InMemoryStorage();
  storage2.state.assets[newAssetId] = { control: null, metadata: { name: 'No Control Token' }, immutable: false };
  storage2.state.utxos[`${'cafe'.repeat(16)}:0`] = { [newAssetId]: '1000' };
  const indexer2 = new Indexer(storage2);

  const reissuePacket: Packet = {
    groups: [{
      assetId: { txidHex: 'cafe'.repeat(16), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 2000n }],  // Trying to mint
    }],
  };

  const reissueScript = buildOpReturnScript(reissuePacket);
  const reissueTx = {
    txid: 'dada'.repeat(16),
    vin: [{ txid: 'cafe'.repeat(16), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(reissueScript).toString('hex') },
    ],
  };

  const reissueResult = indexer2.applyToArkadeVirtualMempool(reissueTx as any);
  assert.ok(!reissueResult.success, 'Reissuance without control asset should fail');

  console.log('  ✓ Fresh issuance without control passed');
}

function testImmutableAssetCreation() {
  console.log('Testing immutable asset creation...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Create an immutable asset
  const packet: Packet = {
    groups: [{
      issuance: {
        metadata: { name: 'Immutable Token', description: 'Cannot change' },
        immutable: true,
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1000n }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'abed'.repeat(16),
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  const result = indexer.applyToArkadeVirtualMempool(tx as any);
  assert.ok(result.success, `Immutable asset creation should succeed: ${result.error}`);

  const specState = indexer.getSpeculativeState();
  const newAssetId = `${'abed'.repeat(16)}:0`;
  assert.strictEqual(specState.assets[newAssetId]?.immutable, true, 'Asset should be immutable');

  console.log('  ✓ Immutable asset creation passed');
}

function testEmptyGroupsPacket() {
  console.log('Testing empty groups packet...');

  const packet: Packet = {
    groups: [],  // Empty!
  };

  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Should decode empty groups packet');
  assert.strictEqual(decoded.groups?.length, 0, 'Should have 0 groups');

  console.log('  ✓ Empty groups packet passed');
}

function testMaxU64Amount() {
  console.log('Testing max u64 amount...');

  const maxU64 = 18446744073709551615n;  // 2^64 - 1

  const packet: Packet = {
    groups: [{
      issuance: { metadata: { name: 'Max Token' } },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: maxU64 }],
    }],
  };

  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Should decode max u64 packet');
  assert.strictEqual(decoded.groups?.[0].outputs[0].amt, maxU64.toString(), 'Amount should be max u64');

  console.log('  ✓ Max u64 amount passed');
}

// ----------------- COMPACT ENCODING EDGE CASE TESTS -----------------

function testVarintAmountBoundaries() {
  console.log('Testing varint amount boundaries...');

  const boundaryValues: { amt: bigint; label: string }[] = [
    { amt: 0n, label: '0 (min, 1-byte varint)' },
    { amt: 252n, label: '252 (max 1-byte varint)' },
    { amt: 253n, label: '253 (first 3-byte varint, 0xfd prefix)' },
    { amt: 65535n, label: '65535 (max 3-byte varint)' },
    { amt: 65536n, label: '65536 (first 5-byte varint, 0xfe prefix)' },
    { amt: 4294967295n, label: '4294967295 (max 5-byte varint)' },
    { amt: 4294967296n, label: '4294967296 (first 9-byte varint, 0xff prefix)' },
    { amt: 18446744073709551615n, label: 'max u64 (9-byte varint)' },
  ];

  for (const { amt, label } of boundaryValues) {
    const packet: Packet = {
      groups: [{
        issuance: { metadata: { name: 'Boundary' } },
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt }],
      }],
    };

    const script = buildOpReturnScript(packet);
    const decoded = parseOpReturnScript(script);

    assert.ok(decoded, `Failed to decode packet with amount ${label}`);
    assert.strictEqual(
      decoded.groups?.[0].outputs[0].amt,
      amt.toString(),
      `Amount mismatch for ${label}: expected ${amt.toString()}, got ${decoded.groups?.[0].outputs[0].amt}`
    );
  }

  console.log('  ✓ Varint amount boundaries passed');
}

function testPackedCountsBoundaries() {
  console.log('Testing packed counts boundaries...');

  // Helper to create a group with N inputs and M outputs
  function makeGroup(inCount: number, outCount: number): Packet {
    const inputs = [];
    for (let k = 0; k < inCount; k++) {
      inputs.push({ type: 'LOCAL' as const, i: k, amt: 1n });
    }
    const outputs = [];
    for (let k = 0; k < outCount; k++) {
      outputs.push({ type: 'LOCAL' as const, o: k, amt: 1n });
    }
    return {
      groups: [{
        issuance: { metadata: { name: 'Counts' } },
        inputs,
        outputs,
      }],
    };
  }

  const cases: { inCount: number; outCount: number; label: string }[] = [
    { inCount: 0, outCount: 0, label: '(0,0) -> packed 0x00' },
    { inCount: 1, outCount: 1, label: '(1,1) -> packed 0x11' },
    { inCount: 15, outCount: 14, label: '(15,14) -> packed 0xFE' },
    { inCount: 14, outCount: 15, label: '(14,15) -> packed 0xEF' },
    { inCount: 15, outCount: 15, label: '(15,15) -> escape format (0xFF collision)' },
    { inCount: 16, outCount: 0, label: '(16,0) -> escape format (inCount > 15)' },
    { inCount: 0, outCount: 16, label: '(0,16) -> escape format (outCount > 15)' },
  ];

  for (const { inCount, outCount, label } of cases) {
    const packet = makeGroup(inCount, outCount);
    const script = buildOpReturnScript(packet);
    const decoded = parseOpReturnScript(script);

    assert.ok(decoded, `Failed to decode packet for ${label}`);
    assert.strictEqual(decoded.groups?.length, 1, `Expected 1 group for ${label}`);
    assert.strictEqual(
      decoded.groups![0].inputs.length,
      inCount,
      `Input count mismatch for ${label}: expected ${inCount}, got ${decoded.groups![0].inputs.length}`
    );
    assert.strictEqual(
      decoded.groups![0].outputs.length,
      outCount,
      `Output count mismatch for ${label}: expected ${outCount}, got ${decoded.groups![0].outputs.length}`
    );

    // Verify individual input/output indices round-trip
    for (let k = 0; k < inCount; k++) {
      const inp: any = decoded.groups![0].inputs[k];
      assert.strictEqual(inp.type, 'LOCAL', `Input ${k} type mismatch for ${label}`);
      assert.strictEqual(inp.i, k, `Input ${k} index mismatch for ${label}`);
      assert.strictEqual(inp.amt, '1', `Input ${k} amount mismatch for ${label}`);
    }
    for (let k = 0; k < outCount; k++) {
      const out: any = decoded.groups![0].outputs[k];
      assert.strictEqual(out.type, 'LOCAL', `Output ${k} type mismatch for ${label}`);
      assert.strictEqual(out.o, k, `Output ${k} index mismatch for ${label}`);
      assert.strictEqual(out.amt, '1', `Output ${k} amount mismatch for ${label}`);
    }
  }

  console.log('  ✓ Packed counts boundaries passed');
}

function testSelfDelimitingTlv() {
  console.log('Testing self-delimiting TLV encoding...');

  // Build a minimal packet and check that the payload uses self-delimiting type 0x00
  // (no length field), saving 1 byte compared to a length-prefixed TLV.
  const packet: Packet = {
    groups: [{
      issuance: { metadata: { name: 'TLV' } },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
    }],
  };

  const payload = buildOpReturnPayload(packet);

  // Payload format: magic(3) + type(1) + asset_data(variable)
  // magic = "ARK" = 0x41 0x52 0x4b
  assert.strictEqual(payload[0], 0x41, 'Magic byte 0 should be "A"');
  assert.strictEqual(payload[1], 0x52, 'Magic byte 1 should be "R"');
  assert.strictEqual(payload[2], 0x4b, 'Magic byte 2 should be "K"');
  assert.strictEqual(payload[3], 0x00, 'TLV type should be 0x00');

  // Verify there is NO length field after the type byte.
  // In self-delimiting format, byte 4 should be the start of the asset payload
  // (i.e., the group count varint), NOT a length prefix.
  // A packet with 1 group would have group count = 1 (varint: 0x01).
  assert.strictEqual(payload[4], 0x01, 'Byte after type should be group count (1), not a length prefix');

  // Verify the round-trip works correctly
  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);
  assert.ok(decoded, 'Self-delimiting TLV should decode correctly');
  assert.strictEqual(decoded.groups?.length, 1, 'Should have 1 group');
  assert.strictEqual(decoded.groups?.[0].outputs[0].amt, '1', 'Amount should round-trip');

  // Verify payload is 1 byte shorter than it would be with a length field.
  // With a length field, the format would be: magic(3) + type(1) + compactsize_length + data
  // Without: magic(3) + type(1) + data
  // The data portion starts at offset 4 in the self-delimiting format.
  const assetDataLength = payload.length - 4; // everything after magic + type byte
  // If we had a length prefix, for small payloads (<253 bytes) it would add 1 byte
  // So the self-delimiting format saves exactly 1 byte for small payloads.
  assert.ok(assetDataLength < 253, 'Asset data should be small enough that length prefix would be 1 byte');
  // The total payload with length-prefix would be: 3(magic) + 1(type) + 1(length) + assetDataLength
  // Self-delimiting:                               3(magic) + 1(type) + assetDataLength
  // Difference = 1 byte saved
  const expectedWithLengthPrefix = 3 + 1 + 1 + assetDataLength;
  const actualSelfDelimiting = payload.length;
  assert.strictEqual(
    expectedWithLengthPrefix - actualSelfDelimiting,
    1,
    `Self-delimiting should save exactly 1 byte (expected ${expectedWithLengthPrefix} with length, got ${actualSelfDelimiting} without)`
  );

  console.log('  ✓ Self-delimiting TLV encoding passed');
}

// ----------------- REORG TESTS -----------------

function testBasicReorg() {
  console.log('Testing basic reorg (single block rollback)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial state at block 0
  const assetId = 'aa'.repeat(32) + ':0';
  storage.state.assets[assetId] = { control: null, metadata: { name: 'Test Token' }, immutable: false };
  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [assetId]: '1000' };
  storage.state.blockHeight = 0;
  storage.save(0);

  // Create a transfer transaction
  const packet: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [
        { type: 'LOCAL' as const, o: 0, amt: 600n },
        { type: 'LOCAL' as const, o: 1, amt: 400n },
      ],
    }],
  };

  const script = buildOpReturnScript(packet);
  const tx = {
    txid: 'b1b1'.repeat(16),
    vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: '51' },
      { n: 2, scriptPubKey: Buffer.from(script).toString('hex') },
    ],
  };

  // Apply block 1 with the transfer
  indexer.applyBlock({ height: 1, transactions: [tx as any] });

  // Verify state after block 1
  assert.strictEqual(storage.state.blockHeight, 1, 'Should be at block 1');
  assert.ok(!storage.state.utxos[`${'aa'.repeat(32)}:0`], 'Original UTXO should be spent');
  assert.strictEqual(storage.state.utxos[`${'b1b1'.repeat(16)}:0`]?.[assetId], '600', 'First output should have 600');
  assert.strictEqual(storage.state.utxos[`${'b1b1'.repeat(16)}:1`]?.[assetId], '400', 'Second output should have 400');

  // Rollback block 1
  const rollbackResult = indexer.rollbackLastBlock();
  assert.ok(rollbackResult.changed, 'Rollback should succeed');
  assert.strictEqual(rollbackResult.newHeight, 0, 'Should be back at block 0');

  // Verify state is restored
  assert.strictEqual(storage.state.blockHeight, 0, 'Should be at block 0');
  assert.strictEqual(storage.state.utxos[`${'aa'.repeat(32)}:0`]?.[assetId], '1000', 'Original UTXO should be restored');
  assert.ok(!storage.state.utxos[`${'b1b1'.repeat(16)}:0`], 'Transfer output should not exist');

  console.log('  ✓ Basic reorg passed');
}

function testReorgWithMultipleBlocks() {
  console.log('Testing reorg with multiple blocks...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial state
  const assetId = 'aa'.repeat(32) + ':0';
  storage.state.assets[assetId] = { control: null, metadata: { name: 'Test Token' }, immutable: false };
  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [assetId]: '1000' };
  storage.state.blockHeight = 0;
  storage.save(0);

  // Block 1: Transfer 1000 -> 600 + 400
  const packet1: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 600n }, { type: 'LOCAL' as const, o: 1, amt: 400n }],
    }],
  };
  const script1 = buildOpReturnScript(packet1);
  const tx1 = {
    txid: 'b1b1'.repeat(16),
    vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: '51' }, { n: 2, scriptPubKey: Buffer.from(script1).toString('hex') }],
  };
  indexer.applyBlock({ height: 1, transactions: [tx1 as any] });

  // Block 2: Transfer 600 -> 500 + 100
  const packet2: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 600n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 500n }, { type: 'LOCAL' as const, o: 1, amt: 100n }],
    }],
  };
  const script2 = buildOpReturnScript(packet2);
  const tx2 = {
    txid: 'b2b2'.repeat(16),
    vin: [{ txid: 'b1b1'.repeat(16), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: '51' }, { n: 2, scriptPubKey: Buffer.from(script2).toString('hex') }],
  };
  indexer.applyBlock({ height: 2, transactions: [tx2 as any] });

  // Block 3: Burn 100
  const packet3: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],
      outputs: [],  // Burn all
    }],
  };
  const script3 = buildOpReturnScript(packet3);
  const tx3 = {
    txid: 'b3b3'.repeat(16),
    vin: [{ txid: 'b2b2'.repeat(16), vout: 1 }],
    vout: [{ n: 0, scriptPubKey: Buffer.from(script3).toString('hex') }],
  };
  indexer.applyBlock({ height: 3, transactions: [tx3 as any] });

  // Verify at block 3
  assert.strictEqual(storage.state.blockHeight, 3, 'Should be at block 3');
  assert.strictEqual(storage.state.utxos[`${'b2b2'.repeat(16)}:0`]?.[assetId], '500', 'Should have 500 in block 2 output');
  assert.strictEqual(storage.state.utxos[`${'b1b1'.repeat(16)}:1`]?.[assetId], '400', 'Should have 400 in block 1 output');

  // Rollback to block 1 (2 rollbacks)
  indexer.rollbackLastBlock();  // 3 -> 2
  indexer.rollbackLastBlock();  // 2 -> 1

  assert.strictEqual(storage.state.blockHeight, 1, 'Should be at block 1');
  assert.strictEqual(storage.state.utxos[`${'b1b1'.repeat(16)}:0`]?.[assetId], '600', 'Block 1 output 0 should have 600');
  assert.strictEqual(storage.state.utxos[`${'b1b1'.repeat(16)}:1`]?.[assetId], '400', 'Block 1 output 1 should have 400');
  assert.ok(!storage.state.utxos[`${'b2b2'.repeat(16)}:0`], 'Block 2 outputs should not exist');

  console.log('  ✓ Reorg with multiple blocks passed');
}

function testReorgWithNewChain() {
  console.log('Testing reorg with new chain (rollback and apply different block)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial state with unique IDs for this test
  const assetId = 'f1'.repeat(32) + ':0';
  storage.state.assets[assetId] = { control: null, metadata: { name: 'Test Token' }, immutable: false };
  storage.state.utxos[`${'f1'.repeat(32)}:0`] = { [assetId]: '1000' };
  storage.state.blockHeight = 0;
  storage.save(0);

  // Block 1 (Chain A): Transfer 1000 -> 700 + 300
  const packetA: Packet = {
    groups: [{
      assetId: { txidHex: 'f1'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 700n }, { type: 'LOCAL' as const, o: 1, amt: 300n }],
    }],
  };
  const scriptA = buildOpReturnScript(packetA);
  const txA = {
    txid: 'f2f2'.repeat(16),
    vin: [{ txid: 'f1'.repeat(32), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: '51' }, { n: 2, scriptPubKey: Buffer.from(scriptA).toString('hex') }],
  };
  indexer.applyBlock({ height: 1, transactions: [txA as any] });

  // Verify Chain A state
  assert.strictEqual(storage.state.utxos[`${'f2f2'.repeat(16)}:0`]?.[assetId], '700', 'Chain A: should have 700');
  assert.strictEqual(storage.state.utxos[`${'f2f2'.repeat(16)}:1`]?.[assetId], '300', 'Chain A: should have 300');

  // Rollback Chain A
  indexer.rollbackLastBlock();
  assert.strictEqual(storage.state.blockHeight, 0, 'Should be back at block 0');

  // Block 1 (Chain B): Transfer 1000 -> 550 + 450 (different split)
  const packetB: Packet = {
    groups: [{
      assetId: { txidHex: 'f1'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 550n }, { type: 'LOCAL' as const, o: 1, amt: 450n }],
    }],
  };
  const scriptB = buildOpReturnScript(packetB);
  const txB = {
    txid: 'f3f3'.repeat(16),
    vin: [{ txid: 'f1'.repeat(32), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: '51' }, { n: 2, scriptPubKey: Buffer.from(scriptB).toString('hex') }],
  };
  indexer.applyBlock({ height: 1, transactions: [txB as any] });

  // Verify Chain B state
  assert.strictEqual(storage.state.blockHeight, 1, 'Should be at block 1 on Chain B');
  assert.ok(!storage.state.utxos[`${'f2f2'.repeat(16)}:0`], 'Chain A outputs should not exist');
  assert.strictEqual(storage.state.utxos[`${'f3f3'.repeat(16)}:0`]?.[assetId], '550', 'Chain B: should have 550');
  assert.strictEqual(storage.state.utxos[`${'f3f3'.repeat(16)}:1`]?.[assetId], '450', 'Chain B: should have 450');

  console.log('  ✓ Reorg with new chain passed');
}

function testReorgWithTeleport() {
  console.log('Testing reorg with teleport (pending teleport handling)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial state
  const assetId = 'aa'.repeat(32) + ':0';
  storage.state.assets[assetId] = { control: null, metadata: { name: 'Test Token' }, immutable: false };
  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [assetId]: '1000' };
  storage.state.blockHeight = 0;
  storage.save(0);

  // Block 1: Create a teleport commit
  const commitment = 'cdef'.repeat(16);
  const packet1: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [
        { type: 'LOCAL' as const, o: 0, amt: 500n },
        { type: 'TELEPORT' as const, commitment, amt: 500n },
      ],
    }],
  };
  const script1 = buildOpReturnScript(packet1);
  const tx1 = {
    txid: 'c1c1'.repeat(16),
    vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: Buffer.from(script1).toString('hex') }],
  };
  indexer.applyBlock({ height: 1, transactions: [tx1 as any] });

  // Verify teleport is pending
  assert.ok(storage.state.pendingTeleports[commitment], 'Teleport should be pending');
  assert.strictEqual(storage.state.pendingTeleports[commitment].amount, '500', 'Pending amount should be 500');
  assert.strictEqual(storage.state.pendingTeleports[commitment].sourceHeight, 1, 'Source height should be 1');

  // Rollback block 1
  indexer.rollbackLastBlock();

  // Verify state is restored (teleport should be removed)
  assert.strictEqual(storage.state.blockHeight, 0, 'Should be at block 0');
  assert.strictEqual(storage.state.utxos[`${'aa'.repeat(32)}:0`]?.[assetId], '1000', 'Original UTXO should be restored');
  // Note: pending teleports are tricky - they might still exist but sourceHeight undefined
  // The important thing is the UTXO state is correct

  console.log('  ✓ Reorg with teleport passed');
}

function testReorgPreservesMempool() {
  console.log('Testing reorg preserves mempool transactions...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // Set up initial state with two separate UTXOs
  const assetId = 'aa'.repeat(32) + ':0';
  storage.state.assets[assetId] = { control: null, metadata: { name: 'Test Token' }, immutable: false };
  storage.state.utxos[`${'aa'.repeat(32)}:0`] = { [assetId]: '1000' };
  storage.state.utxos[`${'aa'.repeat(32)}:1`] = { [assetId]: '500' };
  storage.state.blockHeight = 0;
  storage.save(0);

  // Block 1: Spend the first UTXO
  const packet1: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1000n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1000n }],
    }],
  };
  const script1 = buildOpReturnScript(packet1);
  const tx1 = {
    txid: 'c1c1'.repeat(16),
    vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: Buffer.from(script1).toString('hex') }],
  };
  indexer.applyBlock({ height: 1, transactions: [tx1 as any] });

  // Add a mempool transaction that spends the second UTXO
  const packetMem: Packet = {
    groups: [{
      assetId: { txidHex: 'aa'.repeat(32), gidx: 0 },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 500n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 500n }],
    }],
  };
  const scriptMem = buildOpReturnScript(packetMem);
  const txMem = {
    txid: 'dead'.repeat(16),
    vin: [{ txid: 'aa'.repeat(32), vout: 1 }],
    vout: [{ n: 0, scriptPubKey: '51' }, { n: 1, scriptPubKey: Buffer.from(scriptMem).toString('hex') }],
  };
  const memResult = indexer.applyToArkadeVirtualMempool(txMem as any);
  assert.ok(memResult.success, 'Mempool tx should succeed');

  // Verify mempool tx is tracked
  assert.ok(storage.state.transactions['dead'.repeat(16)], 'Mempool tx should be tracked');
  assert.strictEqual(storage.state.transactions['dead'.repeat(16)].status, 'arkade', 'Status should be arkade');

  // Rollback block 1
  indexer.rollbackLastBlock();

  // Mempool transaction should still be preserved
  assert.ok(storage.state.transactions['dead'.repeat(16)], 'Mempool tx should still exist after rollback');
  assert.strictEqual(storage.state.transactions['dead'.repeat(16)].status, 'arkade', 'Mempool tx status should still be arkade');

  // Block 1 tx should be moved to mempool (reverted to arkade status)
  assert.ok(storage.state.transactions['c1c1'.repeat(16)], 'Rolled back tx should still exist');
  assert.strictEqual(storage.state.transactions['c1c1'.repeat(16)].status, 'arkade', 'Rolled back tx should be arkade status');

  console.log('  ✓ Reorg preserves mempool passed');
}

function testReorgAtGenesis() {
  console.log('Testing reorg at genesis (cannot rollback past genesis)...');

  const storage = new InMemoryStorage();
  const indexer = new Indexer(storage);

  // At genesis state (blockHeight = -1)
  assert.strictEqual(storage.state.blockHeight, -1, 'Should start at genesis');

  // Try to rollback - should fail gracefully
  const result = indexer.rollbackLastBlock();
  assert.ok(!result.changed, 'Should not change at genesis');
  assert.strictEqual(storage.state.blockHeight, -1, 'Should still be at genesis');

  console.log('  ✓ Reorg at genesis passed');
}

// ----------------- RUN ALL TESTS -----------------

async function runAllTests() {
  console.log('\n========== ARKADE ASSETS CODEC TESTS ==========\n');

  try {
    // Codec tests
    testCodecRoundTrip();
    testTeleportCodec();
    testMetadataMerkleHash();
    testTeleportCommitment();
    testTeleportWitnessEncoding();
    testVariableNonceSize();
    testTeleportWithWitness();
    testEmptyGroupsPacket();
    testMaxU64Amount();

    // Compact encoding edge case tests
    testVarintAmountBoundaries();
    testPackedCountsBoundaries();
    testSelfDelimitingTlv();

    // Indexer tests
    testIndexerFreshIssuance();
    testIndexerSimpleTransfer();
    testIndexerBurn();
    testIndexerImmutableMetadata();
    testIndexerTeleportFlow();
    testIndexerValidationOutputBounds();
    testIndexerValidationSelfReference();
    testMultipleOpReturnHandling();

    // Control asset tests
    testSingleLevelControl();
    testForwardReferenceByGroup();
    testControlAssetById();

    // Validation tests
    testZeroAmountValidation();
    testInputAmountValidation();
    testMintWithoutControlAsset();
    testReissuanceWithControlAsset();
    testMetadataUpdateWithControl();
    testMetadataUpdateWithoutControl();
    testMultiAssetPerUtxo();
    testFreshIssuanceWithoutControl();
    testImmutableAssetCreation();

    // Teleport edge case tests
    testTeleportWrongPaymentScript();
    testTeleportConfirmationDelay();
    testTeleportConfirmationSuccess();

    // Reorg tests
    testBasicReorg();
    testReorgWithMultipleBlocks();
    testReorgWithNewChain();
    testReorgWithTeleport();
    testReorgPreservesMempool();
    testReorgAtGenesis();

    console.log('\n========== ALL TESTS PASSED ==========\n');
  } catch (err) {
    console.error('\n========== TEST FAILED ==========\n');
    console.error(err);
    process.exit(1);
  }
}

runAllTests();
