// tools/make-opreturn.js
// Generate a transaction JSON embedding an ArkAsset OP_RETURN.
// Supports --example=A (predefined) or --groups=file.json (custom JSON groups).

const fs = require('fs');
const path = require('path');
const { buildOpReturnScript, bufToHex } = require('./arkass-codec');

function exampleA(txidHex) {
  const groups = [
    // Group[0] C: fresh, output 0:1
    { inputs: [], outputs: [{ o: 0, amt: 1n }] },
    // Group[1] A: fresh, control group 0, outputs 1:500, 2:500
    { control: { gidx: 0 }, inputs: [], outputs: [{ o: 1, amt: 500n }, { o: 2, amt: 500n }] },
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

function exampleB(txidHex) {
  const groups = [
    // Group[0] (Control Asset): fresh, no metadata, 1 unit to output 0
    {
        inputs: [],
        outputs: [{ o: 0, amt: 1n }]
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
        outputs: [{ o: 1, amt: 1000n }]
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

function buildTxFromPayload({ groups = [], updates = [] }, txidHex) {
  const script = buildOpReturnScript({ groups, updates });
  const scriptHex = bufToHex(script);
  
  // Find max output index referenced in groups
  let maxOutput = -1;
  for (const group of groups) {
    for (const out of group.outputs || []) {
      if (out.o > maxOutput) maxOutput = out.o;
    }
  }
  
  // Create vout array with placeholders up to maxOutput, then OP_RETURN
  const vout = [];
  for (let i = 0; i <= maxOutput; i++) {
    vout.push({ n: i, scriptPubKey: '51' }); // OP_1 placeholder
  }
  vout.push({ n: maxOutput + 1, scriptPubKey: scriptHex }); // OP_RETURN
  
  return {
    txid: txidHex,
    vin: [],
    vout
  };
}

function usage() {
  console.error('Usage:');
  console.error('  node tools/make-opreturn.js --example=A|B [--txid <64-hex>]');
  console.error('  node tools/make-opreturn.js [--groups=g.json] [--updates=u.json] [--txid <64-hex>]');
  console.error('');
  console.error('At least one of --groups or --updates must be provided if not using --example.');
  console.error('JSON format for groups: [{ inputs, outputs, control?, metadata? }, ...]');
  console.error('JSON format for updates: [{ assetRef, metadata }, ...]');
}

(function main() {
  const args = process.argv.slice(2);
  
  // Parse txid
  const txidIdx = args.indexOf('--txid');
  let txid = 'aa'.repeat(32); // default dummy txid
  if (txidIdx !== -1) {
    const v = args[txidIdx + 1];
    if (!v || v.length !== 64) { console.error('Invalid --txid; must be 64 hex chars'); process.exit(1); }
    txid = v.toLowerCase();
  }
  
  let tx;
  
  // Check for --example
  const exIdx = args.indexOf('--example');
  if (exIdx !== -1 && args[exIdx + 1]) {
    const example = args[exIdx + 1].toUpperCase();
    if (example === 'A') {
      tx = exampleA(txid);
    } else if (example === 'B') {
      tx = exampleB(txid);
    } else {
      console.error('Unknown example:', example);
      return usage();
    }
  }
  // Check for --groups and/or --updates
  else {
    const groupsIdx = args.indexOf('--groups');
    const updatesIdx = args.indexOf('--updates');

    if (groupsIdx === -1 && updatesIdx === -1) {
      return usage();
    }

    let groups = [];
    let updates = [];

    const parseFile = (filePath) => JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));

    try {
      if (groupsIdx !== -1 && args[groupsIdx + 1]) {
        groups = parseFile(args[groupsIdx + 1]);
        if (!Array.isArray(groups)) throw new Error('Groups JSON must be an array');
        // Convert string amounts to BigInt
        for (const group of groups) {
          for (const out of group.outputs || []) {
            if (typeof out.amt === 'string') out.amt = BigInt(out.amt);
          }
          for (const inp of group.inputs || []) {
            if (typeof inp.amt === 'string') inp.amt = BigInt(inp.amt);
          }
        }
      }

      if (updatesIdx !== -1 && args[updatesIdx + 1]) {
        updates = parseFile(args[updatesIdx + 1]);
        if (!Array.isArray(updates)) throw new Error('Updates JSON must be an array');
      }

      tx = buildTxFromPayload({ groups, updates }, txid);
    } catch (error) {
      console.error('Error reading input file(s):', error.message);
      process.exit(1);
    }
  }
  
  if (!tx) return usage();
  
  process.stdout.write(JSON.stringify(tx, null, 2) + '\n');
})();
