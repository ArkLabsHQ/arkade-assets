// tools/make-opreturn.ts
// Generate a transaction JSON embedding an ArkAsset OP_RETURN.
// Supports --example=A (predefined) or --groups=file.json (custom JSON groups).

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


export function buildTxFromPayload(payload: Packet, txidHex: string): Tx {
  const script = buildOpReturnScript(payload);
  const scriptHex = bufToHex(script);
  // Determine number of asset outputs to create placeholder vouts
  const numAssetOutputs = payload.groups?.reduce((acc, g) => 
    acc + (g.outputs?.filter(o => o.type === 'LOCAL').length || 0), 0) || 0;
  
  const vout: TxVout[] = [];
  for (let i = 0; i < numAssetOutputs; i++) {
    vout.push({ n: i, scriptPubKey: '51' }); // Placeholder
  }
  vout.push({ n: numAssetOutputs, scriptPubKey: scriptHex });

  return {
    txid: txidHex,
    vin: [],
    vout,
  };
}

