// tools/cli.ts
// Command-line interface for Arkade Asset tools.

import * as fs from 'fs';
import * as path from 'path';
import { buildTxFromPayload, Tx } from './make-opreturn';
import { Packet } from './arkade-assets-codec';
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
import { Indexer } from './indexer';
import { NodeFileStorage } from './node-storage';

function parseArgs() {
  const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    acc[key.replace(/^--/, '')] = value === undefined ? true : value;
    return acc;
  }, {} as { [key: string]: string | boolean });
  return args;
}

function handleMakeTx(args: { [key: string]: any }): void {
  const txidHex = args.txid || '00'.repeat(32);
  let tx;

  if (args.example) {
    const commitmentHex = (args.commitment as string) || 'ab'.repeat(32);
    switch (args.example.toUpperCase()) {
      case 'A':
        tx = exampleA(txidHex);
        break;
      case 'B':
        tx = exampleB(txidHex);
        break;
      case 'C':
        tx = exampleC(txidHex);
        break;
      case 'E':
        tx = exampleE_metadata_update(txidHex);
        break;
      case 'F':
        tx = exampleF_simple_transfer(txidHex);
        break;
      case 'G':
        tx = exampleG_burn(txidHex);
        break;
      case 'H':
        tx = exampleH_reissuance(txidHex);
        break;
      case 'I':
        tx = exampleI_multi_asset_per_utxo(txidHex);
        break;
      case 'J':
        tx = exampleJ_teleport_commit(txidHex, commitmentHex);
        break;
      case 'K':
        tx = exampleK_teleport_claim(txidHex, commitmentHex);
        break;
      case 'L':
        tx = exampleL_multi_asset_per_tx(txidHex);
        break;
      default:
        console.error(`Unknown example: ${args.example}`);
        console.error('Available examples: A, B, C, E, F, G, H, I, J, K, L');
        process.exit(1);
    }
  } else if (args['update-metadata']) {
    try {
      const assetIdParts = (args['asset-id'] as string).split(':');
      const controlIdParts = (args['control-id'] as string).split(':');
      const controlVinParts = (args['control-vin'] as string).split(':');
      const assetVinParts = (args['asset-vin'] as string).split(':');
      const metadata = JSON.parse(fs.readFileSync(args['metadata-file'] as string, 'utf8'));

      const payload: Packet = {
        groups: [
          {
            assetId: { txidHex: controlIdParts[0], gidx: parseInt(controlIdParts[1]) },
            inputs: [{ type: 'LOCAL', i: 0, amt: 1n }],
            outputs: [{ type: 'LOCAL', o: parseInt(args['control-vout'] as string), amt: 1n }]
          },
          {
            assetId: { txidHex: assetIdParts[0], gidx: parseInt(assetIdParts[1]) },
            metadata: metadata,
            inputs: [{ type: 'LOCAL', i: 1, amt: BigInt(args['asset-amt'] as string) }],
            outputs: [{ type: 'LOCAL', o: parseInt(args['asset-vout'] as string), amt: BigInt(args['asset-amt'] as string) }]
          }
        ]
      };

      const vins = [
        { txid: controlVinParts[0], vout: parseInt(controlVinParts[1]) },
        { txid: assetVinParts[0], vout: parseInt(assetVinParts[1]) }
      ];

      tx = buildTxFromPayload(payload, txidHex, vins);

    } catch (error: any) {
      console.error(`Error processing update-metadata command: ${error.message}`);
      console.error('Usage: cli.ts make-tx --update-metadata --asset-id=<txid:gidx> --control-id=<txid:gidx> --control-vin=<txid:vout> --asset-vin=<txid:vout> --asset-amt=<amount> --metadata-file=<path> --asset-vout=<n> --control-vout=<n>');
      process.exit(1);
    }
  } else if (args.groups) {
    try {
      const payloadStr = fs.readFileSync(args.groups, 'utf8');
      const payload = JSON.parse(payloadStr, (key, value) => {
        if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
          return BigInt(value.slice(0, -1));
        }
        return value;
      });
      tx = buildTxFromPayload(payload, txidHex);
    } catch (error: any) {
      console.error(`Error reading or parsing groups file: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error('Usage: cli.ts make-tx --example=A|B|C|E | --groups=<file> | --update-metadata ...');
    process.exit(1);
  }

  console.log(JSON.stringify(tx, (key, value) =>
    typeof value === 'bigint' ? value.toString() + 'n' : value, 2));
}

function handleIndexer(args: { [key: string]: any }): void {
  const dataDir = (args.dataDir as string) || path.join(process.cwd(), 'data');
  const storage = new NodeFileStorage(dataDir);
  const indexer = new Indexer(storage);
  const command = process.argv[3]; // e.g., init, apply

  const printState = (state: any) => console.log(JSON.stringify(state, (key, value) =>
    typeof value === 'bigint' ? value.toString() + 'n' : value, 2));

  switch (command) {
    case 'init':
      indexer.store.save(-1);
      console.log(`Indexer state initialized at height -1 in ${indexer.store.getRootDir()}`);
      break;
    case 'apply': {
      const filePath = args.file;
      if (!filePath || typeof filePath !== 'string') {
        console.error('Usage: cli.ts indexer apply --file=<path/to/block.json>');
        process.exit(1);
      }
      const block = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      indexer.applyBlock(block);
      console.log(`Applied block ${block.height}`);
      break;
    }
    case 'add-to-arkade-mempool': {
      const txPath = args.tx;
      if (!txPath || typeof txPath !== 'string') {
        console.error('Usage: cli.ts indexer add-to-arkade-mempool --tx=<path/to/tx.json>');
        return;
      }
      const tx = JSON.parse(fs.readFileSync(txPath, 'utf8'));
      const result = indexer.applyToArkadeVirtualMempool(tx);
      if (result.success) {
        console.log('Transaction added to arkadeVirtualMempool.');
      } else {
        console.error('Failed to add transaction to arkadeVirtualMempool:', result.error);
      }
      break;
    }
    case 'get-speculative-state':
      printState(indexer.getSpeculativeState());
      break;
    case 'get-confirmed-state':
      printState(indexer.store.state);
      break;
    default:
      console.error(`Unknown indexer command: ${command}`);
      console.error('Available commands: init, apply, add-to-arkade-mempool, get-speculative-state, get-confirmed-state');
      process.exit(1);
  }
}

async function main() {
  const args = parseArgs();
  const command = process.argv[2];

  switch (command) {
    case 'make-tx':
      handleMakeTx(args);
      break;
    case 'indexer':
      handleIndexer(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available commands: make-tx, indexer');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
