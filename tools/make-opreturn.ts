// tools/make-opreturn.ts
// Generate a transaction JSON embedding an ArkAsset OP_RETURN.
// Supports --example=A (predefined) or --groups=file.json (custom JSON groups).

import { buildOpReturnScript, bufToHex, Packet } from './arkade-assets-codec';

interface TxVout {
  n: number;
  scriptPubKey: string;
}

export interface Tx {
  txid: string;
  vin: any[]; // Simplified for this tool
  vout: TxVout[];
}


export function buildTxFromPayload(payload: Packet, txidHex: string, vins: any[] = []): Tx {
  const script = buildOpReturnScript(payload);
  const scriptHex = bufToHex(script);
  // Determine number of asset outputs to create placeholder vouts
  const maxVoutIndex = payload.groups?.reduce((maxIdx, g) => {
    const groupMax = g.outputs
      ?.filter(o => o.type === 'LOCAL')
      .reduce((maxO, out) => Math.max(maxO, out.o), -1) ?? -1;
    return Math.max(maxIdx, groupMax);
  }, -1) ?? -1;
  const numAssetOutputs = maxVoutIndex + 1;
  
  const vout: TxVout[] = [];
  for (let i = 0; i < numAssetOutputs; i++) {
    vout.push({ n: i, scriptPubKey: '51' }); // Placeholder
  }
  vout.push({ n: numAssetOutputs, scriptPubKey: scriptHex });

  return {
    txid: txidHex,
    vin: vins,
    vout,
  };
}

