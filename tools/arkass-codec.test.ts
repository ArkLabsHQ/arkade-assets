import * as assert from 'assert';
import {
  Packet,
  buildOpReturnScript,
  parseOpReturnScript,
  Config,
} from './arkass-codec';

function testCodec() {
  console.log('Running codec tests...');

  const originalPacket: Packet = {
    groups: [
      {
        assetId: { txidHex: 'a'.repeat(64), gidx: 1 },
        control: { txidHex: 'b'.repeat(64), gidx: 2 },
        metadata: { 'key': 'value' },
        inputs: [
          { type: 'LOCAL', i: 0, amt: 100n },
          { type: 'TELEPORT', commitment: 'c'.repeat(64), amt: 200n },
        ],
        outputs: [
          { type: 'LOCAL', o: 1, amt: 50n },
          { type: 'TELEPORT', commitment: 'd'.repeat(64), amt: 250n },
        ],
      },
      {
        assetId: { txidHex: 'e'.repeat(64), gidx: 3 },
        inputs: [],
        outputs: [],
      },
    ],
  };

  // Convert bigints to strings for comparison, as they are stringified in the codec
  const expectedPacket = JSON.parse(JSON.stringify(originalPacket, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));

  Config.txidLE = false;
  Config.u16LE = true;
  Config.u64LE = true;

  const script = buildOpReturnScript(originalPacket);
  const decodedPacket = parseOpReturnScript(script);

  try {
    assert.deepStrictEqual(decodedPacket, expectedPacket, 'Decoded packet does not match original');
  } catch (err) {
    console.error('Decoded packet:', JSON.stringify(decodedPacket, null, 2));
    console.error('Expected packet:', JSON.stringify(expectedPacket, null, 2));
    throw err;
  }

  console.log('Codec tests passed!');
}

testCodec();
