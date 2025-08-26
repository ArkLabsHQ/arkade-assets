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
  // Example A (revised): fresh issuance with control present (Δ arbitrary; example shows Δ=0 and pre-existing control)
  const controlTxidHex = '11'.repeat(32); // placeholder previous control txid
  const controlGidx = 0;
  const groups: Packet['groups'] = [
    // Group[0] Control: control present (Δ arbitrary; here Δ=0, input vin[0] -> output 0); references pre-existing assetId
    { assetId: { txidHex: controlTxidHex, gidx: controlGidx }, inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }], outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }] },
    // Group[1] Token: fresh, controlled by group 0, outputs 1:500, 2:500
    { control: { gidx: 0 }, inputs: [], outputs: [{ type: 'LOCAL' as const, o: 1, amt: 500n }, { type: 'LOCAL' as const, o: 2, amt: 500n }] },
  ];
  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);
  return {
    txid: txidHex,
    // vin[0] must reference a UTXO holding 1 unit of the control asset
    vin: [{ txid: controlTxidHex, vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Control re-output
      { n: 1, scriptPubKey: '51' }, // Token out #1
      { n: 2, scriptPubKey: '51' }, // Token out #2
      { n: 3, scriptPubKey: scriptHex }, // OP_RETURN
    ],
  };
}

export function exampleC(txidHex: string): Tx {
  // Example C: fresh control and fresh token in the same tx.
  // Group[0] mints the control asset (fresh). Group[1] mints a token controlled by group[0].
  const groups: Packet['groups'] = [
    // Group[0] Control: fresh, outputs to vout 0 (Δ>0)
    { inputs: [], outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }] },
    // Group[1] Token: fresh, controlled by group 0, outputs to vout 1 (Δ>0)
    { control: { gidx: 0 }, inputs: [], outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }] },
  ];
  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);
  return {
    txid: txidHex,
    vin: [],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Control freshly minted
      { n: 1, scriptPubKey: '51' }, // Token freshly minted
      { n: 2, scriptPubKey: scriptHex }, // OP_RETURN
    ],
  };
}

export function exampleD_commit(commitTxidHex: string): Tx {
  // Example D (Commit): ArkadeKitties commit-reveal breeding, step 1.
  // Spends Species Control, Sire, and Dame. Creates a temporary commit UTXO.

  // Mock Asset IDs
  const speciesControlId = { txidHex: '33'.repeat(32), gidx: 0 };
  const sireId = { txidHex: '44'.repeat(32), gidx: 1 };
  const dameId = { txidHex: '55'.repeat(32), gidx: 1 };

  // In a real scenario, the revealScript would be the compiled script of the
  // BreedReveal contract, parameterized with constants from this commit.
  // For this example, we'll use a placeholder script.
  const revealScriptHex = '6a'; // Placeholder for reveal script

  const groups: Packet['groups'] = [
    // Group 0: Species Control (retained, Δ=0)
    { assetId: speciesControlId, inputs: [{ type: 'LOCAL', i: 0, amt: 1n }], outputs: [{ type: 'LOCAL', o: 0, amt: 1n }] },
    // Group 1: Sire Kitty (retained, Δ=0)
    { assetId: sireId, inputs: [{ type: 'LOCAL', i: 1, amt: 1n }], outputs: [{ type: 'LOCAL', o: 1, amt: 1n }] },
    // Group 2: Dame Kitty (retained, Δ=0)
    { assetId: dameId, inputs: [{ type: 'LOCAL', i: 2, amt: 1n }], outputs: [{ type: 'LOCAL', o: 2, amt: 1n }] },
  ];

  const opReturnScript = buildOpReturnScript({ groups });
  const opReturnScriptHex = bufToHex(opReturnScript);

  return {
    txid: commitTxidHex,
    vin: [
      { txid: speciesControlId.txidHex, vout: 0 }, // Spends species control UTXO
      { txid: sireId.txidHex, vout: 1 },           // Spends sire UTXO
      { txid: dameId.txidHex, vout: 1 },           // Spends dame UTXO
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Species Control re-output
      { n: 1, scriptPubKey: '51' }, // Sire re-output
      { n: 2, scriptPubKey: '51' }, // Dame re-output
      { n: 3, scriptPubKey: revealScriptHex }, // The temporary commit UTXO
      { n: 4, scriptPubKey: opReturnScriptHex }, // OP_RETURN
    ],
  };
}

export function exampleD_reveal(revealTxidHex: string, commitTx: Tx): Tx {
  // Example D (Reveal): ArkadeKitties commit-reveal breeding, step 2.
  // Spends the commit UTXO and creates the new Kitty.

  const speciesControlId = { txidHex: '33'.repeat(32), gidx: 0 };

  // Mock metadata for the new kitty. In a real scenario, the genome would be
  // derived from the parents, user salt, and oracle randomness.
  const newKittyMetadata = {
    name: "Kitty #123",
    "custom-field": "abc",
    generation: "2",
    genome: "0x" + 'ab'.repeat(32),
  };

  const groups: Packet['groups'] = [
    // Group 0: New Kitty (freshly minted, controlled by species control)
    {
      control: { txidHex: speciesControlId.txidHex, gidx: speciesControlId.gidx },
      metadata: newKittyMetadata,
      inputs: [],
      outputs: [{ type: 'LOCAL', o: 0, amt: 1n }]
    }
  ];

  const opReturnScript = buildOpReturnScript({ groups });
  const opReturnScriptHex = bufToHex(opReturnScript);

  return {
    txid: revealTxidHex,
    vin: [
      // Spends the commit UTXO from the previous transaction (vout[3])
      { txid: commitTx.txid, vout: 3 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // The new Kitty output
      { n: 1, scriptPubKey: opReturnScriptHex }, // OP_RETURN
    ],
  };
}

export function exampleB(txidHex: string): Tx {
  // Example B: token with metadata, control present (Δ arbitrary; example shows Δ=0 with pre-existing control)
  const controlTxidHex = '22'.repeat(32); // placeholder previous control txid
  const controlGidx = 0;
  const groups: Packet['groups'] = [
    {
      assetId: { txidHex: controlTxidHex, gidx: controlGidx },
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }]
    },
    {
      control: { gidx: 0 },
      metadata: {
        name: "My Test Token",
        ticker: "MTT",
        decimals: "8"
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }]
    }
  ];
  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);
  return {
    txid: txidHex,
    vin: [{ txid: controlTxidHex, vout: 0 }],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Control re-output
      { n: 1, scriptPubKey: '51' }, // Token output
      { n: 2, scriptPubKey: scriptHex }, // OP_RETURN
    ],
  };
}
