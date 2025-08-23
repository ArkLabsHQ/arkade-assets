// tools/cli.ts
// Command-line interface for ArkAsset tools.

import * as fs from 'fs';
import * as path from 'path';
import { buildTxFromPayload } from './make-opreturn';
import { exampleA, exampleB } from './example-txs';
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
    switch (args.example.toUpperCase()) {
      case 'A':
        tx = exampleA(txidHex);
        break;
      case 'B':
        tx = exampleB(txidHex);
        break;
      default:
        console.error(`Unknown example: ${args.example}`);
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
    console.error('Usage: cli.ts make-tx --example=A|B or --groups=path/to/groups.json');
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
