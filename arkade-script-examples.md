# ArkAsset Integration with Arkade Script

This document demonstrates how to integrate ArkAssets with Arkade Script, providing introspection capabilities and example contracts for common use cases.

## Asset Introspection API

### Asset Group Introspection

Following CashScript's transaction introspection pattern, ArkAssets extend Arkade Script with asset-specific introspection:

```javascript
// Asset Group Introspection
int tx.assetGroups.length                    // Number of asset groups
bytes32 tx.assetGroups[i].assetId.txid       // Asset genesis txid
int tx.assetGroups[i].assetId.gidx           // Asset group index
int tx.assetGroups[i].inputs.length         // Number of inputs in group
int tx.assetGroups[i].outputs.length        // Number of outputs in group
int tx.assetGroups[i].delta                 // Net change (outputs - inputs)

// Asset Input/Output Details
bool tx.assetGroups[i].inputs[j].isLocal     // LOCAL vs TELEPORT
int tx.assetGroups[i].inputs[j].index        // Input index (LOCAL only)
bytes32 tx.assetGroups[i].inputs[j].commitment // Commitment (TELEPORT only)
int tx.assetGroups[i].inputs[j].amount       // Asset amount

// Cross-input/output lookups
int tx.inputs[i].assetCount                  // Number of assets on input i
bytes32 tx.inputs[i].assets[j].assetId.txid  // j-th asset on input i
int tx.inputs[i].assets[j].amount            // Amount of j-th asset
```

### Asset Types and Structures

```javascript
// Asset ID type
struct AssetId {
    bytes32 txid;
    int gidx;
}

// Asset reference for control assets
struct AssetRef {
    bool byId;              // true for BY_ID, false for BY_GROUP
    AssetId assetId;        // Used when byId = true
    int groupIndex;         // Used when byId = false
}
```

## Example Contracts

### 1. Teleport Batch Swap Contract

This contract enforces that assets are teleported in and out correctly for batch swaps using commitments:

```typescript
contract TeleportBatchSwap(
    operator: PubKey,
    expectedInCommitments: Array<{commitment: bytes32, assetId: AssetId, amount: bigint}>,
    expectedOutCommitments: Array<{commitment: bytes32, assetId: AssetId, amount: bigint}>
) {
    function execute(sig: Sig) {
        // Verify operator signature
        require(checkSig(sig, operator));
        
        // Verify all expected teleport inputs are present
        for (let expected of expectedInCommitments) {
            let group = tx.assets.findGroup(expected.assetId);
            require(group != null, "Missing expected input asset");
            
            // Check teleport inputs match expected commitments
            let found = false;
            for (let i = 0; i < group.numInputs; i++) {
                let input = group.getInput(i);
                if (input.type == AssetInputType.TELEPORT && 
                    input.commitment == expected.commitment &&
                    input.amount == expected.amount) {
                    found = true;
                    break;
                }
            }
            require(found, "Missing expected teleport input");
        }
        
        // Verify all expected teleport outputs are present
        for (let expected of expectedOutCommitments) {
            let group = tx.assets.findGroup(expected.assetId);
            require(group != null, "Missing expected output asset");
            
            // Check teleport outputs match expected commitments
            let found = false;
            for (let i = 0; i < group.numOutputs; i++) {
                let output = group.getOutput(i);
                if (output.type == AssetOutputType.TELEPORT && 
                    output.commitment == expected.commitment &&
                    output.amount == expected.amount) {
                    found = true;
                    break;
                }
            }
            require(found, "Missing expected teleport output");
        }
    }
}
```

**Use Case**: Premium VTXOs that require holding governance tokens or membership NFTs.

### 2. Teleport Batch Swap

A VTXO designed for Arkade batch swaps using teleport transfers:

```javascript
pragma arkade ^1.0.0;

// Arkade batch swap using teleport transfers
contract BatchSwapVTXO(
    pubkey userPk,
    pubkey operatorPk,
    bytes32 targetCommitment
) {
    function forfeit(signature userSig) {
        require(checkSig(userSig, userPk));
        
        // Ensure all assets are teleported with the target commitment
        for (int i = 0; i < tx.assetGroups.length; i++) {
            bool hasTeleportToTarget = false;
            for (int j = 0; j < tx.assetGroups[i].outputs.length; j++) {
                if (!tx.assetGroups[i].outputs[j].isLocal &&
                    tx.assetGroups[i].outputs[j].commitment == targetCommitment) {
                    hasTeleportToTarget = true;
                    break;
                }
            }
            require(hasTeleportToTarget, "All assets must teleport to target commitment");
        }
    }
    
    function operatorSpend(signature operatorSig) {
        require(checkSig(operatorSig, operatorPk));
        // Operator can spend after timeout
        require(tx.time >= this.age + 144); // 24 hour timeout
    }
}
```

**Use Case**: Enables seamless asset continuity across VTXO batch swaps without requiring operator liquidity fronting.

### 3. Multi-Asset Escrow with Teleports

An escrow that holds multiple assets and releases them via teleports using pre-agreed commitments:

```typescript
contract MultiAssetEscrow(
    seller: PubKey,
    buyer: PubKey,
    arbiter: PubKey,
    expectedAssets: Array<{assetId: AssetId, amount: bigint}>,
    releaseCommitments: Array<{commitment: bytes32, assetId: AssetId}>,
    releaseHeight: int
) {
    function release(sig: Sig) {
        // After timeout, seller can reclaim
        if (tx.time >= releaseHeight) {
            require(checkSig(sig, seller));
        } else {
            // Before timeout, need 2-of-3 signatures
            require(
                (checkSig(sig, seller) && checkSig(sig, buyer)) ||
                (checkSig(sig, seller) && checkSig(sig, arbiter)) ||
                (checkSig(sig, buyer) && checkSig(sig, arbiter))
            );
        }
        
        // Verify assets are being teleported to correct commitments
        for (let release of releaseCommitments) {
            let group = tx.assets.findGroup(release.assetId);
            require(group != null, "Missing asset");
            
            // Ensure teleport output uses correct commitment
            let found = false;
            for (let i = 0; i < group.numOutputs; i++) {
                let output = group.getOutput(i);
                if (output.type == AssetOutputType.TELEPORT &&
                    output.commitment == release.commitment) {
                    found = true;
                    break;
                }
            }
            require(found, "Missing required teleport output");
        }
    }
}
```

**Use Case**: Cross-chain or complex trades where assets need to be delivered to specific destinations in a coordinated manner.

### 4. Asset Reissuance Controller

A contract that manages control assets for reissuance operations:

```javascript
pragma arkade ^1.0.0;

// Control asset management for reissuance
contract AssetController(
    pubkey issuerPk,
    bytes32 controlAssetTxid,
    int controlAssetGidx
) {
    function reissue(signature issuerSig, int newAmount) {
        require(checkSig(issuerSig, issuerPk));
        
        // Find control asset group
        int controlGroupIndex = -1;
        for (int i = 0; i < tx.assetGroups.length; i++) {
            if (tx.assetGroups[i].assetId.txid == controlAssetTxid && 
                tx.assetGroups[i].assetId.gidx == controlAssetGidx) {
                controlGroupIndex = i;
                break;
            }
        }
        require(controlGroupIndex >= 0, "Control asset not found");
        
        // Control asset must be retained (delta = 0)
        require(tx.assetGroups[controlGroupIndex].delta == 0, "Control asset must be retained");
        
        // Find controlled asset group (should have positive delta for reissuance)
        bool foundReissuance = false;
        for (int i = 0; i < tx.assetGroups.length; i++) {
            if (i != controlGroupIndex && tx.assetGroups[i].delta > 0) {
                foundReissuance = true;
                require(tx.assetGroups[i].delta == newAmount, "Wrong reissuance amount");
            }
        }
        require(foundReissuance, "No reissuance found");
    }
}
```

**Use Case**: Stablecoin issuers or asset managers who need programmatic control over supply management.

### 5. Asset Swap with Price Oracle

A decentralized exchange contract that uses price oracles for asset swaps:

```javascript
pragma arkade ^1.0.0;

// Asset swap with oracle price verification
contract AssetSwap(
    pubkey oraclePk,
    bytes32 baseAssetTxid,
    int baseAssetGidx,
    bytes32 quoteAssetTxid,
    int quoteAssetGidx,
    int maxSlippageBps  // Basis points (100 = 1%)
) {
    function swap(
        signature userSig,
        pubkey userPk,
        datasig oracleSig,
        bytes oracleMessage
    ) {
        require(checkSig(userSig, userPk));
        
        // Decode oracle price message { timestamp, basePrice, quotePrice }
        bytes4 timestampBin, bytes4 basePriceBin, bytes4 quotePriceBin = oracleMessage.split(4);
        int timestamp = int(timestampBin);
        int basePrice = int(basePriceBin);
        int quotePrice = int(quotePriceBin);
        
        // Verify oracle signature and freshness
        require(checkDataSig(oracleSig, oracleMessage, oraclePk));
        require(tx.time <= timestamp + 300); // 5 minute freshness
        
        // Find asset groups
        int baseGroupIndex = -1;
        int quoteGroupIndex = -1;
        for (int i = 0; i < tx.assetGroups.length; i++) {
            if (tx.assetGroups[i].assetId.txid == baseAssetTxid && 
                tx.assetGroups[i].assetId.gidx == baseAssetGidx) {
                baseGroupIndex = i;
            }
            if (tx.assetGroups[i].assetId.txid == quoteAssetTxid && 
                tx.assetGroups[i].assetId.gidx == quoteAssetGidx) {
                quoteGroupIndex = i;
            }
        }
        require(baseGroupIndex >= 0 && quoteGroupIndex >= 0, "Assets not found");
        
        // Calculate expected exchange rate with slippage tolerance
        int expectedRate = (basePrice * 10000) / quotePrice;
        int actualRate = (tx.assetGroups[baseGroupIndex].delta * 10000) / 
                        (-tx.assetGroups[quoteGroupIndex].delta);
        
        int slippage = abs(actualRate - expectedRate) * 10000 / expectedRate;
        require(slippage <= maxSlippageBps, "Slippage too high");
    }
}
```

**Use Case**: Automated market makers or DEX contracts that need price verification for fair swaps.

### 6. Multi-Signature Asset Vault

A vault requiring multiple signatures to release assets:

```javascript
pragma arkade ^1.0.0;

// Multi-signature vault for asset custody
contract MultiSigAssetVault(
    pubkey[3] signers,
    int requiredSigs,
    bytes32 targetCommitment
) {
    function release(
        signature[3] sigs,
        pubkey[3] pubkeys
    ) {
        // Verify we have enough valid signatures
        int validSigs = 0;
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                if (pubkeys[i] == signers[j] && checkSig(sigs[i], pubkeys[i])) {
                    validSigs++;
                    break;
                }
            }
        }
        require(validSigs >= requiredSigs, "Insufficient signatures");
        
        // All assets must teleport with the specified commitment
        for (int i = 0; i < tx.assetGroups.length; i++) {
            require(tx.assetGroups[i].outputs.length == 1, "Must have single output per group");
            require(!tx.assetGroups[i].outputs[0].isLocal, "Must use teleport");
            require(tx.assetGroups[i].outputs[0].commitment == targetCommitment, "Wrong target commitment");
        }
    }
}
```

**Use Case**: Corporate treasuries or DAOs that require multiple approvals for asset movements.

## Key Integration Benefits

### 1. Teleport Support
The introspection API distinguishes between LOCAL and TELEPORT transfers, enabling batch swap contracts to enforce proper asset flow across transactions.

### 2. Asset Balance Validation
Contracts can verify asset ownership and amounts before allowing VTXO spending, enabling asset-gated functionality.

### 3. Control Asset Management
Contracts can enforce proper control asset retention during reissuance operations.

### 4. Multi-Asset Handling
The group-based structure allows contracts to handle multiple asset types in a single transaction efficiently.

### 5. Cross-Transaction Coordination
Teleport transfers enable complex multi-party protocols where assets need to move between different transactions in a coordinated manner.

## Implementation Notes

- All introspection data is read-only and reflects the current transaction's ArkAsset packet
- Teleport validation requires both source and target transactions to confirm
- Asset amounts are handled as 64-bit integers following ArkAsset specification
- Control asset validation follows the standard ArkAsset authorization model
- Error messages should be descriptive to aid in debugging contract execution

This integration maintains Arkade Script's familiar syntax while adding powerful asset introspection capabilities that leverage ArkAsset's teleport system for seamless batch swap operations and advanced asset management scenarios.
