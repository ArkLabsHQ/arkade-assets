// tools/example-txs.ts
// Example transactions for Arkade Asset V1.

import { buildOpReturnScript, bufToHex, Packet, TeleportWitness } from './arkade-assets-codec';

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
  // Example A (revised): fresh issuance with a pre-existing control asset.
  const controlTxidHex = '11'.repeat(32);
  const controlGidx = 0;
  const groups: Packet['groups'] = [
    // Group[0] Control: A pre-existing control asset, spent and re-created.
    { assetId: { txidHex: controlTxidHex, gidx: controlGidx }, inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }], outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }] },
    // Group[1] Token: A fresh issuance, controlled by group 0.
    {
      issuance: {
        controlAsset: { gidx: 0 },
        metadata: { name: 'Token A' },
        immutable: false,
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 500n }, { type: 'LOCAL' as const, o: 2, amt: 500n }]
    },
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
    {
      issuance: {
        controlAsset: { gidx: 0 },
        metadata: { name: 'Token C' },
        immutable: false,
      },
      inputs: [],
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 1000n }]
    },
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
      issuance: {
        controlAsset: { txidHex: speciesControlId.txidHex, gidx: speciesControlId.gidx },
        metadata: newKittyMetadata,
        immutable: true,
      },
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

export function exampleE_metadata_update(txidHex: string): Tx {
  // Example E: metadata update for an existing asset.
  // Spends the control asset and the token, and re-creates both with updated metadata for the token.
  const controlAssetId = { txidHex: 'cc'.repeat(32), gidx: 0 };
  const tokenId = { txidHex: 'dd'.repeat(32), gidx: 1 };

  const groups: Packet['groups'] = [
    // Group 0: Control asset (retained, Δ=0)
    {
      assetId: controlAssetId,
      inputs: [{ type: 'LOCAL', i: 0, amt: 1n }],
      outputs: [{ type: 'LOCAL', o: 0, amt: 1n }]
    },
    // Group 1: Token with updated metadata
    {
      assetId: tokenId,
      metadata: { 'description': 'This token has new and improved metadata!' },
      inputs: [{ type: 'LOCAL', i: 1, amt: 1000n }],
      outputs: [{ type: 'LOCAL', o: 1, amt: 1000n }]
    }
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: controlAssetId.txidHex, vout: 0 }, // Spends control UTXO
      { txid: tokenId.txidHex, vout: 1 },      // Spends token UTXO
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Control re-output
      { n: 1, scriptPubKey: '51' }, // Token re-output
      { n: 2, scriptPubKey: scriptHex }, // OP_RETURN
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
      issuance: {
        controlAsset: { gidx: 0 },
        metadata: {
          name: "My Test Token",
          ticker: "MTT",
          decimals: "8"
        },
        immutable: false,
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

// ==================== SIMPLE TRANSFER ====================

export function exampleF_simple_transfer(txidHex: string): Tx {
  // Example F: Simple transfer - move tokens from one UTXO to another
  // Σin = Σout (no issuance, no burn)
  const tokenAssetId = { txidHex: '70'.repeat(32), gidx: 0 };

  const groups: Packet['groups'] = [
    {
      assetId: tokenAssetId,
      inputs: [
        { type: 'LOCAL' as const, i: 0, amt: 100n },
        { type: 'LOCAL' as const, i: 1, amt: 40n },
      ],
      outputs: [
        { type: 'LOCAL' as const, o: 0, amt: 70n },
        { type: 'LOCAL' as const, o: 1, amt: 70n },
      ],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: tokenAssetId.txidHex, vout: 0 },
      { txid: tokenAssetId.txidHex, vout: 1 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' },
      { n: 1, scriptPubKey: '51' },
      { n: 2, scriptPubKey: scriptHex },
    ],
  };
}

// ==================== ASSET BURN ====================

export function exampleG_burn(txidHex: string): Tx {
  // Example G: Burn tokens - Σin > Σout
  const tokenAssetId = { txidHex: '88'.repeat(32), gidx: 0 };

  const groups: Packet['groups'] = [
    {
      assetId: tokenAssetId,
      inputs: [
        { type: 'LOCAL' as const, i: 0, amt: 30n },
        { type: 'LOCAL' as const, i: 1, amt: 10n },
      ],
      outputs: [], // No outputs = all 40 tokens burned
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: tokenAssetId.txidHex, vout: 0 },
      { txid: tokenAssetId.txidHex, vout: 1 },
    ],
    vout: [
      { n: 0, scriptPubKey: scriptHex }, // Only OP_RETURN
    ],
  };
}

// ==================== REISSUANCE WITH CONTROL ====================

export function exampleH_reissuance(txidHex: string): Tx {
  // Example H: Reissuance - Σout > Σin with control asset present
  const controlAssetId = { txidHex: 'cc'.repeat(32), gidx: 0 };
  const tokenAssetId = { txidHex: 'aa'.repeat(32), gidx: 1 };

  const groups: Packet['groups'] = [
    // Control asset (must be present for reissuance)
    {
      assetId: controlAssetId,
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 1n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 1n }],
    },
    // Token being reissued (200 in, 230 out = +30 new tokens)
    {
      assetId: tokenAssetId,
      inputs: [{ type: 'LOCAL' as const, i: 1, amt: 200n }],
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 230n }],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: controlAssetId.txidHex, vout: 0 },
      { txid: tokenAssetId.txidHex, vout: 1 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Control re-output
      { n: 1, scriptPubKey: '51' }, // Token output (reissued)
      { n: 2, scriptPubKey: scriptHex },
    ],
  };
}

// ==================== MULTI-ASSET PER UTXO ====================

export function exampleI_multi_asset_per_utxo(txidHex: string): Tx {
  // Example I: Multiple assets in a single UTXO
  // Input 0 contains both Asset X (10) and Asset Y (50)
  const assetX = { txidHex: '55'.repeat(32), gidx: 0 };
  const assetY = { txidHex: '66'.repeat(32), gidx: 1 };

  const groups: Packet['groups'] = [
    {
      assetId: assetX,
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 10n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 10n }],
    },
    {
      assetId: assetY,
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 50n }], // Same input as X!
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 50n }],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: 'ab'.repeat(32), vout: 0 }, // Single input with both assets
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Asset X output
      { n: 1, scriptPubKey: '51' }, // Asset Y output
      { n: 2, scriptPubKey: scriptHex },
    ],
  };
}

// ==================== TELEPORT COMMIT ====================

export function exampleJ_teleport_commit(txidHex: string, commitmentHex: string): Tx {
  // Example J: Teleport commit - send tokens to a teleport output
  const tokenAssetId = { txidHex: 'dd'.repeat(32), gidx: 0 };

  const groups: Packet['groups'] = [
    {
      assetId: tokenAssetId,
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 100n }],
      outputs: [
        { type: 'TELEPORT' as const, commitment: commitmentHex, amt: 100n },
      ],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: tokenAssetId.txidHex, vout: 0 },
    ],
    vout: [
      { n: 0, scriptPubKey: scriptHex }, // Only OP_RETURN (no LOCAL outputs)
    ],
  };
}

// ==================== TELEPORT CLAIM ====================

export function exampleK_teleport_claim(txidHex: string, witness: TeleportWitness): Tx {
  // Example K: Teleport claim - claim tokens from a teleport commitment
  // Commitment is derived from witness as sha256(paymentScript || nonce)
  const tokenAssetId = { txidHex: 'dd'.repeat(32), gidx: 0 };

  const groups: Packet['groups'] = [
    {
      assetId: tokenAssetId,
      inputs: [
        { type: 'TELEPORT' as const, amt: 100n, witness },
      ],
      outputs: [
        { type: 'LOCAL' as const, o: 0, amt: 100n },
      ],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [], // No Bitcoin inputs needed for teleport claim (in Arkade context)
    vout: [
      { n: 0, scriptPubKey: '51' }, // Token output
      { n: 1, scriptPubKey: scriptHex },
    ],
  };
}

// ==================== MULTI-ASSET PER TRANSACTION ====================

export function exampleL_multi_asset_per_tx(txidHex: string): Tx {
  // Example L: Multiple independent asset transfers in one transaction
  const assetP = { txidHex: 'ab'.repeat(32), gidx: 0 };
  const assetQ = { txidHex: 'cd'.repeat(32), gidx: 0 };

  const groups: Packet['groups'] = [
    {
      assetId: assetP,
      inputs: [{ type: 'LOCAL' as const, i: 0, amt: 10n }],
      outputs: [{ type: 'LOCAL' as const, o: 0, amt: 10n }],
    },
    {
      assetId: assetQ,
      inputs: [{ type: 'LOCAL' as const, i: 1, amt: 50n }],
      outputs: [{ type: 'LOCAL' as const, o: 1, amt: 50n }],
    },
  ];

  const script = buildOpReturnScript({ groups });
  const scriptHex = bufToHex(script);

  return {
    txid: txidHex,
    vin: [
      { txid: assetP.txidHex, vout: 0 },
      { txid: assetQ.txidHex, vout: 1 },
    ],
    vout: [
      { n: 0, scriptPubKey: '51' }, // Asset P output
      { n: 1, scriptPubKey: '51' }, // Asset Q output
      { n: 2, scriptPubKey: scriptHex },
    ],
  };
}
