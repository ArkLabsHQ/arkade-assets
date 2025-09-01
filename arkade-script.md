# Arkade Script Opcodes

This document outlines the introspection opcodes available in Arkade Script for interacting with Arkade Assets, along with the high-level API structure and example contracts.

## Introspection Opcodes

All Asset Ids are handled as **two stack items**: `(txid32, gidx_u16)`.

### Basics

- `OP_TXHASH` → *[out]* `txid32`\
  *Pushes the txid of the current transaction.*

### Groups

- `OP_INSPECTNUMASSETGROUPS` → *[out]* `K`\
  *Number of groups in the Arkade AssetV1 packet.*
- `OP_INSPECTASSETGROUPASSETID k` → *[out]* `assetid_txid32  assetid_gidx_u16`\
  *Resolved AssetId of group **k**. Fresh groups use **this_txid**.*
- `OP_INSPECTASSETGROUPCTRL k` → *[out]* `ctrl_txid32  ctrl_gidx_u16 | OP_0`\
  *Control AssetId if present, else OP_0.*
- `OP_FINDASSETGROUPBYASSETID assetid_txid32 assetid_gidx_u16` → *[out]* `k | OP_0`\
  *Find group index for a given AssetId, or OP_0 if absent.*

### Per-group I/O
- `OP_INSPECTASSETGROUPMETADATAHASH k source_u8` → *[out]* `metadata_hash_bytes32`\
  *Pushes the metadata hash (Merkle root) of group **k**. `source_u8` determines the source: `0` for the existing metadata (from inputs), `1` for the new metadata (from outputs), and `2` to push both (existing then new).*
- `OP_INSPECTASSETGROUPNUM k source_u8` → *[out]* `count_u16` or `count_in_u16 count_out_u16`\
  *Pushes the number of inputs/outputs for group **k**. `source_u8`: `0` for inputs, `1` for outputs, `2` for both (in, then out).*
- `OP_INSPECTASSETGROUP k j source_u8` → *[out]* `type_u8  data...  amount_u64`\
  *Retrieve the j-th input/output of group **k**. `source_u8`: `0` for input, `1` for output.*
- `OP_INSPECTASSETGROUPSUM k source_u8` → *[out]* `sum_u64` or `sum_in_u64 sum_out_u64`\
  *Pushes the sum of input/output amounts for group **k**. `source_u8`: `0` for inputs, `1` for outputs, `2` for both (in, then out).*
### Cross-output (multi-asset per UTXO)

- `OP_INSPECTOUTASSETCOUNT o` → *[out]* `n`\
  *Number of asset entries assigned to output o.*
- `OP_INSPECTOUTASSETAT o t` → *[out]* `assetid_txid32  assetid_gidx_u16  amount_u64`\
  *t-th asset and amount assigned to output o.*
- `OP_INSPECTOUTASSETLOOKUP o assetid_txid32 assetid_gidx_u16` → *[out]* `amount_u64 | OP_0`\
  *Declared amount for given asset at output o, or OP_0 if none.*

### Cross-input (packet-declared)

- `OP_INSPECTINASSETCOUNT i` → *[out]* `n`\
  *Number of assets declared for input i.*
- `OP_INSPECTINASSETAT i t` → *[out]* `assetid_txid32  assetid_gidx_u16  amount_u64`\
  *t-th asset and amount declared for input i.*
- `OP_INSPECTINASSETLOOKUP i assetid_txid32 assetid_gidx_u16` → *[out]* `amount_u64 | OP_0`\
  *Declared amount for given asset at input i, or OP_0 if none.*

### Teleport-specific

- `OP_INSPECTGROUPTELEPORTOUTCOUNT k` → *[out]* `n`\
  *Number of TELEPORT outputs in group k.*
- `OP_INSPECTGROUPTELEPORTOUT k j` → *[out]* `txid_32  vout_u32  amount_u64`\
  *j-th TELEPORT output in group k (target txid, vout, amount).*
- `OP_INSPECTGROUPTELEPORTINCOUNT k` → *[out]* `n`\
  *Number of TELEPORT inputs in group k.*
- `OP_INSPECTGROUPTELEPORTIN k j` → *[out]* `txid_32  vout_u32  amount_u64`\
  *j-th TELEPORT input in group k (source txid, vout, amount).*

---

## Asset Introspection API

Arkade Assets extend Arkade Script with asset-specific introspection, following a pattern similar to other smart contract languages:

```javascript
// Transaction basics
tx.txid;                               // maps to OP_TXHASH

// Asset Group Introspection
tx.assetGroups.length;                    // Number of asset groups -> maps to OP_INSPECTNUMASSETGROUPS
tx.assetGroups.find(AssetId);     // Find a group by asset ID -> maps to OP_FINDASSETGROUPBYASSETID

// AssetGroup Object
tx.assetGroups[i].assetId;            // Asset ID for this group -> maps to OP_INSPECTASSETGROUPASSETID
int tx.assetGroups[i].numInputs;              // -> OP_INSPECTASSETGROUPNUM with source 0
int tx.assetGroups[i].numOutputs;             // -> OP_INSPECTASSETGROUPNUM with source 1
bigint tx.assetGroups[i].sumInputs;           // -> OP_INSPECTASSETGROUPSUM with source 0
bigint tx.assetGroups[i].sumOutputs;          // -> OP_INSPECTASSETGROUPSUM with source 1
tx.assetGroups[i].inputs[j];    // -> OP_INSPECTASSETGROUP k j 0
tx.assetGroups[i].outputs[j]; // -> OP_INSPECTASSETGROUP k j 1

// AssetInput Object
tx.assetGroups[i].inputs[j].type; // LOCAL or TELEPORT
tx.assetGroups[i].inputs[j].amount;       // Asset amount
// TELEPORT only:
tx.assetGroups[i].inputs[j].commitment; // Teleport commitment

// AssetOutput Object
tx.assetGroups[i].outputs[j].type; // LOCAL or TELEPORT
tx.assetGroups[i].outputs[j].amount;        // Asset amount
// TELEPORT only:
tx.assetGroups[i].outputs[j].commitment;  // Teleport commitment
// LOCAL only:
tx.assetGroups[i].outputs[j].scriptPubKey; // Output script (via out_index from OP_INSPECTASSETGROUPOUT + OP_INSPECTOUTPUTSCRIPTPUBKEY)

// Enum Types
enum AssetInputType { LOCAL, TELEPORT }
enum AssetOutputType { LOCAL, TELEPORT }

// Cross-input lookups (packet-declared)
tx.inputs[i].assets.length;               // maps to OP_INSPECTINASSETCOUNT
tx.inputs[i].assets[j].assetId;          // maps to OP_INSPECTINASSETAT (asset id part)
tx.inputs[i].assets[j].amount;           // maps to OP_INSPECTINASSETAT (amount part)
tx.inputs[i].assets.lookup(AssetId);     // maps to OP_INSPECTINASSETLOOKUP (amount | 0)

// AssetGroup lineage pointer (control asset reference)
tx.assetGroups[i].control;                 // maps to OP_INSPECTASSETGROUPCTRL

// Output introspection (multi-asset per UTXO)
tx.outputs.length;                           // number of transaction outputs
tx.outputs[i].scriptPubKey;                  // maps to OP_INSPECTOUTPUTSCRIPTPUBKEY
tx.outputs[i].assets.length;                 // maps to OP_INSPECTOUTASSETCOUNT
tx.outputs[i].assets[j].assetId;          // maps to OP_INSPECTOUTASSETAT (asset id part)
tx.outputs[i].assets[j].amount;           // maps to OP_INSPECTOUTASSETAT (amount part)
tx.outputs[i].assets.lookup(AssetId);     // maps to OP_INSPECTOUTASSETLOOKUP (amount | 0)
```

### Asset Types and Structures

```javascript
// Asset ID type
struct AssetId {
    txid: bytes32,
    gidx: int
}

// Asset reference for control assets
struct AssetRef {
    byId: bool,              // true for BY_ID, false for BY_GROUP
    assetId: AssetId,        // Used when byId = true
    groupIndex: int         // Used when byId = false
}

// Teleport-specific introspection records
struct TeleportOut {
    txid: bytes32,
    vout: int,
    amount: bigint
}
struct TeleportIn {
    txid: bytes32,
    vout: int,
    amount: bigint
}
```
