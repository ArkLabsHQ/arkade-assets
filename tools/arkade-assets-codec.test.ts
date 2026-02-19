import * as assert from 'assert';
import {
  Packet,
  buildOpReturnScript,
  parseOpReturnScript,
  buildOpReturnPayload,
  Config,
  computeMetadataMerkleRootHex,
  computeMetadataLeafHash,
  computeMetadataMerkleRoot,
  computeMetadataMerkleProof,
  computeBranchHash,
  verifyMerkleProof,
  taggedHash,
  ARK_LEAF_VERSION,
  hexToBytes,
  bufToHex,
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
  exampleL_multi_asset_per_tx,
} from './example-txs';

// ----------------- IN-MEMORY STORAGE FOR TESTS -----------------

class InMemoryStorage implements Storage {
  public state: State;
  private snapshots: Map<number, State> = new Map();

  constructor() {
    this.state = { assets: {}, utxos: {}, transactions: {}, blockHeight: -1 };
  }

  load(height?: number): void {
    if (height === undefined) {
      // Find latest
      const heights = Array.from(this.snapshots.keys());
      height = heights.length > 0 ? Math.max(...heights) : -1;
    }
    if (height === -1) {
      this.state = { assets: {}, utxos: {}, transactions: {}, blockHeight: -1 };
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

function testLittleEndianIndexEncoding() {
  console.log('Testing little-endian index encoding...');

  // Test that u16 index fields are encoded in little-endian (matching Bitcoin convention)
  const packet: Packet = {
    groups: [{
      issuance: { metadata: { name: 'LE Test' } },
      inputs: [{ type: 'LOCAL' as const, i: 0x0102, amt: 1n }],  // 258 decimal
      outputs: [{ type: 'LOCAL' as const, o: 0x0304, amt: 1n }], // 772 decimal
    }],
  };

  const script = buildOpReturnScript(packet);
  const decoded = parseOpReturnScript(script);

  assert.ok(decoded, 'Should decode LE packet');
  assert.strictEqual(decoded.groups?.[0].inputs[0].type, 'LOCAL');
  const inp = decoded.groups![0].inputs[0] as any;
  assert.strictEqual(inp.i, 0x0102, 'Input index should round-trip correctly');

  const out = decoded.groups![0].outputs[0] as any;
  assert.strictEqual(out.o, 0x0304, 'Output index should round-trip correctly');

  // Verify the round-trip works, which confirms LE encoding is consistent
  const payload = buildOpReturnPayload(packet);
  assert.ok(payload.length > 0, 'Payload should be non-empty');

  console.log('  ✓ Little-endian index encoding passed');
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

// ----------------- MERKLE TREE TESTS (BIP-341-aligned) -----------------

function testTaggedHashDomainSeparation() {
  console.log('Testing tagged hash domain separation...');

  const msg = new Uint8Array([0x01, 0x02, 0x03]);

  // Different tags must produce different hashes for the same message
  const h1 = taggedHash('ArkadeAssetLeaf', msg);
  const h2 = taggedHash('ArkadeAssetBranch', msg);
  const h3 = taggedHash('TapLeaf', msg);

  assert.notDeepStrictEqual(h1, h2, 'ArkadeAssetLeaf and ArkadeAssetBranch should differ');
  assert.notDeepStrictEqual(h1, h3, 'ArkadeAssetLeaf and TapLeaf should differ');
  assert.notDeepStrictEqual(h2, h3, 'ArkadeAssetBranch and TapLeaf should differ');

  // Same tag + same message must be deterministic
  const h1b = taggedHash('ArkadeAssetLeaf', msg);
  assert.deepStrictEqual(h1, h1b, 'Same tag+msg should be deterministic');

  console.log('  ✓ Tagged hash domain separation passed');
}

function testLeafUsesArkadeAssetLeafTag() {
  console.log('Testing leaf uses ArkadeAssetLeaf tagged hash with version byte...');

  const leaf = computeMetadataLeafHash('name', 'Token');

  // Manually compute expected: tagged_hash("ArkadeAssetLeaf", 0x00 || varuint(4) || "name" || varuint(5) || "Token")
  const te = new TextEncoder();
  const expected = taggedHash('ArkadeAssetLeaf', new Uint8Array([
    ARK_LEAF_VERSION,
    4, ...te.encode('name'),
    5, ...te.encode('Token'),
  ]));

  assert.deepStrictEqual(leaf, expected, 'Leaf should use tagged_hash("ArkadeAssetLeaf", version || data)');
  assert.strictEqual(leaf.length, 32, 'Leaf hash should be 32 bytes');

  console.log('  ✓ Leaf uses ArkadeAssetLeaf tagged hash passed');
}

function testBranchUsesLexicographicSorting() {
  console.log('Testing branch uses lexicographic sorting (ArkadeAssetBranch)...');

  const a = computeMetadataLeafHash('aaa', 'val1');
  const b = computeMetadataLeafHash('bbb', 'val2');

  // computeBranchHash should sort, so order of arguments shouldn't matter
  const hash_ab = computeBranchHash(a, b);
  const hash_ba = computeBranchHash(b, a);

  assert.deepStrictEqual(hash_ab, hash_ba, 'Branch hash must be order-independent (sorted)');

  // Verify it's actually using ArkadeAssetBranch tag
  let first = a, second = b;
  for (let i = 0; i < 32; i++) {
    if (a[i] < b[i]) break;
    if (a[i] > b[i]) { first = b; second = a; break; }
  }
  const expected = taggedHash('ArkadeAssetBranch', new Uint8Array([...first, ...second]));
  assert.deepStrictEqual(hash_ab, expected, 'Branch should use tagged_hash("ArkadeAssetBranch", sorted(a,b))');

  console.log('  ✓ Branch uses lexicographic sorting passed');
}

function testMerkleProofGeneration() {
  console.log('Testing Merkle proof generation and verification...');

  const metadata = { name: 'TestToken', ticker: 'TST', decimals: '8' };
  const root = computeMetadataMerkleRoot(metadata);

  // Generate and verify proof for each key
  for (const key of Object.keys(metadata)) {
    const proof = computeMetadataMerkleProof(metadata, key);
    assert.ok(proof !== null, `Proof for "${key}" should not be null`);

    const leafHash = computeMetadataLeafHash(key, metadata[key]);
    const valid = verifyMerkleProof(leafHash, proof!, root);
    assert.ok(valid, `Proof for "${key}" should verify against root`);
  }

  // Non-existent key should return null
  const badProof = computeMetadataMerkleProof(metadata, 'nonexistent');
  assert.strictEqual(badProof, null, 'Non-existent key should return null proof');

  console.log('  ✓ Merkle proof generation and verification passed');
}

function testMerkleProofSingleEntry() {
  console.log('Testing Merkle proof for single-entry metadata...');

  const metadata = { genome: 'deadbeef' };
  const root = computeMetadataMerkleRoot(metadata);
  const proof = computeMetadataMerkleProof(metadata, 'genome');

  assert.ok(proof !== null, 'Proof should exist');
  assert.strictEqual(proof!.length, 0, 'Single-leaf tree should have empty proof path');

  // Root should equal the leaf hash directly
  const leafHash = computeMetadataLeafHash('genome', 'deadbeef');
  assert.deepStrictEqual(root, leafHash, 'Single-leaf root should equal the leaf hash');

  const valid = verifyMerkleProof(leafHash, proof!, root);
  assert.ok(valid, 'Single-leaf proof should verify');

  console.log('  ✓ Merkle proof single entry passed');
}

function testMerkleProofTwoEntries() {
  console.log('Testing Merkle proof for two-entry metadata (ArkadeKitties pattern)...');

  // This matches the ArkadeKitties pattern: generation + genome
  const metadata = { generation: '0', genome: '733833e4519f1811c5f81b12ab391cb3' };
  const root = computeMetadataMerkleRoot(metadata);

  // Keys sort: "generation" < "genome"
  const genLeaf = computeMetadataLeafHash('generation', '0');
  const genomeLeaf = computeMetadataLeafHash('genome', '733833e4519f1811c5f81b12ab391cb3');

  // Root should be ArkadeAssetBranch(sorted(genLeaf, genomeLeaf))
  const expectedRoot = computeBranchHash(genLeaf, genomeLeaf);
  assert.deepStrictEqual(root, expectedRoot, 'Two-leaf root should be branch(sorted(leaf1, leaf2))');

  // Verify proofs for both keys
  const proofGen = computeMetadataMerkleProof(metadata, 'generation');
  assert.ok(proofGen !== null && proofGen.length === 1, 'generation proof should have 1 sibling');
  assert.deepStrictEqual(proofGen![0], genomeLeaf, 'generation sibling should be genome leaf');
  assert.ok(verifyMerkleProof(genLeaf, proofGen!, root), 'generation proof should verify');

  const proofGenome = computeMetadataMerkleProof(metadata, 'genome');
  assert.ok(proofGenome !== null && proofGenome.length === 1, 'genome proof should have 1 sibling');
  assert.deepStrictEqual(proofGenome![0], genLeaf, 'genome sibling should be generation leaf');
  assert.ok(verifyMerkleProof(genomeLeaf, proofGenome!, root), 'genome proof should verify');

  console.log('  ✓ Merkle proof two entries passed');
}

function testMerkleProofWrongValue() {
  console.log('Testing Merkle proof rejects wrong value...');

  const metadata = { name: 'Token', ticker: 'TKN' };
  const root = computeMetadataMerkleRoot(metadata);
  const proof = computeMetadataMerkleProof(metadata, 'name');
  assert.ok(proof !== null);

  // Correct leaf verifies
  const correctLeaf = computeMetadataLeafHash('name', 'Token');
  assert.ok(verifyMerkleProof(correctLeaf, proof!, root), 'Correct leaf should verify');

  // Wrong value for same key should NOT verify
  const wrongLeaf = computeMetadataLeafHash('name', 'FakeToken');
  assert.ok(!verifyMerkleProof(wrongLeaf, proof!, root), 'Wrong value should not verify');

  console.log('  ✓ Merkle proof rejects wrong value passed');
}

function testMerkleProofOddLeafCount() {
  console.log('Testing Merkle proof with odd leaf counts (3, 5, 7)...');

  for (const count of [3, 5, 7]) {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      metadata[`key${String(i).padStart(2, '0')}`] = `val${i}`;
    }

    const root = computeMetadataMerkleRoot(metadata);

    for (const key of Object.keys(metadata)) {
      const proof = computeMetadataMerkleProof(metadata, key);
      assert.ok(proof !== null, `Proof for "${key}" should exist (count=${count})`);

      const leaf = computeMetadataLeafHash(key, metadata[key]);
      assert.ok(
        verifyMerkleProof(leaf, proof!, root),
        `Proof for "${key}" should verify (count=${count})`
      );
    }
  }

  console.log('  ✓ Merkle proof odd leaf counts passed');
}

// ----------------- RUN ALL TESTS -----------------

async function runAllTests() {
  console.log('\n========== ARKADE ASSETS CODEC TESTS ==========\n');

  try {
    // Codec tests
    testCodecRoundTrip();
    testMetadataMerkleHash();
    testEmptyGroupsPacket();
    testMaxU64Amount();

    // Compact encoding edge case tests
    testVarintAmountBoundaries();
    testLittleEndianIndexEncoding();
    testSelfDelimitingTlv();

    // Taproot-aligned merkle tree tests
    testTaggedHashDomainSeparation();
    testLeafUsesArkadeAssetLeafTag();
    testBranchUsesLexicographicSorting();
    testMerkleProofGeneration();
    testMerkleProofSingleEntry();
    testMerkleProofTwoEntries();
    testMerkleProofWrongValue();
    testMerkleProofOddLeafCount();

    // Indexer tests
    testIndexerFreshIssuance();
    testIndexerSimpleTransfer();
    testIndexerBurn();
    testIndexerImmutableMetadata();
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

    // Reorg tests
    testBasicReorg();
    testReorgWithMultipleBlocks();
    testReorgWithNewChain();
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
