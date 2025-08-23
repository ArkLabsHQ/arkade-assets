// tools/example-txs.ts
// Example transactions for ArkAssetV1.

import { buildOpReturnScript, bufToHex, Packet } from './arkass-codec';

interface TxVout {
  n: number;
  scriptPubKey: string;
}

interface Tx {
  txid: string;
  vin: any[]; // Simplified for this tool
  vout: TxVout[];
}

export function exampleA(txidHex: string): Tx {
  const groups: Packet['groups'] = [
    // Group[0] C: fresh, output 0:1
    { inputs: [], outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }] },
    // Group[1] A: fresh, control group 0, outputs 1:500, 2:500
    { control: { gidx: 0 }, inputs: [], outputs: [{ type: 'LOCAL' as const, o: 1, amt: 500n }, { type: 'LOCAL' as const, o: 2, amt: 500n }] },
  ];
  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);
  // Place OP_RETURN at vout index 3; asset outputs are at 0,1,2 as above
  return {
    txid: txidHex,
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' }, // OP_1 placeholder
      { n: 1, scriptPubKey: '51' },
      { n: 2, scriptPubKey: '51' },
      { n: 3, scriptPubKey: scriptHex },
    ],
  };
}

export function exampleB(txidHex: string): Tx {
  const groups: Packet['groups'] = [
    // Group[0] (Control Asset): fresh, no metadata, 1 unit to output 0
    {
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }]
    },
    // Group[1] (Token): fresh, controlled by group 0, with metadata
    {
        control: { gidx: 0 },
        metadata: {
            "name": "My Test Token",
            "ticker": "MTT",
            "decimals": "8"
        },
        inputs: [],
        outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }]
    }
  ];
  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);
  return {
      txid: txidHex,
      vin: [],
      vout: [
          { n: 0, scriptPubKey: '51' }, // Placeholder for control asset
          { n: 1, scriptPubKey: '51' }, // Placeholder for token
          { n: 2, scriptPubKey: scriptHex }, // OP_RETURN
      ],
  };
}
